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

  // ---- Structured logging --------------------------------------------------
  // All relay activity logs to console.log with a [QGRelay] prefix, plus
  // appends to an in-page debug panel that the page can show. The panel
  // is the only way to see what's happening on phones (no DevTools).
  let _panelEl = null;
  function _ensurePanel() {
    if (_panelEl) return _panelEl;
    if (typeof document === 'undefined') return null;
    const wantsDebug = /\bqg-debug=1|\bdebug=1/.test(location.search) ||
                       localStorage.getItem('qg-debug') === '1';
    if (!wantsDebug) return null;
    const el = document.createElement('div');
    el.id = 'qg-debug-panel';
    el.style.cssText =
      'position:fixed;right:8px;bottom:8px;width:340px;max-height:50vh;' +
      'overflow:auto;background:rgba(13,38,64,.92);color:#cfe8fb;' +
      'font:11px/1.5 ui-monospace,Menlo,monospace;padding:8px 10px;' +
      'border-radius:8px;z-index:99999;white-space:pre-wrap;word-break:break-all;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.3)';
    el.textContent = '[QGRelay] debug panel armed (?debug=1 or localStorage qg-debug=1)\n';
    document.body.appendChild(el);
    _panelEl = el;
    return el;
  }
  function L(level, ...args) {
    const ts = new Date().toISOString().slice(11, 23);
    const head = '[QGRelay ' + ts + ']';
    if (level === 'error') console.error(head, ...args);
    else if (level === 'warn') console.warn(head, ...args);
    else console.log(head, ...args);
    const panel = _ensurePanel();
    if (panel) {
      const line = head + ' ' + args.map(a => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object') {
          try { return JSON.stringify(a).slice(0, 240); } catch (_) { return String(a); }
        }
        return String(a);
      }).join(' ');
      panel.textContent += line + '\n';
      panel.scrollTop = panel.scrollHeight;
    }
  }
  // Allow pages to flip on the debug panel programmatically.
  function enableDebugPanel() {
    try { localStorage.setItem('qg-debug', '1'); } catch (_) {}
    _ensurePanel();
  }

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
        const url = relayUrl(this.pin, this.role);
        L('log', 'WS open →', url, '(role=' + this.role + ')');
        L('log', 'localCaps:',
          'msKind=' + this.localCaps.msKind,
          '#record=' + this.localCaps.record.length,
          '#decode=' + this.localCaps.decode.length);
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => {
          settled = true;
          L('log', 'WS onopen, sending caps');
          this._send({ type: 'caps', caps: this.localCaps });
          resolve();
        };
        ws.onerror = (e) => {
          L('error', 'WS onerror', e);
          if (!settled) { settled = true; reject(new Error('WebSocket 连接失败')); }
          if (this.onError) this.onError(e);
        };
        ws.onclose = (e) => {
          L('warn', 'WS onclose code=' + e.code + ' reason="' + (e.reason || '') + '"');
          if (this.onClose) this.onClose();
        };
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
      if (!this.peerCaps) {
        L('log', '_tryStartSending: peerCaps not yet here, will wait');
        return;
      }
      const { stream, hasVideo } = this._pendingSend;
      this._pendingSend = null;

      const myRec = this.localCaps.record;
      const peerDec = this.peerCaps.decode || [];
      let mime = negotiateMime(myRec, peerDec, hasVideo);
      L('log', 'negotiate hasVideo=' + hasVideo,
        '\n  myRecord(' + myRec.length + '):', myRec.slice(0, 5).join(' | ') + (myRec.length > 5 ? ' …' : ''),
        '\n  peerDecode(' + peerDec.length + '):', peerDec.slice(0, 5).join(' | ') + (peerDec.length > 5 ? ' …' : ''),
        '\n  → picked:', mime || '(none)');

      if (!mime) {
        try {
          this.recorder = new MediaRecorder(stream);
          mime = this.recorder.mimeType || (hasVideo ? 'video/webm' : 'audio/webm');
          L('warn', 'no intersection — falling back to default MediaRecorder mime:', mime);
        } catch (e) {
          L('error', 'fallback MediaRecorder ctor failed:', e.message);
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
      L('log', 'sending media-start, recorder mimeType=', this.recorder.mimeType);
      this._send({ type: 'media-start', mime });

      let chunkN = 0, totalSent = 0;
      this.recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        ev.data.arrayBuffer().then(buf => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(buf);
              chunkN++; totalSent += buf.byteLength;
              if (chunkN <= 3 || chunkN % 20 === 0) {
                L('log', 'TX chunk #' + chunkN + ' (' + buf.byteLength + 'B, total ' + totalSent + 'B)');
              }
            } catch (e) { L('error', 'ws.send failed:', e.message); }
          }
        });
      };
      this.recorder.onerror = (e) => {
        L('error', 'MediaRecorder error:', e.error || e);
        if (this.onError) this.onError(e);
      };
      this.recorder.onstart = () => L('log', 'MediaRecorder started, state=' + this.recorder.state);
      this.recorder.onstop  = () => L('log', 'MediaRecorder stopped');
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
        try { msg = JSON.parse(data); }
        catch (_) { L('warn', 'RX non-JSON text:', data.slice(0, 80)); return; }
        if (msg.type === 'caps') {
          const caps = msg.caps || { record: [], decode: [] };
          L('log', 'RX caps from peer: msKind=' + caps.msKind,
            '#record=' + (caps.record || []).length,
            '#decode=' + (caps.decode || []).length);
          this.peerCaps = caps;
          if (this.onPeerCaps) this.onPeerCaps(this.peerCaps);
          this._capsWaiters.splice(0).forEach(r => r(this.peerCaps));
          this._tryStartSending();
        } else if (msg.type === 'peer-status') {
          L('log', 'RX peer-status: teacher=' + msg.teacher + ' student=' + msg.student);
          if (this.onPeerStatus) this.onPeerStatus(msg);
          this._send({ type: 'caps', caps: this.localCaps });
        } else if (msg.type === 'media-start') {
          L('log', 'RX media-start mime=' + msg.mime);
          this._initReceiver(msg.mime);
        } else if (msg.type === 'media-end') {
          L('log', 'RX media-end');
          this._closeReceiver();
        } else {
          L('warn', 'RX unknown text msg:', msg.type);
        }
        return;
      }
      if (data instanceof ArrayBuffer) {
        this._rxN = (this._rxN || 0) + 1;
        this._rxTotal = (this._rxTotal || 0) + data.byteLength;
        if (this._rxN <= 3 || this._rxN % 20 === 0) {
          L('log', 'RX chunk #' + this._rxN + ' (' + data.byteLength + 'B, total ' + this._rxTotal + 'B)' +
              (this.sourceBuffer ? ' → SourceBuffer' : ' → queue (no SB yet)'));
        }
        if (!this.mediaSource || !this.sourceBuffer) {
          this.appendQueue.push(data);
          return;
        }
        this.appendQueue.push(data);
        this._flush();
      }
    }

    _initReceiver(mime) {
      if (!this.mediaEl) {
        L('error', '_initReceiver called but no mediaEl attached!');
        return;
      }
      if (!mime) {
        L('error', '_initReceiver: empty mime');
        if (this.onError) this.onError(new Error('对端未声明编码'));
        return;
      }
      const MSC = getMediaSourceCtor();
      if (!MSC || typeof MSC.isTypeSupported !== 'function' || !MSC.isTypeSupported(mime)) {
        L('error', '_initReceiver: MSC missing or cannot decode', mime);
        if (this.onError) this.onError(
          new Error('本浏览器不支持解码对端的 ' + mime +
                    '；它可能录的是本机 MediaSource 无法播放的格式。'));
        return;
      }
      this.recvMime = mime;
      this._closeReceiver();
      this.mediaSource = new MSC();
      L('log', '_initReceiver: created ' + (MSC === ManagedMediaSource ? 'ManagedMediaSource' : 'MediaSource') +
        ' for mime=' + mime);

      const isManaged = (typeof ManagedMediaSource !== 'undefined' &&
                         this.mediaSource instanceof ManagedMediaSource);
      if (isManaged) {
        try { this.mediaEl.disableRemotePlayback = true; } catch (_) {}
        try {
          this.mediaEl.srcObject = this.mediaSource;
          L('log', 'attached MMS via srcObject + disableRemotePlayback');
        } catch (e) {
          L('warn', 'srcObject failed, falling back to URL.createObjectURL:', e.message);
          try { this.mediaEl.src = URL.createObjectURL(this.mediaSource); } catch (_) {}
        }
      } else {
        this.mediaEl.src = URL.createObjectURL(this.mediaSource);
        L('log', 'attached MS via URL.createObjectURL');
      }

      this.mediaSource.addEventListener('sourceopen', () => {
        L('log', 'MediaSource sourceopen, calling addSourceBuffer(' + mime + ')');
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
          this.sourceBuffer.mode = 'sequence';
          this.sourceBuffer.addEventListener('updateend', () => this._flush());
          this.sourceBuffer.addEventListener('error', (e) => L('error', 'SourceBuffer error event', e));
          this.sourceBuffer.addEventListener('abort', (e) => L('warn', 'SourceBuffer abort event', e));
          L('log', 'SourceBuffer ready, queue length=' + this.appendQueue.length);
          if (this.onReceiveStarted) this.onReceiveStarted();
          this._flush();
        } catch (e) {
          L('error', 'addSourceBuffer failed:', e.message, e.name);
          if (this.onError) this.onError(new Error('addSourceBuffer 失败：' + e.message));
        }
      });
      this.mediaSource.addEventListener('sourceclose', () => L('warn', 'MediaSource sourceclose'));
      this.mediaSource.addEventListener('sourceended', () => L('warn', 'MediaSource sourceended'));

      // Triggered by ManagedMediaSource — we treat them as informational for now.
      this.mediaSource.addEventListener('startstreaming', () => L('log', 'MMS startstreaming'));
      this.mediaSource.addEventListener('endstreaming',   () => L('log', 'MMS endstreaming'));

      if (this.mediaEl.play) {
        this.mediaEl.play().then(() => L('log', 'mediaEl.play() resolved'))
                          .catch(e => L('warn', 'mediaEl.play() rejected:', e.message));
      }
    }

    _flush() {
      if (!this.sourceBuffer || this.sourceBuffer.updating) return;
      if (this.appendQueue.length === 0) return;
      if (this.appendQueue.length > 256) {
        const dropped = this.appendQueue.length - 256;
        L('warn', 'queue overflow, dropping', dropped, 'chunks');
        this.appendQueue.splice(0, dropped);
      }
      const chunk = this.appendQueue.shift();
      try {
        this.sourceBuffer.appendBuffer(chunk);
      } catch (e) {
        L('error', 'appendBuffer failed name=' + e.name + ' msg=' + e.message,
          'chunk=' + chunk.byteLength + 'B mime=' + this.recvMime);
        if (e && e.name === 'QuotaExceededError') {
          try {
            const buffered = this.sourceBuffer.buffered;
            if (buffered.length) {
              const start = buffered.start(0);
              const end = buffered.end(buffered.length - 1);
              if (end - start > 4) this.sourceBuffer.remove(start, end - 4);
            }
          } catch (_) {}
        } else {
          // Unrecoverable on this chunk — surface to UI
          if (this.onError) this.onError(new Error('appendBuffer ' + e.name + ': ' + e.message));
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

  global.QGRelay = { WSRelay, discoverCaps, ALL_MIMES, enableDebugPanel };
})(window);
