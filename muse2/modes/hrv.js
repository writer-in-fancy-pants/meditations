/**
 * muse2/modes/hrv.js — HRV mode for Muse 2
 * Uses PPG data from muselsl (type:"ppg", ppg_bvp:[]) at 64 Hz.
 * Also accepts pre-computed RR frames (type:"rr", bpm, rr_ms:[]).
 * All HRV math and charting delegates to ../../lib/hrv.js (HrvLib).
 * Depends on: HrvLib, Audio, AudioPanel, ChartUtils, WsClient (globals)
 */

'use strict';

const HRV = (() => {

  const PPG_FS             = 64;
  const PEAK_MIN_DIST_S    = 0.30;
  const PEAK_MIN_SAMPLES   = Math.floor(PPG_FS * PEAK_MIN_DIST_S);
  const BASELINE_BEATS     = 120;
  const MAX_PTS            = 300;

  /* ── State ──────────────────────────────────────────────────── */
  let _mounted       = false;
  let sessionActive  = false;
  let baselinePhase  = false;
  let rrBuffer       = [];
  let ppgBuffer      = [];
  let lastPeakIdx    = -1;
  let baselineRMSSD  = null;
  let elapsedSec     = 0;
  let timerInterval  = null;
  let lastCoherence  = false;
  const hist  = HrvLib.makeHist();
  const charts = {};

  /* ── PPG peak detector ───────────────────────────────────────── */
  function _detectPeaks(newSamples) {
    const found = [];
    ppgBuffer.push(...newSamples);
    const maxBuf = PPG_FS * 10;
    if (ppgBuffer.length > maxBuf) {
      const trim = ppgBuffer.length - maxBuf;
      ppgBuffer.splice(0, trim);
      if (lastPeakIdx >= 0) lastPeakIdx -= trim;
    }
    const N = ppgBuffer.length;
    const start = lastPeakIdx < 0 ? 1 : lastPeakIdx + PEAK_MIN_SAMPLES;
    for (let i = Math.max(1, start); i < N - 1; i++) {
      const prev = ppgBuffer[i-1], curr = ppgBuffer[i], next = ppgBuffer[i+1];
      if (curr <= prev || curr < next) continue;
      const win = ppgBuffer.slice(Math.max(0, i - PPG_FS*2), i+1);
      const mn = Math.min(...win), mx = Math.max(...win);
      const rng = mx - mn;
      if (rng < 1e-6 || (curr - mn) < 0.3 * rng) continue;
      if (lastPeakIdx >= 0) {
        const rr = ((i - lastPeakIdx) / PPG_FS) * 1000;
        if (rr >= 300 && rr <= 2000) found.push(Math.round(rr));
      }
      lastPeakIdx = i;
    }
    return found;
  }

  /* ── Frame handler ───────────────────────────────────────────── */
  function _onFrame(frame) {
    if (!_mounted) return;
    let bpm = null, newRR = [];

    if (frame.type === 'ppg' && Array.isArray(frame.ppg_bvp)) {
      newRR = _detectPeaks(frame.ppg_bvp);
      if (newRR.length) bpm = Math.round(60000 / (newRR.reduce((a,b)=>a+b,0)/newRR.length));
    } else if (Array.isArray(frame.rr_ms) && frame.rr_ms.length) {
      newRR = frame.rr_ms;
      bpm   = frame.bpm ?? null;
    }

    if (!newRR.length) return;
    rrBuffer.push(...newRR);

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
    HrvLib.pushHist(hist, { label, hr: bpm, rr: newRR[0]??null, rv }, MAX_PTS);
    HrvLib.updateCharts(charts, hist, baselineRMSSD);
    HrvLib.drawGauge('hrvGauge', ci, rv, baselineRMSSD);
    HrvLib.updateStateBadge('hrvStateBadge', rv, baselineRMSSD);

    if (bpm !== null) _el('hrvStatHR').innerHTML  = `${bpm}<span class="stat-unit">bpm</span>`;
    if (rv  !== null) _el('hrvStatRMSSD').innerHTML= `${rv.toFixed(1)}<span class="stat-unit">ms</span>`;
    if (pv  !== null) _el('hrvStatPNN50').innerHTML= `${pv.toFixed(1)}<span class="stat-unit">%</span>`;

    const highCoh = rv !== null && baselineRMSSD !== null && rv > baselineRMSSD;
    if (highCoh && !lastCoherence && _el('fbCoherence')?.checked && sessionActive)
      Audio.coherenceChime();
    lastCoherence = highCoh;

    if (sessionActive && _el('fbVolume')?.checked && rv !== null && baselineRMSSD !== null)
      Audio.adaptVolume(rv, baselineRMSSD, AudioPanel.targetVolume);
  }

  function _finishBaseline() {
    baselinePhase = false;
    baselineRMSSD = HrvLib.computeBaseline(rrBuffer, 60);
    _el('hrvStatBaseline').textContent = baselineRMSSD ? baselineRMSSD.toFixed(1)+' ms' : '—';
    _el('hrvStatStatus').textContent   = 'Baseline done';
    _el('hrvStartBtn').disabled        = false;
    rrBuffer = [];
  }

  /* ── Session ─────────────────────────────────────────────────── */
  function _startSession() {
    sessionActive = true; elapsedSec = 0;
    _el('hrvStatStatus').textContent  = 'Training';
    _el('hrvStartBtn').disabled       = true;
    _el('hrvStopBtn').disabled        = false;
    _el('hrvBaselineBtn').disabled    = true;
    AudioPanel.startSelectedSound();
    if (_el('fbBeep')?.checked)
      Audio.scheduleBeep(+(_el('beepInterval')?.value||30),
        () => ({ score: HrvLib.rmssd(rrBuffer.slice(-HrvLib.RR_WINDOW))??0,
                 threshold: baselineRMSSD??1 }),
        () => sessionActive);
    timerInterval = setInterval(() => {
      elapsedSec++;
      _el('hrvStatElapsed').textContent =
        String(Math.floor(elapsedSec/60))+':'+String(elapsedSec%60).padStart(2,'0');
    }, 1000);
  }

  function _stopSession() {
    sessionActive = false;
    clearInterval(timerInterval);
    Audio.cancelBeep();
    Audio.stopSound();
    _el('hrvStatStatus').textContent = 'Stopped';
    _el('hrvStartBtn').disabled      = false;
    _el('hrvStopBtn').disabled       = true;
    _el('hrvBaselineBtn').disabled   = false;
  }

  function _el(id) { return document.getElementById(id); }

  /* ── Template ────────────────────────────────────────────────── */
  const TEMPLATE = `
<section class="section-card">
  <div class="section-hdr">
    <span class="section-title">HRV Session (Muse 2 PPG)</span>
    <div class="session-actions">
      <button class="btn-sm" id="hrvBaselineBtn">Calibrate baseline (2 min)</button>
      <button class="btn-sm btn-accent" id="hrvStartBtn">Start training</button>
      <button class="btn-sm btn-danger" id="hrvStopBtn" disabled>Stop</button>
    </div>
  </div>
  <p class="ctrl-desc" style="margin-bottom:.5rem">
    Requires <code>python ppg_bridge.py</code> (Muse 2 PPG at 64 Hz).
    Also accepts WHOOP-compatible <code>{ rr_ms, bpm }</code> frames.
  </p>
  <div class="stat-row">
    <div class="stat"><span class="stat-lbl">Status</span><span class="stat-val" id="hrvStatStatus">Idle</span></div>
    <div class="stat"><span class="stat-lbl">Elapsed</span><span class="stat-val" id="hrvStatElapsed">0:00</span></div>
    <div class="stat"><span class="stat-lbl">Heart rate</span><span class="stat-val" id="hrvStatHR">—</span></div>
    <div class="stat"><span class="stat-lbl">RMSSD</span><span class="stat-val" id="hrvStatRMSSD">—</span></div>
    <div class="stat"><span class="stat-lbl">pNN50</span><span class="stat-val" id="hrvStatPNN50">—</span></div>
    <div class="stat"><span class="stat-lbl">Baseline</span><span class="stat-val" id="hrvStatBaseline">—</span></div>
  </div>
</section>
<div class="charts-row">
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr"><span class="chart-title">Heart rate</span><span class="chart-sub">BPM · live</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="hrvHRChart"></canvas></div>
  </div>
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr"><span class="chart-title">RR tachogram</span><span class="chart-sub">Beat-to-beat · ms</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="hrvRRChart"></canvas></div>
  </div>
</div>
<div class="charts-row">
  <div class="chart-card" style="flex:1.4">
    <div class="chart-hdr"><span class="chart-title">Rolling RMSSD</span><span class="chart-sub">30-beat window</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="hrvRMSSDChart"></canvas></div>
    <div class="band-legend">
      <span class="bl-item" style="--c:#2db891">RMSSD (ms)</span>
      <span class="bl-item" style="--c:rgba(255,140,60,0.55)">— Baseline</span>
    </div>
  </div>
  <div class="chart-card" style="flex:0.6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem">
    <div class="chart-hdr" style="text-align:center;width:100%">
      <span class="chart-title">Coherence</span><span class="chart-sub">LF power ratio</span>
    </div>
    <canvas id="hrvGauge" width="180" height="180"></canvas>
    <div class="hrv-state-badge" id="hrvStateBadge">Waiting for data</div>
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
  </section>
</div>`;

  /* ── Mount / Unmount ─────────────────────────────────────────── */
  function mount() {
    if (_mounted) return;
    _mounted = true;
    document.getElementById('modePanel').innerHTML = TEMPLATE;
    Object.assign(charts, HrvLib.initCharts({ hrId:'hrvHRChart', rrId:'hrvRRChart', rmssdId:'hrvRMSSDChart', maxPts: MAX_PTS }));
    AudioPanel.init(() => sessionActive);
    WsClient.setOnFrame(_onFrame);
    _el('hrvBaselineBtn').addEventListener('click', () => {
      if (!WsClient.isConnected()) { alert('Connect to ppg_bridge first.'); return; }
      baselinePhase = true; rrBuffer = [];
      _el('hrvStartBtn').disabled = true;
      _el('hrvStatStatus').textContent = 'Calibrating…';
    });
    _el('hrvStartBtn').addEventListener('click', _startSession);
    _el('hrvStopBtn').addEventListener('click',  _stopSession);
    _el('beepInterval')?.addEventListener('input', e => {
      _el('beepIntervalVal').textContent = e.target.value+' s';
    });
  }

  function unmount() {
    if (!_mounted) return;
    _mounted = false;
    if (sessionActive) _stopSession();
    WsClient.setOnFrame(null);
    HrvLib.destroyCharts(charts);
    document.getElementById('modePanel').innerHTML = '';
    rrBuffer = []; ppgBuffer = []; lastPeakIdx = -1;
    Object.keys(hist).forEach(k => { hist[k] = []; });
    baselineRMSSD = null;
  }

  return { mount, unmount };
})();
