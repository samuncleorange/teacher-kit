#!/usr/bin/env python3
"""Quiet Garden multi-class server.

- Serves student page at /
- Serves teacher page at /teacher/<4-digit-pin>
- Per-class state (settings, trees, current dB) persisted in memory
- Settings persisted to settings.json
- Server-Sent Events stream at /api/stream/<pin>
- Bark notifications when dB stays above alert threshold for alertSeconds
"""

import base64
import hashlib
import http.server
import json
import os
import queue
import re
import socketserver
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from typing import Dict, List, Optional

# ============================================================
# Configuration
# ============================================================

PORT = 55556
HOST = "0.0.0.0"
ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
SETTINGS_FILE = os.path.join(ROOT, "settings.json")
STATE_FILE    = os.path.join(ROOT, "state.json")    # per-class trees (survives restart)

GROW_DURATION_S = 60        # ≤ quietTarget for this many seconds → grow tree
SHRINK_DURATION_S = 60      # ≥ loudTarget for this many seconds → remove tree
MERGE_COUNT = 3             # 3 trees of level N merge to 1 tree of level N+1
MAX_LEVEL = 4               # 1=small, 2=medium, 3=large, 4=huge
ONLINE_TIMEOUT_S = 5        # no samples for 5s → class is offline

DEFAULT_SETTINGS = {
    "quietTarget": 40,
    "loudTarget": 80,
    "barkUrl": "",
    "alertDb": 80,
    "alertSeconds": 60,
    # Weekly schedule: list of {day:0-6, start:"HH:MM", end:"HH:MM"}
    # day 0 = Monday … 6 = Sunday (matches Python time.localtime().tm_wday)
    # An empty schedule means "always monitoring" (legacy behaviour).
    "schedule": [],
    # TURN relay (server fallback for WebRTC when P2P direct connection
    # fails — e.g. symmetric NAT, captive portals, blocked UDP).
    # Multiple TURN URIs can be provided separated by commas, e.g.
    #   turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
    # Empty turnUrl means "STUN-only" (P2P only, may fail across NATs).
    "turnUrl": "",
    "turnUsername": "",
    "turnCredential": "",
}
INT_SETTING_KEYS = {"quietTarget", "loudTarget", "alertDb", "alertSeconds"}
STR_SETTING_KEYS = {"barkUrl", "turnUrl", "turnUsername", "turnCredential"}
LIST_SETTING_KEYS = {"schedule"}
SETTINGS_KEYS = INT_SETTING_KEYS | STR_SETTING_KEYS | LIST_SETTING_KEYS

PIN_RE = re.compile(r"^\d{4}$")
SIGNAL_TYPES = {"offer", "answer", "ice", "hangup", "ring"}
SIGNAL_FROM = {"teacher", "student"}


# ============================================================
# Schedule helpers
# ============================================================

def _parse_hhmm(s):
    """'HH:MM' -> (h, m) or (None, None) if invalid."""
    if not isinstance(s, str):
        return (None, None)
    parts = s.split(":")
    if len(parts) != 2:
        return (None, None)
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError:
        return (None, None)
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return (None, None)
    return (h, m)


def sanitize_schedule(raw):
    """Return a list of clean schedule entries; drop anything malformed."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            day = int(item.get("day"))
        except (TypeError, ValueError):
            continue
        if not (0 <= day <= 6):
            continue
        sh, sm = _parse_hhmm(item.get("start", ""))
        eh, em = _parse_hhmm(item.get("end", ""))
        if sh is None or eh is None:
            continue
        s_min = sh * 60 + sm
        e_min = eh * 60 + em
        if e_min <= s_min:
            continue  # zero or negative duration → skip
        out.append({
            "day": day,
            "start": f"{sh:02d}:{sm:02d}",
            "end": f"{eh:02d}:{em:02d}",
        })
    return out


def is_in_schedule(schedule):
    """True if the current local time falls in any slot, OR schedule is empty."""
    if not schedule:
        return True
    now = time.localtime()
    weekday = now.tm_wday  # 0=Mon … 6=Sun
    minutes = now.tm_hour * 60 + now.tm_min
    for slot in schedule:
        try:
            d = int(slot["day"])
        except (KeyError, TypeError, ValueError):
            continue
        sh, sm = _parse_hhmm(slot.get("start", ""))
        eh, em = _parse_hhmm(slot.get("end", ""))
        if sh is None or eh is None:
            continue
        if d == weekday and (sh * 60 + sm) <= minutes < (eh * 60 + em):
            return True
    return False

# ============================================================
# Settings persistence
# ============================================================

_persist_lock = threading.Lock()
_state_persist_lock = threading.Lock()


def _load_persisted() -> dict:
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_persisted(snapshot: dict) -> None:
    with _persist_lock:
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SETTINGS_FILE)


def _load_persisted_state() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_persisted_state(snapshot: dict) -> None:
    """Atomically write per-class trees to state.json."""
    with _state_persist_lock:
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False, indent=2)
        os.replace(tmp, STATE_FILE)


_persisted_settings = _load_persisted()
_persisted_state    = _load_persisted_state()


def _sanitize_trees(raw) -> "List[dict]":
    """Defensive: ignore garbage entries from state.json on disk."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            level = int(item.get("level", 0))
        except (TypeError, ValueError):
            continue
        if not (1 <= level <= MAX_LEVEL):
            continue
        tid = item.get("id")
        if not isinstance(tid, str) or not tid:
            tid = "t_" + uuid.uuid4().hex[:8]
        out.append({"id": tid, "level": level})
    return out


# ============================================================
# Class state
# ============================================================

def uid() -> str:
    return "t_" + uuid.uuid4().hex[:8]


class ClassState:
    """In-memory state for one class (one PIN)."""

    def __init__(self, pin: str, settings: Optional[dict] = None,
                 trees: Optional[List[dict]] = None):
        self.pin = pin
        self.lock = threading.RLock()
        self.settings = dict(DEFAULT_SETTINGS)
        if settings:
            for k in SETTINGS_KEYS:
                if k in settings:
                    self.settings[k] = settings[k]
            # extra sanitation for list fields loaded from disk
            self.settings["schedule"] = sanitize_schedule(
                self.settings.get("schedule", [])
            )
        self.current_db: float = 0.0
        self.last_sample_at: float = 0.0
        # Trees survive restarts (loaded from state.json); streaks reset.
        self.trees: List[dict] = _sanitize_trees(trees) if trees else []
        self.quiet_streak_start: Optional[float] = None
        self.loud_streak_start: Optional[float] = None
        self.alert_streak_start: Optional[float] = None
        self.last_bark_sent_at: float = 0.0
        self.last_bark_status: str = ""
        self.subscribers: List["queue.Queue"] = []

    # ---------- snapshot ----------

    def to_state(self) -> dict:
        with self.lock:
            now = time.time()
            online = (
                self.last_sample_at > 0
                and (now - self.last_sample_at) < ONLINE_TIMEOUT_S
            )
            local = time.localtime(now)
            in_sched = is_in_schedule(self.settings.get("schedule", []))
            return {
                "pin": self.pin,
                "settings": dict(self.settings),
                "currentDb": round(self.current_db),
                "lastSampleAt": self.last_sample_at,
                "serverNow": now,
                "serverWeekday": local.tm_wday,                  # 0=Mon..6=Sun
                "serverTimeStr": time.strftime("%H:%M", local),
                "inSchedule": in_sched,
                "online": online,
                "trees": list(self.trees),
                "quietStreakMs": (
                    int((now - self.quiet_streak_start) * 1000)
                    if self.quiet_streak_start
                    else 0
                ),
                "loudStreakMs": (
                    int((now - self.loud_streak_start) * 1000)
                    if self.loud_streak_start
                    else 0
                ),
                "alertStreakMs": (
                    int((now - self.alert_streak_start) * 1000)
                    if self.alert_streak_start
                    else 0
                ),
                "growDurationMs": GROW_DURATION_S * 1000,
                "shrinkDurationMs": SHRINK_DURATION_S * 1000,
                "alertDurationMs": int(self.settings.get("alertSeconds", 60)) * 1000,
                "lastBarkSentAt": self.last_bark_sent_at,
                "lastBarkStatus": self.last_bark_status,
            }

    # ---------- subscribers ----------

    def add_subscriber(self) -> "queue.Queue":
        q: "queue.Queue" = queue.Queue(maxsize=128)
        with self.lock:
            self.subscribers.append(q)
        return q

    def remove_subscriber(self, q: "queue.Queue") -> None:
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def _enqueue(self, event: Optional[str], payload: str) -> None:
        with self.lock:
            subs = list(self.subscribers)
        dead = []
        for q in subs:
            try:
                q.put_nowait((event, payload))
            except queue.Full:
                dead.append(q)
        for q in dead:
            self.remove_subscriber(q)

    def broadcast(self) -> None:
        """Broadcast a state snapshot (default SSE event)."""
        self._enqueue(None, json.dumps(self.to_state(), ensure_ascii=False))

    def broadcast_signal(self, signal: dict) -> None:
        """Broadcast a WebRTC signaling envelope (event: signal).

        All subscribers (including the sender's own page) receive it; clients
        ignore messages where `from` matches their own role.
        """
        self._enqueue("signal", json.dumps(signal, ensure_ascii=False))

    # ---------- settings ----------

    def update_settings(self, new_settings: dict) -> None:
        with self.lock:
            for k in INT_SETTING_KEYS:
                if k in new_settings:
                    try:
                        self.settings[k] = int(float(new_settings[k]))
                    except (TypeError, ValueError):
                        pass
            for k in STR_SETTING_KEYS:
                if k in new_settings:
                    self.settings[k] = str(new_settings[k]).strip()
            if "schedule" in new_settings:
                self.settings["schedule"] = sanitize_schedule(new_settings["schedule"])
        persist_all_settings()
        self.broadcast()

    # ---------- trees ----------

    def _consolidate(self) -> None:
        """Merge MERGE_COUNT trees of same level into one of next level."""
        changed = True
        while changed:
            changed = False
            for level in range(1, MAX_LEVEL):
                same = [t for t in self.trees if t["level"] == level]
                if len(same) >= MERGE_COUNT:
                    ids = {t["id"] for t in same[:MERGE_COUNT]}
                    self.trees = [t for t in self.trees if t["id"] not in ids]
                    self.trees.append({"id": uid(), "level": level + 1})
                    changed = True
                    break

    def add_tree(self) -> None:
        with self.lock:
            self.trees.append({"id": uid(), "level": 1})
            self._consolidate()
        persist_all_state()

    def remove_tree(self) -> None:
        """Lose the most-recently-added smallest tree. If only larger trees
        exist, break one back down (1 large -> MERGE_COUNT-1 smaller)."""
        changed = False
        with self.lock:
            if not self.trees:
                return
            min_level = min(t["level"] for t in self.trees)
            target_idx = None
            for i in range(len(self.trees) - 1, -1, -1):
                if self.trees[i]["level"] == min_level:
                    target_idx = i
                    break
            if target_idx is None:
                return
            target = self.trees.pop(target_idx)
            changed = True
            if target["level"] > 1:
                for _ in range(MERGE_COUNT - 1):
                    self.trees.append({"id": uid(), "level": target["level"] - 1})
        if changed:
            persist_all_state()

    # ---------- sample ingest ----------

    def process_sample(self, db: float) -> None:
        now = time.time()
        bark_url_to_use = ""
        bark_payload = None
        trees_changed = False

        with self.lock:
            # clamp
            if db < 0:
                db = 0.0
            if db > 200:
                db = 200.0
            self.current_db = db
            self.last_sample_at = now

            quiet_target = float(self.settings.get("quietTarget", 40))
            loud_target = float(self.settings.get("loudTarget", 80))
            alert_db = float(self.settings.get("alertDb", 80))
            alert_seconds = float(self.settings.get("alertSeconds", 60))
            in_sched = is_in_schedule(self.settings.get("schedule", []))

            if not in_sched:
                # Outside the scheduled monitoring window: dB is still recorded
                # for live display, but trees and Bark alerts are paused.
                self.quiet_streak_start = None
                self.loud_streak_start = None
                self.alert_streak_start = None
            else:
                # ---- tree streak ----
                if db <= quiet_target:
                    if self.quiet_streak_start is None:
                        self.quiet_streak_start = now
                    self.loud_streak_start = None
                    if (now - self.quiet_streak_start) >= GROW_DURATION_S:
                        self.trees.append({"id": uid(), "level": 1})
                        self._consolidate()
                        self.quiet_streak_start = now
                        trees_changed = True
                elif db >= loud_target:
                    if self.loud_streak_start is None:
                        self.loud_streak_start = now
                    self.quiet_streak_start = None
                    if (now - self.loud_streak_start) >= SHRINK_DURATION_S:
                        # inline remove_tree to keep one lock
                        if self.trees:
                            min_level = min(t["level"] for t in self.trees)
                            idx = None
                            for i in range(len(self.trees) - 1, -1, -1):
                                if self.trees[i]["level"] == min_level:
                                    idx = i
                                    break
                            if idx is not None:
                                target = self.trees.pop(idx)
                                trees_changed = True
                                if target["level"] > 1:
                                    for _ in range(MERGE_COUNT - 1):
                                        self.trees.append(
                                            {"id": uid(), "level": target["level"] - 1}
                                        )
                        self.loud_streak_start = now
                else:
                    self.quiet_streak_start = None
                    self.loud_streak_start = None

                # ---- alert streak (Bark) ----
                if db >= alert_db:
                    if self.alert_streak_start is None:
                        self.alert_streak_start = now
                    if (now - self.alert_streak_start) >= alert_seconds:
                        cooldown = max(alert_seconds, 30)
                        if (now - self.last_bark_sent_at) >= cooldown:
                            url = self.settings.get("barkUrl", "").strip()
                            if url:
                                bark_url_to_use = url
                                bark_payload = {
                                    "title": f"⚠️ 班级 {self.pin} 噪音告警",
                                    "body": (
                                        f"当前 {round(db)} dB，已超过 "
                                        f"{int(alert_db)} dB 持续 "
                                        f"{int(alert_seconds)} 秒。请关注课堂。"
                                    ),
                                }
                                self.last_bark_sent_at = now
                                self.last_bark_status = "sending..."
                                self.alert_streak_start = now  # reset window
                else:
                    self.alert_streak_start = None

        if bark_url_to_use and bark_payload:
            send_bark_async(self, bark_url_to_use, bark_payload)

        if trees_changed:
            persist_all_state()

        self.broadcast()


# ============================================================
# Bark notifications
# ============================================================

def send_bark_async(cls: "ClassState", bark_url: str, payload: dict) -> None:
    threading.Thread(
        target=_send_bark, args=(cls, bark_url, payload), daemon=True
    ).start()


def _send_bark(cls: "ClassState", bark_url: str, payload: dict) -> None:
    body = dict(payload)
    body.setdefault("group", "QuietGarden")
    body.setdefault("sound", "alarm")
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    try:
        req = urllib.request.Request(
            bark_url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8", "ignore")[:200]
            with cls.lock:
                cls.last_bark_status = f"OK {resp.status}"
            sys.stderr.write(f"[bark] {cls.pin} -> {resp.status} {text}\n")
    except Exception as e:
        with cls.lock:
            cls.last_bark_status = f"ERR {e}"
        sys.stderr.write(f"[bark] {cls.pin} error: {e}\n")
    cls.broadcast()


# ============================================================
# Class registry
# ============================================================

CLASSES: Dict[str, ClassState] = {}
_classes_lock = threading.Lock()


def get_or_create_class(pin: str) -> ClassState:
    with _classes_lock:
        if pin not in CLASSES:
            persisted = _persisted_settings.get(pin)
            saved_state = _persisted_state.get(pin) or {}
            CLASSES[pin] = ClassState(
                pin, persisted, saved_state.get("trees")
            )
        return CLASSES[pin]


def persist_all_settings() -> None:
    with _classes_lock:
        snapshot = {pin: dict(c.settings) for pin, c in CLASSES.items()}
    threading.Thread(target=_save_persisted, args=(snapshot,), daemon=True).start()


def persist_all_state() -> None:
    """Persist trees for every active class. Call after any change to trees."""
    with _classes_lock:
        snapshot = {
            pin: {"trees": list(c.trees)}
            for pin, c in CLASSES.items()
            if c.trees  # don't bloat the file with empty classes
        }
    threading.Thread(target=_save_persisted_state, args=(snapshot,), daemon=True).start()


# ============================================================
# WebSocket relay (server-side fallback when P2P fails)
# ============================================================
#
# Implements just enough of RFC 6455 to relay binary frames between two
# peers (teacher + student) of the same class. The server doesn't decode
# or store any media — it's a dumb pass-through. Combined with the
# reverse proxy's HTTPS termination, this lets WebRTC fail-over to
# server relay without needing a separate TURN service.
#
# Protocol on the wire is exactly WebSocket binary frames carrying
# MediaRecorder chunks (e.g. webm/vp8+opus). Clients decode using
# MediaSource on a <video>/<audio> element.

_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
WS_OP_CONT, WS_OP_TEXT, WS_OP_BIN = 0x0, 0x1, 0x2
WS_OP_CLOSE, WS_OP_PING, WS_OP_PONG = 0x8, 0x9, 0xA

# {pin: {role: handler_instance}} — protected by RELAY_LOCK
RELAY_HUB: "Dict[str, Dict[str, object]]" = {}
RELAY_LOCK = threading.Lock()


def ws_compute_accept(key: str) -> str:
    """RFC 6455 Sec-WebSocket-Accept derivation."""
    h = hashlib.sha1((key + _WS_MAGIC).encode("ascii")).digest()
    return base64.b64encode(h).decode("ascii")


def ws_recv_frame(rfile):
    """Read one WebSocket frame.

    Returns (opcode, payload_bytes, fin) or None on EOF / malformed.
    Handles fragmentation lazily (caller may need to reassemble; for our
    relay use-case MediaRecorder produces one chunk per frame).
    """
    head = rfile.read(2)
    if len(head) < 2:
        return None
    b1, b2 = head[0], head[1]
    fin = (b1 & 0x80) != 0
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    plen = b2 & 0x7F
    if plen == 126:
        ext = rfile.read(2)
        if len(ext) < 2:
            return None
        plen = struct.unpack(">H", ext)[0]
    elif plen == 127:
        ext = rfile.read(8)
        if len(ext) < 8:
            return None
        plen = struct.unpack(">Q", ext)[0]
    if plen > 16 * 1024 * 1024:  # 16 MiB hard cap per frame
        return None
    mask = rfile.read(4) if masked else None
    data = rfile.read(plen) if plen else b""
    if len(data) < plen:
        return None
    if masked and mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return (opcode, data, fin)


def ws_send_frame(wfile, opcode: int, data: bytes = b"") -> None:
    """Write one WebSocket frame (server → client, no mask)."""
    b1 = 0x80 | (opcode & 0x0F)
    plen = len(data)
    if plen < 126:
        header = bytes([b1, plen])
    elif plen < (1 << 16):
        header = bytes([b1, 126]) + struct.pack(">H", plen)
    else:
        header = bytes([b1, 127]) + struct.pack(">Q", plen)
    wfile.write(header + data)
    wfile.flush()


# ============================================================
# Periodic tick — broadcasts state every second so streak progress
# advances on subscriber UIs even between samples.
# ============================================================

def tick_loop() -> None:
    while True:
        time.sleep(1.0)
        with _classes_lock:
            classes = list(CLASSES.values())
        now = time.time()
        for c in classes:
            with c.lock:
                has_subs = bool(c.subscribers)
                offline = (
                    c.last_sample_at
                    and (now - c.last_sample_at) >= ONLINE_TIMEOUT_S
                )
                out_of_schedule = not is_in_schedule(c.settings.get("schedule", []))
                # If class went offline OR fell outside its monitoring window,
                # any in-flight streak is no longer meaningful — clear it so
                # the UI doesn't stall at "再坚持 12 秒".
                if offline or out_of_schedule:
                    if (
                        c.quiet_streak_start
                        or c.loud_streak_start
                        or c.alert_streak_start
                    ):
                        c.quiet_streak_start = None
                        c.loud_streak_start = None
                        c.alert_streak_start = None
            if has_subs:
                c.broadcast()


# ============================================================
# HTTP handler
# ============================================================

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "QuietGarden/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- helpers ----------

    def log_message(self, fmt, *args):
        sys.stderr.write(
            f"[quiet-tree] {self.address_string()} {fmt % args}\n"
        )

    def _send_simple(self, status, ctype="text/plain; charset=utf-8", body=b""):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_simple(status, "application/json; charset=utf-8", body)

    def _send_404(self, msg="Not Found"):
        self._send_simple(404, body=msg)

    def _serve_static(self, rel_path: str):
        rel_path = rel_path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel_path))
        if not (full == STATIC or full.startswith(STATIC + os.sep)):
            return self._send_404()
        if not os.path.isfile(full):
            return self._send_404()
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self._send_simple(200, ctype, data)

    # ---------- routing ----------

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/" or path == "/index.html":
            return self._serve_static("index.html")

        # Diagnostic page for WebSocket relay troubleshooting.
        if path == "/relay-test" or path == "/relay-test.html":
            return self._serve_static("relay-test.html")

        m = re.match(r"^/teacher/(\d{4})/?$", path)
        if m:
            return self._serve_static("teacher.html")

        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/") :])

        m = re.match(r"^/api/state/(\d{4})$", path)
        if m:
            cls = get_or_create_class(m.group(1))
            return self._send_json(cls.to_state())

        m = re.match(r"^/api/stream/(\d{4})$", path)
        if m:
            return self._handle_sse(m.group(1))

        # WebSocket relay: GET /api/relay/<pin>/<role>  (Upgrade: websocket)
        m = re.match(r"^/api/relay/(\d{4})/(teacher|student)$", path)
        if m:
            return self._handle_relay(m.group(1), m.group(2))

        return self._send_404()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._send_simple(400, body="bad json")
        if not isinstance(body, dict):
            return self._send_simple(400, body="json must be object")

        if path == "/api/sample":
            pin = str(body.get("pin", "")).strip()
            if not PIN_RE.match(pin):
                return self._send_simple(400, body="invalid pin")
            try:
                db = float(body.get("db", 0))
            except (TypeError, ValueError):
                return self._send_simple(400, body="bad db")
            cls = get_or_create_class(pin)
            cls.process_sample(db)
            return self._send_json({"ok": True})

        m = re.match(r"^/api/settings/(\d{4})$", path)
        if m:
            cls = get_or_create_class(m.group(1))
            cls.update_settings(body)
            return self._send_json({"ok": True, "settings": cls.settings})

        m = re.match(r"^/api/test-bark/(\d{4})$", path)
        if m:
            cls = get_or_create_class(m.group(1))
            with cls.lock:
                url = cls.settings.get("barkUrl", "").strip()
                cur_db = cls.current_db
            if not url:
                return self._send_simple(400, body="bark url not set")
            send_bark_async(
                cls,
                url,
                {
                    "title": f"📣 班级 {cls.pin} 测试通知",
                    "body": (
                        f"Bark 已连通 ✅ 当前分贝 {round(cur_db)}。"
                        " 真实告警将在持续超标后自动发送。"
                    ),
                },
            )
            return self._send_json({"ok": True})

        if path == "/api/reset":
            pin = str(body.get("pin", "")).strip()
            if not PIN_RE.match(pin):
                return self._send_simple(400, body="invalid pin")
            cls = get_or_create_class(pin)
            with cls.lock:
                cls.trees = []
                cls.quiet_streak_start = None
                cls.loud_streak_start = None
                cls.alert_streak_start = None
            persist_all_state()
            cls.broadcast()
            return self._send_json({"ok": True})

        # ---- WebRTC signaling relay ----
        # Body: {"from":"teacher"|"student", "type":"offer"|"answer"|"ice"|"hangup"|"ring", "data": <any>}
        # Server only relays — it never stores signaling, so peers must be
        # connected to the SSE stream at the time of relay.
        m = re.match(r"^/api/signal/(\d{4})$", path)
        if m:
            cls = get_or_create_class(m.group(1))
            sender = body.get("from")
            typ = body.get("type")
            if sender not in SIGNAL_FROM:
                return self._send_simple(400, body="bad from")
            if typ not in SIGNAL_TYPES:
                return self._send_simple(400, body="bad type")
            cls.broadcast_signal({
                "from": sender,
                "type": typ,
                "data": body.get("data"),
                "ts": int(time.time() * 1000),
            })
            return self._send_json({"ok": True})

        return self._send_404()

    # ---------- SSE ----------

    def _handle_sse(self, pin):
        if not PIN_RE.match(pin):
            return self._send_404()
        cls = get_or_create_class(pin)
        sub = cls.add_subscriber()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            # initial state snapshot — default event
            self._sse_write(None, json.dumps(cls.to_state(), ensure_ascii=False))
            last_heartbeat = time.time()
            while True:
                try:
                    item = sub.get(timeout=10)
                    if isinstance(item, tuple) and len(item) == 2:
                        ev, payload = item
                    else:
                        ev, payload = None, item  # legacy
                    self._sse_write(ev, payload)
                except queue.Empty:
                    pass
                if time.time() - last_heartbeat >= 15:
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    last_heartbeat = time.time()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            cls.remove_subscriber(sub)

    def _sse_write(self, event, data: str) -> None:
        out = []
        if event:
            out.append(f"event: {event}\n")
        for line in data.splitlines() or [""]:
            out.append("data: ")
            out.append(line)
            out.append("\n")
        out.append("\n")
        self.wfile.write("".join(out).encode("utf-8"))
        self.wfile.flush()

    # ---------- WebSocket relay ----------

    def _handle_relay(self, pin: str, role: str):
        """Hijack the connection for a WebSocket session that relays binary
        frames to the opposite peer in the same class."""
        upg = (self.headers.get("Upgrade") or "").lower()
        conn = (self.headers.get("Connection") or "").lower()
        ws_key = self.headers.get("Sec-WebSocket-Key") or ""
        if "websocket" not in upg or "upgrade" not in conn or not ws_key:
            return self._send_simple(400, body="not a websocket request")

        accept = ws_compute_accept(ws_key.strip())
        # Tell the framework we'll keep talking on the socket: don't auto-close.
        self.close_connection = True  # we'll close manually at end
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        # Register self as this PIN's <role>; if a previous one is registered,
        # close it (probably a stale tab).
        peer_role = "student" if role == "teacher" else "teacher"
        prev = None
        with RELAY_LOCK:
            peers = RELAY_HUB.setdefault(pin, {})
            prev = peers.get(role)
            peers[role] = self
            other = peers.get(peer_role)

        if prev is not None and prev is not self:
            try:
                ws_send_frame(prev.wfile, WS_OP_CLOSE, b"\x03\xe8")  # 1000 normal
            except Exception:
                pass
            try:
                prev.connection.close()
            except Exception:
                pass

        # Notify both peers about who's online via a tiny JSON text frame.
        # Clients use this to know when to start sending media.
        def notify_status():
            with RELAY_LOCK:
                peers = RELAY_HUB.get(pin, {})
                t_on = "teacher" in peers
                s_on = "student" in peers
                snapshot = list(peers.items())
            msg = json.dumps({
                "type": "peer-status",
                "teacher": t_on,
                "student": s_on,
            }).encode("utf-8")
            for r, h in snapshot:
                try:
                    ws_send_frame(h.wfile, WS_OP_TEXT, msg)
                except Exception:
                    pass

        notify_status()

        try:
            while True:
                frame = ws_recv_frame(self.rfile)
                if frame is None:
                    break
                opcode, data, _fin = frame
                if opcode == WS_OP_CLOSE:
                    try:
                        ws_send_frame(self.wfile, WS_OP_CLOSE, data[:125])
                    except Exception:
                        pass
                    break
                if opcode == WS_OP_PING:
                    try:
                        ws_send_frame(self.wfile, WS_OP_PONG, data)
                    except Exception:
                        pass
                    continue
                if opcode == WS_OP_PONG:
                    continue
                if opcode in (WS_OP_TEXT, WS_OP_BIN, WS_OP_CONT):
                    # Forward to the other role.
                    with RELAY_LOCK:
                        peers = RELAY_HUB.get(pin, {})
                        target = peers.get(peer_role)
                    if target is not None and target is not self:
                        try:
                            ws_send_frame(target.wfile, opcode, data)
                        except Exception:
                            # Target's socket is broken; drop it and notify us.
                            with RELAY_LOCK:
                                peers = RELAY_HUB.get(pin, {})
                                if peers.get(peer_role) is target:
                                    peers.pop(peer_role, None)
                            try:
                                target.connection.close()
                            except Exception:
                                pass
                            notify_status()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with RELAY_LOCK:
                peers = RELAY_HUB.get(pin, {})
                if peers.get(role) is self:
                    peers.pop(role, None)
                    if not peers:
                        RELAY_HUB.pop(pin, None)
            # Tell the surviving peer (if any) we're gone.
            try:
                notify_status()
            except Exception:
                pass


# ============================================================
# Server
# ============================================================

class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if not os.path.isdir(STATIC):
        sys.stderr.write(f"[quiet-tree] missing static dir: {STATIC}\n")
        sys.exit(1)

    threading.Thread(target=tick_loop, daemon=True).start()

    httpd = ThreadingServer((HOST, PORT), Handler)
    print(f"[quiet-tree] Listening on http://{HOST}:{PORT}")
    print(f"[quiet-tree]   Student page: http://localhost:{PORT}/")
    print(f"[quiet-tree]   Teacher page: http://localhost:{PORT}/teacher/<4-digit-pin>")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[quiet-tree] shutting down")


if __name__ == "__main__":
    main()
