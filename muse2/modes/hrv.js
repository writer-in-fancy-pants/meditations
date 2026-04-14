/**
 * modes/hrv.js — HRV neurofeedback mode
 * Reads PPG data from Muse 2 via the muselsl bridge.
 * Bridge must emit frames with type:"ppg" and field ppg_bvp (raw BVP signal array).
 * RR intervals are derived from peak detection on the BVP waveform.
 * Computes RMSSD, pNN50, and a coherence index; drives the same feedback
 * mechanisms as the WHOOP HRV tool (Audio.adaptVolume, coherenceChime, etc.)
 *
 * Muse 2 PPG spec: ~64 Hz BVP signal on channel ppg_bvp
 * Bridge frame:    { type:"ppg", ppg_bvp:[...], ts:number }
 * Also accepts pre-computed RR frames: { type:"rr", bpm:number, rr_ms:[...] }
 * (for compatibility with the WHOOP simulator and bridge.py)
 *
 * Depends on: Audio, AudioPanel, ChartUtils, WsClient (globals from lib/)
 *
 * Public API:
 *   HRV.mount()
 *   HRV.unmount()
 */

'use strict';

const HRV = (() => {
  /* ── Constants ──────────────────────────────────────────────────── */
  const PPG_FS          = 64;          // Muse 2 PPG sample rate (Hz)
  const RR_WINDOW       = 30;          // beats for rolling RMSSD
  const BASELINE_BEATS  = 120;         // ~2 min at 60 bpm
  const COHERENCE_WIN   = 60;          // beats for coherence DFT
  const MAX_CHART_PTS   = 300;

  // Peak detector: min peak distance 300ms, min prominence as fraction of recent range
  const PEAK_MIN_DIST_S  = 0.3;
  const PEAK_MIN_DIST_SAMPLES = Math.floor(PPG_FS * PEAK_MIN_DIST_S);

  /* ── State ──────────────────────────────────────────────────────── */
  let sessionActive  = false;
  let baselinePhase  = false;
  let rrBuffer       = [];             // all RR intervals this session (ms)
  let ppgBuffer      = [];             // raw BVP ring buffer for peak detection
  let lastPeakIdx    = -1;             // sample index of last detected peak
  let sampleCount    = 0;             // total samples received
  let baselineRMSSD  = null;
  let elapsedSec     = 0;
  let timerInterval  = null;
  let lastCoherence  = false;
  let _mounted       = false;

  const hist = { labels:[], hr:[], rr:[], rmssd:[], t0:null };
  const charts = { hr:null, rr:null, rmssd:null };

  /* ── HRV math ───────────────────────────────────────────────────── */

  function _rmssd(rr) {
    if (rr.length < 2) return null;
    let sum = 0;
    for (let i = 1; i < rr.length; i++) { const d = rr[i]-rr[i-1]; sum += d*d; }
    return Math.sqrt(sum / (rr.length-1));
  }

  function _pnn50(rr) {
    if (rr.length < 2) return null;
    let n = 0;
    for (let i = 1; i < rr.length; i++) if (Math.abs(rr[i]-rr[i-1]) > 50) n++;
    return (n / (rr.length-1)) * 100;
  }

  function _coherence(rr) {
    const seg = rr.slice(-Math.min(rr.length, COHERENCE_WIN));
    if (seg.length < 20) return 0;
    const meanRR   = seg.reduce((a,b)=>a+b,0)/seg.length/1000;
    const fs       = 1/meanRR;
    const N        = seg.length;
    let total=0, lf=0;
    for (let k = 0; k < N/2; k++) {
      let re=0, im=0;
      for (let n = 0; n < N; n++) {
        const a = -2*Math.PI*k*n/N;
        re += seg[n]*Math.cos(a); im += seg[n]*Math.sin(a);
      }
      const pow  = (re*re+im*im)/N;
      const freq = k*fs/N;
      total += pow;
      if (freq >= 0.04 && freq <= 0.15) lf += pow;
    }
    return total > 0 ? Math.min(lf/total, 1) : 0;
  }

  /* ── PPG peak detector ─────────────────────────────────────────── */
  // Simple derivative-zero-crossing peak detector on the BVP signal.
  // Muse 2 BVP is the derivative of the PPG, so peaks in BVP ~= R-peaks.

  function _detectPeaks(newSamples) {
    const detected = [];
    for (const s of newSamples) {
      ppgBuffer.push(s);
      sampleCount++;
    }
    // Keep buffer manageable (10 s window)
    const maxBuf = PPG_FS * 10;
    if (ppgBuffer.length > maxBuf) {
      const trimBy = ppgBuffer.length - maxBuf;
      ppgBuffer.splice(0, trimBy);
      if (lastPeakIdx >= 0) lastPeakIdx -= trimBy;
    }

    const N = ppgBuffer.length;
    // Look for peaks starting after the last detected one + min distance
    const startIdx = lastPeakIdx < 0 ? 1 : lastPeakIdx + PEAK_MIN_DIST_SAMPLES;
    for (let i = Math.max(1, startIdx); i < N-1; i++) {
      const prev = ppgBuffer[i-1], curr = ppgBuffer[i], next = ppgBuffer[i+1];
      if (curr > prev && curr >= next) {
        // Amplitude threshold: must exceed 0.3 × recent range
        const recent = ppgBuffer.slice(Math.max(0, i-PPG_FS*2), i+1);
        const mn = Math.min(...recent), mx = Math.max(...recent);
        const range = mx - mn;
        if (range > 0 && (curr - mn) > 0.3 * range) {
          if (lastPeakIdx >= 0) {
            const rrMs = ((i - lastPeakIdx) / PPG_FS) * 1000;
            if (rrMs >= 300 && rrMs <= 2000) detected.push(Math.round(rrMs));
          }
          lastPeakIdx = i;
        }
      }
    }
    return detected;
  }

  /* ── Frame handler ──────────────────────────────────────────────── */

  function _onFrame(frame) {
    if (!_mounted) return;

    let bpm = null, newRR = [];

    if (frame.type === 'ppg' && Array.isArray(frame.ppg_bvp)) {
      newRR = _detectPeaks(frame.ppg_bvp);
      if (newRR.length) bpm = Math.round(60000 / (newRR.reduce((a,b)=>a+b,0)/newRR.length));
    } else if ((frame.type === 'rr' || frame.bpm !== undefined) && Array.isArray(frame.rr_ms)) {
      // WHOOP-compatible frame (from bridge.py / whoop_simulator.py)
      newRR = frame.rr_ms;
      bpm   = frame.bpm;
    }

    if (!newRR.length) return;

    rrBuffer.push(...newRR);

    // Baseline collection
    if (baselinePhase) {
      const pct = Math.min(rrBuffer.length / BASELINE_BEATS, 1);
      _el('hrvStatStatus').textContent = `Calibrating… ${Math.round(pct*100)}%`;
      if (rrBuffer.length >= BASELINE_BEATS) _finishBaseline();
      return;
    }

    const window = rrBuffer.slice(-RR_WINDOW);
    const rv     = _rmssd(window);
    const pv     = _pnn50(window);
    const ci     = _coherence(rrBuffer);
    const hr     = bpm ?? (rv ? Math.round(60000/(rrBuffer.slice(-1)[0]||800)) : null);
    const label  = sessionActive && hist.t0 ? String(Math.floor((Date.now()-hist.t0)/1000)) : '';

    const P = MAX_CHART_PTS;
    ChartUtils.rollingPush(hist.labels, label,          P);
    ChartUtils.rollingPush(hist.hr,     hr??null,       P);
    ChartUtils.rollingPush(hist.rr,     newRR[0]??null, P);
    ChartUtils.rollingPush(hist.rmssd,  rv,             P);

    _updateCharts(rv);
    _drawGauge(ci, rv);

    // Stats
    if (hr  !== null) _el('hrvStatHR').innerHTML  = `${hr}<span class="stat-unit">bpm</span>`;
    if (rv  !== null) _el('hrvStatRMSSD').innerHTML= `${rv.toFixed(1)}<span class="stat-unit">ms</span>`;
    if (pv  !== null) _el('hrvStatPNN50').innerHTML= `${pv.toFixed(1)}<span class="stat-unit">%</span>`;

    // Coherence chime
    const highCoh = rv !== null && baselineRMSSD !== null && rv > baselineRMSSD;
    if (highCoh && !lastCoherence && _el('fbCoherence')?.checked && sessionActive) {
      Audio.coherenceChime();
    }
    lastCoherence = highCoh;

    // Adaptive volume
    if (sessionActive && _el('fbVolume')?.checked && rv !== null && baselineRMSSD !== null) {
      Audio.adaptVolume(rv, baselineRMSSD, AudioPanel.targetVolume);
    }
  }

  function _finishBaseline() {
    baselinePhase = false;
    const rv = _rmssd(rrBuffer);
    baselineRMSSD = rv;
    _el('hrvStatBaseline').textContent = rv ? rv.toFixed(1)+' ms' : '—';
    _el('hrvStatStatus').textContent   = 'Baseline done';
    _el('hrvStartBtn').disabled        = false;
    rrBuffer = [];
  }

  /* ── Gauge canvas ───────────────────────────────────────────────── */

  function _drawGauge(coherence, rv) {
    const canvas = _el('hrvGauge');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w=canvas.width, h=canvas.height, cx=w/2, cy=h/2+10, r=70;
    ctx.clearRect(0,0,w,h);
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const trackCol = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
    ctx.beginPath(); ctx.arc(cx,cy,r,Math.PI,0);
    ctx.strokeStyle=trackCol; ctx.lineWidth=12; ctx.lineCap='round'; ctx.stroke();

    const arcColor = coherence>0.55 ? (isDark?'#2db891':'#1a9e75')
                   : coherence>0.3  ? (isDark?'#d0901a':'#b07010')
                   :                  (isDark?'#e05050':'#c03030');
    ctx.beginPath(); ctx.arc(cx,cy,r,Math.PI,Math.PI+coherence*Math.PI);
    ctx.strokeStyle=arcColor; ctx.lineWidth=12; ctx.lineCap='round'; ctx.stroke();

    const na = Math.PI+coherence*Math.PI;
    ctx.beginPath(); ctx.moveTo(cx,cy);
    ctx.lineTo(cx+(r-8)*Math.cos(na), cy+(r-8)*Math.sin(na));
    ctx.strokeStyle=isDark?'#e8eaf0':'#111827'; ctx.lineWidth=2; ctx.lineCap='round'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2);
    ctx.fillStyle=isDark?'#e8eaf0':'#111827'; ctx.fill();

    ctx.font='10px monospace'; ctx.fillStyle=isDark?'#555d78':'#9ca3af';
    ctx.textAlign='left';  ctx.fillText('low',  cx-r-2, cy+18);
    ctx.textAlign='right'; ctx.fillText('high', cx+r+2, cy+18);
    ctx.textAlign='center'; ctx.font='13px monospace';
    ctx.fillStyle=isDark?'#e8eaf0':'#111827';
    ctx.fillText((coherence*100).toFixed(0)+'%', cx, cy-r+18);

    const pv = _pnn50(rrBuffer.slice(-RR_WINDOW));
    const badge = _el('hrvStateBadge');
    if (badge) {
      if (rv !== null && baselineRMSSD !== null) {
        if (rv >= baselineRMSSD*1.1)  { badge.textContent='High coherence ↑'; badge.className='hrv-state-badge good'; }
        else if (rv < baselineRMSSD*0.85) { badge.textContent='Below baseline ↓'; badge.className='hrv-state-badge low'; }
        else                           { badge.textContent='Near baseline →';   badge.className='hrv-state-badge'; }
      }
    }
  }

  /* ── Charts ─────────────────────────────────────────────────────── */

  function _initCharts() {
    const cc    = ChartUtils.colors();
    const empty = () => Array(MAX_CHART_PTS).fill(null);
    const intCb = v => Math.round(v);

    charts.hr = new Chart(_el('hrvHRChart'), {
      type:'line',
      data:{ labels:empty(), datasets:[ChartUtils.makeDataset('HR','#e07050',empty())] },
      options:{ responsive:true, maintainAspectRatio:false, animation:false,
        plugins:{legend:{display:false}},
        scales:{ x:ChartUtils.scaleX(cc), y:ChartUtils.scaleY(cc,'BPM',intCb) } },
    });

    charts.rr = new Chart(_el('hrvRRChart'), {
      type:'line',
      data:{ labels:empty(), datasets:[ChartUtils.makeDataset('RR','#7c75e0',empty())] },
      options:{ responsive:true, maintainAspectRatio:false, animation:false,
        plugins:{legend:{display:false}},
        scales:{ x:ChartUtils.scaleX(cc), y:ChartUtils.scaleY(cc,'ms',intCb) } },
    });

    charts.rmssd = new Chart(_el('hrvRMSSDChart'), {
      type:'line',
      data:{ labels:empty(), datasets:[
        ChartUtils.makeDataset('RMSSD','#2db891',empty()),
        ChartUtils.makeDataset('Baseline','rgba(255,140,60,0.55)',empty(),'y',{borderDash:[5,4],spanGaps:false,backgroundColor:'transparent'}),
      ]},
      options:{ responsive:true, maintainAspectRatio:false, animation:false,
        plugins:{legend:{display:false}},
        scales:{ x:ChartUtils.scaleX(cc), y:ChartUtils.scaleY(cc,'RMSSD (ms)',intCb) } },
    });
  }

  function _updateCharts(rv) {
    const L = [...hist.labels];
    charts.hr.data.labels=L; charts.hr.data.datasets[0].data=[...hist.hr]; charts.hr.update('none');
    charts.rr.data.labels=L; charts.rr.data.datasets[0].data=[...hist.rr]; charts.rr.update('none');
    charts.rmssd.data.labels=L;
    charts.rmssd.data.datasets[0].data=[...hist.rmssd];
    charts.rmssd.data.datasets[1].data=new Array(L.length).fill(baselineRMSSD);
    charts.rmssd.update('none');
  }

  /* ── Session control ────────────────────────────────────────────── */

  function _startSession() {
    sessionActive=true; hist.t0=Date.now(); elapsedSec=0;
    _el('hrvStatStatus').textContent='Training';
    _el('hrvStartBtn').disabled=true;
    _el('hrvStopBtn').disabled=false;
    _el('hrvBaselineBtn').disabled=true;
    AudioPanel.startSelectedSound();
    const beepSec = +(_el('beepInterval')?.value||30);
    if (_el('fbBeep')?.checked) {
      Audio.scheduleBeep(beepSec,
        () => ({ score: _rmssd(rrBuffer.slice(-RR_WINDOW))??0, threshold: baselineRMSSD??1 }),
        () => sessionActive);
    }
    timerInterval = setInterval(()=>{
      elapsedSec++;
      _el('hrvStatElapsed').textContent =
        String(Math.floor(elapsedSec/60))+':'+String(elapsedSec%60).padStart(2,'0');
    },1000);
  }

  function _stopSession() {
    sessionActive=false;
    clearInterval(timerInterval);
    Audio.cancelBeep();
    Audio.stopSound();
    _el('hrvStatStatus').textContent='Stopped';
    _el('hrvStartBtn').disabled=false;
    _el('hrvStopBtn').disabled=true;
    _el('hrvBaselineBtn').disabled=false;
  }

  function _el(id) { return document.getElementById(id); }

  /* ── HTML template ──────────────────────────────────────────────── */

  const TEMPLATE = `
<section class="section-card">
  <div class="section-hdr">
    <span class="section-title">HRV Session</span>
    <div class="session-actions">
      <button class="btn-sm" id="hrvBaselineBtn">Calibrate baseline (2 min)</button>
      <button class="btn-sm btn-accent" id="hrvStartBtn">Start training</button>
      <button class="btn-sm btn-danger" id="hrvStopBtn" disabled>Stop</button>
    </div>
  </div>
  <p class="ctrl-desc" style="margin-bottom:.5rem">
    Uses Muse 2 PPG (BVP channel) at 64 Hz. Also accepts WHOOP-compatible
    <code>{ type:"rr", bpm, rr_ms }</code> frames from bridge.py or whoop_simulator.py.
  </p>
  <div class="stat-row">
    <div class="stat"><span class="stat-lbl">Status</span><span class="stat-val" id="hrvStatStatus">Idle</span></div>
    <div class="stat"><span class="stat-lbl">Elapsed</span><span class="stat-val" id="hrvStatElapsed">0:00</span></div>
    <div class="stat"><span class="stat-lbl">Heart rate</span><span class="stat-val" id="hrvStatHR">—</span></div>
    <div class="stat"><span class="stat-lbl">RMSSD</span><span class="stat-val" id="hrvStatRMSSD">—</span></div>
    <div class="stat"><span class="stat-lbl">pNN50</span><span class="stat-val" id="hrvStatPNN50">—</span></div>
    <div class="stat"><span class="stat-lbl">Baseline RMSSD</span><span class="stat-val" id="hrvStatBaseline">—</span></div>
  </div>
</section>

<div class="charts-row">
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr"><span class="chart-title">Heart rate</span><span class="chart-sub">BPM · live</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="hrvHRChart"></canvas></div>
  </div>
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr"><span class="chart-title">RR tachogram</span><span class="chart-sub">Beat-to-beat interval · ms</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="hrvRRChart"></canvas></div>
  </div>
</div>

<div class="charts-row">
  <div class="chart-card" style="flex:1.4">
    <div class="chart-hdr"><span class="chart-title">HRV — rolling RMSSD</span><span class="chart-sub">30-beat window · ms · parasympathetic tone</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="hrvRMSSDChart"></canvas></div>
    <div class="band-legend">
      <span class="bl-item" style="--c:#2db891">RMSSD (ms)</span>
      <span class="bl-item" style="--c:rgba(255,140,60,0.55)">— Baseline</span>
    </div>
  </div>
  <div class="chart-card" style="flex:0.6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem">
    <div class="chart-hdr" style="text-align:center;width:100%">
      <span class="chart-title">HRV coherence</span>
      <span class="chart-sub">LF power ratio · 0.04–0.15 Hz</span>
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
    <div class="ctrl-title">Feedback options</div>
    <label class="fb-chk"><input type="checkbox" id="fbVolume" checked />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Adaptive volume</span>
        <span class="fb-chk-sub">Softens when RMSSD rises above baseline — deepens parasympathetic state</span>
      </div>
    </label>
    <label class="fb-chk"><input type="checkbox" id="fbBeep" checked />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Periodic tone</span>
        <span class="fb-chk-sub">660 Hz when RMSSD ≥ baseline · 330 Hz when below</span>
      </div>
    </label>
    <div class="fb-sub-row">
      <label class="vol-lbl">Interval</label>
      <input type="range" id="beepInterval" min="10" max="60" step="5" value="30" />
      <span class="vol-val" id="beepIntervalVal">30 s</span>
    </div>
    <label class="fb-chk"><input type="checkbox" id="fbCoherence" checked />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Coherence chime</span>
        <span class="fb-chk-sub">Soft chime when RMSSD crosses above baseline</span>
      </div>
    </label>
  </section>

  <section class="ctrl-card">
    <div class="ctrl-title">Breathing pacer</div>
    <p class="ctrl-desc">Resonant frequency breathing — 5–6 breaths/min maximises HRV coherence.</p>
    <label class="fb-chk"><input type="checkbox" id="hrvBreathPacer" />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Enable breathing cues</span>
        <span class="fb-chk-sub">Audible inhale/exhale tones at target rate</span>
      </div>
    </label>
    <div class="fb-sub-row">
      <label class="vol-lbl">Rate</label>
      <input type="range" id="hrvBreathRate" min="4" max="8" step="0.5" value="5.5" />
      <span class="vol-val" id="hrvBreathRateVal">5.5 /min</span>
    </div>
    <div id="hrvBreathVis" style="display:none;flex-direction:column;align-items:center;gap:5px;margin-top:.5rem">
      <div style="width:100%;height:6px;border-radius:3px;background:var(--border-subtle);overflow:hidden">
        <div id="hrvBreathBar" style="height:100%;background:var(--accent);border-radius:3px;width:0%;transition:width linear"></div>
      </div>
      <span id="hrvBreathLabel" style="font-size:11px;color:var(--accent);font-family:var(--font-mono)">Inhale</span>
    </div>
  </section>
</div>`;

  /* ── Breathing pacer ─────────────────────────────────────────────── */
  let _breathTimer = null, _breathPhase = 'in', _breathStart = 0;

  function _startBreath() {
    const rate = +(_el('hrvBreathRate')?.value || 5.5);
    const cycle = 60/rate, durIn = cycle*0.4, durOut = cycle*0.6;
    _breathPhase='in'; _breathStart=Date.now();
    _el('hrvBreathVis').style.display='flex';
    Audio.playTone(440, 100, 0.04);

    _breathTimer = setInterval(() => {
      const elapsed = (Date.now()-_breathStart)/1000;
      let bar, label;
      if (_breathPhase==='in') {
        bar = Math.min(elapsed/durIn,1)*100;
        label = `Inhale (${Math.max(durIn-elapsed,0).toFixed(1)}s)`;
        if (elapsed>=durIn) { _breathPhase='out'; _breathStart=Date.now(); Audio.playTone(330,100,0.04); }
      } else {
        bar = (1-Math.min(elapsed/durOut,1))*100;
        label = `Exhale (${Math.max(durOut-elapsed,0).toFixed(1)}s)`;
        if (elapsed>=durOut) { _breathPhase='in'; _breathStart=Date.now(); Audio.playTone(440,100,0.04); }
      }
      const barEl = _el('hrvBreathBar');
      if (barEl) barEl.style.width = bar.toFixed(1)+'%';
      const lblEl = _el('hrvBreathLabel');
      if (lblEl) lblEl.textContent = label;
    }, 80);
  }

  function _stopBreath() {
    clearInterval(_breathTimer);
    const vis = _el('hrvBreathVis');
    if (vis) vis.style.display='none';
  }

  /* ── Mount / unmount ────────────────────────────────────────────── */

  function mount() {
    if (_mounted) return;
    _mounted = true;

    document.getElementById('modePanel').innerHTML = TEMPLATE;
    _initCharts();
    AudioPanel.init(() => sessionActive);
    // Register this mode's frame handler with the shared WsClient singleton.
    WsClient.setOnFrame(_onFrame);

    _el('hrvBaselineBtn').addEventListener('click', () => {
      if (!WsClient.isConnected()) { alert('Connect to the bridge first.'); return; }
      baselinePhase=true; rrBuffer=[];
      _el('hrvStartBtn').disabled=true;
      _el('hrvStatStatus').textContent='Calibrating…';
    });
    _el('hrvStartBtn').addEventListener('click', _startSession);
    _el('hrvStopBtn').addEventListener('click',  _stopSession);

    _el('beepInterval')?.addEventListener('input', e => {
      _el('beepIntervalVal').textContent = e.target.value+' s';
    });
    _el('hrvBreathRate')?.addEventListener('input', e => {
      _el('hrvBreathRateVal').textContent = (+e.target.value).toFixed(1)+' /min';
    });
    _el('hrvBreathPacer')?.addEventListener('change', () => {
      _el('hrvBreathPacer').checked ? _startBreath() : _stopBreath();
    });
  }

  function unmount() {
    if (!_mounted) return;
    _mounted = false;
    if (sessionActive) _stopSession();
    _stopBreath();
    ChartUtils.destroyAll(charts);
    document.getElementById('modePanel').innerHTML='';
    WsClient.setOnFrame(null);
    rrBuffer=[]; ppgBuffer=[]; lastPeakIdx=-1; sampleCount=0;
    hist.labels=[]; hist.hr=[]; hist.rr=[]; hist.rmssd=[]; hist.t0=null;
    baselineRMSSD=null;
  }

  return { mount, unmount };

})();
