'use strict';
/**
 * app.js — Orchestrator
 * Owns: tab navigation, WebSocket connection, status display, theme.
 * Delegates all mode logic to AT, HRV, HowTo modules in modes/.
 *
 * WsClient usage:
 *   - app.js calls WsClient.connect() and WsClient.setOnStatus()
 *   - Modes call WsClient.setOnFrame() on mount, setOnFrame(null) on unmount
 *   - The socket stays open across tab switches; only the frame handler swaps
 */

/* ── Mode registry ──────────────────────────────────────── */

const MODES = { at: AT, hrv: HRV, howto: HowTo };
let activeMode     = null;
let activeModeKey  = null;

function switchMode(name) {
  if (!MODES[name] || name === activeModeKey) return;

  // Unmount previous (clears its onFrame handler)
  if (activeMode) activeMode.unmount();

  // Update tab UI
  document.querySelectorAll('.mode-tab').forEach(t => {
    const on = t.dataset.mode === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });

  activeMode    = MODES[name];
  activeModeKey = name;
  activeMode.mount();
  localStorage.setItem('nf-mode', name);
}

/* ── Tab clicks ─────────────────────────────────────────── */

document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});

/* ── Status indicator ───────────────────────────────────── */

function _applyStatus(s) {
  // Broadcast to any mounted mode that wants to react to WS state changes
  window.dispatchEvent(new CustomEvent('ws-status', { detail: s }));

  const dot = document.getElementById('wsDot');
  const lbl = document.getElementById('wsLabel');
  const btn = document.getElementById('connectBtn');
  if (!dot || !lbl || !btn) return;

  dot.className = 'ws-dot';
  switch (s) {
    case 'connected':
      dot.classList.add('on');
      lbl.textContent = 'Connected';
      btn.textContent = 'Disconnect';
      document.getElementById('connectBanner').style.display = 'none';
      _hideMixedContentWarning();
      break;
    case 'connecting':
      dot.classList.add('connecting');
      lbl.textContent = 'Connecting…';
      btn.textContent = 'Cancel';
      break;
    case 'mixed-content':
      lbl.textContent = 'Blocked';
      btn.textContent = 'Connect';
      _showMixedContentWarning();
      break;
    default:
      lbl.textContent = 'Disconnected';
      btn.textContent = 'Connect';
  }
}


/* ── Mixed-content warning banner ──────────────────────────── */

const _MC_ID = 'mixedContentWarning';

function _showMixedContentWarning() {
  if (document.getElementById(_MC_ID)) return;
  const div = document.createElement('div');
  div.id = _MC_ID;
  div.className = 'mixed-content-warning';
  div.innerHTML = `
    <strong>Connection blocked by browser security policy.</strong>
    This page is served over <code>https://</code> but the bridge URL uses
    <code>ws://</code>. Non-localhost addresses require a TLS-terminating proxy
    so the browser can upgrade to <code>wss://</code>. Options:
    <ul>
      <li>Use <strong>ngrok</strong>: <code>ngrok http 8765</code> → paste the
          <code>wss://…ngrok.io</code> URL into the connect box above.</li>
      <li>Use <strong>Caddy</strong> locally:
          <code>caddy reverse-proxy --from localhost:8766 --to localhost:8765</code>
          → connect to <code>wss://localhost:8766</code>.</li>
      <li>If the bridge is on the same machine as your browser,
          use <code>ws://localhost:8765</code> — localhost is exempt
          from this restriction on Chrome 94+ and Firefox 95+.</li>
    </ul>
    <button class="mixed-content-close" onclick="document.getElementById('${_MC_ID}')?.remove()">Dismiss</button>
  `;
  // Insert below the connect banner
  const banner = document.getElementById('connectBanner');
  banner?.parentNode?.insertBefore(div, banner.nextSibling);
}

function _hideMixedContentWarning() {
  document.getElementById(_MC_ID)?.remove();
}

WsClient.setOnStatus(_applyStatus);

/* ── Connect / disconnect ───────────────────────────────── */

document.getElementById('connectBtn').addEventListener('click', () => {
  if (WsClient.isConnected()) {
    WsClient.disconnect();
  } else {
    const banner = document.getElementById('connectBanner');
    banner.style.display = banner.style.display === 'none' ? 'block' : 'none';
  }
});

document.getElementById('doConnectBtn').addEventListener('click', () => {
  const url = document.getElementById('wsUrlInput').value.trim();
  if (!url) return;
  WsClient.connect(url);
});

document.getElementById('wsUrlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('doConnectBtn').click();
});

/* ── Theme ──────────────────────────────────────────────── */

Theme.init(() => {
  // Rebuild charts in active mode after theme toggle
  if (activeMode && activeMode !== HowTo) {
    const key = activeModeKey;
    activeModeKey = null;   // allow re-mount of same mode
    activeMode.unmount();
    activeMode = MODES[key];
    activeMode.mount();
    activeModeKey = key;
  }
});

/* ── Boot ───────────────────────────────────────────────── */

(function boot() {
  const saved = localStorage.getItem('nf-mode') || 'at';
  switchMode(saved);
})();
