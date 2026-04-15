/**
 * lib/wsClient.js — Shared WebSocket client singleton.
 *
 * Design: one persistent socket for the lifetime of the page.
 * - app.js owns the onStatus callback (drives topbar indicator).
 * - Each mode sets its own onFrame handler via setOnFrame().
 *   When a mode unmounts it calls setOnFrame(null); the socket stays open.
 * - connect() opens the socket (or re-uses if already open at same URL).
 * - Modes must NOT call connect() themselves — only app.js does.
 *
 * ── Mixed-content / HTTPS fix ────────────────────────────────────────────
 *
 * Problem: browsers block ws:// (plain WebSocket) when the page is served
 * over https://.  This is "mixed active content" — silently blocked before
 * the OS ever sees the TCP SYN.  The error surfaces as an immediate close
 * event with no useful message, which previously looked like a network
 * failure rather than a policy block.
 *
 * Fix — two layers:
 *
 *   1. Auto-upgrade:  _resolveUrl() rewrites ws:// → wss:// when
 *      location.protocol is 'https:'.  This allows the bridge to be
 *      exposed through a TLS-terminating reverse proxy (nginx, Caddy,
 *      ngrok, Cloudflare Tunnel) without the user having to remember
 *      to type wss://.
 *
 *   2. Localhost exemption detection:  Chrome 94+ and Firefox 95+ grant
 *      an exemption for ws://localhost and ws://127.0.0.1 even on HTTPS
 *      pages (Secure Context for localhost, per W3C).  _isLocalhostUrl()
 *      detects this case so we don't silently upgrade a URL that the
 *      browser will already allow — preserving the plain ws:// that the
 *      Python bridge actually speaks.
 *
 *   3. Mixed-content error detection:  if a ws:// connection closes
 *      immediately (readyState goes CLOSED within 100 ms of opening)
 *      while the page is on HTTPS and the target is not localhost,
 *      _onFastClose() surfaces a specific 'mixed-content' status so
 *      the UI can show an actionable message instead of "Disconnected".
 *
 * Bridge-side requirement for wss://:
 *   The Python bridge speaks plain WebSocket.  To reach it from an HTTPS
 *   page at a non-localhost address you need a TLS-terminating proxy in
 *   front of it.  Quick options:
 *
 *     # ngrok (zero-config tunnel, free tier):
 *     ngrok http 8765 --scheme=https
 *     # → use the wss://xxxx.ngrok.io URL shown in the terminal
 *
 *     # Caddy (local TLS cert, stays localhost):
 *     caddy reverse-proxy --from localhost:8766 --to localhost:8765
 *     # → use wss://localhost:8766  (Caddy auto-provisions a self-signed cert)
 *
 *     # nginx snippet (add to server block listening on 443 ssl):
 *     location /ws {
 *       proxy_pass         http://127.0.0.1:8765;
 *       proxy_http_version 1.1;
 *       proxy_set_header   Upgrade    $http_upgrade;
 *       proxy_set_header   Connection "Upgrade";
 *     }
 *
 * Exported API — unchanged from previous version:
 *   WsClient.connect(url)          — open/re-open socket
 *   WsClient.disconnect()          — close socket
 *   WsClient.setOnFrame(fn|null)   — register active mode's frame handler
 *   WsClient.setOnStatus(fn|null)  — register status indicator callback
 *   WsClient.isConnected()         → boolean
 *   WsClient.getUrl()              → string  (resolved URL, not the raw input)
 *   WsClient.isMixedContentBlocked() → boolean  (true after a mixed-content close)
 */

'use strict';

const WsClient = (() => {

  let _ws                  = null;
  let _url                 = 'ws://localhost:8765';
  let _onFrame             = null;
  let _onStatus            = null;
  let _mixedContentBlocked = false;
  let _openTimestamp       = 0;   // performance.now() when socket was created

  /* ── URL resolution ───────────────────────────────────────────── */

  /**
   * Returns true if url targets localhost / 127.0.0.1 / ::1.
   * Chrome 94+ and Firefox 95+ exempt these from mixed-content blocking,
   * so we should NOT force-upgrade them to wss://.
   */
  function _isLocalhostUrl(url) {
    try {
      const { hostname } = new URL(url);
      return hostname === 'localhost'
          || hostname === '127.0.0.1'
          || hostname === '[::1]'
          || hostname === '::1';
    } catch(e) { return false; }
  }

  /**
   * Rewrite ws:// → wss:// when:
   *   - the page is served over HTTPS, AND
   *   - the target is NOT localhost (localhost is already exempt).
   *
   * Also normalises wss:// input that arrives on an HTTP page (no-op).
   */
  function _resolveUrl(raw) {
    if (location.protocol !== 'https:') return raw;
    if (_isLocalhostUrl(raw))           return raw;   // localhost exemption
    // Non-localhost ws:// on HTTPS → upgrade
    if (raw.startsWith('ws://'))  return 'wss://' + raw.slice(5);
    return raw;
  }

  /* ── Status emission ─────────────────────────────────────────── */

  function _emit(status) {
    if (_onStatus) _onStatus(status);
  }

  /* ── Mixed-content fast-close detector ──────────────────────── */

  /**
   * Called on every close event.  If the socket closed within 80 ms of
   * being created, the page is on HTTPS, and the target is not localhost,
   * we infer a mixed-content block and emit a distinct status so the UI
   * can surface an actionable message.
   *
   * 80 ms is well above TCP round-trip time for a local bridge (~0.1 ms)
   * but well below any real connection timeout (≥1 s).  A mixed-content
   * block fires the close event synchronously (within one event loop tick).
   */
  function _onFastClose() {
    const elapsed = performance.now() - _openTimestamp;
    if (
      elapsed < 80
      && location.protocol === 'https:'
      && !_isLocalhostUrl(_url)
    ) {
      _mixedContentBlocked = true;
      _emit('mixed-content');   // callers should treat this as disconnected
                                // but show a specific error message
      return;
    }
    _mixedContentBlocked = false;
    _emit('disconnected');
  }

  /* ── Core connect / disconnect ───────────────────────────────── */

  function connect(rawUrl) {
    const url = _resolveUrl(rawUrl);

    // Re-use existing open connection at the same resolved URL
    if (_ws && _ws.readyState === WebSocket.OPEN && url === _url) {
      _emit('connected');
      return;
    }

    // Close previous socket silently
    if (_ws) {
      _ws.onopen = _ws.onmessage = _ws.onerror = _ws.onclose = null;
      try { _ws.close(); } catch(e) {}
      _ws = null;
    }

    _url                 = url;
    _mixedContentBlocked = false;
    _emit('connecting');

    _openTimestamp = performance.now();
    _ws = new WebSocket(url);

    _ws.onopen = () => {
      _mixedContentBlocked = false;
      _emit('connected');
    };

    _ws.onmessage = e => {
      if (!_onFrame) return;
      let frame;
      try { frame = JSON.parse(e.data); } catch { return; }
      _onFrame(frame);
    };

    _ws.onerror = () => {
      // onerror always fires before onclose; we do our diagnosis in onclose
      // where readyState is already CLOSED and the timestamp diff is meaningful.
    };

    _ws.onclose = () => {
      _ws = null;
      _onFastClose();
    };
  }

  function disconnect() {
    if (_ws) {
      _ws.onopen = _ws.onmessage = _ws.onerror = _ws.onclose = null;
      try { _ws.close(); } catch(e) {}
      _ws = null;
    }
    _mixedContentBlocked = false;
    _emit('disconnected');
  }

  function setOnFrame(fn)           { _onFrame  = fn || null; }
  function setOnStatus(fn)          { _onStatus = fn || null; }
  function isConnected()            { return _ws !== null && _ws.readyState === WebSocket.OPEN; }
  function getUrl()                 { return _url; }
  function isMixedContentBlocked()  { return _mixedContentBlocked; }

  return {
    connect,
    disconnect,
    setOnFrame,
    setOnStatus,
    isConnected,
    getUrl,
    isMixedContentBlocked,
  };

})();
