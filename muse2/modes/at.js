/**
 * modes/at.js — Alpha/Theta neurofeedback mode
 * Uses EEG band powers from the muselsl WebSocket bridge.
 * Depends on: Audio, AudioPanel, ChartUtils, WsClient (globals from lib/)
 *
 * Public API (called by app.js):
 *   AT.mount()    — render UI into #modePanel, wire up events, init charts
 *   AT.unmount()  — destroy charts, stop session, remove listeners
 */

'use strict';

const AT = (() => {

  /* ── Constants ──────────────────────────────────────────────────── */
  const HISTORY_SECONDS = 120;
  const PUSH_HZ         = 4;
  const MAX_POINTS      = HISTORY_SECONDS * PUSH_HZ;
  const BASELINE_SECS   = 30;
  const BLOCK_SECS      = 60;
  const THRESH_UP_PCT   = 0.60;
  const THRESH_DOWN_PCT = 0.40;
  const THRESH_STEP     = 0.05;

  const BAND_COLORS = { delta:'#6b7db3', theta:'#7c75e0', alpha:'#2db891', beta:'#e07050', gamma:'#e0b020' };
  const AT_COLORS   = { alpha:'#2db891', theta:'#7c75e0', ratio:'#e07050', thresh:'rgba(255,140,60,0.55)' };

  /* ── State ──────────────────────────────────────────────────────── */
  let sessionActive  = false;
  let baselineActive = false;
  let baselineBuffer = [];
  let baseline       = { alpha:null, theta:null, atRatio:null };
  let threshold      = 1.0;
  let blockTimer     = 0;
  let blockAbove     = 0;
  let elapsedSec     = 0;
  let timerInterval  = null;
  let lastCrossover  = false;
  let _mounted       = false;

  const hist = {
    labels:[], delta:[], theta:[], alpha:[], beta:[], gamma:[], atRatio:[],
    t0: null,
  };

  const charts = { band: null, at: null };

  /* ── HTML template ──────────────────────────────────────────────── */
  const TEMPLATE = `
<section class="section-card">
  <div class="section-hdr">
    <span class="section-title">α/θ Session</span>
    <div class="session-actions">
      <button class="btn-sm" id="atBaselineBtn">Calibrate baseline (30 s)</button>
      <button class="btn-sm btn-accent" id="atStartBtn">Start training</button>
      <button class="btn-sm btn-danger" id="atStopBtn" disabled>Stop</button>
    </div>
  </div>
  <div class="stat-row">
    <div class="stat"><span class="stat-lbl">Status</span><span class="stat-val" id="atStatStatus">Idle</span></div>
    <div class="stat"><span class="stat-lbl">Elapsed</span><span class="stat-val" id="atStatElapsed">0:00</span></div>
    <div class="stat"><span class="stat-lbl">α/θ ratio</span><span class="stat-val" id="atStatAT">—</span></div>
    <div class="stat"><span class="stat-lbl">α power</span><span class="stat-val" id="atStatAlpha">—</span></div>
    <div class="stat"><span class="stat-lbl">θ power</span><span class="stat-val" id="atStatTheta">—</span></div>
    <div class="stat"><span class="stat-lbl">Threshold</span><span class="stat-val" id="atStatThresh">—</span></div>
  </div>
</section>

<div class="charts-row">
  <div class="chart-card" style="flex:1.3">
    <div class="chart-hdr">
      <span class="chart-title">Live band powers</span>
      <span class="chart-sub">All channels averaged · 4 Hz update</span>
    </div>
    <div class="chart-wrap" style="height:220px"><canvas id="atBandChart"></canvas></div>
    <div class="band-legend">
      <span class="bl-item" style="--c:#6b7db3">δ Delta</span>
      <span class="bl-item" style="--c:#7c75e0">θ Theta</span>
      <span class="bl-item" style="--c:#2db891">α Alpha</span>
      <span class="bl-item" style="--c:#e07050">β Beta</span>
      <span class="bl-item" style="--c:#e0b020">γ Gamma</span>
    </div>
  </div>
  <div class="chart-card" style="flex:1">
    <div class="chart-hdr">
      <span class="chart-title">α / θ neurofeedback</span>
      <span class="chart-sub">Peniston protocol · θ/α crossover goal</span>
    </div>
    <div class="chart-wrap" style="height:220px"><canvas id="atRatioChart"></canvas></div>
    <div class="band-legend">
      <span class="bl-item" style="--c:#2db891">α Alpha</span>
      <span class="bl-item" style="--c:#7c75e0">θ Theta</span>
      <span class="bl-item" style="--c:#e07050">θ/α ratio</span>
      <span class="bl-item threshold-item">— Threshold</span>
    </div>
    <div class="crossover-badge" id="atCrossoverBadge">θ > α</div>
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
        <span class="fb-chk-sub">Music softens when θ/α exceeds threshold, deepening inward focus</span>
      </div>
    </label>
    <label class="fb-chk"><input type="checkbox" id="fbBeep" />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Periodic tone</span>
        <span class="fb-chk-sub">660 Hz when θ > α · 330 Hz when α > θ</span>
      </div>
    </label>
    <div class="fb-sub-row">
      <label class="vol-lbl">Interval</label>
      <input type="range" id="beepInterval" min="10" max="60" step="5" value="30" />
      <span class="vol-val" id="beepIntervalVal">30 s</span>
    </div>
    <label class="fb-chk"><input type="checkbox" id="fbCrossover" />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Crossover chime</span>
        <span class="fb-chk-sub">Soft chime when θ crosses above α</span>
      </div>
    </label>
  </section>

  <section class="ctrl-card">
    <div class="ctrl-title">Threshold (Peniston adaptive)</div>
    <p class="ctrl-desc">Auto-adjusts each 60 s block. Manual override below.</p>
    <label class="fb-chk"><input type="checkbox" id="autoThreshold" checked />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Auto-adjust threshold</span>
        <span class="fb-chk-sub">Raises when above >60% of block, lowers when below 40% — Nan et al. 2014</span>
      </div>
    </label>
    <div class="fb-sub-row">
      <label class="vol-lbl">θ/α threshold</label>
      <input type="range" id="manualThresh" min="0.2" max="3.0" step="0.05" value="1.0" />
      <span class="vol-val" id="manualThreshVal">1.00</span>
    </div>
  </section>
</div>`;

  /* ── Chart init ─────────────────────────────────────────────────── */

  function _initCharts() {
    const cc    = ChartUtils.colors();
    const empty = () => Array(MAX_POINTS).fill(null);

    charts.band = new Chart(document.getElementById('atBandChart'), {
      type: 'line',
      data: {
        labels: empty(),
        datasets: [
          ChartUtils.makeDataset('δ Delta', BAND_COLORS.delta, empty()),
          ChartUtils.makeDataset('θ Theta', BAND_COLORS.theta, empty()),
          ChartUtils.makeDataset('α Alpha', BAND_COLORS.alpha, empty()),
          ChartUtils.makeDataset('β Beta',  BAND_COLORS.beta,  empty()),
          ChartUtils.makeDataset('γ Gamma', BAND_COLORS.gamma, empty()),
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { mode:'index', intersect:false } },
        scales: { x: ChartUtils.scaleX(cc), y: ChartUtils.scaleY(cc, 'Power (µV²/Hz)') },
      },
    });

    charts.at = new Chart(document.getElementById('atRatioChart'), {
      type: 'line',
      data: {
        labels: empty(),
        datasets: [
          ChartUtils.makeDataset('α Alpha',   AT_COLORS.alpha, empty(), 'y'),
          ChartUtils.makeDataset('θ Theta',   AT_COLORS.theta, empty(), 'y'),
          ChartUtils.makeDataset('θ/α ratio', AT_COLORS.ratio, empty(), 'y2'),
          ChartUtils.makeDataset('Threshold', AT_COLORS.thresh, empty(), 'y2', {
            borderDash:[5,4], spanGaps:false, backgroundColor:'transparent',
          }),
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend:{ display:false },
                   tooltip:{ mode:'index', intersect:false,
                     callbacks:{ label:c=>`${c.dataset.label}: ${c.parsed.y.toFixed(4)}` } } },
        scales: {
          x:  ChartUtils.scaleX(cc),
          y:  ChartUtils.scaleY(cc, 'Power (µV²/Hz)'),
          y2: { position:'right', ticks:{ font:{size:10}, color:cc.tick, callback:v=>v.toFixed(2) },
                grid:{drawOnChartArea:false}, title:{display:true, text:'θ/α ratio', font:{size:10}, color:cc.title} },
        },
      },
    });
  }

  /* ── Frame processing ───────────────────────────────────────────── */

  function _onFrame(frame) {
    if (!_mounted || frame.type !== 'eeg') return;

    const { bands, metrics } = frame;
    const avg4 = band => ['tp9','af7','af8','tp10'].reduce((s,ch) => s+(bands[ch]?.[band]??0), 0)/4;
    const delta = avg4('delta'), theta = avg4('theta'),
          alpha = avg4('alpha'), beta  = avg4('beta'), gamma = avg4('gamma');
    const atRatio = metrics.at_ratio ?? (theta / (alpha + 1e-12));
    const label   = sessionActive && hist.t0 ? String(Math.floor((Date.now()-hist.t0)/1000)) : '';

    const P = MAX_POINTS;
    ChartUtils.rollingPush(hist.labels, label, P);
    ChartUtils.rollingPush(hist.delta,  delta,  P);
    ChartUtils.rollingPush(hist.theta,  theta,  P);
    ChartUtils.rollingPush(hist.alpha,  alpha,  P);
    ChartUtils.rollingPush(hist.beta,   beta,   P);
    ChartUtils.rollingPush(hist.gamma,  gamma,  P);
    ChartUtils.rollingPush(hist.atRatio,atRatio,P);

    // Band chart
    const L = [...hist.labels];
    charts.band.data.labels         = L;
    charts.band.data.datasets[0].data = [...hist.delta];
    charts.band.data.datasets[1].data = [...hist.theta];
    charts.band.data.datasets[2].data = [...hist.alpha];
    charts.band.data.datasets[3].data = [...hist.beta];
    charts.band.data.datasets[4].data = [...hist.gamma];
    charts.band.update('none');

    // AT chart
    charts.at.data.labels = L;
    charts.at.data.datasets[0].data = [...hist.alpha];
    charts.at.data.datasets[1].data = [...hist.theta];
    charts.at.data.datasets[2].data = [...hist.atRatio];
    charts.at.data.datasets[3].data = new Array(L.length).fill(threshold);
    charts.at.update('none');

    // Crossover
    const crossover = theta > alpha;
    const badge = document.getElementById('atCrossoverBadge');
    if (badge) badge.classList.toggle('visible', crossover);
    if (crossover && !lastCrossover && document.getElementById('fbCrossover')?.checked && sessionActive) {
      Audio.crossoverChime();
    }
    lastCrossover = crossover;

    // Stats
    _el('atStatAT').textContent    = atRatio.toFixed(3);
    _el('atStatAlpha').textContent = alpha.toExponential(2);
    _el('atStatTheta').textContent = theta.toExponential(2);
    _el('atStatThresh').textContent= threshold.toFixed(2);

    // Training
    if (sessionActive) {
      if (document.getElementById('fbVolume')?.checked) {
        const base = threshold > 0 ? threshold : 1;
        Audio.adaptVolume(atRatio, base, AudioPanel.targetVolume);
      }
      blockTimer++;
      if (atRatio > threshold) blockAbove++;
      if (blockTimer >= BLOCK_SECS * PUSH_HZ) {
        if (document.getElementById('autoThreshold')?.checked) {
          const pct = blockAbove / blockTimer;
          if (pct > THRESH_UP_PCT)   threshold = Math.min(threshold + THRESH_STEP, 3.0);
          if (pct < THRESH_DOWN_PCT) threshold = Math.max(threshold - THRESH_STEP, 0.2);
          _el('manualThresh').value         = threshold.toFixed(2);
          _el('manualThreshVal').textContent = threshold.toFixed(2);
        }
        blockTimer = 0; blockAbove = 0;
      }
    }

    // Baseline
    if (baselineActive) {
      baselineBuffer.push({ alpha, theta, atRatio });
      const pct = Math.min(baselineBuffer.length / (BASELINE_SECS * PUSH_HZ), 1);
      _el('atStatStatus').textContent = `Calibrating… ${Math.round(pct*100)}%`;
      if (baselineBuffer.length >= BASELINE_SECS * PUSH_HZ) _finishBaseline();
    }
  }

  function _finishBaseline() {
    baselineActive = false;
    const n = baselineBuffer.length;
    baseline.alpha   = baselineBuffer.reduce((s,f) => s+f.alpha,   0)/n;
    baseline.theta   = baselineBuffer.reduce((s,f) => s+f.theta,   0)/n;
    baseline.atRatio = baselineBuffer.reduce((s,f) => s+f.atRatio, 0)/n;
    threshold = Math.max(0.2, Math.min(baseline.atRatio * 0.95, 3.0));
    _el('manualThresh').value         = threshold.toFixed(2);
    _el('manualThreshVal').textContent = threshold.toFixed(2);
    _el('atStatStatus').textContent   = 'Baseline done';
    _el('atStartBtn').disabled        = false;
    baselineBuffer = [];
  }

  /* ── Session control ────────────────────────────────────────────── */

  function _startSession() {
    sessionActive = true;
    hist.t0 = Date.now();
    elapsedSec = blockTimer = blockAbove = 0;
    _el('atStatStatus').textContent = 'Training';
    _el('atStartBtn').disabled      = true;
    _el('atStopBtn').disabled       = false;
    _el('atBaselineBtn').disabled   = true;

    AudioPanel.startSelectedSound();

    const beepSec = +(_el('beepInterval')?.value || 30);
    if (_el('fbBeep')?.checked) {
      Audio.scheduleBeep(beepSec,
        () => ({ score: hist.atRatio.slice(-1)[0] ?? 0, threshold }),
        () => sessionActive
      );
    }

    timerInterval = setInterval(() => {
      elapsedSec++;
      const m = String(Math.floor(elapsedSec/60));
      const s = String(elapsedSec%60).padStart(2,'0');
      _el('atStatElapsed').textContent = `${m}:${s}`;
    }, 1000);
  }

  function _stopSession() {
    sessionActive = false;
    clearInterval(timerInterval);
    Audio.cancelBeep();
    Audio.stopSound();
    _el('atStatStatus').textContent = 'Stopped';
    _el('atStartBtn').disabled      = false;
    _el('atStopBtn').disabled       = true;
    _el('atBaselineBtn').disabled   = false;
  }

  /* ── Helpers ────────────────────────────────────────────────────── */
  function _el(id) { return document.getElementById(id); }

  /* ── Mount / unmount ────────────────────────────────────────────── */

  function mount() {
    if (_mounted) return;
    _mounted = true;

    document.getElementById('modePanel').innerHTML = TEMPLATE;
    _initCharts();
    AudioPanel.init(() => sessionActive);
    // Register this mode's frame handler with the shared WsClient singleton.
    // app.js owns the socket; we only swap the onFrame handler.
    WsClient.setOnFrame(_onFrame);

    _el('atBaselineBtn').addEventListener('click', () => {
      if (!WsClient.isConnected()) { alert('Connect to the bridge first.'); return; }
      baselineActive = true; baselineBuffer = [];
      _el('atStartBtn').disabled = true;
      _el('atStatStatus').textContent = 'Calibrating…';
    });
    _el('atStartBtn').addEventListener('click', _startSession);
    _el('atStopBtn').addEventListener('click',  _stopSession);

    _el('beepInterval')?.addEventListener('input', e => {
      _el('beepIntervalVal').textContent = e.target.value + ' s';
      if (sessionActive && _el('fbBeep')?.checked) {
        Audio.scheduleBeep(+e.target.value,
          () => ({ score: hist.atRatio.slice(-1)[0]??0, threshold }),
          () => sessionActive);
      }
    });

    _el('manualThresh')?.addEventListener('input', e => {
      threshold = +e.target.value;
      _el('manualThreshVal').textContent = (+e.target.value).toFixed(2);
    });
  }

  function unmount() {
    if (!_mounted) return;
    _mounted = false;
    if (sessionActive) _stopSession();
    ChartUtils.destroyAll(charts);
    document.getElementById('modePanel').innerHTML = '';
    // Reset state
    baselineActive = false; baselineBuffer = [];
    WsClient.setOnFrame(null);
    hist.labels=[]; hist.delta=[]; hist.theta=[]; hist.alpha=[];
    hist.beta=[]; hist.gamma=[]; hist.atRatio=[]; hist.t0=null;
  }

  return { mount, unmount };

})();
