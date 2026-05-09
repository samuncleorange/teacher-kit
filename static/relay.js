/* Quiet Garden — WebSocket-based media relay (server-side fallback).
 *
 * Used when the server-side relay is the chosen transport (either because
 * P2P/WebRTC failed within the timeout, or because the user picked relay
 * mode explicitly). The flow is dead simple:
 *
 *   ┌─────────┐  MediaRecorder chunks (binary WS frames)  ┌─────────┐
 *   │ peer A  │ ────────────────────────────────────────▶ │ peer B  │
 *   │         │ ◀──────────────────────────────────────── │         │
 *   └─────────┘   /api/relay/<pin>/<role>  WebSocket      └─────────┘
 *                       (server is dumb byte forwarder)
 *
 * Each side opens a WebSocket to /api/relay/<pin>/<role>; whatever it
 * sends is forwarded to the other role's socket. Server sends a periodic
 * JSON {type:"peer-status",teacher,student} text frame so each end
 * knows when its partner is online.
 *
 * We use webm/vp8+opus (broad Chromium/Firefox support). On Safari fall
 * back to webm/opus audio-only, which Safari MSE doesn't fully support
 * either — log and surface a friendly error.
 */
(function (global) {
  'use strict';

  // Try a list of mime types and return the first that BOTH MediaRecorder
  // and MediaSource support. Returns null if nothing works.
  function pickMime(candidates) {
    for (const m of candidates) {
      try {
        const recOK = (typeof MediaRecorder !== 'undefined') &&
                       MediaRecorder.isTypeSupported(m);
        const msOK  = (typeof MediaSource !== 'undefined') &&
                       MediaSource.isTypeSupported(m);
        if (recOK && msOK) return m;
      } catch (_) {}
    }
    return null;
  }

  const VIDEO_MIMES = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const AUDIO_MIMES = [
    'audio/webm;codecs=opus',
    'audio/webm',
  ];

  // Build a WebSocket URL for the relay endpoint, honouring HTTPS reverse proxy.
  function relayUrl(pin, role) {
    const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/relay/${pin}/${role}`;
  }

  /** WSRelay — the workhorse for one side of a relay session. */
  class WSRelay {
    constructor(pin, role) {
      this.pin = pin;
      this.role = role;
      this.ws = null;

      // Sender state
      this.recorder = null;
      this.sendMime = null;

      // Receiver state
      this.mediaSource = null;
      this.sourceBuffer = null;
      this.recvMime = null;
      this.appendQueue = [];
      this.mediaEl = null;

      // Hooks for outer code
      this.onPeerStatus = null;   // (status:{teacher,student}) → void
      this.onClose = null;
      this.onError = null;
      this.onReceiveStarted = null;
    }

    open() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(relayUrl(this.pin, this.role));
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => { settled = true; resolve(); };
        ws.onerror = (e) => {
          if (!settled) { settled = true; reject(new Error('WebSocket 连接失败')); }
          if (this.onError) this.onError(e);
        };
        ws.onclose = () => { if (this.onClose) this.onClose(); };
        ws.onmessage = (e) => this._onMessage(e.data);
      });
    }

    /** Begin streaming a MediaStream to the peer.
     *  hasVideo controls codec selection. */
    startSending(stream, hasVideo) {
      const mime = pickMime(hasVideo ? VIDEO_MIMES : AUDIO_MIMES);
      if (!mime) {
        if (this.onError) this.onError(new Error('浏览器不支持 webm/opus 中转编码'));
        return false;
      }
      this.sendMime = mime;
      const opts = {
        mimeType: mime,
        videoBitsPerSecond: 350_000,   // ~350 kbps video — fine for课堂监看
        audioBitsPerSecond: 48_000,    // ~48 kbps audio — voice quality
      };
      try {
        this.recorder = new MediaRecorder(stream, opts);
      } catch (e) {
        // Retry without explicit bitrate (older browsers reject those keys)
        try { this.recorder = new MediaRecorder(stream, { mimeType: mime }); }
        catch (e2) { if (this.onError) this.onError(e2); return false; }
      }
      // First chunk is special: it carries the EBML header — receiver MUST
      // get it before any media chunks. We send a tiny JSON text frame
      // ahead announcing the mime type so the receiver can configure
      // its MediaSource before the binary stream starts.
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
      // 250ms timeslices — small enough to feel live, big enough that VP8
      // clusters typically align with chunk boundaries.
      this.recorder.start(250);
      return true;
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
      // Text → control message; ArrayBuffer → media chunk
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }
        if (msg.type === 'peer-status' && this.onPeerStatus) this.onPeerStatus(msg);
        else if (msg.type === 'media-start') this._initReceiver(msg.mime);
        else if (msg.type === 'media-end') this._closeReceiver();
        return;
      }
      // Binary chunk
      if (data instanceof ArrayBuffer) {
        if (!this.mediaSource || !this.sourceBuffer) {
          // Still waiting for media-start with mime; queue
          this.appendQueue.push(data);
          return;
        }
        this.appendQueue.push(data);
        this._flush();
      }
    }

    _initReceiver(mime) {
      if (!this.mediaEl) return;
      if (!mime || !MediaSource.isTypeSupported(mime)) {
        if (this.onError) this.onError(new Error('对端编码不被本浏览器支持：' + mime));
        return;
      }
      this.recvMime = mime;
      this._closeReceiver();
      this.mediaSource = new MediaSource();
      this.mediaEl.src = URL.createObjectURL(this.mediaSource);
      this.mediaSource.addEventListener('sourceopen', () => {
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
          this.sourceBuffer.mode = 'sequence';
          this.sourceBuffer.addEventListener('updateend', () => this._flush());
          this.sourceBuffer.addEventListener('error', (e) => {
            if (this.onError) this.onError(new Error('SourceBuffer 错误'));
          });
          if (this.onReceiveStarted) this.onReceiveStarted();
          this._flush();
        } catch (e) {
          if (this.onError) this.onError(e);
        }
      });
    }

    _flush() {
      if (!this.sourceBuffer || this.sourceBuffer.updating) return;
      if (this.appendQueue.length === 0) return;
      // Cap queue to avoid unbounded growth if MSE stalls
      if (this.appendQueue.length > 256) {
        this.appendQueue.splice(0, this.appendQueue.length - 256);
      }
      const chunk = this.appendQueue.shift();
      try {
        this.sourceBuffer.appendBuffer(chunk);
      } catch (e) {
        // Drop the chunk; common transient issue is QuotaExceeded — try
        // pruning the start of the buffer.
        if (e && e.name === 'QuotaExceededError') {
          try {
            const buffered = this.sourceBuffer.buffered;
            if (buffered.length) {
              const start = buffered.start(0);
              const end = buffered.end(buffered.length - 1);
              if (end - start > 4) {
                this.sourceBuffer.remove(start, end - 4);
              }
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

  global.QGRelay = { WSRelay, pickMime, VIDEO_MIMES, AUDIO_MIMES };
})(window);
