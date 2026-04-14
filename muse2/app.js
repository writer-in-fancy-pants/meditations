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
      break;
    case 'connecting':
      dot.classList.add('connecting');
      lbl.textContent = 'Connecting…';
      btn.textContent = 'Cancel';
      break;
    default:
      lbl.textContent = 'Disconnected';
      btn.textContent = 'Connect';
  }
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
