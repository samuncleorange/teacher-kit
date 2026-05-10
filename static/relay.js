/* Quiet Garden — WebSocket-based media relay (server-side fallback).
 *
 * Used when WebRTC P2P fails (8s timeout) and we need to relay media via
 * the server's HTTPS reverse proxy. Wire format: WebSocket binary frames
 * carrying MediaRecorder output; receiver feeds them into MediaSource.
 *
 * Cross-browser is tricky because MediaRecorder & MediaSource have very
 * different codec coverage:
 *
 *   Browser        | MR record       | MSE decode
 *   ---------------|-----------------|---------------------------------
 *   Chrome / Edge  | webm + mp4(124+)| webm + mp4
 *   Firefox        | webm only       | webm + mp4 (limited)
 *   Safari iOS/mac | mp4 only        | mp4 only (no webm at all)
 *
 * Strategy:
 *   1. On WS open both peers exchange capabilities (a `caps` message
 *      listing every mime each side can record AND every mime each side
 *      can decode).
 *   2. The *sender* picks the first mime that is in its own RECORD list
 *      AND in the peer's DECODE list. This makes Safer↔Chrome work
 *      (Safari sends mp4, Chrome decodes mp4; Chrome sends mp4 if it
 *      detects peer can't decode webm, etc).
 *   3. If the intersection is empty, surface a diagnostic error with
 *      both peers' capability lists so the user can tell which browser
 *      to switch.
 *
 * Receiver flow: a `media-start` text frame announces the mime, then
 * binary chunks follow. MediaSource is configured with sequence mode and
 * appended chunk-by-chunk.
 */
(function (global) {
  'use strict';

  // Candidate mimes ordered by preference (best quality / widest support first).
  const ALL_MIMES = [
    // WebM / VP8 + Opus — best on Chrome/Firefox
    'video/webm;codecs="vp8,opus"',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs="h264,opus"',
    'video/webm',
    // Fragmented MP4 — required for Safari, also works on recent Chrome
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1.4D401E,mp4a.40.2"',
    'video/mp4;codecs="avc1.640028,mp4a.40.2"',
    'video/mp4',
    // Audio-only variants
    'audio/webm;codecs="opus"',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs="mp4a.40.2"',
    'audio/mp4',
  ];
  const VIDEO_PREFIX = 'video/';
  const AUDIO_PREFIX = 'audio/';

  function isVideoMime(m) { return m && m.indexOf(VIDEO_PREFIX) === 0; }

  // The MediaSource implementation actually present on this browser.
  // iPhone Safari (≥17.1) only exposes ManagedMediaSource — same surface
  // for our purposes (addSourceBuffer / appendBuffer / isTypeSupported
  // all work), but it must be wired up via .srcObject (not URL.createObjectURL)
  // and the <video>/<audio> element must have disableRemotePlayback=true.
  function getMediaSourceCtor() {
    if (typeof MediaSource !== 'undefined') return MediaSource;
    if (typeof ManagedMediaSource !== 'undefined') return ManagedMediaSource;
    if (typeof self !== 'undefined' && self.ManagedMediaSource) return self.ManagedMediaSource;
    return null;
  }

  // Apple's ManagedMediaSource (iOS Safari) infamously reports video/webm
  // as supported via isTypeSupported() but cannot actually decode it —
  // sourceBuffer.appendBuffer either errors or silently produces no frames.
  // We strip those entries from the decode list so the codec negotiator
  // never picks webm-video for Safari peers.
  // (Audio webm/opus *is* genuinely supported on Safari, leave it in.)
  const SAFARI_DECODE_BLACKLIST = new Set([
    'video/webm;codecs="vp8,opus"',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs="h264,opus"',
    'video/webm',
  ]);

  // Discover capabilities of THIS browser.
  function discoverCaps() {
    const MSC = getMediaSourceCtor();
    const out = {
      record: [], decode: [],
      ua: '', mr: false, ms: false, msKind: null,
    };
    try { out.ua = navigator.userAgent; } catch (_) {}
    out.mr = (typeof MediaRecorder !== 'undefined');
    out.ms = !!MSC;
    const isManaged = !!MSC && (typeof ManagedMediaSource !== 'undefined') &&
                      (MSC === ManagedMediaSource);
    out.msKind = !MSC ? null : (isManaged ? 'ManagedMediaSource' : 'MediaSource');

    if (out.mr) {
      for (const m of ALL_MIMES) {
        try { if (MediaRecorder.isTypeSupported(m)) out.record.push(m); } catch (_) {}
      }
    }
    if (MSC && typeof MSC.isTypeSupported === 'function') {
      for (const m of ALL_MIMES) {
        // Trust-but-verify: filter out lying entries on Safari.
        if (isManaged && SAFARI_DECODE_BLACKLIST.has(m)) continue;
        try { if (MSC.isTypeSupported(m)) out.decode.push(m); } catch (_) {}
      }
    }
    return out;
  }

  // Build a WebSocket URL for the relay endpoint, honouring HTTPS reverse proxy.
  function relayUrl(pin, role) {
    const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/relay/${pin}/${role}`;
  }

  // Pick a mime where:
  //   - we can record it (myRecord)
  //   - peer can decode it (peerDecode)
  //   - it matches the requested track type (video vs audio)
  function negotiateMime(myRecord, peerDecode, hasVideo) {
    const wantVideo = !!hasVideo;
    for (const m of myRecord) {
      if (wantVideo && !isVideoMime(m)) continue;
      if (!wantVideo && isVideoMime(m)) continue;
      if (peerDecode.includes(m)) return m;
      // Also try cross-quote-style matching: 'codecs="opus"' vs 'codecs=opus'
      const norm = m.replace(/"/g, '');
      for (const p of peerDecode) {
        if (p.replace(/"/g, '') === norm) return m;
      }
    }
    return null;
  }

  /** WSRelay — the workhorse for one side of a relay session. */
  class WSRelay {
    constructor(pin, role) {
      this.pin = pin;
      this.role = role;
      this.ws = null;

      this.localCaps = discoverCaps();
      this.peerCaps = null;          // arrives via 'caps' text frame
      this._capsWaiters = [];        // resolvers awaiting peer caps

      // Sender state
      this.recorder = null;
      this.sendMime = null;
      this._pendingSend = null;      // { stream, hasVideo } queued until caps arrive

      // Receiver state
      this.mediaSource = null;
      this.sourceBuffer = null;
      this.recvMime = null;
      this.appendQueue = [];
      this.mediaEl = null;

      // Hooks
      this.onPeerStatus = null;
      this.onClose = null;
      this.onError = null;
      this.onReceiveStarted = null;
      this.onPeerCaps = null;
    }

    open() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(relayUrl(this.pin, this.role));
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => {
          settled = true;
          // Announce our capabilities immediately. Peer will reply when they
          // open their side; the server forwards transparently.
          this._send({ type: 'caps', caps: this.localCaps });
          resolve();
        };
        ws.onerror = (e) => {
          if (!settled) { settled = true; reject(new Error('WebSocket 连接失败')); }
          if (this.onError) this.onError(e);
        };
        ws.onclose = () => { if (this.onClose) this.onClose(); };
        ws.onmessage = (e) => this._onMessage(e.data);
      });
    }

    /** Begin streaming a MediaStream. If peer caps not yet received,
     *  the start is queued and runs as soon as caps arrive. */
    startSending(stream, hasVideo) {
      this._pendingSend = { stream, hasVideo: !!hasVideo };
      this._tryStartSending();
    }

    _tryStartSending() {
      if (!this._pendingSend) return;
      if (!this.peerCaps) return;       // wait for caps
      const { stream, hasVideo } = this._pendingSend;
      this._pendingSend = null;

      const myRec = this.localCaps.record;
      const peerDec = this.peerCaps.decode || [];
      let mime = negotiateMime(myRec, peerDec, hasVideo);

      if (!mime) {
        // Last-ditch: try MediaRecorder with no mimeType (browser default).
        // Use the actual recorder.mimeType after construction and HOPE the
        // peer can decode. Most browsers default to webm, which the peer
        // already either can or cannot decode (we just told them).
        try {
          this.recorder = new MediaRecorder(stream);
          mime = this.recorder.mimeType || (hasVideo ? 'video/webm' : 'audio/webm');
        } catch (e) {
          this._reportNoMimeError(hasVideo);
          return;
        }
      }

      // (Re)create with explicit mime so we know exactly what wire format we're producing.
      if (!this.recorder || (mime && this.recorder.mimeType !== mime)) {
        if (this.recorder) { try { this.recorder.stop(); } catch (_) {} }
        const opts = { mimeType: mime };
        if (hasVideo) opts.videoBitsPerSecond = 350_000;
        opts.audioBitsPerSecond = 48_000;
        try {
          this.recorder = new MediaRecorder(stream, opts);
        } catch (_e1) {
          try { this.recorder = new MediaRecorder(stream, { mimeType: mime }); }
          catch (_e2) {
            try { this.recorder = new MediaRecorder(stream); }
            catch (e3) {
              if (this.onError) this.onError(new Error('创建 MediaRecorder 失败：' + e3.message));
              return;
            }
            mime = this.recorder.mimeType || mime;
          }
        }
      }

      this.sendMime = mime;
      // Tell receiver what we'll be streaming, so it can configure MediaSource.
      this._send({ type: 'media-start', mime });

      this.recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        ev.data.arrayBuffer().then(buf => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try { this.ws.send(buf); } catch (_) {}
          }
        });
      };
      this.recorder.onerror = (e) => { if (this.onError) this.onError(e); };
      this.recorder.start(250);
    }

    _reportNoMimeError(hasVideo) {
      const peer = this.peerCaps || { record: [], decode: [] };
      const my = this.localCaps;
      const myKind = (hasVideo ? 'video' : 'audio');
      const myList = my.record.filter(m => isVideoMime(m) === hasVideo);
      const peerList = peer.decode.filter(m => isVideoMime(m) === hasVideo);
      const msg =
        '本端可录 ' + myKind + '：[' + (myList.join(', ') || '无') + ']；' +
        '对端可播 ' + myKind + '：[' + (peerList.join(', ') || '无') + ']。' +
        ' 没有交集——建议双方都用最新版 Chrome / Edge / Firefox。';
      if (this.onError) this.onError(new Error(msg));
    }

    stopSending() {
      if (this.recorder && this.recorder.state !== 'inactive') {
        try { this.recorder.stop(); } catch (_) {}
      }
      this.recorder = null;
    }

    /** Attach a <video>/<audio> element that will play the incoming stream. */
    attachReceiver(mediaEl) {
      this.mediaEl = mediaEl;
    }

    close() {
      this.stopSending();
      this._closeReceiver();
      if (this.ws) {
        try { this.ws.close(); } catch (_) {}
        this.ws = null;
      }
    }

    // ---- internals ----

    _send(jsonObj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify(jsonObj)); } catch (_) {}
      }
    }

    _onMessage(data) {
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }
        if (msg.type === 'caps') {
          this.peerCaps = msg.caps || { record: [], decode: [] };
          if (this.onPeerCaps) this.onPeerCaps(this.peerCaps);
          // Drain anyone awaiting caps + maybe start sending now
          this._capsWaiters.splice(0).forEach(r => r(this.peerCaps));
          this._tryStartSending();
        } else if (msg.type === 'peer-status') {
          if (this.onPeerStatus) this.onPeerStatus(msg);
          // Server sends this when peer connects. Re-announce caps in case
          // peer connected after us (their first 'caps' may have raced).
          this._send({ type: 'caps', caps: this.localCaps });
        } else if (msg.type === 'media-start') {
          this._initReceiver(msg.mime);
        } else if (msg.type === 'media-end') {
          this._closeReceiver();
        }
        return;
      }
      if (data instanceof ArrayBuffer) {
        if (!this.mediaSource || !this.sourceBuffer) {
          this.appendQueue.push(data);
          return;
        }
        this.appendQueue.push(data);
        this._flush();
      }
    }

    _initReceiver(mime) {
      if (!this.mediaEl) return;
      if (!mime) {
        if (this.onError) this.onError(new Error('对端未声明编码'));
        return;
      }
      const MSC = getMediaSourceCtor();
      if (!MSC || typeof MSC.isTypeSupported !== 'function' || !MSC.isTypeSupported(mime)) {
        if (this.onError) this.onError(
          new Error('本浏览器不支持解码对端的 ' + mime +
                    '；它可能录的是本机 MediaSource 无法播放的格式。'));
        return;
      }
      this.recvMime = mime;
      this._closeReceiver();
      this.mediaSource = new MSC();

      // ManagedMediaSource (iPhone Safari 17.1+) needs srcObject wiring +
      // disableRemotePlayback. Plain MediaSource works with URL.createObjectURL.
      const isManaged = (typeof ManagedMediaSource !== 'undefined' &&
                         this.mediaSource instanceof ManagedMediaSource);
      if (isManaged) {
        try { this.mediaEl.disableRemotePlayback = true; } catch (_) {}
        try { this.mediaEl.srcObject = this.mediaSource; }
        catch (_) {
          // Fallback if browser refuses srcObject for MMS (shouldn't happen on iOS 17.1+)
          try { this.mediaEl.src = URL.createObjectURL(this.mediaSource); } catch (_) {}
        }
      } else {
        this.mediaEl.src = URL.createObjectURL(this.mediaSource);
      }

      this.mediaSource.addEventListener('sourceopen', () => {
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
          this.sourceBuffer.mode = 'sequence';
          this.sourceBuffer.addEventListener('updateend', () => this._flush());
          if (this.onReceiveStarted) this.onReceiveStarted();
          this._flush();
        } catch (e) {
          if (this.onError) this.onError(new Error('addSourceBuffer 失败：' + e.message));
        }
      });

      // ManagedMediaSource emits startstreaming/endstreaming to control buffering.
      // We don't pause sending on endstreaming (server pace is already throttled),
      // but exposing a `play()` retry helps Safari kick off playback.
      this.mediaEl.play && this.mediaEl.play().catch(() => {});
    }

    _flush() {
      if (!this.sourceBuffer || this.sourceBuffer.updating) return;
      if (this.appendQueue.length === 0) return;
      if (this.appendQueue.length > 256) {
        this.appendQueue.splice(0, this.appendQueue.length - 256);
      }
      const chunk = this.appendQueue.shift();
      try {
        this.sourceBuffer.appendBuffer(chunk);
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') {
          try {
            const buffered = this.sourceBuffer.buffered;
            if (buffered.length) {
              const start = buffered.start(0);
              const end = buffered.end(buffered.length - 1);
              if (end - start > 4) this.sourceBuffer.remove(start, end - 4);
            }
          } catch (_) {}
        }
      }
    }

    _closeReceiver() {
      if (this.mediaSource) {
        try {
          if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
        } catch (_) {}
        this.mediaSource = null;
      }
      this.sourceBuffer = null;
      this.appendQueue = [];
      if (this.mediaEl) {
        try { this.mediaEl.removeAttribute('src'); this.mediaEl.load(); } catch (_) {}
      }
    }
  }

  global.QGRelay = { WSRelay, discoverCaps, ALL_MIMES };
})(window);
