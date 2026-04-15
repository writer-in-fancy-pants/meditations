/**
 * modes/at.js — Alpha/Theta neurofeedback mode
 * Uses EEG band powers from the muselsl WebSocket bridge.
 * Depends on: Audio, AudioPanel, ChartUtils, WsClient (globals from lib/)
 *
 * Features added vs original:
 *   • Speed dial  — 4 preset adaptation rates (blockSecs × threshUpPct)
 *   • Pause/resume — freezes chart updates and training logic, audio continues
 *   • Graph reset  — clears both charts on every recalibrate click
 *   • Gong fix     — long sustain (20 s decay, 25–30 s repeat interval)
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
  const HISTORY_SECONDS  = 120;
  const PUSH_HZ          = 4;
  const MAX_POINTS       = HISTORY_SECONDS * PUSH_HZ;
  const BASELINE_SECS    = 30;
  const THRESH_DOWN_PCT  = 0.40;
  const THRESH_STEP      = 0.05;

  // Speed presets: [ label, blockSecs, threshUpPct ]
  const SPEED_PRESETS = [
    { label: 'Relaxed',  blockSecs: 60, threshUpPct: 0.60 },
    { label: 'Standard', blockSecs: 10, threshUpPct: 0.75 },
    { label: 'Fast',     blockSecs:  5, threshUpPct: 0.90 },
    { label: 'Reactive', blockSecs:  2, threshUpPct: 0.99 },
  ];

  const BAND_COLORS = { delta:'#6b7db3', theta:'#7c75e0', alpha:'#2db891', beta:'#e07050', gamma:'#e0b020' };
  const AT_COLORS   = { alpha:'#2db891', theta:'#7c75e0', ratio:'#e07050', thresh:'rgba(255,140,60,0.55)' };

  /* ── Mutable adaptation speed (driven by speed dial) ───────────── */
  let blockSecs    = SPEED_PRESETS[0].blockSecs;
  let threshUpPct  = SPEED_PRESETS[0].threshUpPct;

  /* ── State ──────────────────────────────────────────────────────── */
  let sessionActive  = false;
  let sessionPaused  = false;
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
  let _toastTimer    = null;  // disconnect toast timeout handle
  let _ytLoaded      = false; // has a YouTube video been loaded?

  const hist = {
    labels:[], delta:[], theta:[], alpha:[], beta:[], gamma:[], atRatio:[],
    t0: null,
  };

  const charts = { band: null, at: null };

  /* ── HTML template ──────────────────────────────────────────────── */
  const TEMPLATE = `
<!-- Disconnection toast -->
<div class="at-toast" id="atToast" style="display:none">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
  EEG connection lost — data stream interrupted
  <button class="at-toast-close" id="atToastClose">×</button>
</div>

<section class="section-card">
  <div class="section-hdr">
    <span class="section-title">α/θ Session</span>
    <div class="session-actions">
      <button class="btn-sm" id="atBaselineBtn">Calibrate (30 s)</button>
      <button class="btn-sm btn-accent" id="atStartBtn">Start training</button>
      <button class="btn-sm" id="atPauseBtn" disabled>Pause</button>
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
  <!-- ── Background music ────────────────────────── -->
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
    <!-- upload row -->
    <div class="upload-row" id="uploadRow" style="display:none">
      <input type="file" id="audioUpload" accept=".wav,.mp3" style="display:none" />
      <button class="btn-sm" id="audioUploadBtn">Choose WAV / MP3…</button>
      <span class="upload-name" id="uploadName">No file</span>
    </div>
    <!-- youtube row -->
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

  <!-- ── Feedback options ────────────────────────── -->
  <section class="ctrl-card">
    <div class="ctrl-title">Feedback options</div>
    <label class="fb-chk"><input type="checkbox" id="fbVolume" checked />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Adaptive volume</span>
        <span class="fb-chk-sub">Music softens when θ/α exceeds threshold, deepening inward focus</span>
      </div>
    </label>
    <label class="fb-chk"><input type="checkbox" id="fbBeep" checked />
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

  <!-- ── Threshold + speed dial ──────────────────── -->
  <section class="ctrl-card">
    <div class="ctrl-title">Adaptive threshold</div>
    <p class="ctrl-desc">Auto-adjusts each block. Set adaptation speed below.</p>
    <label class="fb-chk"><input type="checkbox" id="autoThreshold" checked />
      <div class="fb-chk-body">
        <span class="fb-chk-title">Auto-adjust threshold</span>
        <span class="fb-chk-sub">Nan et al. 2014 staircase method</span>
      </div>
    </label>

    <!-- Speed dial -->
    <div class="ctrl-label" style="margin-top:.75rem">Adaptation speed</div>
    <div class="speed-dial" id="speedDial">
      ${SPEED_PRESETS.map((p,i) =>
        `<button class="speed-btn${i===0?' active':''}" data-idx="${i}">${p.label}</button>`
      ).join('')}
    </div>
    <p class="speed-info" id="speedInfo">Block: ${SPEED_PRESETS[0].blockSecs}s · Up ≥${Math.round(SPEED_PRESETS[0].threshUpPct*100)}%</p>

    <div class="fb-sub-row" style="margin-top:.75rem">
      <label class="vol-lbl">Manual threshold</label>
      <input type="range" id="manualThresh" min="0.2" max="3.0" step="0.05" value="1.0" />
      <span class="vol-val" id="manualThreshVal">1.00</span>
    </div>
  </section>
</div>`;

  /* ── Chart helpers ──────────────────────────────────────────────── */

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
          y2: {
            position:'right',
            ticks:{ font:{size:10}, color:cc.tick, callback:v=>v.toFixed(2) },
            grid:{drawOnChartArea:false},
            title:{display:true, text:'θ/α ratio', font:{size:10}, color:cc.title},
          },
        },
      },
    });
  }

  /* ── Disconnection toast ────────────────────────────────────────── */

  function _showToast() {
    const toast = _el('atToast');
    if (!toast) return;
    toast.style.display = 'flex';
    clearTimeout(_toastTimer);
    // Auto-dismiss after 8 s
    _toastTimer = setTimeout(_hideToast, 8000);
  }

  function _hideToast() {
    const toast = _el('atToast');
    if (toast) toast.style.display = 'none';
  }

  /* ── Frame processing ───────────────────────────────────────────── */

  function _onFrame(frame) {
    if (!_mounted || frame.type !== 'eeg') return;

    // Got a frame → hide any disconnection toast
    _hideToast();

    // If paused, accept frames (keeps bridge alive) but skip chart/training
    if (sessionPaused) return;

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

    const L = [...hist.labels];

    // Band chart
    charts.band.data.labels            = L;
    charts.band.data.datasets[0].data  = [...hist.delta];
    charts.band.data.datasets[1].data  = [...hist.theta];
    charts.band.data.datasets[2].data  = [...hist.alpha];
    charts.band.data.datasets[3].data  = [...hist.beta];
    charts.band.data.datasets[4].data  = [...hist.gamma];
    charts.band.update('none');

    // AT chart
    charts.at.data.labels              = L;
    charts.at.data.datasets[0].data    = [...hist.alpha];
    charts.at.data.datasets[1].data    = [...hist.theta];
    charts.at.data.datasets[2].data    = [...hist.atRatio];
    charts.at.data.datasets[3].data    = new Array(L.length).fill(threshold);
    charts.at.update('none');

    // Crossover badge
    const crossover = theta > alpha;
    const badge = _el('atCrossoverBadge');
    if (badge) badge.classList.toggle('visible', crossover);
    if (crossover && !lastCrossover && _el('fbCrossover')?.checked && sessionActive)
      Audio.crossoverChime();
    lastCrossover = crossover;

    // Stats
    _el('atStatAT').textContent     = atRatio.toFixed(3);
    _el('atStatAlpha').textContent  = alpha.toExponential(2);
    _el('atStatTheta').textContent  = theta.toExponential(2);
    _el('atStatThresh').textContent = threshold.toFixed(2);

    // Training logic (only while session active and not paused)
    if (sessionActive) {
      if (_el('fbVolume')?.checked) {
        const base = threshold > 0 ? threshold : 1;
        Audio.adaptVolume(atRatio, base, AudioPanel.targetVolume);
      }
      blockTimer++;
      if (atRatio > threshold) blockAbove++;
      if (blockTimer >= blockSecs * PUSH_HZ) {
        if (_el('autoThreshold')?.checked) {
          const pct = blockAbove / blockTimer;
          if (pct > threshUpPct)   threshold = Math.min(threshold + THRESH_STEP, 3.0);
          if (pct < THRESH_DOWN_PCT) threshold = Math.max(threshold - THRESH_STEP, 0.2);
          _el('manualThresh').value          = threshold.toFixed(2);
          _el('manualThreshVal').textContent = threshold.toFixed(2);
        }
        blockTimer = 0; blockAbove = 0;
      }
    }

    // Baseline collection
    if (baselineActive) {
      baselineBuffer.push({ alpha, theta, atRatio });
      const pct = Math.min(baselineBuffer.length / (BASELINE_SECS * PUSH_HZ), 1);
      _el('atStatStatus').textContent = `Calibrating… ${Math.round(pct*100)}%`;
      if (baselineBuffer.length >= BASELINE_SECS * PUSH_HZ) _finishBaseline();
    }
  }

  /* ── Disconnection handler (called by app.js via WsClient.setOnStatus) ── */
  // NOTE: modes cannot set their own onStatus because app.js owns that.
  // Instead app.js must call AT.onDisconnect() when status becomes 'disconnected'.
  // See mount() — we register a secondary status watcher on the shared WsClient.
  function _onDisconnect() {
    if (sessionActive) _showToast();
  }

  /* ── Baseline ────────────────────────────────────────────────────── */

  function _finishBaseline() {
    baselineActive = false;
    const n = baselineBuffer.length;
    baseline.alpha   = baselineBuffer.reduce((s,f) => s+f.alpha,   0)/n;
    baseline.theta   = baselineBuffer.reduce((s,f) => s+f.theta,   0)/n;
    baseline.atRatio = baselineBuffer.reduce((s,f) => s+f.atRatio, 0)/n;
    threshold = Math.max(0.2, Math.min(baseline.atRatio * 0.95, 3.0));
    _el('manualThresh').value          = threshold.toFixed(2);
    _el('manualThreshVal').textContent = threshold.toFixed(2);
    _el('atStatStatus').textContent    = 'Baseline done';
    _el('atStartBtn').disabled         = false;
    baselineBuffer = [];
  }

  /* ── Session control ─────────────────────────────────────────────── */

  function _startSession() {
    sessionActive  = true;
    sessionPaused  = false;
    hist.t0        = Date.now();
    elapsedSec     = blockTimer = blockAbove = 0;
    _el('atStatStatus').textContent = 'Training';
    _el('atStartBtn').disabled      = true;
    _el('atPauseBtn').disabled      = false;
    _el('atStopBtn').disabled       = false;
    _el('atBaselineBtn').disabled   = true;

    AudioPanel.startSelectedSound();
    // YouTube: play if already loaded
    if (_el('sound-youtube')?.checked || _ytLoaded) {
      const ytRadio = document.querySelector('input[name="sound"][value="youtube"]');
      if (ytRadio?.checked && _ytLoaded) {
        Audio.setMasterVolume(0, 0);  // silence Web Audio during YT play
        if (typeof YtAudio !== 'undefined') {
          YtAudio.play();
          YtAudio.setVolume(AudioPanel.targetVolume);
        }
      }
    }

    const beepSec = +(_el('beepInterval')?.value || 30);
    if (_el('fbBeep')?.checked) {
      Audio.scheduleBeep(beepSec,
        () => ({ score: hist.atRatio.slice(-1)[0] ?? 0, threshold }),
        () => sessionActive && !sessionPaused
      );
    }

    timerInterval = setInterval(() => {
      if (!sessionPaused) {
        elapsedSec++;
        const m = String(Math.floor(elapsedSec/60));
        const s = String(elapsedSec%60).padStart(2,'0');
        _el('atStatElapsed').textContent = `${m}:${s}`;
      }
    }, 1000);
  }

  function _togglePause() {
    if (!sessionActive) return;
    sessionPaused = !sessionPaused;
    const btn = _el('atPauseBtn');
    if (sessionPaused) {
      btn.textContent = 'Resume';
      btn.classList.add('btn-accent');
      _el('atStatStatus').textContent = 'Paused';
      Audio.stopSound();
      if (typeof YtAudio !== 'undefined') YtAudio.pause();
    } else {
      btn.textContent = 'Pause';
      btn.classList.remove('btn-accent');
      _el('atStatStatus').textContent = 'Training';
      AudioPanel.startSelectedSound();
      if (typeof YtAudio !== 'undefined' && _ytLoaded) {
        const ytRadio = document.querySelector('input[name="sound"][value="youtube"]');
        if (ytRadio?.checked) YtAudio.play();
      }
    }
  }

  function _stopSession() {
    sessionActive = false;
    sessionPaused = false;
    clearInterval(timerInterval);
    Audio.cancelBeep();
    Audio.stopSound();
    if (typeof YtAudio !== 'undefined') YtAudio.pause();
    _el('atStatStatus').textContent = 'Stopped';
    _el('atStartBtn').disabled      = false;
    _el('atPauseBtn').disabled      = true;
    _el('atPauseBtn').textContent   = 'Pause';
    _el('atPauseBtn').classList.remove('btn-accent');
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
    AudioPanel.init(() => sessionActive && !sessionPaused);
    WsClient.setOnFrame(_onFrame);

    // ── Baseline button ──────────────────────────────────────────
    _el('atBaselineBtn').addEventListener('click', () => {
      if (!WsClient.isConnected()) { alert('Connect to the bridge first.'); return; }
      baselineActive = true; baselineBuffer = [];
      _el('atStartBtn').disabled = true;
      _el('atStatStatus').textContent = 'Calibrating…';
      // Reset both charts so user sees fresh data from this calibration
      hist.labels=[]; hist.delta=[]; hist.theta=[]; hist.alpha=[];
      hist.beta=[]; hist.gamma=[]; hist.atRatio=[]; hist.t0=null;
      _resetChartData();
    });

    // ── Session buttons ──────────────────────────────────────────
    _el('atStartBtn').addEventListener('click', _startSession);
    _el('atPauseBtn').addEventListener('click', _togglePause);
    _el('atStopBtn').addEventListener('click',  _stopSession);

    // ── Toast close ──────────────────────────────────────────────
    _el('atToastClose').addEventListener('click', _hideToast);

    // ── Speed dial ───────────────────────────────────────────────
    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = +btn.dataset.idx;
        const p = SPEED_PRESETS[idx];
        blockSecs   = p.blockSecs;
        threshUpPct = p.threshUpPct;
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _el('speedInfo').textContent = `Block: ${p.blockSecs}s · Up ≥${Math.round(p.threshUpPct*100)}%`;
        // Reset block counters so new speed takes effect immediately
        blockTimer = 0; blockAbove = 0;
      });
    });

    // ── Threshold slider ─────────────────────────────────────────
    _el('manualThresh')?.addEventListener('input', e => {
      threshold = +e.target.value;
      _el('manualThreshVal').textContent = (+e.target.value).toFixed(2);
    });

    // ── Beep interval ────────────────────────────────────────────
    _el('beepInterval')?.addEventListener('input', e => {
      _el('beepIntervalVal').textContent = e.target.value + ' s';
      if (sessionActive && _el('fbBeep')?.checked) {
        Audio.scheduleBeep(+e.target.value,
          () => ({ score: hist.atRatio.slice(-1)[0]??0, threshold }),
          () => sessionActive && !sessionPaused);
      }
    });

    // ── YouTube controls ─────────────────────────────────────────
    // Show/hide yt row alongside upload row based on radio selection
    document.querySelectorAll('input[name="sound"]').forEach(r => {
      r.addEventListener('change', () => {
        _el('uploadRow').style.display = r.value === 'upload'  ? 'flex' : 'none';
        _el('ytRow').style.display     = r.value === 'youtube' ? 'flex' : 'none';
        // If switching away from youtube, pause it
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
        onError: (msg) => {
          _ytLoaded = false;
          _el('ytStatus').textContent = `✗ ${msg}`;
        },
      });
    });

    // ── WsClient status watcher for disconnect toast ─────────────
    // We piggy-back on WsClient by wrapping its existing status callback
    // rather than replacing it (app.js owns setOnStatus).
    // Use a CustomEvent on window so app.js can trigger it.
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
    baselineActive = false; baselineBuffer = [];
    sessionPaused  = false;
    hist.labels=[]; hist.delta=[]; hist.theta=[]; hist.alpha=[];
    hist.beta=[]; hist.gamma=[]; hist.atRatio=[]; hist.t0=null;
  }

  return { mount, unmount };

})();
