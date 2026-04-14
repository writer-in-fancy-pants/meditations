/**
 * whoop/modes/hrv.js — HRV mode for WHOOP
 * Connects via Web Bluetooth BLE (direct) or WebSocket bridge.
 * All HRV math/charts delegate to ../../lib/hrv.js (HrvLib).
 * BLE connections use ../../lib/bleClient.js (BleClient).
 * Depends on: HrvLib, BleClient, Audio, AudioPanel, ChartUtils, WsClient
 */

'use strict';

const HRV = (() => {

  const BASELINE_BEATS = 120;
  const MAX_PTS        = 300;

  /* ── State ──────────────────────────────────────────────────── */
  let _mounted       = false;
  let sessionActive  = false;
  let baselinePhase  = false;
  let rrBuffer       = [];
  let baselineRMSSD  = null;
  let elapsedSec     = 0;
  let sessionDurSec  = 0;
  let timerInterval  = null;
  let lastCoherence  = false;
  const hist  = HrvLib.makeHist();
  const charts = {};

  /* ── Data handler (shared by BLE + WS) ─────────────────────── */
  function _onHRData(bpm, rrIntervals) {
    if (!_mounted || !rrIntervals.length) return;
    rrBuffer.push(...rrIntervals);

    if (baselinePhase) {
      const pct = Math.min(rrBuffer.length / BASELINE_BEATS, 1);
      _el('hrvStatStatus').textContent = `Calibrating… ${Math.round(pct*100)}%`;
      if (rrBuffer.length >= BASELINE_BEATS) _finishBaseline();
      return;
    }

    const window = rrBuffer.slice(-HrvLib.RR_WINDOW);
    const rv = HrvLib.rmssd(window);
    const pv = HrvLib.pnn50(window);
    const ci = HrvLib.coherenceIndex(rrBuffer);
    const label = sessionActive ? String(elapsedSec) : '';

    HrvLib.pushHist(hist, { label, hr: bpm, rr: rrIntervals[0]??null, rv }, MAX_PTS);
    HrvLib.updateCharts(charts, hist, baselineRMSSD);
    HrvLib.drawGauge('whoopGauge', ci, rv, baselineRMSSD);
    HrvLib.updateStateBadge('whoopStateBadge', rv, baselineRMSSD);

    if (bpm !== null) _el('whoopStatHR').innerHTML   = `${bpm}<span class="stat-unit">bpm</span>`;
    if (rv  !== null) _el('whoopStatRMSSD').innerHTML = `${rv.toFixed(1)}<span class="stat-unit">ms</span>`;
    if (pv  !== null) _el('whoopStatPNN50').innerHTML = `${pv.toFixed(1)}<span class="stat-unit">%</span>`;

    const highCoh = rv !== null && baselineRMSSD !== null && rv > baselineRMSSD;
    if (highCoh && !lastCoherence && _el('fbCoherence')?.checked && sessionActive)
      Audio.coherenceChime();
    lastCoherence = highCoh;

    if (sessionActive && _el('fbVolume')?.checked && rv !== null && baselineRMSSD !== null)
      Audio.adaptVolume(rv, baselineRMSSD, AudioPanel.targetVolume);

    // Session duration countdown
    if (sessionActive && sessionDurSec > 0) {
      const rem = Math.max(sessionDurSec - elapsedSec, 0);
      _el('whoopStatRemaining').textContent = _fmt(rem);
      if (rem === 0) _endSession();
    }
  }

  /* ── WS frame handler ───────────────────────────────────────── */
  function _onWsFrame(frame) {
    if (!_mounted) return;
    if (Array.isArray(frame.rr_ms) && frame.rr_ms.length)
      _onHRData(frame.bpm ?? null, frame.rr_ms);
  }

  /* ── Baseline ────────────────────────────────────────────────── */
  function _finishBaseline() {
    baselinePhase = false;
    baselineRMSSD = HrvLib.computeBaseline(rrBuffer, 60);
    _el('whoopStatBaseline').textContent = baselineRMSSD ? baselineRMSSD.toFixed(1)+' ms' : '—';
    _el('whoopStatStatus').textContent   = 'Baseline done';
    _el('whoopStartBtn').disabled        = false;
    rrBuffer = [];
  }

  /* ── Session ─────────────────────────────────────────────────── */
  function _startSession() {
    sessionDurSec = (+(_el('sessionDur')?.value || 20)) * 60;
    sessionActive = true; elapsedSec = 0;
    _el('whoopStatStatus').textContent   = 'Training';
    _el('whoopStartBtn').disabled        = true;
    _el('whoopStopBtn').disabled         = false;
    _el('whoopBaselineBtn').disabled     = true;
    _el('whoopStatRemaining').textContent= sessionDurSec > 0 ? _fmt(sessionDurSec) : '—';
    AudioPanel.startSelectedSound();
    if (_el('fbBeep')?.checked)
      Audio.scheduleBeep(+(_el('beepInterval')?.value||30),
        () => ({ score: HrvLib.rmssd(rrBuffer.slice(-HrvLib.RR_WINDOW))??0,
                 threshold: baselineRMSSD??1 }),
        () => sessionActive);
    timerInterval = setInterval(() => {
      elapsedSec++;
      _el('whoopStatElapsed').textContent = _fmt(elapsedSec);
    }, 1000);
  }

  function _endSession() {
    if (!sessionActive) return;
    sessionActive = false;
    clearInterval(timerInterval);
    Audio.cancelBeep();
    Audio.stopSound();
    if (_el('fbEndAlarm')?.checked) Audio.endAlarm();
    _el('whoopStatStatus').textContent = 'Complete';
    _el('whoopStartBtn').disabled      = false;
    _el('whoopStopBtn').disabled       = true;
    _el('whoopBaselineBtn').disabled   = false;
    // Show summary
    const summaryEl = _el('whoopSummary');
    if (summaryEl) {
      summaryEl.innerHTML = HrvLib.sessionSummary(rrBuffer, hist, elapsedSec, baselineRMSSD);
      _el('whoopEndOverlay').style.display = 'flex';
    }
  }

  function _fmt(s) {
    return String(Math.floor(s/60))+':'+String(s%60).padStart(2,'0');
  }

  function _el(id) { return document.getElementById(id); }

  /* ── Template ────────────────────────────────────────────────── */
  const TEMPLATE = `
<section class="section-card">
  <div class="section-hdr">
    <span class="section-title">HRV Session (WHOOP)</span>
    <div class="session-actions">
      <label class="dur-label">Duration
        <input type="number" id="sessionDur" class="dur-input" min="1" max="120" value="20" />
        <span class="dur-unit">min</span>
      </label>
      <button class="btn-sm" id="whoopBaselineBtn">Calibrate baseline (2 min)</button>
      <button class="btn-sm btn-accent" id="whoopStartBtn">Start training</button>
      <button class="btn-sm btn-danger" id="whoopStopBtn" disabled>Stop</button>
    </div>
  </div>
  <div class="stat-row">
    <div class="stat"><span class="stat-lbl">Status</span><span class="stat-val" id="whoopStatStatus">Idle</span></div>
    <div class="stat"><span class="stat-lbl">Elapsed</span><span class="stat-val" id="whoopStatElapsed">0:00</span></div>
    <div class="stat"><span class="stat-lbl">Remaining</span><span class="stat-val" id="whoopStatRemaining">—</span></div>
    <div class="stat"><span class="stat-lbl">Heart rate</span><span class="stat-val" id="whoopStatHR">—</span></div>
    <div class="stat"><span class="stat-lbl">RMSSD</span><span class="stat-val" id="whoopStatRMSSD">—</span></div>
    <div class="stat"><span class="stat-lbl">pNN50</span><span class="stat-val" id="whoopStatPNN50">—</span></div>
    <div class="stat"><span class="stat-lbl">Baseline</span><span class="stat-val" id="whoopStatBaseline">—</span></div>
  </div>
</section>
<div class="charts-row">
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr"><span class="chart-title">Heart rate</span><span class="chart-sub">BPM</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="whoopHRChart"></canvas></div>
  </div>
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr"><span class="chart-title">RR tachogram</span><span class="chart-sub">Beat-to-beat · ms</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="whoopRRChart"></canvas></div>
  </div>
</div>
<div class="charts-row">
  <div class="chart-card" style="flex:1.4">
    <div class="chart-hdr"><span class="chart-title">Rolling RMSSD</span><span class="chart-sub">30-beat window</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="whoopRMSSDChart"></canvas></div>
    <div class="band-legend">
      <span class="bl-item" style="--c:#2db891">RMSSD (ms)</span>
      <span class="bl-item" style="--c:rgba(255,140,60,0.55)">— Baseline</span>
    </div>
  </div>
  <div class="chart-card" style="flex:0.6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem">
    <div class="chart-hdr" style="text-align:center;width:100%">
      <span class="chart-title">Coherence</span><span class="chart-sub">LF power ratio</span>
    </div>
    <canvas id="whoopGauge" width="180" height="180"></canvas>
    <div class="hrv-state-badge" id="whoopStateBadge">Waiting for data</div>
  </div>
</div>
<div class="controls-row">
  <section class="ctrl-card">
    <div class="ctrl-title">Background music</div>
    <div class="sound-options">
      <label class="sound-opt"><input type="radio" name="sound" value="none" checked /> None</label>
      <label class="sound-opt"><input type="radio" name="sound" value="waves" /> Ocean waves</label>
      <label class="sound-opt"><input type="radio" name="sound" value="brook" /> Babbling brook</label>
      <label class="sound-opt"><input type="radio" name="sound" value="gong" /> Tibetan gong</label>
      <label class="sound-opt"><input type="radio" name="sound" value="generative" /> Generative ambient <span class="badge-new">live</span></label>
      <label class="sound-opt"><input type="radio" name="sound" value="upload" /> Upload file</label>
    </div>
    <div class="upload-row" id="uploadRow" style="display:none">
      <input type="file" id="audioUpload" accept=".wav,.mp3" style="display:none" />
      <button class="btn-sm" id="audioUploadBtn">Choose WAV / MP3…</button>
      <span class="upload-name" id="uploadName">No file</span>
    </div>
    <div class="volume-row">
      <label class="vol-lbl">Volume</label>
      <input type="range" id="masterVolume" min="0" max="1" step="0.01" value="0.5" />
      <span class="vol-val" id="volVal">50%</span>
    </div>
  </section>
  <section class="ctrl-card">
    <div class="ctrl-title">Feedback</div>
    <label class="fb-chk"><input type="checkbox" id="fbVolume" checked />
      <div class="fb-chk-body"><span class="fb-chk-title">Adaptive volume</span>
        <span class="fb-chk-sub">Softens when RMSSD rises above baseline</span></div></label>
    <label class="fb-chk"><input type="checkbox" id="fbBeep" checked />
      <div class="fb-chk-body"><span class="fb-chk-title">Periodic tone</span>
        <span class="fb-chk-sub">660 Hz above baseline · 330 Hz below</span></div></label>
    <div class="fb-sub-row">
      <label class="vol-lbl">Interval</label>
      <input type="range" id="beepInterval" min="10" max="60" step="5" value="30" />
      <span class="vol-val" id="beepIntervalVal">30 s</span>
    </div>
    <label class="fb-chk"><input type="checkbox" id="fbCoherence" checked />
      <div class="fb-chk-body"><span class="fb-chk-title">Coherence chime</span>
        <span class="fb-chk-sub">Soft chime when RMSSD crosses above baseline</span></div></label>
    <label class="fb-chk"><input type="checkbox" id="fbEndAlarm" checked />
      <div class="fb-chk-body"><span class="fb-chk-title">Session end alarm</span>
        <span class="fb-chk-sub">Gentle ascending chime when session completes</span></div></label>
  </section>
</div>
<!-- End overlay -->
<div class="end-overlay" id="whoopEndOverlay" style="display:none">
  <div class="end-card">
    <h2 class="end-title">Session complete</h2>
    <div class="end-stats" id="whoopSummary"></div>
    <button class="btn-primary end-close" id="whoopEndClose">Done</button>
  </div>
</div>`;

  /* ── Mount / Unmount ─────────────────────────────────────────── */
  function mount() {
    if (_mounted) return;
    _mounted = true;
    document.getElementById('modePanel').innerHTML = TEMPLATE;
    Object.assign(charts, HrvLib.initCharts({
      hrId:'whoopHRChart', rrId:'whoopRRChart', rmssdId:'whoopRMSSDChart', maxPts: MAX_PTS
    }));
    AudioPanel.init(() => sessionActive);
    WsClient.setOnFrame(_onWsFrame);

    _el('whoopBaselineBtn').addEventListener('click', () => {
      if (!WsClient.isConnected() && !BleClient.isConnected()) {
        alert('Connect to WHOOP (BLE or bridge) first.'); return;
      }
      baselinePhase = true; rrBuffer = [];
      _el('whoopStartBtn').disabled = true;
      _el('whoopStatStatus').textContent = 'Calibrating…';
    });
    _el('whoopStartBtn').addEventListener('click', _startSession);
    _el('whoopStopBtn').addEventListener('click',  _endSession);
    _el('whoopEndClose')?.addEventListener('click', () => {
      _el('whoopEndOverlay').style.display = 'none';
    });
    _el('beepInterval')?.addEventListener('input', e => {
      _el('beepIntervalVal').textContent = e.target.value+' s';
    });
  }

  function unmount() {
    if (!_mounted) return;
    _mounted = false;
    if (sessionActive) _endSession();
    WsClient.setOnFrame(null);
    BleClient.disconnect();
    HrvLib.destroyCharts(charts);
    document.getElementById('modePanel').innerHTML = '';
    rrBuffer = [];
    Object.keys(hist).forEach(k => { hist[k] = []; });
    baselineRMSSD = null;
  }

  // Expose BLE data handler so app.js can wire it after BLE connects
  return { mount, unmount, onHRData: _onHRData };
})();
