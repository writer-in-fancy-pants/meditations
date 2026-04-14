'use strict';
/**
 * whoop/app.js — WHOOP HRV orchestrator
 * Manages BLE (direct) and WebSocket (bridge) connections.
 * Delegates mode logic to HRV and HowTo.
 */

const MODES = { hrv: HRV, howto: HowTo };
let activeMode    = null;
let activeModeKey = null;

/* ── Tab switching ──────────────────────────────────────── */

function switchMode(name) {
  if (!MODES[name] || name === activeModeKey) return;
  if (activeMode) activeMode.unmount();
  document.querySelectorAll('.mode-tab').forEach(t => {
    const on = t.dataset.mode === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  activeMode    = MODES[name];
  activeModeKey = name;
  activeMode.mount();
  localStorage.setItem('whoop-mode', name);
}

document.querySelectorAll('.mode-tab').forEach(t =>
  t.addEventListener('click', () => switchMode(t.dataset.mode)));

/* ── BLE connection ─────────────────────────────────────── */

function _applyBleStatus(state, detail) {
  const dot = document.getElementById('bleDot');
  const lbl = document.getElementById('bleLabel');
  const btn = document.getElementById('connectBleBtn');
  if (!dot || !lbl || !btn) return;
  dot.className = 'ble-dot';
  switch (state) {
    case 'connected':
      dot.classList.add('on');
      lbl.textContent = detail || 'Connected';
      btn.textContent = 'Disconnect';
      break;
    case 'connecting':
      dot.classList.add('connecting');
      lbl.textContent = 'Connecting…';
      btn.textContent = 'Cancel';
      break;
    case 'error':
      lbl.textContent = 'BLE error';
      btn.textContent = 'Connect WHOOP';
      break;
    default:
      lbl.textContent = 'Not connected';
      btn.textContent = 'Connect WHOOP';
  }
}

document.getElementById('connectBleBtn').addEventListener('click', async () => {
  if (BleClient.isConnected()) {
    BleClient.disconnect();
    return;
  }
  try {
    await BleClient.connect({
      onStatus: _applyBleStatus,
      onData:   (bpm, rr) => {
        // Route BLE data directly into the active HRV mode if it exposes onHRData
        if (activeMode && typeof activeMode.onHRData === 'function') {
          activeMode.onHRData(bpm, rr);
        }
      },
    });
  } catch(err) {
    if (!err.name?.includes('NotFound') && !err.message?.includes('cancel')) {
      alert('Bluetooth connection failed: ' + err.message);
    }
  }
});

/* ── WebSocket bridge ───────────────────────────────────── */

function _applyWsStatus(s) {
  const dot = document.getElementById('wsDot');
  const lbl = document.getElementById('wsLabel');
  const wsStatus = document.getElementById('wsStatus');
  if (!dot || !lbl) return;
  if (wsStatus) wsStatus.style.display = s !== 'disconnected' ? '' : 'none';
  dot.className = 'ws-dot';
  if (s === 'connected')    { dot.classList.add('on');          lbl.textContent = 'Bridge'; }
  else if (s === 'connecting') { dot.classList.add('connecting'); lbl.textContent = 'Connecting…'; }
  else                      { lbl.textContent = 'Bridge off'; }
  if (s === 'connected') document.getElementById('connectBanner').style.display = 'none';
}

WsClient.setOnStatus(_applyWsStatus);

document.getElementById('connectWsBtn').addEventListener('click', () => {
  const banner = document.getElementById('connectBanner');
  banner.style.display = banner.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('doConnectBtn').addEventListener('click', () => {
  WsClient.connect(document.getElementById('wsUrlInput').value.trim());
});

document.getElementById('wsUrlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('doConnectBtn').click();
});

/* ── Theme ──────────────────────────────────────────────── */

Theme.init(() => {
  if (activeMode && activeMode !== HowTo) {
    const key = activeModeKey;
    activeModeKey = null;
    activeMode.unmount();
    activeMode = MODES[key];
    activeMode.mount();
    activeModeKey = key;
  }
});

/* ── Boot ───────────────────────────────────────────────── */
switchMode(localStorage.getItem('whoop-mode') || 'hrv');
