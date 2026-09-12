/**
 * modes/hrv.js — HRV neurofeedback mode
 * Reads PPG data from Muse S Athena via the mnelsl bridge.
 * Bridge must emit frames with type:"ppg" and field ppg_bvp (raw BVP signal array).
 * RR intervals are derived from peak detection on the BVP waveform.
 * Computes RMSSD, pNN50, and a coherence index; drives the same feedback
 * mechanisms as the WHOOP HRV tool (Audio.adaptVolume, coherenceChime, etc.)
 *
 * Muse S Athena PPG spec: ~64 Hz BVP signal on channel ppg_bvp
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
  const PPG_FS          = 64;          // Muse S Athena PPG sample rate (Hz)
  // const RR_WINDOW       = 30;          // beats for rolling RMSSD
  const BASELINE_BEATS  = 60;         // ~2 min at update every 2 second
  const COHERENCE_WIN   = 60;          // beats for coherence DFT
  const MAX_CHART_PTS   = 300;

  // Peak detector: min peak distance 300ms, min prominence as fraction of recent range
  const PEAK_MIN_DIST_S  = 0.3;
  const PEAK_MIN_DIST_SAMPLES = Math.floor(PPG_FS * PEAK_MIN_DIST_S);

  /* ── State ──────────────────────────────────────────────────────── */
  let sessionActive  = false;
  let sessionPaused = false;
  let baselinePhase  = false;
  const ppg_keys     = ['rr_ms', 'rmssd_ms', 'rr_intervals_ms', 'sdnn_ms','pnn50', 'mean_hr_bpm', 'lf_power', 'hf_power', 'lf_hf_ratio', 'peak_count'];       
  let ppg_frames     = {};            // all RR intervals this session (ms)
  let lastPeakIdx    = -1;            // sample index of last detected peak
  let sampleCount    = 0;             // total samples received
  let baselineRMSSD  = null;
  let elapsedSec     = 0;
  let timerInterval  = null;
  let lastCoherence  = false;
  let _mounted       = false;

  const hist  = HrvLib.makeHist();
  const charts = {};

 /* ── Helpers ────────────────────────────────────────────────────── */
  function _el(id) { return document.getElementById(id); }

  /* ── Disconnection toast ────────────────────────────────────────── */

  function _showToast() {
    const toast = _el('Toast');
    if (!toast) return;
    toast.style.display = 'flex';
    clearTimeout(_toastTimer);
    // Auto-dismiss after 8 s
    _toastTimer = setTimeout(_hideToast, 8000);
  }

  function _hideToast() {
    const toast = _el('Toast');
    if (toast) toast.style.display = 'none';
  }

  /* ── Frame handler ──────────────────────────────────────────────── */

  function _onFrame(frame) {
    if (!_mounted || ( frame.type !== 'ppg' && frame.type !== 'rr')) return;
      // Got a frame → hide any disconnection toast
      _hideToast();
    // If paused, accept frames (keeps bridge alive) but skip chart/training
    if (sessionPaused) return;
    const metrics = frame.metrics;
    if (metrics == null) return;

    // console.log(metrics)

    ppg_keys.forEach( key => {
      ppg_frames[key].push(metrics[key]);
    });

    //console.log(ppg_frames)

    // Baseline collection
    if (baselinePhase) {
      const pct = Math.min(ppg_frames['rr_ms'].length / BASELINE_BEATS, 1);
      _el('statStatus').textContent = `Calibrating… ${Math.round(pct*100)}%`;
      if (ppg_frames['rr_ms'].length >= BASELINE_BEATS) _finishBaseline();
      //return;
    }

    const rv = metrics['rmssd_ms'];
    const pv = metrics['pnn50'];
    const ci = HrvLib.coherenceIndex(ppg_frames['rr_ms']);
    const hr     = metrics['mean_hr_bpm'];
    const label  = sessionActive && hist.t0 ? String(Math.floor((Date.now()-hist.t0)/1000)) : '';

    HrvLib.pushHist(hist, { label, hr: hr, rr: metrics['rr_ms']??null, rv }, MAX_CHART_PTS);
    HrvLib.updateCharts(charts, hist, baselineRMSSD);
    HrvLib.drawGauge('Gauge', pv/100);
    HrvLib.updateStateBadge('stateBadge', rv, baselineRMSSD);

    // Stats
    if (hr  !== null) _el('statHR').innerHTML  = `${hr}<span class="stat-unit">bpm</span>`;
    if (rv  !== null) _el('statRMSSD').innerHTML= `${rv.toFixed(1)}<span class="stat-unit">ms</span>`;
    if (pv  !== null) _el('statPNN50').innerHTML= `${pv.toFixed(1)}<span class="stat-unit">%</span>`;

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

  function reset_ppg(){
    ppg_keys.forEach(key=>{ppg_frames[key] = [];});
  }

  function _finishBaseline() {
    baselinePhase = false;
    baselineRMSSD = ppg_frames['rmssd_ms'].at(-1);
    _el('statBaseline').textContent = baselineRMSSD ? baselineRMSSD.toFixed(1)+' ms' : '—';
    _el('statStatus').textContent   = 'Baseline done';
    _el('startBtn').disabled        = false;
    //reset_ppg();
  }
  
  /* ── Session control ────────────────────────────────────────────── */

  function _startSession() {
    sessionActive=true; hist.t0=Date.now(); elapsedSec=0;
    _el('statStatus').textContent='Training';
    _el('startBtn').disabled=true;
    _el('stopBtn').disabled=false;
    _el('BaselineBtn').disabled=true;
    AudioPanel.startSelectedSound();
    const beepSec = +(_el('beepInterval')?.value||30);
    if (_el('fbBeep')?.checked) {
      Audio.scheduleBeep(beepSec,
        () => ({ score: ppg_frames['rmssd_ms'].at(-1)??0, threshold: baselineRMSSD??1 }),
        () => sessionActive);
    }
    timerInterval = setInterval(()=>{
      elapsedSec++;
      _el('statElapsed').textContent =
        String(Math.floor(elapsedSec/60))+':'+String(elapsedSec%60).padStart(2,'0');
    },1000);
  }

  function _stopSession() {
    sessionActive=false;
    clearInterval(timerInterval);
    Audio.cancelBeep();
    Audio.stopSound();
    _el('statStatus').textContent='Stopped';
    _el('startBtn').disabled=false;
    _el('stopBtn').disabled=true;
    _el('BaselineBtn').disabled=false;
  }

  function _el(id) { return document.getElementById(id); }

  /* ── HTML template ──────────────────────────────────────────────── */

  const TEMPLATE = `
<section class="section-card">
  <div class="section-hdr">
    <span class="section-title">HRV Session</span>
    <div class="session-actions">
      <button class="btn-sm" id="BaselineBtn">Calibrate baseline (2 min)</button>
      <button class="btn-sm btn-accent" id="startBtn">Start training</button>
      <button class="btn-sm btn-danger" id="stopBtn" disabled>Stop</button>
    </div>
  </div>
  <p class="ctrl-desc" style="margin-bottom:.5rem">
    Uses Muse S Athena PPG (BVP channel) at 64 Hz. Also accepts WHOOP-compatible
    <code>{ type:"rr", bpm, rr_ms }</code> frames from bridge.py or hr_rr_simulator.py.
  </p>
  <div class="stat-row">
    <div class="stat"><span class="stat-lbl">Status</span><span class="stat-val" id="statStatus">Idle</span></div>
    <div class="stat"><span class="stat-lbl">Elapsed</span><span class="stat-val" id="statElapsed">0:00</span></div>
    <div class="stat"><span class="stat-lbl">Heart rate</span><span class="stat-val" id="statHR">—</span></div>
    <div class="stat"><span class="stat-lbl">RMSSD</span><span class="stat-val" id="statRMSSD">—</span></div>
    <div class="stat"><span class="stat-lbl">pNN50</span><span class="stat-val" id="statPNN50">—</span></div>
    <div class="stat"><span class="stat-lbl">Baseline RMSSD</span><span class="stat-val" id="statBaseline">—</span></div>
  </div>
</section>

<div class="charts-row">
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr"><span class="chart-title">Heart rate</span><span class="chart-sub">BPM · live</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="HRChart"></canvas></div>
  </div>
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr"><span class="chart-title">RR tachogram</span><span class="chart-sub">Beat-to-beat interval · ms</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="RRChart"></canvas></div>
  </div>
</div>

<div class="charts-row">
  <div class="chart-card" style="flex:1.4">
    <div class="chart-hdr"><span class="chart-title">HRV — rolling RMSSD</span><span class="chart-sub">30-beat window · ms · parasympathetic tone</span></div>
    <div class="chart-wrap" style="height:200px"><canvas id="RMSSDChart"></canvas></div>
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
    <canvas id="Gauge" width="180" height="180"></canvas>
    <div class="hrv-state-badge" id="stateBadge">Waiting for data</div>
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
    <label class="fb-chk"><input type="checkbox" id="BreathPacer" />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Enable breathing cues</span>
        <span class="fb-chk-sub">Audible inhale/exhale tones at target rate</span>
      </div>
    </label>
    <div class="fb-sub-row">
      <label class="vol-lbl">Rate</label>
      <input type="range" id="BreathRate" min="4" max="8" step="0.5" value="5.5" />
      <span class="vol-val" id="BreathRateVal">5.5 /min</span>
    </div>
    <div id="BreathVis" style="display:none;flex-direction:column;align-items:center;gap:5px;margin-top:.5rem">
      <div style="width:100%;height:6px;border-radius:3px;background:var(--border-subtle);overflow:hidden">
        <div id="BreathBar" style="height:100%;background:var(--accent);border-radius:3px;width:0%;transition:width linear"></div>
      </div>
      <span id="BreathLabel" style="font-size:11px;color:var(--accent);font-family:var(--font-mono)">Inhale</span>
    </div>
  </section>
</div>`;

  /* ── Breathing pacer ─────────────────────────────────────────────── */
  let _breathTimer = null, _breathPhase = 'in', _breathStart = 0;

  function _startBreath() {
    const rate = +(_el('BreathRate')?.value || 5.5);
    const cycle = 60/rate, durIn = cycle*0.4, durOut = cycle*0.6;
    _breathPhase='in'; _breathStart=Date.now();
    _el('BreathVis').style.display='flex';
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
      const barEl = _el('BreathBar');
      if (barEl) barEl.style.width = bar.toFixed(1)+'%';
      const lblEl = _el('BreathLabel');
      if (lblEl) lblEl.textContent = label;
    }, 80);
  }

  function _stopBreath() {
    clearInterval(_breathTimer);
    const vis = _el('BreathVis');
    if (vis) vis.style.display='none';
  }

  /* ── Mount / unmount ────────────────────────────────────────────── */

  function mount() {
    if (_mounted) return;
    _mounted = true;
    reset_ppg();

    document.getElementById('modePanel').innerHTML = TEMPLATE;
    Object.assign(charts, HrvLib.initCharts({
      hrId:'HRChart', rrId:'RRChart', rmssdId:'RMSSDChart', maxPts: MAX_CHART_PTS
    }));
    //_initCharts();
    AudioPanel.init(() => sessionActive);
    // Register this mode's frame handler with the shared WsClient singleton.
    WsClient.setOnFrame(_onFrame);

    _el('BaselineBtn').addEventListener('click', () => {
      if (!WsClient.isConnected()) { alert('Connect to the bridge first.'); return; }
      baselinePhase=true;
      _el('startBtn').disabled=true;
      _el('statStatus').textContent='Calibrating…';
    });
    _el('startBtn').addEventListener('click', _startSession);
    _el('stopBtn').addEventListener('click',  _stopSession);

    _el('beepInterval')?.addEventListener('input', e => {
      _el('beepIntervalVal').textContent = e.target.value+' s';
    });
    _el('BreathRate')?.addEventListener('input', e => {
      _el('BreathRateVal').textContent = (+e.target.value).toFixed(1)+' /min';
    });
    _el('BreathPacer')?.addEventListener('change', () => {
      _el('BreathPacer').checked ? _startBreath() : _stopBreath();
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
    reset_ppg(); lastPeakIdx=-1; sampleCount=0;
    hist.labels=[]; hist.hr=[]; hist.rr=[]; hist.rmssd=[]; hist.t0=null;
    baselineRMSSD=null;
  }

  return { mount, unmount };

})();
