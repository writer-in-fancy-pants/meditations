/**
 * lib/youtubeAudio.js — YouTube background audio integration
 *
 * Embeds a hidden YouTube IFrame player and exposes the same start/stop/volume
 * interface as lib/audio.js so AudioPanel can treat it as just another sound
 * source. The IFrame API is lazy-loaded on first use.
 *
 * Limitations:
 *   - Requires an internet connection (YouTube CDN).
 *   - Autoplay is allowed only after a user gesture (browser policy).
 *     Call YtAudio.prime() inside any click handler to satisfy this.
 *   - Volume control works via YT Player API setVolume(0–100).
 *   - Some videos are blocked for embedding by the uploader; if loading
 *     fails the error is surfaced via the onError callback.
 *   - Works in Chrome, Edge, Firefox, Safari (IFrame API is universal).
 *
 * Exported API (YtAudio namespace):
 *   YtAudio.load(videoIdOrUrl, { onReady?, onError?, loop? })
 *      → load a video and auto-play when ready (after user gesture)
 *   YtAudio.play()        → resume / start playback
 *   YtAudio.pause()       → pause playback
 *   YtAudio.stop()        → pause and seek to 0
 *   YtAudio.setVolume(v)  → v in 0–1 (maps to YT 0–100)
 *   YtAudio.fadeVolume(v, ms) → smooth linear fade over ms milliseconds
 *   YtAudio.isReady()     → boolean
 *   YtAudio.isPlaying()   → boolean
 *   YtAudio.currentId()   → string|null  (active video ID)
 *   YtAudio.destroy()     → remove player and container
 *
 * Integration with AudioPanel (code diff in at.js):
 *   Add 'youtube' as a sound option in the template, then in mount():
 *     if (sound === 'youtube') YtAudio.load(urlInput.value, {...})
 */

'use strict';

const YtAudio = (() => {

  /* ── State ───────────────────────────────────────────────────── */
  let _player       = null;    // YT.Player instance
  let _ready        = false;   // player is initialised and video loaded
  let _playing      = false;
  let _volume       = 0.5;     // 0–1, mirrored for fade calculations
  let _videoId      = null;
  let _loop         = true;
  let _pendingPlay  = false;   // play was requested before player was ready
  let _onReady      = null;
  let _onError      = null;
  let _fadeRaf      = null;    // requestAnimationFrame handle for fade
  let _containerId  = 'yt-audio-container';

  /* ── YouTube URL → video ID ──────────────────────────────────── */

  /**
   * Extract an 11-character video ID from any YouTube URL format, or
   * return the input unchanged if it already looks like a raw ID.
   */
  function _parseId(input) {
    if (!input) return null;
    input = input.trim();
    // Raw 11-char ID (letters, digits, _ -)
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
    try {
      const url = new URL(input);
      // Standard: youtube.com/watch?v=ID
      const v = url.searchParams.get('v');
      if (v) return v;
      // Short: youtu.be/ID
      if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0];
      // Embed: youtube.com/embed/ID
      const em = url.pathname.match(/\/embed\/([A-Za-z0-9_-]{11})/);
      if (em) return em[1];
    } catch(e) {}
    return null;
  }

  /* ── IFrame API loader ───────────────────────────────────────── */

  let _apiLoading = false;
  let _apiReady   = false;
  const _apiQueue = [];  // callbacks waiting for API

  function _loadApi(cb) {
    if (_apiReady) { cb(); return; }
    _apiQueue.push(cb);
    if (_apiLoading) return;
    _apiLoading = true;

    // The IFrame API calls window.onYouTubeIframeAPIReady when loaded.
    // We chain onto any existing handler.
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      _apiReady = true;
      if (prev) prev();
      _apiQueue.forEach(fn => fn());
      _apiQueue.length = 0;
    };

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  /* ── Container management ────────────────────────────────────── */

  function _ensureContainer() {
    if (document.getElementById(_containerId)) return;
    const div = document.createElement('div');
    div.id    = _containerId;
    // Hidden off-screen — we only want audio, not video
    div.style.cssText = [
      'position:fixed', 'left:-9999px', 'top:-9999px',
      'width:1px', 'height:1px', 'overflow:hidden',
      'pointer-events:none', 'z-index:-1',
    ].join(';');
    document.body.appendChild(div);
  }

  /* ── Player creation ─────────────────────────────────────────── */

  function _createPlayer(videoId) {
    _ready   = false;
    _playing = false;
    _videoId = videoId;

    if (_player) {
      try { _player.destroy(); } catch(e) {}
      _player = null;
    }

    _ensureContainer();

    // Inner div for the IFrame to replace
    const inner = document.createElement('div');
    inner.id    = _containerId + '-inner';
    const container = document.getElementById(_containerId);
    container.innerHTML = '';
    container.appendChild(inner);

    _player = new YT.Player(inner.id, {
      height:  '1',
      width:   '1',
      videoId: videoId,
      playerVars: {
        autoplay:       1,
        controls:       0,
        disablekb:      1,
        fs:             0,
        iv_load_policy: 3,   // hide annotations
        modestbranding: 1,
        rel:            0,
        playsinline:    1,
      },
      events: {
        onReady:       _onPlayerReady,
        onStateChange: _onStateChange,
        onError:       _onPlayerError,
      },
    });
  }

  function _onPlayerReady(event) {
    _ready = true;
    // Apply buffered volume
    _player.setVolume(Math.round(_volume * 100));
    if (_pendingPlay || true) {   // autoplay is set, but ensure it fires
      _player.playVideo();
      _pendingPlay = false;
    }
    if (_onReady) _onReady();
  }

  function _onStateChange(event) {
    const S = YT.PlayerState;
    _playing = (event.data === S.PLAYING);
    // Loop: when ended, restart
    if (event.data === S.ENDED && _loop) {
      _player.seekTo(0);
      _player.playVideo();
    }
  }

  function _onPlayerError(event) {
    const codes = {
      2:  'Invalid video ID',
      5:  'HTML5 player error',
      100:'Video not found or private',
      101:'Video embedding disabled by uploader',
      150:'Video embedding disabled by uploader',
    };
    const msg = codes[event.data] || `YouTube error ${event.data}`;
    console.warn('YtAudio error:', msg);
    if (_onError) _onError(msg);
  }

  /* ── Public API ──────────────────────────────────────────────── */

  /**
   * Load and begin playing a YouTube video (audio only — player is hidden).
   * Must be called inside or after a user gesture (click/touch).
   * @param {string} videoIdOrUrl  — full URL or 11-char ID
   * @param {{ onReady?, onError?, loop? }} opts
   */
  function load(videoIdOrUrl, opts = {}) {
    const id = _parseId(videoIdOrUrl);
    if (!id) {
      const msg = `YtAudio: could not parse video ID from "${videoIdOrUrl}"`;
      console.warn(msg);
      if (opts.onError) opts.onError(msg);
      return;
    }

    _onReady = opts.onReady  || null;
    _onError = opts.onError  || null;
    _loop    = opts.loop !== false;   // default true

    _loadApi(() => _createPlayer(id));
  }

  /** Resume playback (no-op if not loaded). */
  function play() {
    if (_player && _ready) { _player.playVideo(); }
    else { _pendingPlay = true; }
  }

  /** Pause playback. */
  function pause() {
    _pendingPlay = false;
    if (_player && _ready) _player.pauseVideo();
  }

  /** Pause and seek to start. */
  function stop() {
    _pendingPlay = false;
    if (_player && _ready) {
      _player.stopVideo();
      _playing = false;
    }
  }

  /**
   * Set volume immediately.
   * @param {number} v  0–1
   */
  function setVolume(v) {
    _volume = Math.max(0, Math.min(1, v));
    if (_player && _ready) _player.setVolume(Math.round(_volume * 100));
  }

  /**
   * Smoothly fade volume from current level to target over ms milliseconds.
   * @param {number} targetV   0–1
   * @param {number} ms        fade duration
   */
  function fadeVolume(targetV, ms = 1000) {
    if (_fadeRaf) cancelAnimationFrame(_fadeRaf);
    const startV = _volume;
    const start  = performance.now();
    function step(now) {
      const t = Math.min((now - start) / ms, 1);
      setVolume(startV + (targetV - startV) * t);
      if (t < 1) _fadeRaf = requestAnimationFrame(step);
      else        _fadeRaf = null;
    }
    _fadeRaf = requestAnimationFrame(step);
  }

  /** Remove the hidden IFrame player entirely. */
  function destroy() {
    if (_fadeRaf) cancelAnimationFrame(_fadeRaf);
    if (_player) { try { _player.destroy(); } catch(e) {} _player = null; }
    const c = document.getElementById(_containerId);
    if (c) c.remove();
    _ready = _playing = false;
    _videoId = null;
  }

  function isReady()   { return _ready; }
  function isPlaying() { return _playing; }
  function currentId() { return _videoId; }

  return {
    load, play, pause, stop,
    setVolume, fadeVolume, destroy,
    isReady, isPlaying, currentId,
  };

})();
