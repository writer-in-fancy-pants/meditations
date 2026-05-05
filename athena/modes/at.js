/**
 * modes/at.js — Multi-protocol neurofeedback mode
 * Uses EEG band powers from the mnelsl/pylsl WebSocket bridge.
 * Depends on: Audio, AudioPanel, ChartUtils, WsClient (globals from lib/)
 *
 * Features:
 *   • Protocol dropdown  — choose any neurofeedback mechanism; chart, legend,
 *                          stats and threshold update instantly
 *   • Snapshot support   — frames carrying a `snapshot` key (from neurofeedback.py)
 *                          are parsed and their pre-computed metrics drive the
 *                          active protocol graph instead of local DSP
 *   • Speed dial         — 4 preset adaptation rates (blockSecs × threshUpPct)
 *   • Pause/resume       — freezes chart updates and training logic, audio continues
 *   • Graph reset        — clears both charts on every recalibrate click
 *   • Gong fix           — long sustain (20 s decay, 25–30 s repeat interval)
 *   • Disconnection toast — appears when WS drops during a session
 *   • YouTube audio option — load a YT URL/ID as background music
 *
 * Public API (called by app.js):
 *   AT.mount()   — render UI into #modePanel, wire up events, init charts
 *   AT.unmount() — destroy charts, stop session, remove listeners
 */

'use strict';

const AT = (() => {

  /* ── Constants ──────────────────────────────────────────────────── */
  const HISTORY_SECONDS = 120;
  const PUSH_HZ         = 4;
  const MAX_POINTS      = HISTORY_SECONDS * PUSH_HZ;
  const BASELINE_SECS   = 60;
  const THRESH_DOWN_PCT = 0.40;
  const THRESH_STEP     = 0.05;
  const scaleReadings   = true;

  // Speed presets: [ label, blockSecs, threshUpPct ]
  const SPEED_PRESETS = [
    { label: 'Relaxed',  blockSecs: 60, threshUpPct: 0.60 },
    { label: 'Standard', blockSecs: 10, threshUpPct: 0.75 },
    { label: 'Fast',     blockSecs:  5, threshUpPct: 0.90 },
    { label: 'Reactive', blockSecs:  2, threshUpPct: 0.99 },
  ];

  const BAND_COLORS = {
    delta: '#2a45db', theta: '#7c75e0', alpha: '#2db891',
    beta:  '#e07050', gamma: '#e0b020',
  };

  const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma'];

  /* ── Neurofeedback protocol definitions ─────────────────────────── */
  //
  // Each protocol defines:
  //   id          – unique key, also used to read from snapshot
  //   label       – shown in dropdown
  //   description – subtitle under chart title
  //   goal        – short goal string shown in badge
  //   // Chart dataset descriptors
  //   datasets    – array of { label, color, histKey, axis }
  //                 histKey = key in `hist` object OR a function(hist,snap)=>value
  //   threshAxis  – which axis the threshold line lives on ('y' or 'y2')
  //   yLabel      – left Y-axis label
  //   y2Label     – right Y-axis label (null = hide y2)
  //   // Threshold defaults
  //   threshMin   – slider min
  //   threshMax   – slider max
  //   threshStep  – slider step
  //   threshDefault – starting threshold value
  //   // Snapshot metric key (path into snapshot object, dot-separated)
  //   snapshotKey – key to read from the `snapshot` object for primary metric
  //   // Baseline computation
  //   baselineMetric – function(frame metrics, bands) => value used for baseline
  //   // Adaptive threshold direction (higher = good → 'up', lower = good → 'down')
  //   direction   – 'up' | 'down'
  //   // Crossover / badge logic
  //   badgeFn     – function(hist, threshold) => bool (show badge?)
  //   badgeLabel  – text on the badge

  const PROTOCOLS = [
    {
      id: 'at',
      label: 'α/θ  —  Alpha / Theta  (Peniston)',
      description: 'Peniston protocol · θ/α crossover goal',
      task: "A calm aware joyful experience - like smelling the fresh spring bloom.",
      goal: 'θ > α',
      datasets: [
        { label: 'α Alpha',   color: '#2db891', histKey: 'alpha',   axis: 'y'  },
        { label: 'θ Theta',   color: '#7c75e0', histKey: 'theta',   axis: 'y'  },
        { label: 'θ/α ratio', color: '#e07050', histKey: 'atRatio', axis: 'y2' },
        { label: 'Threshold', color: 'rgba(255,140,60,0.55)', histKey: '_thresh', axis: 'y2',
          dash: true },
      ],
      threshAxis: 'y2', yLabel: 'Power (µV²/Hz)', y2Label: 'θ/α ratio',
      threshMin: 0.2, threshMax: 3.0, threshStep: 0.05, threshDefault: 1.0,
      snapshotKey: 'alpha_theta_ratio',
      baselineMetric: (metrics) => metrics.at_ratio ?? 1.0,
      direction: 'up',
      badgeFn: (hist) => {
        const t = hist.theta.slice(-1)[0]; const a = hist.alpha.slice(-1)[0];
        return t != null && a != null && t > a;
      },
      badgeLabel: 'θ > α',
    },
    {
      id: 'smr',
      label: 'SMR  —  Sensorimotor Rhythm  (12–15 Hz)',
      description: 'SMR enhancement · calm focus goal',
      task: "Ready but relaxed - like a cat is watching a bird, still and laser-focused.",
      goal: 'SMR ↑',
      datasets: [
        { label: 'SMR power', color: '#2db891', histKey: 'smrPower', axis: 'y' },
        { label: 'SMR score', color: '#7c75e0', histKey: 'smrScore', axis: 'y2' },
        { label: 'Threshold', color: 'rgba(255,140,60,0.55)', histKey: '_thresh', axis: 'y2',
          dash: true },
      ],
      threshAxis: 'y2', yLabel: 'SMR power (µV²/Hz)', y2Label: 'Normalised score',
      threshMin: 0.0, threshMax: 1.0, threshStep: 0.01, threshDefault: 0.5,
      snapshotKey: 'smr_score',
      baselineMetric: (metrics, bands) => {
        const avg4 = b => ['tp9','af7','af8','tp10'].reduce((s,ch)=>s+(bands[ch]?.[b]??0),0)/4;
        return avg4('beta') / (avg4('alpha') + 1e-9);
      },
      direction: 'up',
      badgeFn: (hist, thresh) => {
        const v = hist.smrScore.slice(-1)[0]; return v != null && v > thresh;
      },
      badgeLabel: 'SMR ↑',
    },
    {
      id: 'faa',
      label: 'FAA  —  Frontal Alpha Asymmetry',
      description: 'Approach motivation · positive valence goal',
      task: 'Regulate anxiety and depression - notice how you blink, or twitch, or other repetitive movements.',
      goal: 'AF8α > AF7α',
      datasets: [
        { label: 'AF7 α',  color: '#e07050', histKey: 'af7Alpha',  axis: 'y'  },
        { label: 'AF8 α',  color: '#2db891', histKey: 'af8Alpha',  axis: 'y'  },
        { label: 'FAA',    color: '#7c75e0', histKey: 'faa',       axis: 'y2' },
        { label: 'Threshold', color: 'rgba(255,140,60,0.55)', histKey: '_thresh', axis: 'y2',
          dash: true },
      ],
      threshAxis: 'y2', yLabel: 'α power (µV²/Hz)', y2Label: 'FAA  (ln ratio)',
      threshMin: -1.0, threshMax: 1.0, threshStep: 0.05, threshDefault: 0.0,
      snapshotKey: 'faa_score',
      baselineMetric: (metrics) => metrics.faa ?? 0.0,
      direction: 'up',
      badgeFn: (hist, thresh) => {
        const v = hist.faa.slice(-1)[0]; return v != null && v > thresh;
      },
      badgeLabel: 'Positive',
    },
    {
      id: 'beta_supp',
      label: 'β Suppression  —  Anxiety / Hyperarousal',
      description: 'Frontal beta suppression · calm goal',
      task:"Keep steady, muscles relaxed. Improves motor control, reaction time - Parkinson's for example",
      goal: 'β ↓',
      datasets: [
        { label: 'AF7 β',     color: '#e07050', histKey: 'af7Beta',    axis: 'y'  },
        { label: 'AF8 β',     color: '#e0b020', histKey: 'af8Beta',    axis: 'y'  },
        { label: 'Suppression', color: '#2db891', histKey: 'betaSupp', axis: 'y2' },
        { label: 'Threshold', color: 'rgba(255,140,60,0.55)', histKey: '_thresh', axis: 'y2',
          dash: true },
      ],
      threshAxis: 'y2', yLabel: 'β power (µV²/Hz)', y2Label: 'Suppression score (0–1)',
      threshMin: 0.0, threshMax: 1.0, threshStep: 0.01, threshDefault: 0.5,
      snapshotKey: 'beta_suppression',
      baselineMetric: (metrics, bands) => {
        const avg2 = b => (['af7','af8'].reduce((s,ch)=>s+(bands[ch]?.[b]??0),0)/2);
        return avg2('beta') / (avg2('alpha') + 1e-9);
      },
      direction: 'up',   // score is inverted (higher = less beta = calmer)
      badgeFn: (hist, thresh) => {
        const v = hist.betaSupp.slice(-1)[0]; return v != null && v > thresh;
      },
      badgeLabel: 'β low',
    },
    {
      id: 'gamma',
      label: 'γ Coherence  —  Frontal Gamma  (30–44 Hz)',
      description: 'Cognitive binding · working memory goal',
      task:"Improve working memory and flexibility via mental recall games.",
      goal: 'γ ↑',
      datasets: [
        { label: 'AF7 γ',      color: '#e0b020', histKey: 'af7Gamma',     axis: 'y'  },
        { label: 'AF8 γ',      color: '#7c75e0', histKey: 'af8Gamma',     axis: 'y'  },
        { label: 'Frontal γ',  color: '#2db891', histKey: 'frontalGamma', axis: 'y'  },
        { label: 'Threshold',  color: 'rgba(255,140,60,0.55)', histKey: '_thresh', axis: 'y',
          dash: true },
      ],
      threshAxis: 'y', yLabel: 'γ power (µV²/Hz)', y2Label: null,
      threshMin: 0.0, threshMax: 0.001, threshStep: 0.00001, threshDefault: 0.0001,
      snapshotKey: 'gamma_coherence',
      baselineMetric: (metrics) => metrics.frontal_gamma ?? 0.0001,
      direction: 'up',
      badgeFn: (hist, thresh) => {
        const v = hist.frontalGamma.slice(-1)[0]; return v != null && v > thresh;
      },
      badgeLabel: 'γ ↑',
    },
    {
      id: 'theta_enh',
      label: 'θ Enhancement  —  Deep Meditation / Creativity',
      description: 'Frontal theta enhancement · meditative depth goal',
      task:"Cultivate deep concentration/flow - rely on thoughts, feelings, or mental focus to keep engaged.",
      goal: 'Fθ ↑',
      datasets: [
        { label: 'AF7 θ',    color: '#7c75e0', histKey: 'af7Theta',     axis: 'y'  },
        { label: 'AF8 θ',    color: '#6b7db3', histKey: 'af8Theta',     axis: 'y'  },
        { label: 'θ score',  color: '#2db891', histKey: 'thetaScore',   axis: 'y2' },
        { label: 'Threshold', color: 'rgba(255,140,60,0.55)', histKey: '_thresh', axis: 'y2',
          dash: true },
      ],
      threshAxis: 'y2', yLabel: 'θ power (µV²/Hz)', y2Label: 'Normalised score',
      threshMin: 0.0, threshMax: 1.0, threshStep: 0.01, threshDefault: 0.5,
      snapshotKey: 'frontal_theta',
      baselineMetric: (metrics, bands) => {
        return (['af7','af8'].reduce((s,ch)=>s+(bands[ch]?.theta??0),0)/2);
      },
      direction: 'up',
      badgeFn: (hist, thresh) => {
        const v = hist.thetaScore.slice(-1)[0]; return v != null && v > thresh;
      },
      badgeLabel: 'Deep θ',
    },
    {
      id: 'composite',
      label: 'Composite NF Score  —  Wellbeing Index',
      description: 'Weighted blend of all protocols · 0–100 goal',
      task:"",
      goal: 'Score ↑',
      datasets: [
        { label: 'NF Score',  color: '#2db891', histKey: 'nfScore',  axis: 'y'  },
        { label: 'Threshold', color: 'rgba(255,140,60,0.55)', histKey: '_thresh', axis: 'y',
          dash: true },
      ],
      threshAxis: 'y', yLabel: 'Composite score (0–100)', y2Label: null,
      threshMin: 0, threshMax: 100, threshStep: 1, threshDefault: 50,
      snapshotKey: 'nf_score',
      baselineMetric: () => 50,
      direction: 'up',
      badgeFn: (hist, thresh) => {
        const v = hist.nfScore.slice(-1)[0]; return v != null && v > thresh;
      },
      badgeLabel: 'Above target',
    },
  ];

  // Look up a protocol by id
  const _proto = id => PROTOCOLS.find(p => p.id === id);

  /* ── Mutable adaptation speed ────────────────────────────────────── */
  let blockSecs   = SPEED_PRESETS[0].blockSecs;
  let threshUpPct = SPEED_PRESETS[0].threshUpPct;

  /* ── Active protocol state ───────────────────────────────────────── */
  let activeProtoId = 'at';   // default: Alpha/Theta

  /* ── Session state ──────────────────────────────────────────────── */
  let sessionActive  = false;
  let sessionPaused  = false;
  let baselineActive = false;
  let baselineBuffer = [];
  let baseline       = {};
  let threshold      = 1.0;
  let blockTimer     = 0;
  let blockAbove     = 0;
  let elapsedSec     = 0;
  let timerInterval  = null;
  let lastBadge      = false;
  let _mounted       = false;
  let _toastTimer    = null;
  let _ytLoaded      = false;

  /* ── Rolling history (one slot per metric) ──────────────────────── */
  const hist = {
    labels: [], t0: null,
    // Raw band averages (all-channel)
    delta: [], theta: [], alpha: [], beta: [], gamma: [],
    // Per-channel values needed by protocols
    af7Alpha: [], af8Alpha: [], af7Theta: [], af8Theta: [],
    af7Beta:  [], af8Beta:  [], af7Gamma: [], af8Gamma: [],
    // Protocol metrics
    atRatio:     [],
    smrPower:    [], smrScore:   [],
    faa:         [],
    betaSupp:    [],
    frontalGamma:[], af7Gamma:   [], af8Gamma: [],
    thetaScore:  [],
    nfScore:     [],
  };

  let scaleFactors = {'delta':1.0, 'theta':1.0, 'alpha':1.0, 'gamma':1.0, 'beta':1.0}

  const charts = { band: null, at: null };

  /* ── HTML template ──────────────────────────────────────────────── */
  const TEMPLATE = `
<!-- Disconnection toast -->
<div class="at-toast" id="Toast" style="display:none">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
  EEG connection lost — data stream interrupted
  <button class="at-toast-close" id="ToastClose">×</button>
</div>

<section class="section-card">
  <div class="section-hdr">
    <select class="nf-proto-select" id="ProtoSelect">
      ${PROTOCOLS.map(p =>
        `<option value="${p.id}"${p.id==='at'?' selected':''}>${p.label}</option>`
      ).join('\n      ')}
    </select>
    <div class="session-actions">
      <button class="btn-sm" id="BaselineBtn">Calibrate baseline (60 s)</button>
      <button class="btn-sm btn-accent" id="startBtn">Start training</button>
      <button class="btn-sm" id="PauseBtn" disabled>Pause</button>
      <button class="btn-sm btn-danger" id="stopBtn" disabled>Stop</button>
    </div>
  </div>
  <div class="stat-row">
    <div class="stat"><span class="stat-lbl">Status</span><span class="stat-val" id="statStatus">Idle</span></div>
    <div class="stat"><span class="stat-lbl">Elapsed</span><span class="stat-val" id="statElapsed">0:00</span></div>
    <div class="stat"><span class="stat-lbl" id="statMetricLbl">θ/α ratio</span><span class="stat-val" id="statMetric">—</span></div>
    <div class="stat"><span class="stat-lbl">Source</span><span class="stat-val" id="statSource">local</span></div>
    <div class="stat"><span class="stat-lbl">Threshold</span><span class="stat-val" id="statThresh">—</span></div>
  </div>
  <div>
  <span class="chart-sub" id="instructionsText">Instructions</span>
  </div>
</section>

<div class="charts-row">
  <div class="chart-card" style="flex:1.3">
    <div class="chart-hdr">
      <span class="chart-title">Live band powers</span>
      <span class="chart-sub">All channels averaged · 4 Hz update</span>
    </div>
    <div class="chart-wrap" style="height:220px"><canvas id="BandChart"></canvas></div>
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
      <span class="chart-title" id="RatioChartTitle">α / θ neurofeedback</span>
      <span class="chart-sub"   id="RatioChartSub">Peniston protocol · θ/α crossover goal</span>
    </div>
    <div class="chart-wrap" style="height:220px"><canvas id="RatioChart"></canvas></div>
    <div class="band-legend" id="RatioLegend"></div>
    <div class="crossover-badge" id="CrossoverBadge">θ > α</div>
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
      <label class="sound-opt"><input type="radio" name="sound" value="youtube" /> YouTube link <span class="badge-new">yt</span></label>
    </div>
    <div class="upload-row" id="uploadRow" style="display:none">
      <input type="file" id="audioUpload" accept=".wav,.mp3" style="display:none" />
      <button class="btn-sm" id="audioUploadBtn">Choose WAV / MP3…</button>
      <span class="upload-name" id="uploadName">No file</span>
    </div>
    <div class="upload-row" id="ytRow" style="display:none">
      <input type="text" class="ws-input" id="ytUrlInput" placeholder="YouTube URL or video ID" style="max-width:none;flex:1" />
      <button class="btn-sm" id="ytLoadBtn">Load</button>
      <span class="upload-name" id="ytStatus"></span>
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
        <span class="fb-chk-sub" id="fbVolumeSub">Music softens when θ/α exceeds threshold</span>
      </div>
    </label>
    <label class="fb-chk"><input type="checkbox" id="fbBeep" />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Periodic tone</span>
        <span class="fb-chk-sub">660 Hz above threshold · 330 Hz below</span>
      </div>
    </label>
    <div class="fb-sub-row">
      <label class="vol-lbl">Interval</label>
      <input type="range" id="beepInterval" min="10" max="60" step="5" value="30" />
      <span class="vol-val" id="beepIntervalVal">30 s</span>
    </div>
    <label class="fb-chk"><input type="checkbox" id="fbCrossover" />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Goal chime</span>
        <span class="fb-chk-sub" id="fbCrossoverSub">Soft chime when metric crosses threshold</span>
      </div>
    </label>
  </section>

  <section class="ctrl-card">
    <div class="ctrl-title">Adaptive threshold</div>
    <p class="ctrl-desc">Auto-adjusts each block. Set adaptation speed below.</p>
    <label class="fb-chk"><input type="checkbox" id="autoThreshold" checked />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Auto-adjust threshold</span>
        <span class="fb-chk-sub">Raises when above >60% of block, lowers when below 40% — Nan et al. 2014</span>
      </div>
    </label>

    <div class="ctrl-label" style="margin-top:.75rem">Adaptation speed</div>
    <div class="speed-dial" id="speedDial">
      ${SPEED_PRESETS.map((p,i) =>
        `<button class="speed-btn${i===0?' active':''}" data-idx="${i}">${p.label}</button>`
      ).join('')}
    </div>
    <p class="speed-info" id="speedInfo">Block: ${SPEED_PRESETS[0].blockSecs}s · Up ≥${Math.round(SPEED_PRESETS[0].threshUpPct*100)}%</p>

    <div class="fb-sub-row">
      <label class="vol-lbl" id="threshLabel">θ/α threshold</label>
      <input type="range" id="manualThresh" min="0.2" max="3.0" step="0.05" value="1.0" />
      <span class="vol-val" id="manualThreshVal">1.00</span>
    </div>
  </section>
</div>`;

  /* ── Protocol switcher ───────────────────────────────────────────── */

  function _applyProtocol(id) {
    activeProtoId = id;
    const proto = _proto(id);
    if (!proto) return;

    // Set threshold to protocol default
    threshold = proto.threshDefault;

    // Update threshold slider range and value
    const slider = _el('manualThresh');
    if (slider) {
      slider.min   = proto.threshMin;
      slider.max   = proto.threshMax;
      slider.step  = proto.threshStep;
      slider.value = threshold;
    }
    _el('manualThreshVal') && (_el('manualThreshVal').textContent = _fmtThresh(threshold, proto));
    _el('threshLabel')     && (_el('threshLabel').textContent = proto.id === 'gamma'
      ? 'γ threshold' : proto.id === 'composite' ? 'Score threshold' : 'Metric threshold');

    // Update chart header
    _el('RatioChartTitle') && (_el('RatioChartTitle').textContent = proto.label.split('—')[0].trim());
    _el('RatioChartSub')   && (_el('RatioChartSub').textContent   = proto.description);
    _el('instructionsText') && (_el('instructionsText').textContent = proto.task);

    // Update badge
    const badge = _el('CrossoverBadge');
    if (badge) badge.textContent = proto.badgeLabel;

    // Update stat label
    _el('statMetricLbl') && (_el('statMetricLbl').textContent = proto.datasets[2]?.label ?? proto.datasets[0].label);


    // Rebuild the ratio chart with new datasets
    _rebuildRatioChart(proto);

    // Rebuild legend
    _buildLegend(proto);

    // Update feedback option descriptions
    _el('fbVolumeSub')   && (_el('fbVolumeSub').textContent =
      `Music softens when metric exceeds threshold (${proto.goal})`);
    _el('fbCrossoverSub') && (_el('fbCrossoverSub').textContent =
      `Soft chime when ${proto.goal} is achieved`);
  }

  function _fmtThresh(val, proto) {
    const step = proto?.threshStep ?? 0.05;
    const decimals = step < 0.01 ? 5 : step < 0.1 ? 2 : step < 1 ? 2 : 0;
    return val.toFixed(decimals);
  }

  /* ── Chart helpers ───────────────────────────────────────────────── */

  function _resetChartData() {
    const empty = () => Array(MAX_POINTS).fill(null);
    if (charts.band) {
      charts.band.data.labels = empty();
      charts.band.data.datasets.forEach(d => { d.data = empty(); });
      charts.band.update('none');
    }
    if (charts.at) {
      charts.at.data.labels = empty();
      charts.at.data.datasets.forEach(d => { d.data = empty(); });
      charts.at.update('none');
    }
  }

  function _rebuildRatioChart(proto) {
    if (!charts.at) return;
    const cc    = ChartUtils.colors();
    const empty = () => Array(MAX_POINTS).fill(null);

    const datasets = proto.datasets.map(ds => {
      const extra = ds.dash ? { borderDash:[5,4], spanGaps:false, backgroundColor:'transparent' } : {};
      return ChartUtils.makeDataset(ds.label, ds.color, empty(), ds.axis, extra);
    });

    charts.at.data.labels   = empty();
    charts.at.data.datasets = datasets;

    // Rebuild scales
    const hasY2 = proto.datasets.some(d => d.axis === 'y2');
    charts.at.options.scales.y.title.text = proto.yLabel;
    if (hasY2) {
      charts.at.options.scales.y2 = {
        position: 'right',
        ticks: { font:{size:10}, color: cc.tick,
                 callback: v => v.toFixed(proto.threshStep < 0.01 ? 4 : 2) },
        grid: { drawOnChartArea: false },
        title: { display:true, text: proto.y2Label, font:{size:10}, color: cc.title },
      };
    } else {
      charts.at.options.scales.y2 = { display: false };
    }
    charts.at.update('none');
  }

  function _buildLegend(proto) {
    const el = _el('RatioLegend');
    if (!el) return;
    el.innerHTML = proto.datasets.map(ds => {
      if (ds.dash) return `<span class="bl-item threshold-item">— Threshold</span>`;
      return `<span class="bl-item" style="--c:${ds.color}">${ds.label}</span>`;
    }).join('');
  }

  function _initCharts() {
    const cc    = ChartUtils.colors();
    const empty = () => Array(MAX_POINTS).fill(null);

    charts.band = ChartUtils.buildChart(document.getElementById('BandChart'), {
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
      options: ChartUtils.opts(cc, 'Power (µV²/Hz)', v => Math.round(v*100)/100),
    });

    // Build the ratio chart skeleton; _applyProtocol will populate it
    charts.at = ChartUtils.buildChart(document.getElementById('RatioChart'), {
      type: 'line',
      data: { labels: empty(), datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { mode:'index', intersect:false,
            callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y?.toFixed(4) ?? '—'}` } },
        },
        scales: {
          x:  ChartUtils.scaleX(cc),
          y:  ChartUtils.scaleY(cc, 'Power (µV²/Hz)'),
          y2: { display: false },
        },
      },
    });

    ChartUtils.enableResetZoomShortcut(charts);

    // Now wire up the default protocol
    _applyProtocol(activeProtoId);
  }

  /* ── Snapshot parser ────────────────────────────────────────────── */
  //
  // When the bridge appends a `snapshot` key to an EEG frame (produced by
  // neurofeedback.py's FeedbackEngine), we extract all pre-computed metrics
  // and overwrite the corresponding hist entries before the chart update.
  // Fields not present in the snapshot fall back to locally computed values.

  function _parseSnapshot(snap, histRef) {
    if (!snap || typeof snap !== 'object') return false;

    // Map snapshot fields → hist keys (all protocols)
    const MAP = {
      alpha_theta_ratio: 'atRatio',
      smr_score:         'smrScore',
      smr_power:         'smrPower',
      faa_score:         'faa',
      beta_suppression:  'betaSupp',
      gamma_coherence:   'frontalGamma',
      frontal_theta:     'thetaScore',
      nf_score:          'nfScore',
    };

    let any = false;
    for (const [snapKey, histKey] of Object.entries(MAP)) {
      const val = snap[snapKey];
      if (val != null && !Number.isNaN(val)) {
        // Overwrite the last rolling-push value that was just appended
        if (histRef[histKey] && histRef[histKey].length > 0) {
          histRef[histKey][histRef[histKey].length - 1] = val;
        }
        any = true;
      }
    }
    return any;
  }

  /* ── Disconnection toast ────────────────────────────────────────── */

  function _showToast() {
    const toast = _el('Toast');
    if (!toast) return;
    toast.style.display = 'flex';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(_hideToast, 8000);
  }

  function _hideToast() {
    const toast = _el('Toast');
    if (toast) toast.style.display = 'none';
  }

  /* ── Frame processing ───────────────────────────────────────────── */

  function _onFrame(frame) {
    if (!_mounted || frame.type !== 'eeg') return;
    //console.log(frame)
    _hideToast();
    if (sessionPaused) return;

    const { bands, metrics } = frame;

    // ── Raw per-channel values ────────────────────────────────────
    const ch = ch => bands[ch] ?? {};
    const avg4 = b => (['tp9','af7','af8','tp10'].reduce((s,c)=>s+(bands[c]?.[b]??0),0)/4);

    const delta = avg4('delta'), theta = avg4('theta'),
          alpha = avg4('alpha'), beta  = avg4('beta'), gamma = avg4('gamma');

    // Per-channel values for per-protocol metrics
    const af7Alpha    = ch('af7').alpha   ?? 0;
    const af8Alpha    = ch('af8').alpha   ?? 0;
    const af7Theta    = ch('af7').theta   ?? 0;
    const af8Theta    = ch('af8').theta   ?? 0;
    const af7Beta     = ch('af7').beta    ?? 0;
    const af8Beta     = ch('af8').beta    ?? 0;
    const af7Gamma    = ch('af7').gamma   ?? 0;
    const af8Gamma    = ch('af8').gamma   ?? 0;

    // ── Local metric fallbacks (used when no snapshot present) ────
    const atRatio     = metrics.at_ratio      ?? (theta / (alpha + 1e-12));
    const faa         = metrics.faa           ?? (Math.log(af8Alpha + 1e-12) - Math.log(af7Alpha + 1e-12));
    const frontalGamma= metrics.frontal_gamma ?? ((af7Gamma + af8Gamma) / 2);
    // SMR: BrainFlow doesn't separate 12-15 Hz from beta; use aux beta proxy
    const smrPower    = ch('aux1').beta ?? ((ch('tp9').beta + ch('tp10').beta) / 2 ?? 0);
    const smrScore    = 0;          // populated from snapshot when available
    const betaSupp    = 0;          // populated from snapshot when available
    const thetaScore  = 0;          // populated from snapshot when available
    const nfScore     = 0;          // populated from snapshot when available

    const label = sessionActive && hist.t0
      ? String(Math.floor((Date.now() - hist.t0) / 1000)) : '';

    const P = MAX_POINTS;
    ChartUtils.rollingPush(hist.labels,      label,       P);
    ChartUtils.rollingPush(hist.delta,       delta,       P);
    ChartUtils.rollingPush(hist.theta,       theta,       P);
    ChartUtils.rollingPush(hist.alpha,       alpha,       P);
    ChartUtils.rollingPush(hist.beta,        beta,        P);
    ChartUtils.rollingPush(hist.gamma,       gamma,       P);
    ChartUtils.rollingPush(hist.atRatio,     atRatio,     P);
    ChartUtils.rollingPush(hist.af7Alpha,    af7Alpha,    P);
    ChartUtils.rollingPush(hist.af8Alpha,    af8Alpha,    P);
    ChartUtils.rollingPush(hist.af7Theta,    af7Theta,    P);
    ChartUtils.rollingPush(hist.af8Theta,    af8Theta,    P);
    ChartUtils.rollingPush(hist.af7Beta,     af7Beta,     P);
    ChartUtils.rollingPush(hist.af8Beta,     af8Beta,     P);
    ChartUtils.rollingPush(hist.af7Gamma,    af7Gamma,    P);
    ChartUtils.rollingPush(hist.af8Gamma,    af8Gamma,    P);
    ChartUtils.rollingPush(hist.smrPower,    smrPower,    P);
    ChartUtils.rollingPush(hist.smrScore,    smrScore,    P);
    ChartUtils.rollingPush(hist.faa,         faa,         P);
    ChartUtils.rollingPush(hist.betaSupp,    betaSupp,    P);
    ChartUtils.rollingPush(hist.frontalGamma,frontalGamma,P);
    ChartUtils.rollingPush(hist.thetaScore,  thetaScore,  P);
    ChartUtils.rollingPush(hist.nfScore,     nfScore,     P);

    // ── Parse snapshot (overwrites last-pushed local values) ──────
    const hasSnap = frame.snapshot ? _parseSnapshot(frame.snapshot, hist) : false;
    _el('statSource') && (_el('statSource').textContent = hasSnap ? 'snapshot' : 'local');

    // ── Band chart ────────────────────────────────────────────────
    const L = [...hist.labels];
    charts.band.data.labels            = L;
    BANDS.forEach(
      (b,i) => {
        charts.band.data.datasets[i].data  = [...(hist[b].map(v => v/scaleFactors[b]))];
      }
    );
    charts.band.update('none');

    // ── Protocol chart ────────────────────────────────────────────
    const proto = _proto(activeProtoId);
    if (proto && charts.at) {
      charts.at.data.labels = L;
      proto.datasets.forEach((ds, i) => {
        if (ds.histKey === '_thresh') {
          charts.at.data.datasets[i].data = new Array(L.length).fill(threshold);
        } else {
          charts.at.data.datasets[i].data = [...(hist[ds.histKey] ?? [])];
        }
      });
      charts.at.update('none');

      // Primary metric stat
      const primaryKey = proto.snapshotKey;
      // Try snapshot value first, then hist
      let primaryVal = frame.snapshot?.[primaryKey];
      if (primaryVal == null) {
        const histKey = proto.datasets.find(d => d.axis === (proto.y2Label ? 'y2' : 'y') && d.histKey !== '_thresh')?.histKey
          ?? proto.datasets[0].histKey;
        primaryVal = hist[histKey]?.slice(-1)[0];
      }
      if (primaryVal != null) {
        _el('statMetric').textContent = typeof primaryVal === 'number'
          ? primaryVal.toFixed(proto.threshStep < 0.01 ? 5 : 3) : primaryVal;
      }
    }

    // ── Badge ─────────────────────────────────────────────────────
    const badge = _el('CrossoverBadge');
    const showBadge = proto?.badgeFn(hist, threshold) ?? false;
    if (badge) badge.classList.toggle('visible', showBadge);

    if (showBadge && !lastBadge && _el('fbCrossover')?.checked && sessionActive) {
      Audio.crossoverChime();
    }
    lastBadge = showBadge;

    // ── Threshold stat ────────────────────────────────────────────
    _el('statThresh').textContent = _fmtThresh(threshold, proto);

    // ── Adaptive volume ───────────────────────────────────────────
    if (sessionActive && _el('fbVolume')?.checked) {
      // atRatio-style volume adaption: scale relative to threshold
      const currentMetric = (() => {
        const pk = proto?.snapshotKey;
        const sv = frame.snapshot?.[pk];
        if (sv != null) return sv;
        const hk = proto?.datasets.find(
          d => d.axis === 'y2' && d.histKey !== '_thresh')?.histKey
          ?? proto?.datasets[0].histKey;
        return hist[hk]?.slice(-1)[0] ?? 0;
      })();
      const base = threshold > 0 ? threshold : 1;
      Audio.adaptVolume(currentMetric, base, AudioPanel.targetVolume);
    }

    // ── Adaptive threshold block logic ────────────────────────────
    if (sessionActive) {
      blockTimer++;
      const currentMetricForThresh = (() => {
        const hk = proto?.datasets.find(
          d => d.axis === (proto.y2Label ? 'y2' : 'y') && d.histKey !== '_thresh')?.histKey
          ?? proto?.datasets[0].histKey;
        return hist[hk]?.slice(-1)[0] ?? 0;
      })();

      if (currentMetricForThresh > threshold) blockAbove++;

      if (blockTimer >= blockSecs * PUSH_HZ) {
        if (_el('autoThreshold')?.checked && proto) {
          const pct = blockAbove / blockTimer;
          if (pct > threshUpPct)
            threshold = Math.min(threshold + THRESH_STEP * (proto.threshMax - proto.threshMin), proto.threshMax);
          if (pct < THRESH_DOWN_PCT)
            threshold = Math.max(threshold - THRESH_STEP * (proto.threshMax - proto.threshMin), proto.threshMin);
          const slider = _el('manualThresh');
          if (slider) slider.value = threshold;
          _el('manualThreshVal') && (_el('manualThreshVal').textContent = _fmtThresh(threshold, proto));
        }
        blockTimer = 0; blockAbove = 0;
      }
    }

    // ── Baseline collection ───────────────────────────────────────
    if (baselineActive) {
      const proto = _proto(activeProtoId);
      const bv = proto?.baselineMetric(metrics, bands) ?? atRatio;
      baselineBuffer.push(bv);
      const PUSH_HZ = 0.5;
      const pct = Math.min(baselineBuffer.length / (BASELINE_SECS * PUSH_HZ), 1);
      _el('statStatus').textContent = `Calibrating… ${Math.round(pct * 100)}%`;
      if (baselineBuffer.length >= BASELINE_SECS * PUSH_HZ) _finishBaseline();
    }
  }

  /* ── Disconnection handler ──────────────────────────────────────── */

  function _onDisconnect() {
    if (sessionActive) _showToast();
  }

  /* ── Baseline finish ────────────────────────────────────────────── */

  function _finishBaseline() {
    baselineActive = false;
    const n = baselineBuffer.length;
    const mean = baselineBuffer.reduce((s, v) => s + v, 0) / n;
    const proto = _proto(activeProtoId);

    // Set threshold just below baseline mean so training starts at the edge
    if (proto) {
      const factor = proto.direction === 'up' ? 0.95 : 1.05;
      threshold = Math.max(proto.threshMin,
                  Math.min(mean * factor, proto.threshMax));
    } else {
      threshold = Math.max(0.2, Math.min(mean * 0.95, 3.0));
    }

    // Calculate scaling factors for hist, scale charts
    if (scaleReadings === true) {
      BANDS.forEach(
        (b, i) => {
          // Set scale factors  to average / median of all hist readings per band in calibration
          scaleFactors[b] = hist[b].reduce((s, v) => s + v, 0) / hist[b].length;
          // rescale existing hist values
          charts.band.data.datasets[i].data = hist[b].map(v => (v/scaleFactors[b]));
          console.log("Scaling", b, scaleFactors[b]);
        }
      )
    }

    const slider = _el('manualThresh');
    if (slider) slider.value = threshold;
    _el('manualThreshVal') && (_el('manualThreshVal').textContent = _fmtThresh(threshold, proto));
    _el('statStatus').textContent = 'Baseline done';
    _el('startBtn').disabled      = false;
    baselineBuffer = [];
  }

  /* ── Session control ────────────────────────────────────────────── */

  function _startSession() {
    sessionActive  = true;
    sessionPaused  = false;
    hist.t0        = Date.now();
    elapsedSec     = blockTimer = blockAbove = 0;
    _el('statStatus').textContent = 'Training';
    _el('startBtn').disabled      = true;
    _el('stopBtn').disabled       = false;
    _el('PauseBtn').disabled      = false;
    _el('BaselineBtn').disabled   = true;

    AudioPanel.startSelectedSound();

    if (typeof YtAudio !== 'undefined' && _ytLoaded) {
      const ytRadio = document.querySelector('input[name="sound"][value="youtube"]');
      if (ytRadio?.checked) {
        Audio.setMasterVolume(0, 0);
        YtAudio.play();
        YtAudio.setVolume(AudioPanel.targetVolume);
      }
    }

    const beepSec = +(_el('beepInterval')?.value || 30);
    if (_el('fbBeep')?.checked) {
      Audio.scheduleBeep(beepSec,
        () => ({ score: hist[_proto(activeProtoId)?.datasets.find(
          d => d.axis === (_proto(activeProtoId)?.y2Label ? 'y2' : 'y') && d.histKey !== '_thresh')
          ?.histKey ?? 'atRatio']?.slice(-1)[0] ?? 0, threshold }),
        () => sessionActive && !sessionPaused
      );
    }

    timerInterval = setInterval(() => {
      elapsedSec++;
      const m = String(Math.floor(elapsedSec / 60));
      const s = String(elapsedSec % 60).padStart(2, '0');
      _el('statElapsed').textContent = `${m}:${s}`;
    }, 1000);
  }

  function _togglePause() {
    if (!sessionActive) return;
    sessionPaused = !sessionPaused;
    const btn = _el('PauseBtn');
    if (sessionPaused) {
      btn.textContent = 'Resume';
      btn.classList.add('btn-accent');
      _el('statStatus').textContent = 'Paused';
      Audio.stopSound();
      if (typeof YtAudio !== 'undefined') YtAudio.pause();
    } else {
      btn.textContent = 'Resume' === btn.textContent ? 'Pause' : btn.textContent;
      btn.textContent = 'Pause';
      btn.classList.remove('btn-accent');
      _el('statStatus').textContent = 'Training';
      AudioPanel.startSelectedSound();
      if (typeof YtAudio !== 'undefined' && _ytLoaded) {
        const ytRadio = document.querySelector('input[name="sound"][value="youtube"]');
        if (ytRadio?.checked) YtAudio.play();
      }
    }
  }

  function _stopSession() {
    sessionActive  = false;
    sessionPaused  = false;
    clearInterval(timerInterval);
    Audio.cancelBeep();
    Audio.stopSound();
    if (typeof YtAudio !== 'undefined') YtAudio.pause();
    _el('statStatus').textContent = 'Stopped';
    _el('startBtn').disabled      = false;
    _el('stopBtn').disabled       = true;
    _el('PauseBtn').disabled      = true;
    _el('PauseBtn').textContent   = 'Pause';
    _el('PauseBtn').classList.remove('btn-accent');
    _el('BaselineBtn').disabled   = false;
  }

  /* ── Helpers ────────────────────────────────────────────────────── */
  function _el(id) { return document.getElementById(id); }

  /* ── Mount / unmount ────────────────────────────────────────────── */

  function mount() {
    if (_mounted) return;
    _mounted = true;

    document.getElementById('modePanel').innerHTML = TEMPLATE;
    _initCharts();
    AudioPanel.init(() => sessionActive && !sessionPaused);
    WsClient.setOnFrame(_onFrame);

    // ── Protocol selector ─────────────────────────────────────────
    _el('ProtoSelect').addEventListener('change', e => {
      _applyProtocol(e.target.value);
      // Reset block counters so new protocol takes effect immediately
      blockTimer = 0; blockAbove = 0;
      // Clear ratio chart history so old protocol data doesn't bleed in
      if (charts.at) {
        const empty = () => Array(MAX_POINTS).fill(null);
        charts.at.data.labels = empty();
        charts.at.data.datasets.forEach(d => { d.data = empty(); });
        charts.at.update('none');
      }
    });

    // ── Calibrate baseline ────────────────────────────────────────
    _el('BaselineBtn').addEventListener('click', () => {
      if (!WsClient.isConnected()) { alert('Connect to the bridge first.'); return; }
      baselineActive = true; baselineBuffer = [];
      _el('startBtn').disabled       = true;
      _el('statStatus').textContent  = 'Calibrating…';
      hist.labels=[]; hist.delta=[]; hist.theta=[]; hist.alpha=[];
      hist.beta=[]; hist.gamma=[]; hist.atRatio=[]; hist.t0=null;
      // Also clear per-protocol hists
      ['af7Alpha','af8Alpha','af7Theta','af8Theta','af7Beta','af8Beta',
       'af7Gamma','af8Gamma','smrPower','smrScore','faa','betaSupp',
       'frontalGamma','thetaScore','nfScore'].forEach(k => { hist[k] = []; });
      _resetChartData();
    });

    // ── Session buttons ───────────────────────────────────────────
    _el('PauseBtn').addEventListener('click', _togglePause);
    _el('startBtn').addEventListener('click', _startSession);
    _el('stopBtn').addEventListener( 'click', _stopSession);

    // ── Toast close ───────────────────────────────────────────────
    _el('ToastClose').addEventListener('click', _hideToast);

    // ── Speed dial ────────────────────────────────────────────────
    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = +btn.dataset.idx;
        const p   = SPEED_PRESETS[idx];
        blockSecs   = p.blockSecs;
        threshUpPct = p.threshUpPct;
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _el('speedInfo').textContent = `Block: ${p.blockSecs}s · Up ≥${Math.round(p.threshUpPct*100)}%`;
        blockTimer = 0; blockAbove = 0;
      });
    });

    // ── Threshold slider ──────────────────────────────────────────
    _el('manualThresh')?.addEventListener('input', e => {
      threshold = +e.target.value;
      const proto = _proto(activeProtoId);
      _el('manualThreshVal').textContent = _fmtThresh(threshold, proto);
    });

    _el('beepInterval')?.addEventListener('input', e => {
      _el('beepIntervalVal').textContent = e.target.value + ' s';
      if (sessionActive && _el('fbBeep')?.checked) {
        Audio.scheduleBeep(+e.target.value,
          () => ({ score: hist.atRatio.slice(-1)[0] ?? 0, threshold }),
          () => sessionActive && !sessionPaused);
      }
    });

    // ── Sound / YouTube controls ──────────────────────────────────
    document.querySelectorAll('input[name="sound"]').forEach(r => {
      r.addEventListener('change', () => {
        _el('uploadRow').style.display = r.value === 'upload'  ? 'flex' : 'none';
        _el('ytRow').style.display     = r.value === 'youtube' ? 'flex' : 'none';
        if (r.value !== 'youtube' && typeof YtAudio !== 'undefined') YtAudio.pause();
      });
    });

    _el('ytLoadBtn').addEventListener('click', () => {
      const url = _el('ytUrlInput').value.trim();
      if (!url) return;
      if (typeof YtAudio === 'undefined') {
        _el('ytStatus').textContent = '⚠ youtubeAudio.js not loaded';
        return;
      }
      _el('ytStatus').textContent = 'Loading…';
      _ytLoaded = false;
      YtAudio.load(url, {
        loop: true,
        onReady: () => {
          _ytLoaded = true;
          _el('ytStatus').textContent = '✓ Ready';
          if (sessionActive && !sessionPaused) {
            Audio.setMasterVolume(0, 200);
            YtAudio.play();
            YtAudio.setVolume(AudioPanel.targetVolume);
          }
        },
        onError: msg => {
          _ytLoaded = false;
          _el('ytStatus').textContent = `✗ ${msg}`;
        },
      });
    });

    // ── WsClient disconnect watcher ───────────────────────────────
    window.addEventListener('ws-status', e => {
      if (e.detail === 'disconnected' && _mounted) _onDisconnect();
    });
  }

  function unmount() {
    if (!_mounted) return;
    _mounted = false;
    if (sessionActive) _stopSession();
    if (typeof YtAudio !== 'undefined') YtAudio.destroy();
    _ytLoaded = false;
    clearTimeout(_toastTimer);
    WsClient.setOnFrame(null);
    ChartUtils.destroyAll(charts);
    document.getElementById('modePanel').innerHTML = '';

    // Reset all state
    baselineActive = false; baselineBuffer = [];
    sessionPaused  = false; activeProtoId  = 'at';
    hist.labels=[]; hist.delta=[]; hist.theta=[]; hist.alpha=[];
    hist.beta=[]; hist.gamma=[]; hist.atRatio=[]; hist.t0=null;
    ['af7Alpha','af8Alpha','af7Theta','af8Theta','af7Beta','af8Beta',
     'af7Gamma','af8Gamma','smrPower','smrScore','faa','betaSupp',
     'frontalGamma','thetaScore','nfScore'].forEach(k => { hist[k] = []; });
  }

  return { mount, unmount };

})();
