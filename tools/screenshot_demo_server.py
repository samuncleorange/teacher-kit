#!/usr/bin/env python3
"""Demo server for screenshots.

Loads the main `server` module without running its main(), monkey-patches a few
constants (faster grow, alternate port), pre-seeds a class with a believable
garden + schedule, and serves until killed.

This is *only* for screenshotting; never expose it publicly. Do not import
it from the real server.
"""

import os
import sys
import threading
import time
import uuid

# Allow importing the server package living one level up.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import server as srv  # noqa: E402

# Demo overrides
DEMO_PORT = int(os.environ.get("DEMO_PORT", "55557"))
srv.PORT = DEMO_PORT
srv.GROW_DURATION_S = 1
srv.SHRINK_DURATION_S = 1


def mktree(level: int) -> dict:
    return {"id": "t_" + uuid.uuid4().hex[:8], "level": level}


def seed():
    pin = "1234"
    cls = srv.get_or_create_class(pin)
    with cls.lock:
        cls.settings.update({
            "quietTarget": 42,
            "loudTarget": 78,
            "barkUrl": "https://api.day.app/示例DeviceKey",
            "alertDb": 75,
            "alertSeconds": 120,
            "schedule": [
                {"day": 0, "start": "08:00", "end": "11:30"},
                {"day": 1, "start": "08:00", "end": "11:30"},
                {"day": 2, "start": "08:00", "end": "11:30"},
                {"day": 3, "start": "08:00", "end": "11:30"},
                {"day": 4, "start": "14:00", "end": "15:00"},
            ],
        })
        # A lush little garden: 2 小 + 2 中 + 1 大
        cls.trees = [
            mktree(1), mktree(1),
            mktree(2), mktree(2),
            mktree(3),
        ]
        cls.current_db = 38
        cls.last_sample_at = time.time()
        cls.last_bark_status = "OK 200"
        cls.last_bark_sent_at = time.time() - 90

    print(f"[demo] seeded class {pin}: {len(cls.trees)} trees, "
          f"{len(cls.settings['schedule'])} schedule slots", flush=True)


def main():
    seed()
    threading.Thread(target=srv.tick_loop, daemon=True).start()
    import http.server  # noqa: F401
    httpd = srv.ThreadingServer((srv.HOST, DEMO_PORT), srv.Handler)
    print(f"[demo] listening on http://{srv.HOST}:{DEMO_PORT}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
