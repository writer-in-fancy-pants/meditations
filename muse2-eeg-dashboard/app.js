/* ================================================================
   EEG Session Comparator — app.js
   Expects muselsl CSV: timestamps, TP9, AF7, AF8, TP10 (raw µV @ 256 Hz)
   ================================================================ */
'use strict';

/* ── Constants ─────────────────────────────────────────────────── */

const FS = 256; // sample rate Hz
const PSD_SEG_LEN = 512;

const BANDS = {
  delta: [0.5, 4],
  theta: [4,   8],
  alpha: [8,  13],
  beta:  [13, 30],
  gamma: [30, 44],
};

/* Precomputed - like Muse S Athena */
/**
 * Candidate column name patterns for pre-computed band CSVs (Muse S Athena etc.).
 * Keys are internal band names; values are ordered lists of substrings to match
 * against lowercased, underscore-normalised header tokens.
 * First match wins.
 */
const PRECOMPUTED_COL_PATTERNS = {
  delta: ['delta_absolute', 'delta_abs', 'delta'],
  theta: ['theta_absolute', 'theta_abs', 'theta'],
  alpha: ['alpha_absolute', 'alpha_abs', 'alpha'],
  beta:  ['beta_absolute',  'beta_abs',  'beta'],
  gamma: ['gamma_absolute', 'gamma_abs', 'gamma'],
};

/**
 * Channel groups for pre-computed files.
 * Many Muse exports give per-electrode columns; we average into the four
 * virtual channels expected by computeMetric().
 * Each entry maps an internal channel name to column substrings to try.
 */
const PRECOMPUTED_CHANNEL_PATTERNS = {
  tp9:  { delta: ['delta_tp9'],  theta: ['theta_tp9'],  alpha: ['alpha_tp9'],  beta: ['beta_tp9'],  gamma: ['gamma_tp9']  },
  af7:  { delta: ['delta_af7'],  theta: ['theta_af7'],  alpha: ['alpha_af7'],  beta: ['beta_af7'],  gamma: ['gamma_af7']  },
  af8:  { delta: ['delta_af8'],  theta: ['theta_af8'],  alpha: ['alpha_af8'],  beta: ['beta_af8'],  gamma: ['gamma_af8']  },
  tp10: { delta: ['delta_tp10'], theta: ['theta_tp10'], alpha: ['alpha_tp10'], beta: ['beta_tp10'], gamma: ['gamma_tp10'] },
};
/*----*/

const METRICS = {
  focus:      { label: 'Focus score',          desc: 'Frontal (AF7+AF8) β/(α+θ) — sustained attention' },
  relaxation: { label: 'Relaxation score',     desc: 'Temporal (TP9+TP10) α power — calm resting state' },
  meditation: { label: 'Meditation depth',     desc: 'Frontal θ/α ratio — deep meditative absorption' },
  stress:     { label: 'Stress index',         desc: 'Frontal (β+γ)/(α+θ) — cognitive tension load' },
  asymmetry:  { label: 'Frontal α asymmetry',  desc: 'ln(AF8 α) − ln(AF7 α) — valence / approach motivation' },
  engagement: { label: 'Engagement index',     desc: 'β/(α+θ) averaged across all 4 channels' },
  delta:      { label: 'δ Delta power',        desc: '0.5–4 Hz mean across all channels' },
  theta:      { label: 'θ Theta power',        desc: '4–8 Hz mean across all channels' },
  alpha:      { label: 'α Alpha power',        desc: '8–13 Hz mean across all channels' },
  beta:       { label: 'β Beta power',         desc: '13–30 Hz mean across all channels' },
  gamma:      { label: 'γ Gamma power',        desc: '30–44 Hz mean across all channels' },
  psd_slice:  { label: 'PSD slice (bin k)',    desc: 'Raw PSD power at a single frequency bin k, tracked across the session' },

  // ── Chaos / nonlinear dynamics ────────────────────────────────
  lle:        { label: 'Largest Lyapunov Exp', desc: 'Mean LLE across all 4 channels — positive = chaotic dynamics, near-zero = ordered/periodic brain state' },
  corr_dim:   { label: 'Correlation Dimension', desc: 'Mean fractal dimension D₂ (Grassberger–Procaccia) — reflects complexity / degrees of freedom in the EEG attractor' },
  chaos_index:{ label: 'Chaos Index (combined)', desc: 'Composite nonlinear score: normalised LLE × D₂ × spectral entropy — near-perfect state classifier' },
};

/** Metric groupings reused by the chaos-metric checkboxes and the per-file combined charts. */
const BAND_METRIC_KEYS  = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
const NEURO_METRIC_KEYS = ['focus', 'relaxation', 'meditation', 'stress', 'asymmetry', 'engagement'];
const CHAOS_METRIC_KEYS = ['lle', 'corr_dim', 'chaos_index'];

/** Session palette — each entry has hex (line), bg (pill fill), txt (pill text). */
const PALETTE = [
  { hex: '#7c75e0', bg: '#2a2845', txt: '#b8b3f5' },
  { hex: '#2db891', bg: '#1a3530', txt: '#7dd6bc' },
  { hex: '#e07050', bg: '#3a2018', txt: '#f0a080' },
  { hex: '#5a9fe0', bg: '#1a2a40', txt: '#92c0f0' },
  { hex: '#d96090', bg: '#3a1828', txt: '#f090b8' },
  { hex: '#d0901a', bg: '#382808', txt: '#f0b860' },
  { hex: '#72b830', bg: '#1c2e08', txt: '#a0d868' },
  { hex: '#e05050', bg: '#381010', txt: '#f09090' },
];

/* ── Application state ─────────────────────────────────────────── */

let sessions  = [];
let charts    = {};       // metric -> Chart instance (session-comparison view)
let timeMode  = 'min'; // 'min' | 'pct'
let psdBinK = 10; // default bin index (~5 Hz at 512-pt FFT, 256 Hz SR → df=0.5 Hz)

// Bumped every time renderCharts()/renderSummary() run. Async work in flight
// from a previous call checks its captured value against the live counter
// before touching the DOM, so a stale computation can never clobber a newer
// render (e.g. rapid metric-checkbox toggling, or removing a session while
// a chaos-metric chart is still crunching numbers).
let chartGen   = 0;
let summaryGen = 0;

/* ── Metric Worker: async, off-main-thread computation ────────────
   computeMetric() is cheap for the simple band-power metrics, but the
   chaos/nonlinear-dynamics metrics (lle, corr_dim, chaos_index) are
   O(N²) per 4-second frame and can take hundreds of milliseconds per
   session — long enough to freeze scrolling, chart interaction, and
   the PSD-slice slider if run on the main thread.

   Each session's frame data (band powers + raw segments/PSDs) is sent
   to a persistent Worker once ("registered"); after that, computing
   any metric's per-frame series for that session is a single
   postMessage round trip. Callers get a Promise and paint results in
   as they arrive — the UI thread is never blocked waiting on chaos math.

   If a Worker can't be created or crashes (e.g. restrictive sandbox),
   we transparently fall back to the original synchronous computeMetric()
   defined further down in this file, so the app keeps working either way.
────────────────────────────────────────────────────────────────── */

let metricWorker   = null;
let workerAvailable = true;
let workerReqId     = 0;
const workerPending    = new Map();    // reqId -> { resolve, reject }
const workerRegistered = new WeakMap(); // session object -> registration Promise
const metricSeriesCache = new WeakMap(); // session object -> metric -> series

// Inject styling for pieces that don't depend on the host page's CSS: the
// busy cursor, per-chart zoom toolbar/reset button, and the per-file tab bar.
(function injectAppStyles() {
  const style = document.createElement('style');
  style.textContent = `
    html.worker-busy, html.worker-busy * { cursor: progress !important; }

    .chart-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .zoom-reset-btn {
      flex: 0 0 auto; font-size: 11px; line-height: 1.4; padding: 3px 10px; margin-top: 1px;
      border-radius: 6px; border: 1px solid currentColor; opacity: .55; cursor: pointer;
      background: transparent; color: inherit; white-space: nowrap;
    }
    .zoom-reset-btn:hover { opacity: 1; }
    .zoom-hint { font-size: 10px; opacity: .5; margin-top: 4px; }

    .per-file-section { margin: 22px 0; }
    .per-file-heading h3 { font-size: 15px; }
    .per-file-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
    .per-file-tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 13px; border-radius: 999px; font-size: 13px; cursor: pointer;
      border: 1px solid var(--tab-color, #888); background: transparent; color: inherit; opacity: .75;
    }
    .per-file-tab:hover { opacity: 1; }
    .per-file-tab.active { background: var(--tab-color, #888); color: #fff; opacity: 1; border-color: transparent; }
    .per-file-body { display: flex; flex-direction: column; gap: 16px; }
  `;
  document.head.appendChild(style);
})();

/** Show/hide the busy cursor for as long as any worker request is in flight. */
function setWorkerBusy(busy) {
  document.documentElement.classList.toggle('worker-busy', busy);
}

// Register chartjs-plugin-zoom if its script tag has been added to the page
// (it self-registers in most builds, but this covers UMD builds that don't).
// Zoom/pan options are included in every chart below regardless — Chart.js
// simply ignores unknown plugin option blocks, so nothing breaks if the
// plugin script hasn't been added yet; zoom/pan just won't be active.
(function registerZoomPlugin() {
  if (typeof Chart === 'undefined') return;
  const zoomPlugin = window.ChartZoom || window.chartjsPluginZoom;
  if (zoomPlugin && typeof Chart.register === 'function') {
    try { Chart.register(zoomPlugin); } catch (_) { /* already registered */ }
  }
})();

/**
 * Shared zoom/pan config for every chart: mouse-wheel zoom, drag-to-select
 * a rectangular x/y region, and ctrl+drag to pan. Bounded so you can't pan
 * or zoom out past the chart's own data range. Requires chartjs-plugin-zoom
 * to be loaded on the page (see index.html) — see registerZoomPlugin() above.
 */
function zoomPanOptions() {
  return {
    limits: {
      x: { min: 'original', max: 'original' },
      y: { min: 'original', max: 'original' },
    },
    pan: {
      enabled: true,
      mode: 'xy',
      modifierKey: 'ctrl',
    },
    zoom: {
      wheel: { enabled: true, speed: 0.08 },
      pinch: { enabled: true },
      drag: {
        enabled: true,
        backgroundColor: 'rgba(124, 117, 224, 0.15)',
        borderColor: 'rgba(124, 117, 224, 0.6)',
        borderWidth: 1,
      },
      mode: 'xy',
    },
  };
}

function getMetricWorker() {
  if (metricWorker || !workerAvailable) return metricWorker;
  try {
    metricWorker = new Worker('metricWorker.js');
    metricWorker.addEventListener('message', e => {
      const { id, ok, result, error } = e.data;
      const pending = workerPending.get(id);
      if (!pending) return;
      workerPending.delete(id);
      if (workerPending.size === 0) setWorkerBusy(false);
      ok ? pending.resolve(result) : pending.reject(new Error(error));
    });
    metricWorker.addEventListener('error', err => {
      console.error('Metric worker crashed — falling back to main-thread compute:', err.message || err);
      workerAvailable = false;
      for (const p of workerPending.values()) p.reject(err);
      workerPending.clear();
      setWorkerBusy(false);
      metricWorker.terminate();
      metricWorker = null;
    });
  } catch (err) {
    console.error('Could not start metric worker, computing on main thread instead:', err);
    workerAvailable = false;
    metricWorker = null;
  }
  return metricWorker;
}

/** Send one request to the worker and resolve/reject when its reply arrives. */
function postToWorker(msg) {
  const worker = getMetricWorker();
  if (!worker) return Promise.reject(new Error('metric worker unavailable'));
  const id = ++workerReqId;
  return new Promise((resolve, reject) => {
    workerPending.set(id, { resolve, reject });
    setWorkerBusy(true);
    worker.postMessage({ ...msg, id });
  });
}

/**
 * Send a session's frame data (band powers + raw segments/PSDs) to the
 * worker once. Memoised per session object via a WeakMap, so repeated
 * chart renders for the same session are a cheap no-op here.
 */
function registerSessionWithWorker(session) {
  const existing = workerRegistered.get(session);
  if (existing) return existing;

  const frames = session.frames.map(fr => ({
    bp:      fr.bp,
    rawSegs: fr.rawSegs || null,
    psds:    fr.psds    || null,
  }));
  const promise = postToWorker({ type: 'registerSession', sessionName: session.name, frames })
    .catch(err => { workerRegistered.delete(session); throw err; });
  workerRegistered.set(session, promise);
  return promise;
}

/** Tell the worker to release a session's cached data (e.g. on removal). */
function dropSessionFromWorker(session) {
  workerRegistered.delete(session);
  metricSeriesCache.delete(session);
  const worker = getMetricWorker();
  if (worker) worker.postMessage({ type: 'dropSession', sessionName: session.name });
}

/**
 * Resolve to a Float64Array (or plain array) of per-frame metric values
 * for one session — computed in the Worker when possible, without ever
 * blocking the UI thread. Falls back to synchronous main-thread
 * computeMetric() if the Worker is unavailable.
 */
async function computeMetricSeriesAsync(metric, session) {
  const cached = metricSeriesCache.get(session);
  if (cached && cached.has(metric)) return cached.get(metric);

  let result;
  try {
    await registerSessionWithWorker(session);
    result = await postToWorker({ type: 'computeSeries', metric, sessionName: session.name });
  } catch (err) {
    result = session.frames.map((fr, fi) => computeMetric(metric, fr.bp, fr, session.name, fi));
  }

  let cache = metricSeriesCache.get(session);
  if (!cache) { cache = new Map(); metricSeriesCache.set(session, cache); }
  cache.set(metric, result);
  return result;
}

/* ── Theme ─────────────────────────────────────────────────────── */

(function initTheme() {
  // Dark is the default (set on <html> in markup). Persist user choice.
  const saved = localStorage.getItem('eeg-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  updateThemeButton();
})();

function updateThemeButton() {
  const isDark  = document.documentElement.getAttribute('data-theme') === 'dark';
  const label   = document.getElementById('themeLabel');
  if (label) label.textContent = isDark ? 'Light mode' : 'Dark mode';
}

document.getElementById('themeToggle').addEventListener('click', () => {
  const html    = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next    = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('eeg-theme', next);
  updateThemeButton();
  // Re-render charts so axis colours update
  renderCharts();
});

/* ── DSP helpers ───────────────────────────────────────────────── */

function hann(N) {
  return Float64Array.from({ length: N }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1))));
}

function fft(signal) {
  const n = signal.length;
  const re = new Float64Array(signal);
  const im = new Float64Array(n);
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe=re[i+k], uIm=im[i+k];
        const vRe=re[i+k+len/2], vIm=im[i+k+len/2];
        const tRe=curRe*vRe-curIm*vIm, tIm=curRe*vIm+curIm*vRe;
        re[i+k]=uRe+tRe; im[i+k]=uIm+tIm;
        re[i+k+len/2]=uRe-tRe; im[i+k+len/2]=uIm-tIm;
        const nr=curRe*wRe-curIm*wIm; curIm=curRe*wIm+curIm*wRe; curRe=nr;
      }
    }
  }
  return {re, im};
}

/**
 * Welch's averaged PSD estimate.
 * @param {number[]} signal
 * @param {number}   segLen   FFT window size (must be power of 2)
 * @param {number}   overlap  Samples of overlap between windows
 * @returns {Float64Array|null}  One-sided PSD of length segLen/2+1, or null if too short
 */
function welchPSD(signal, segLen = 512, overlap = 256) {
  const step = segLen - overlap;
  const win  = hann(segLen);
  //const f = new FFT(segLen);
  const nSeg = Math.floor((signal.length - overlap) / step);
  if (nSeg < 1) return null;

  const psd = new Float64Array(segLen / 2 + 1);
  let count = 0;

  for (let s = 0; s < nSeg; s++) {
    const start = s * step;
    if (start + segLen > signal.length) break;
    const seg = new Float64Array(segLen);

    //for (let i = 0; i < segLen; i++) seg[i] = signal[start + i] * win[i];
    let mean = 0;
    for (let i = 0; i < segLen; i++) mean += signal[start + i];
    mean /= segLen;
    for (let i = 0; i < segLen; i++) seg[i] = (signal[start + i] - mean) * win[i];

    const {re:fRe,im:fIm}=fft(seg);
    for(let k=0;k<=segLen/2;k++) psd[k]+=fRe[k]*fRe[k]+fIm[k]*fIm[k];
    
    // Using indutany/fft.js
    //const realOut = new Float64Array(segLen);
    //f.realTransform(realOut, seg);
    //for(let k=0;k<=segLen/2;k++) psd[k]+=realOut[k]*realOut[k];
    count++;
  }

  //const scale = count * FS * segLen;
  let winEnergy = 0;
  for (let i = 0; i < segLen; i++) winEnergy += win[i] * win[i];
  const scale = count * FS * winEnergy;
  
  for (let k = 0; k <= segLen / 2; k++) psd[k] /= scale;
  for (let k = 1; k <  segLen / 2; k++) psd[k] *= 2; // one-sided doubling

  return psd;
}

/**
 * Integrate PSD bins within [fLow, fHigh] Hz, return mean bin power.
 */
function bandPower(psd, segLen, fLow, fHigh) {
  const df = FS / segLen;
  let sum = 0, n = 0;
  for (let k = 0; k < psd.length; k++) {
    const f = k * df;
    if (f >= fLow && f <= fHigh) { sum += psd[k]; n++; }
  }
  return n ? sum / n : 0;
}

/* ── Chaos / nonlinear-dynamics helpers ────────────────────────── */

/**
 * Time-delay embedding of a 1-D signal into m-dimensional phase space.
 * Returns an array of m-vectors (each a plain Float64Array).
 *
 * @param {ArrayLike<number>} x   Input signal
 * @param {number}            m   Embedding dimension (default 3)
 * @param {number}            tau Delay in samples (default ~10 ms @ 256 Hz → 3)
 * @returns {Float64Array[]}
 */
function embedPhaseSpace(x, m = 3, tau = 3) {
  const N = x.length - (m - 1) * tau;
  const pts = new Array(N);
  for (let i = 0; i < N; i++) {
    const v = new Float64Array(m);
    for (let d = 0; d < m; d++) v[d] = x[i + d * tau];
    pts[i] = v;
  }
  return pts;
}

/** Euclidean distance between two same-length Float64Arrays. */
function euclidDist(a, b) {
  let s = 0;
  for (let d = 0; d < a.length; d++) { const diff = a[d] - b[d]; s += diff * diff; }
  return Math.sqrt(s);
}

/**
 * Rosenstein et al. (1993) Largest Lyapunov Exponent estimator.
 *
 * For every point in the embedded trajectory, we find its nearest neighbour
 * (excluding a Theiler window to avoid temporal correlates), then track the
 * average log-divergence over `evolveSteps` steps.  The slope of that curve
 * is the LLE estimate (in bits/sample; multiply by FS for bits/s).
 *
 * The full O(N²) pass is bounded to ≤ MAX_PTS points to keep per-frame
 * compute under ~5 ms on a modern laptop.
 *
 * @param {ArrayLike<number>} signal  Raw µV window
 * @param {number} m             Embedding dimension
 * @param {number} tau           Embedding delay (samples)
 * @param {number} theilerW      Theiler window (samples) – exclusion zone
 * @param {number} evolveSteps   Number of steps to track divergence
 * @returns {number}  LLE estimate (can be negative for highly ordered signals)
 */
function largestLyapunovExponent(signal, m = 3, tau = 3, theilerW = 20, evolveSteps = 20) {
  const MAX_PTS = 300; // cap for speed
  const pts = embedPhaseSpace(signal, m, tau);
  if (pts.length < evolveSteps + 2) return 0;

  // Subsample if too many points
  const step = pts.length > MAX_PTS ? Math.floor(pts.length / MAX_PTS) : 1;
  const subset = [];
  for (let i = 0; i < pts.length; i += step) subset.push({ pt: pts[i], idx: i });

  // Accumulate mean-log-divergence at each evolution step
  const divSum   = new Float64Array(evolveSteps);
  const divCount = new Int32Array(evolveSteps);

  for (let qi = 0; qi < subset.length; qi++) {
    const { pt: q, idx: qIdx } = subset[qi];

    // Find nearest neighbour outside Theiler window
    let nnIdx = -1, nnDist = Infinity;
    for (let ri = 0; ri < pts.length; ri++) {
      if (Math.abs(ri - qIdx) <= theilerW) continue;
      const d = euclidDist(q, pts[ri]);
      if (d < nnDist && d > 0) { nnDist = d; nnIdx = ri; }
    }
    if (nnIdx < 0 || nnDist === 0) continue;

    // Track divergence over evolveSteps
    for (let k = 1; k <= evolveSteps; k++) {
      const qi2 = qIdx + k, ri2 = nnIdx + k;
      if (qi2 >= pts.length || ri2 >= pts.length) break;
      const dk = euclidDist(pts[qi2], pts[ri2]);
      if (dk > 0) {
        divSum[k - 1]   += Math.log(dk / nnDist);
        divCount[k - 1] += 1;
      }
    }
  }

  // Slope of mean log-divergence vs step index (linear regression)
  const valid = [];
  for (let k = 0; k < evolveSteps; k++) {
    if (divCount[k] > 0) valid.push({ x: k + 1, y: divSum[k] / divCount[k] });
  }
  if (valid.length < 3) return 0;

  const n     = valid.length;
  const sumX  = valid.reduce((s, p) => s + p.x, 0);
  const sumY  = valid.reduce((s, p) => s + p.y, 0);
  const sumXY = valid.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = valid.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

/**
 * Grassberger–Procaccia Correlation Dimension (D₂) estimator.
 *
 * Computes the correlation integral C(r) for a log-spaced range of radii r,
 * then extracts the slope d(log C)/d(log r) as D₂ via linear regression on
 * the scaling region.
 *
 * Bounded to MAX_PTS² / 2 pair comparisons for speed.
 *
 * @param {ArrayLike<number>} signal
 * @param {number} m    Embedding dimension
 * @param {number} tau  Embedding delay
 * @param {number} nR   Number of radius steps
 * @returns {number}  D₂ estimate (typically 1–5 for EEG)
 */
function correlationDimension(signal, m = 3, tau = 3, nR = 20) {
  const MAX_PTS = 200;
  const pts = embedPhaseSpace(signal, m, tau);
  if (pts.length < 10) return 0;

  const step = pts.length > MAX_PTS ? Math.floor(pts.length / MAX_PTS) : 1;
  const sub  = [];
  for (let i = 0; i < pts.length; i += step) sub.push(pts[i]);

  // Precompute all pairwise distances
  const N      = sub.length;
  const dists  = [];
  for (let i = 0; i < N - 1; i++) {
    for (let j = i + 1; j < N; j++) {
      dists.push(euclidDist(sub[i], sub[j]));
    }
  }
  if (dists.length === 0) return 0;
  dists.sort((a, b) => a - b);

  const rMin = dists[Math.floor(dists.length * 0.02)];
  const rMax = dists[Math.floor(dists.length * 0.90)];
  if (rMax <= rMin || rMin <= 0) return 0;

  // Log-spaced radii
  const logMin = Math.log(rMin), logMax = Math.log(rMax);
  const logR = Array.from({ length: nR }, (_, k) => logMin + k * (logMax - logMin) / (nR - 1));

  // Correlation integral: fraction of pairs within radius r
  const total   = dists.length;
  const logCorr = [];
  let   pairIdx = 0;
  for (const lr of logR) {
    const r = Math.exp(lr);
    while (pairIdx < total && dists[pairIdx] <= r) pairIdx++;
    const C = pairIdx / total;
    if (C > 0) logCorr.push({ x: lr, y: Math.log(C) });
  }
  if (logCorr.length < 4) return 0;

  // Linear regression on middle 50 % of scaling region
  const trim = Math.floor(logCorr.length * 0.25);
  const reg  = logCorr.slice(trim, logCorr.length - trim);
  if (reg.length < 2) return 0;

  const n     = reg.length;
  const sumX  = reg.reduce((s, p) => s + p.x, 0);
  const sumY  = reg.reduce((s, p) => s + p.y, 0);
  const sumXY = reg.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = reg.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  return Math.max(0, slope);
}

/**
 * Spectral entropy of a PSD (Shannon entropy of normalised spectral density).
 * @param {Float64Array} psd
 * @returns {number} H in [0, 1]
 */
function spectralEntropy(psd) {
  let total = 0;
  for (let k = 0; k < psd.length; k++) total += psd[k];
  if (total === 0) return 0;
  let H = 0;
  for (let k = 0; k < psd.length; k++) {
    const p = psd[k] / total;
    if (p > 0) H -= p * Math.log2(p);
  }
  return H / Math.log2(psd.length); // normalise to [0,1]
}

/**
 * Cache for per-frame chaos values (LLE + D₂) so they are only computed once.
 * Key: `${sessionName}::${frameIndex}::${channel}`
 */
const _chaosCache = new Map();

/**
 * Compute LLE and D₂ for one raw-signal window, with memoisation.
 * Falls back to zero for pre-computed (band-only) sessions.
 *
 * @param {number[]} rawSeg  Raw µV samples
 * @param {string}   cacheKey
 * @returns {{ lle: number, d2: number }}
 */
function cachedChaos(rawSeg, cacheKey) {
  if (_chaosCache.has(cacheKey)) return _chaosCache.get(cacheKey);
  const result = {
    lle: largestLyapunovExponent(rawSeg),
    d2:  correlationDimension(rawSeg),
  };
  _chaosCache.set(cacheKey, result);
  return result;
}


function computeBands(signal) {
  const segLen = PSD_SEG_LEN;
  const psd    = welchPSD(signal, segLen, 256);
  if (!psd) return null;
  const r = {};
  for (const [name, [lo, hi]] of Object.entries(BANDS)) r[name] = bandPower(psd, segLen, lo, hi);
  return r;
}

/* ── Neurofeedback metric formulas ─────────────────────────────── */

const avg = (...v) => v.reduce((a, b) => a + b, 0) / v.length;
const safeLog = v   => Math.log(Math.max(v, 1e-12));

/**
 * Derive a scalar score from per-channel band powers (and optionally raw segments).
 * @param {string} metric
 * @param {{ tp9, af7, af8, tp10 }} bp  Each value is { delta, theta, alpha, beta, gamma }
 * @param {Object} [frame]  Full frame object (needed for chaos metrics that require raw signal)
 * @param {string} [sessionName]  Used to key the chaos cache
 * @param {number} [frameIdx]
 */
function computeMetric(metric, bp, frame, sessionName, frameIdx) {
  const { tp9, af7, af8, tp10 } = bp;
  const eps = 1e-12;

  switch (metric) {
    case 'focus':
      return avg(af7.beta, af8.beta) / (avg(af7.alpha, af8.alpha) + avg(af7.theta, af8.theta) + eps);

    case 'relaxation':
      return avg(tp9.alpha, tp10.alpha);

    case 'meditation':
      return avg(af7.theta, af8.theta, tp9.theta, tp10.theta) /
             (avg(af7.alpha, af8.alpha, tp9.alpha, tp10.alpha) + eps);

    case 'stress':
      return (avg(af7.beta, af8.beta) + avg(af7.gamma, af8.gamma)) /
             (avg(af7.alpha, af8.alpha) + avg(af7.theta, af8.theta) + eps);

    case 'asymmetry':
      return safeLog(af8.alpha) - safeLog(af7.alpha);

    case 'engagement':
      return avg(af7.beta, af8.beta, tp9.beta, tp10.beta) /
             (avg(af7.alpha, af8.alpha, tp9.alpha, tp10.alpha) +
              avg(af7.theta, af8.theta, tp9.theta, tp10.theta) + eps);

    case 'delta': return avg(tp9.delta, af7.delta, af8.delta, tp10.delta);
    case 'theta': return avg(tp9.theta, af7.theta, af8.theta, tp10.theta);
    case 'alpha': return avg(tp9.alpha, af7.alpha, af8.alpha, tp10.alpha);
    case 'beta':  return avg(tp9.beta,  af7.beta,  af8.beta,  tp10.beta);
    case 'gamma': return avg(tp9.gamma, af7.gamma, af8.gamma, tp10.gamma);

    // ── Chaos / nonlinear dynamics ─────────────────────────────────────────
    case 'lle': {
      if (!frame || !frame.rawSegs) return 0; // pre-computed session — no raw signal
      const channels = ['tp9', 'af7', 'af8', 'tp10'];
      const lles = channels.map(ch => {
        const key = `${sessionName}::${frameIdx}::${ch}::lle`;
        return cachedChaos(frame.rawSegs[ch], key).lle;
      });
      return lles.reduce((a, b) => a + b, 0) / lles.length;
    }

    case 'corr_dim': {
      if (!frame || !frame.rawSegs) return 0;
      const channels = ['tp9', 'af7', 'af8', 'tp10'];
      const dims = channels.map(ch => {
        const key = `${sessionName}::${frameIdx}::${ch}::corr_dim`;
        return cachedChaos(frame.rawSegs[ch], key).d2;
      });
      return dims.reduce((a, b) => a + b, 0) / dims.length;
    }

    case 'chaos_index': {
      if (!frame || !frame.rawSegs) return 0;
      const channels = ['tp9', 'af7', 'af8', 'tp10'];

      let lleMean = 0, d2Mean = 0, seSum = 0;
      for (const ch of channels) {
        const key = `${sessionName}::${frameIdx}::${ch}`;
        const chaos = cachedChaos(frame.rawSegs[ch], key + '::ci');
        lleMean += chaos.lle;
        d2Mean  += chaos.d2;
        // Spectral entropy from the pre-computed PSD in the frame
        if (frame.psds && frame.psds[ch]) seSum += spectralEntropy(frame.psds[ch]);
      }
      lleMean /= channels.length;
      d2Mean  /= channels.length;
      seSum   /= channels.length; // normalised [0,1]

      // Soft-clamp LLE to [0, 0.5] before normalising
      const lleNorm = Math.max(0, Math.min(lleMean, 0.5)) / 0.5;
      // D₂ typically 1–5 for scalp EEG; normalise to [0,1]
      const d2Norm  = Math.max(0, Math.min(d2Mean, 5))   / 5;
      // Composite: geometric mean of three independent complexity indices
      return Math.pow(lleNorm * d2Norm * seSum, 1 / 3);
    }

    default: return 0;
  }
}

/* ── CSV parsing ───────────────────────────────────────────────── */

/**
 * Parse a muselsl EEG CSV.
 * @returns {{ filename, raw: { tp9, af7, af8, tp10, ts } }|null}
 */
function parseMuselslCSV(text, filename) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  const hdr    = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idxTs  = hdr.findIndex(h => h.includes('timestamp') || h === 'time');
  const idxTP9 = hdr.findIndex(h => h === 'tp9' || h === 'eeg_1');
  const idxAF7 = hdr.findIndex(h => h === 'af7' || h === 'eeg_2');
  const idxAF8 = hdr.findIndex(h => h === 'af8' || h === 'eeg_3');
  const idxTP10= hdr.findIndex(h => h === 'tp10'|| h === 'eeg_4');

  if ([idxTP9, idxAF7, idxAF8, idxTP10].some(i => i < 0)) return null;

  const raw = { tp9: [], af7: [], af8: [], tp10: [], ts: [] };

  for (let i = 1; i < lines.length; i++) {
    const c   = lines[i].split(',');
    if (c.length < 4) continue;
    const tp9 = parseFloat(c[idxTP9]);
    const af7 = parseFloat(c[idxAF7]);
    const af8 = parseFloat(c[idxAF8]);
    const tp10= parseFloat(c[idxTP10]);
    if ([tp9, af7, af8, tp10].some(isNaN)) continue;
    raw.tp9.push(tp9); raw.af7.push(af7); raw.af8.push(af8); raw.tp10.push(tp10);
    raw.ts.push(idxTs >= 0 ? parseFloat(c[idxTs]) : i / FS);
  }

  if (raw.tp9.length < FS * 2) return null;
  return { filename, raw };
}

/**
 * Parse a CSV that already contains band power columns (e.g. Muse S Athena exports).
 * Supports two layouts:
 *   A) Per-electrode columns: Delta_TP9, Alpha_AF7 … (Mind Monitor style)
 *   B) Single averaged columns: Delta_Absolute, Alpha_Absolute … (Muse Direct style)
 *
 * Returns null if the file doesn't look like a pre-computed band CSV.
 * Sets session.precomputed = true and session.hasPSD = false on the result.
 *
 * @returns {{ filename, rows: Array<{tSec, bp}>, durationSec }|null}
 */
function parsePrecomputedCSV(text, filename) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  const rawHdr = lines[0].split(',').map(h => h.trim());
  const hdr    = rawHdr.map(h => h.toLowerCase().replace(/[\s\-]+/g, '_'));

  // Helper: find first header index whose token includes any of the given substrings
  const findCol = (candidates) =>
    hdr.findIndex(h => candidates.some(c => h.includes(c)));

  const idxTs = hdr.findIndex(h => h.includes('timestamp') || h === 'time');

  // ── Layout detection ────────────────────────────────────────────────────────
  // Try per-electrode layout first (requires at least one electrode-specific col)
  const chPatterns = PRECOMPUTED_CHANNEL_PATTERNS;
  const perElectrodeIdx = {};
  let perElectrodeValid = true;

  for (const [ch, bands] of Object.entries(chPatterns)) {
    perElectrodeIdx[ch] = {};
    for (const [band, candidates] of Object.entries(bands)) {
      const idx = findCol(candidates);
      perElectrodeIdx[ch][band] = idx; // may be -1
    }
    // Channel is usable if at least one band column found
    const found = Object.values(perElectrodeIdx[ch]).filter(i => i >= 0).length;
    if (found === 0) perElectrodeValid = false;
  }

  // Try averaged layout
  const avgIdx = {};
  let avgValid = true;
  for (const [band, candidates] of Object.entries(PRECOMPUTED_COL_PATTERNS)) {
    const idx = findCol(candidates);
    avgIdx[band] = idx;
    if (idx < 0) avgValid = false;
  }

  if (!perElectrodeValid && !avgValid) return null;

  const usePerElectrode = perElectrodeValid;

  // ── Row parsing ─────────────────────────────────────────────────────────────
  const rows = [];
  let t0 = null;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length < 2) continue;

    //const ts = idxTs >= 0 ? parseFloat(cells[idxTs]) : i;
    const ts = idxTs >= 0 ? (new Date(cells[idxTs]).getTime()/1000.0 ): i;
    if (isNaN(ts)) continue;
    if (t0 === null) t0 = ts;

    let bp;
    if (usePerElectrode) {
      // Build bp with best-effort per-channel values; fall back to cross-channel
      // average for any missing electrode column.
      const chBands = {};
      for (const [ch, bands] of Object.entries(perElectrodeIdx)) {
        chBands[ch] = {};
        for (const [band, idx] of Object.entries(bands)) {
          chBands[ch][band] = idx >= 0 ? parseFloat(cells[idx]) : NaN;
        }
      }

      // For each band, compute a fallback average across channels that have a value
      const bandFallback = {};
      for (const band of Object.keys(BANDS)) {
        const vals = Object.values(chBands).map(b => b[band]).filter(v => !isNaN(v));
        bandFallback[band] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      }

      // Fill missing per-channel values from fallback
      bp = {};
      for (const ch of ['tp9', 'af7', 'af8', 'tp10']) {
        bp[ch] = {};
        for (const band of Object.keys(BANDS)) {
          const v = chBands[ch][band];
          bp[ch][band] = isNaN(v) ? bandFallback[band] : v;
        }
      }
    } else {
      // Averaged layout — same value broadcast to all four virtual channels
      const shared = {};
      for (const [band, idx] of Object.entries(avgIdx)) {
        shared[band] = parseFloat(cells[idx]);
        if (isNaN(shared[band])) shared[band] = 0;
      }
      bp = { tp9: shared, af7: shared, af8: shared, tp10: shared };
    }

    // Skip rows that look like all-zero artefacts
    const anyNonZero = Object.values(bp.af7).some(v => v !== 0);
    if (!anyNonZero) continue;

    rows.push({ tSec: ts - t0, bp, t: ts });
  }

  if (rows.length < 2) return null;

  const durationSec = rows[rows.length - 1].t - rows[0].t;

  return {
    filename,
    rows,
    durationSec,
    precomputed: true,
    hasPSD: false,
    nSamples: rows.length,
    layout: usePerElectrode ? 'per-electrode' : 'averaged',
  };
}

/**
 * Convert parsed pre-computed rows into the same session shape that
 * processSession() produces, so all downstream rendering is identical.
 * Frames are the rows themselves — no windowing needed.
 */
function processPrecomputedSession(parsed) {
  const { filename, rows, durationSec, nSamples, layout } = parsed;

  // Frames mirror the muselsl shape: { t, tSec, bp, psds }
  // psds is null for pre-computed sessions — the PSD slice chart skips them.
  const frames = rows.map(r => ({
    t:    r.t,
    tSec: r.tSec,
    bp:   r.bp,
    psds: null,
  }));

  return {
    name:        filename.replace(/\.csv$/i, ''),
    frames,
    durationSec,
    nSamples,
    precomputed: true,
    hasPSD:      false,
    layout,       // 'per-electrode' | 'averaged' — shown in pill tooltip
  };
}

/* ── Session processing ────────────────────────────────────────── */

/**
 * Slide a 4-second window in 1-second steps over all channels,
 * computing band powers at each frame.
 */
function processSession(parsed, onProgress) {
  const { filename, raw } = parsed;
  const totalSamples = raw.tp9.length;
  const winSamples   = FS * 4;
  const stepSamples  = FS;
  const nFrames      = Math.floor((totalSamples - winSamples) / stepSamples) + 1;
  const channels     = ['tp9', 'af7', 'af8', 'tp10'];
  const frames       = [];

  for (let f = 0; f < nFrames; f++) {
    const start = f * stepSamples;
    const bp    = {};
    const psds  = {};
    for (const ch of channels) {
      const seg = raw[ch].slice(start, start + winSamples);
      const psd = welchPSD(seg, PSD_SEG_LEN, 256);
      psds[ch]   = psd || new Float64Array(PSD_SEG_LEN / 2 + 1);
      bp[ch]     = psd ? (() => {
        const r = {};
        for (const [name, [lo, hi]] of Object.entries(BANDS)) r[name] = bandPower(psd, PSD_SEG_LEN, lo, hi);
        return r;
      })() : { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    }
    const midIdx = start + Math.floor(winSamples / 2);
    // Store raw segments for chaos analysis (kept as views to avoid large copies)
    const rawSegs = {};
    for (const ch of channels) rawSegs[ch] = raw[ch].slice(start, start + winSamples);
    frames.push({ t: raw.ts[midIdx], bp, psds, rawSegs });
    if (onProgress) onProgress((f + 1) / nFrames);
  }

  // Attach relative time (seconds from session start) to each frame
  console.log(totalSamples, frames.length);
  const t0 = frames[0].t;
  frames.forEach(fr => { fr.tSec = fr.t - t0; });

  return {
    name:        filename.replace(/\.csv$/i, ''),
    frames,
    durationSec: raw.ts[raw.ts.length - 1] - raw.ts[0],
    nSamples:    totalSamples,
  };
}

/* ── File handling ─────────────────────────────────────────────── */

async function readFileText(file) {
  return new Promise(resolve => {
    const r  = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.readAsText(file);
  });
}

async function handleFiles(files) {
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressMsg  = document.getElementById('progressMsg');

  progressWrap.style.display = 'block';

  for (const file of files) {
    progressMsg.textContent   = `Parsing ${file.name}…`;
    progressFill.style.width  = '5%';
    await tick();

    const text   = await readFileText(file);

    // ── Detect format and parse ──────────────────────────────────────────────
    let session = null;

    // Try muselsl raw format first (has TP9/AF7/AF8/TP10 raw µV columns)
    const parsedRaw = parseMuselslCSV(text, file.name);
    if (parsedRaw) {
      progressMsg.textContent = `Computing band powers for ${file.name}…`;
      await tick();
      session = processSession(parsedRaw, p => {
        progressFill.style.width = Math.round(5 + p * 90) + '%';
      });
    }

    // Fall back to pre-computed band CSV (Muse S Athena, Mind Monitor, etc.)
    if (!session) {
      const parsedPre = parsePrecomputedCSV(text, file.name);
      if (parsedPre) {
        progressMsg.textContent = `Loading pre-computed bands for ${file.name}…`;
        await tick();
        session = processPrecomputedSession(parsedPre);
      }
    }

    if (!session) {
      alert(`"${file.name}" could not be parsed.\n\nExpected either:\n• muselsl raw CSV (columns: timestamps, TP9, AF7, AF8, TP10)\n• Pre-computed band CSV (columns: Delta/Theta/Alpha/Beta/Gamma, optionally per electrode)`);
      continue;
    }

    const idx = sessions.findIndex(s => s.name === session.name);
    if (idx >= 0) { dropSessionFromWorker(sessions[idx]); sessions[idx] = session; }
    else sessions.push(session);

    // Kick off worker registration now (fire-and-forget) so it's already
    // in flight by the time render() asks for any metric series.
    registerSessionWithWorker(session).catch(() => { /* handled lazily on first use */ });

    progressFill.style.width = '100%';
    await tick(50);
  }

  progressWrap.style.display = 'none';
  render();
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/* ── Render: pills + summary ───────────────────────────────────── */

function render() {
  const ctrlSection = document.getElementById('controlsSection');
  const pillsEl     = document.getElementById('pills');

  pillsEl.innerHTML = '';

  if (sessions.length === 0) {
    ctrlSection.style.display = 'none';
    document.getElementById('chartStack').innerHTML = `
      <div class="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/>
        </svg>
        <p>Upload muselsl CSV files to begin comparing sessions</p>
      </div>`;
    return;
  }

  ctrlSection.style.display = 'block';

  sessions.forEach((s, i) => {
    const c   = PALETTE[i % PALETTE.length];
    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.style.cssText = `background:${c.bg};color:${c.txt};border-color:${c.hex}55`;
    pill.innerHTML = `
      <span class="pill-dot" style="background:${c.hex}"></span>
      ${s.name}
      <span class="pill-dur">${(s.durationSec / 60).toFixed(1)}min</span>
      ${s.precomputed ? `<span class="pill-dur" title="Layout: ${s.layout}">· pre-computed</span>` : ''}
      <button class="pill-x" data-idx="${i}" title="Remove session">×</button>`;
    pillsEl.appendChild(pill);
  });

  renderSummary();
  renderCharts();
  renderPerFileView();
}

document.getElementById('pills').addEventListener('click', e => {
  const btn = e.target.closest('.pill-x');
  if (!btn) return;
  const [removed] = sessions.splice(+btn.dataset.idx, 1);
  if (removed) dropSessionFromWorker(removed);
  render();
});

/* ── Render: summary stat cards ────────────────────────────────── */

function meanOf(arr) {
  const v = arr.filter(x => isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function summaryCardHTML(lbl, val, sub) {
  return `<div class="scard">
       <div class="scard-lbl">${lbl}</div>
       <div class="scard-val">${val}</div>
       <div class="scard-sub">${sub}</div>
     </div>`;
}

async function renderSummary() {
  const myGen  = ++summaryGen;
  const avgDur = (sessions.reduce((a, s) => a + s.durationSec, 0) / sessions.length / 60).toFixed(1);

  // Paint immediately — focus/relaxation need computeMetric (potentially
  // routed through the worker), so show a placeholder until they resolve.
  document.getElementById('summaryGrid').innerHTML =
    summaryCardHTML('Sessions',        sessions.length, 'loaded') +
    summaryCardHTML('Best focus',      '…',              'computing…') +
    summaryCardHTML('Best relaxation', '…',              'computing…') +
    summaryCardHTML('Avg duration',    avgDur + 'min',   'per session');

  const perSession = await Promise.all(sessions.map(async s => {
    const [focusSeries, relaxSeries] = await Promise.all([
      computeMetricSeriesAsync('focus', s),
      computeMetricSeriesAsync('relaxation', s),
    ]);
    return {
      name:  s.name,
      focus: meanOf(Array.from(focusSeries)),
      relax: meanOf(Array.from(relaxSeries)),
    };
  }));

  if (myGen !== summaryGen) return; // a newer renderSummary() call superseded this one

  let bestFocus = '—', bestFocusV = -Infinity;
  let bestRelax = '—', bestRelaxV = -Infinity;
  perSession.forEach(({ name, focus, relax }) => {
    if (focus > bestFocusV) { bestFocusV = focus; bestFocus = name.slice(0, 16); }
    if (relax > bestRelaxV) { bestRelaxV = relax; bestRelax = name.slice(0, 16); }
  });

  document.getElementById('summaryGrid').innerHTML =
    summaryCardHTML('Sessions',        sessions.length, 'loaded') +
    summaryCardHTML('Best focus',      bestFocus,        'highest frontal β/α') +
    summaryCardHTML('Best relaxation', bestRelax,        'highest temporal α') +
    summaryCardHTML('Avg duration',    avgDur + 'min',   'per session');
}

/* ── Frequency power spectrum ───────────────────────────────────────── */
/** Returns the frequency (Hz) for bin k given PSD_SEG_LEN and FS */
function binToHz(k) {
  return +(k * FS / PSD_SEG_LEN).toFixed(2);
}

/** Which named band does a frequency fall in, or 'broadband' */
function freqToBandName(hz) {
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    if (hz >= lo && hz <= hi) return name;
  }
  return 'broadband';
}

/**
 * Builds and appends the PSD slice chart card to `stack`.
 * Called from renderCharts when 'psd_slice' is in chosen metrics.
 */
function buildPsdSliceCard(stack, cc, isMin, maxMin, pctLabels) {
  const N   = 120;
  const cid = 'chart_psd_slice';
  const maxK = PSD_SEG_LEN / 2; // Nyquist bin

  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = 'psdSliceCard';

  card.innerHTML = `
    <div class="chart-toolbar">
      <div>
        <div class="chart-title">PSD slice (bin k)</div>
        <div class="chart-desc">Raw PSD power at a single frequency bin, compared across sessions. Drag the slider to scan frequency.</div>
      </div>
      <button class="zoom-reset-btn" data-registry="main" data-chart-key="psd_slice">Reset zoom</button>
    </div>
    <div class="psd-controls">
      <input type="range" class="psd-slider" id="psdSlider"
             min="1" max="${maxK}" step="1" value="${psdBinK}" />
      <span class="psd-freq-label">k = <strong id="psdKVal">${psdBinK}</strong> → <strong id="psdHzVal">${binToHz(psdBinK)} Hz</strong></span>
      <span class="psd-band-badge" id="psdBandBadge">${freqToBandName(binToHz(psdBinK))}</span>
    </div>
    <div class="chart-wrap"><canvas id="${cid}"></canvas></div>
    <div class="legend" id="psdSliceLegend"></div>
    <div class="zoom-hint">Scroll to zoom · drag to select a region · ctrl+drag to pan</div>`;

  stack.appendChild(card);

  function getDatasets(k) {
    return sessions
      .filter(s => s.hasPSD !== false)   // skip pre-computed sessions
      .map((s, i) => {
        // find original palette index by name so colours stay consistent
        const origIdx = sessions.findIndex(sess => sess.name === s.name);
        const c = PALETTE[origIdx % PALETTE.length];

      if (isMin) {
        const data = s.frames.map(fr => ({
          x: +(fr.tSec / 60).toFixed(4),
          y: +avg(...Object.values(fr.psds).map(psd => psd[k] ?? 0)).toFixed(8),
        }));
        return {
          label: s.name, data,
          borderColor: c.hex, backgroundColor: c.hex + '20',
          borderWidth: 2, pointRadius: 0, tension: 0.35,
          fill: false, spanGaps: true, parsing: false,
        };
      } else {
        const raw      = s.frames.map(fr => avg(...Object.values(fr.psds).map(psd => psd[k] ?? 0)));
        const smoothed = smooth(raw);
        const data     = resampleToPct(smoothed, N).map(v => v !== null ? +v.toFixed(8) : null);
        return {
          label: s.name, data,
          borderColor: c.hex, backgroundColor: c.hex + '20',
          borderWidth: 2, pointRadius: 0, tension: 0.35,
          fill: false, spanGaps: true,
        };
      }
    });
  }

  function updateLegend(k) {
    const legendEl = document.getElementById('psdSliceLegend');
    if (!legendEl) return;
    legendEl.innerHTML = sessions.map((s, i) => {
      const c   = PALETTE[i % PALETTE.length];
      const avg_ = meanOf(s.frames.map(fr => avg(...Object.values(fr.psds).map(psd => psd[k] ?? 0))));
      return `<span class="leg-item">
                <span class="leg-dot" style="background:${c.hex}"></span>
                ${s.name} — avg ${avg_.toExponential(2)}
              </span>`;
    }).join('');
  }

  // Initial render
  setTimeout(() => {
    const ctx = document.getElementById(cid);
    if (!ctx) return;

    const xScale = buildXScale(cc, isMin, maxMin);

    charts['psd_slice'] = new Chart(ctx, {
      type: 'line',
      data: isMin ? { datasets: getDatasets(psdBinK) } : { labels: pctLabels, datasets: getDatasets(psdBinK) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: { label: c => `${c.dataset.label}: ${(+c.parsed.y).toExponential(3)}` },
          },
          zoom: zoomPanOptions(),
        },
        scales: {
          x: xScale,
          y: {
            ticks: { font: { size: 11 }, color: cc.tick, callback: v => (+v).toExponential(1) },
            grid:  { color: cc.grid },
            title: { display: true, text: 'PSD (µV²/Hz)', font: { size: 11 }, color: cc.title },
          },
        },
      },
    });

    updateLegend(psdBinK);

    // Slider interaction — update chart data in-place without full re-render
    document.getElementById('psdSlider').addEventListener('input', e => {
      const k   = +e.target.value;
      psdBinK   = k;
      const hz  = binToHz(k);
      document.getElementById('psdKVal').textContent   = k;
      document.getElementById('psdHzVal').textContent  = hz + ' Hz';
      document.getElementById('psdBandBadge').textContent = freqToBandName(hz);

      const ch = charts['psd_slice'];
      if (!ch) return;
      const newDs = getDatasets(k);
      ch.data.datasets.forEach((ds, i) => { ds.data = newDs[i].data; });
      ch.update('none'); // skip animation for smooth scrubbing
      updateLegend(k);
    });
  }, 0);
}

/* ── Render: charts ────────────────────────────────────────────── */

function smooth(arr, w = 5) {
  return arr.map((_, i) => {
    const s   = Math.max(0, i - Math.floor(w / 2));
    const e   = Math.min(arr.length - 1, i + Math.floor(w / 2));
    const sl  = arr.slice(s, e + 1).filter(x => x !== null && isFinite(x));
    return sl.length ? sl.reduce((a, b) => a + b, 0) / sl.length : null;
  });
}

function resampleToPct(vals, N = 120) {
  if (vals.length === 0) return new Array(N).fill(null);
  return Array.from({ length: N }, (_, k) => {
    const fi = k * (vals.length - 1) / (N - 1);
    const lo = Math.floor(fi), hi = Math.min(lo + 1, vals.length - 1);
    const t  = fi - lo;
    const a  = vals[lo], b = vals[hi];
    if (a === null || b === null) return a ?? b;
    return a * (1 - t) + b * t;
  });
}

/** Read CSS variable colours for Chart.js (must be called at render time). */
function chartColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    grid:  s.getPropertyValue('--chart-grid').trim()       || 'rgba(255,255,255,0.06)',
    tick:  s.getPropertyValue('--chart-tick').trim()       || '#666',
    title: s.getPropertyValue('--chart-axis-title').trim() || '#888',
  };
}

/**
 * Build one Chart.js dataset from an already-computed metric series (a
 * Float64Array/array of per-frame values) for a single session, respecting
 * the current timeMode. Shared by the session-comparison charts (one
 * dataset per session) and the per-file combined charts (one dataset per
 * metric, for a single session).
 */
function seriesToDataset(session, label, colorHex, rawSeries, N = 120) {
  const smoothed = smooth(Array.from(rawSeries));

  if (timeMode === 'pct') {
    const data = resampleToPct(smoothed, N).map(v => v !== null ? +v.toFixed(5) : null);
    return {
      label, data,
      borderColor: colorHex, backgroundColor: colorHex + '20',
      borderWidth: 2, pointRadius: 0, tension: 0.35,
      fill: false, spanGaps: true,
    };
  }
  // Minutes: {x, y} scatter data — sessions end at their own duration
  const data = session.frames.map((fr, k) => ({
    x: +(fr.tSec / 60).toFixed(4),
    y: smoothed[k] !== null ? +smoothed[k].toFixed(5) : null,
  }));
  return {
    label, data,
    borderColor: colorHex, backgroundColor: colorHex + '20',
    borderWidth: 2, pointRadius: 0, tension: 0.35,
    fill: false, spanGaps: true, parsing: false,
  };
}

/** Build the shared x-axis scale config (minutes or session-progress %). */
function buildXScale(cc, isMin, maxMin) {
  return isMin
    ? {
        type: 'linear', min: 0, max: maxMin,
        ticks: { font: { size: 11 }, color: cc.tick, maxTicksLimit: 10,
                 callback: v => v.toFixed(1) + 'm' },
        grid:  { color: cc.grid },
        title: { display: true, text: 'Time (minutes)', font: { size: 11 }, color: cc.title },
      }
    : {
        ticks: { maxTicksLimit: 11, font: { size: 11 }, color: cc.tick },
        grid:  { color: cc.grid },
        title: { display: true, text: 'Session progress', font: { size: 11 }, color: cc.title },
      };
}

/**
 * Pure/synchronous: turn already-fetched per-session metric series into
 * Chart.js datasets. Takes no dependency on computeMetric so it can run
 * immediately once the (possibly worker-computed) series have resolved.
 */
function datasetsFromSeries(seriesPerSession) {
  return sessions.map((s, i) => {
    const c = PALETTE[i % PALETTE.length];
    return seriesToDataset(s, s.name, c.hex, seriesPerSession[i]);
  });
}

function renderCharts() {
  const myGen   = ++chartGen;
  const stack   = document.getElementById('chartStack');
  const chosen  = [...document.querySelectorAll('#controlsSection input[type="checkbox"]:checked')]
    .map(cb => cb.value);

  // Destroy old Chart instances
  Object.values(charts).forEach(c => c.destroy());
  charts = {};
  stack.innerHTML = '';

  if (chosen.length === 0) {
    stack.innerHTML = '<div class="empty-state"><p>Select at least one metric above.</p></div>';
    return;
  }

  const N         = 120;
  const pctLabels = Array.from({ length: N }, (_, i) => Math.round(i * 100 / (N - 1)) + '%');
  const maxMin    = Math.ceil(Math.max(...sessions.map(s => s.durationSec / 60)) * 10) / 10;
  const cc        = chartColors();
  const isMin     = timeMode === 'min';

  chosen.forEach(metric => {
    const m    = METRICS[metric];
    const cid  = 'chart_' + metric;

    if (metric === 'psd_slice') {
      buildPsdSliceCard(stack, cc, isMin, maxMin, pctLabels);
      return;
    }

    // Paint the card immediately — computing the series may be routed
    // through the worker, so the chart body starts as a loading state
    // and the UI stays fully interactive while it crunches numbers.
    const card = document.createElement('div');
    card.className = 'chart-card';
    card.innerHTML = `
      <div class="chart-toolbar">
        <div>
          <div class="chart-title">${m.label}</div>
          <div class="chart-desc">${m.desc}</div>
        </div>
        <button class="zoom-reset-btn" data-registry="main" data-chart-key="${metric}">Reset zoom</button>
      </div>
      <div class="chart-wrap"><canvas id="${cid}"></canvas></div>
      <div class="legend" id="legend_${metric}"><span class="leg-item leg-loading">Computing…</span></div>
      <div class="zoom-hint">Scroll to zoom · drag to select a region · ctrl+drag to pan</div>`;
    stack.appendChild(card);

    renderMetricChart({ metric, m, cid, myGen, isMin, maxMin, pctLabels, cc });
  });
}

/**
 * Fetches one metric's per-session series (async, off the main thread when
 * possible) and then fills in that metric's legend + Chart.js instance.
 * Bails out silently if a newer renderCharts() call has since replaced the
 * DOM (checked via `myGen` against the live `chartGen` counter).
 */
async function renderMetricChart({ metric, m, cid, myGen, isMin, maxMin, pctLabels, cc }) {
  const seriesPerSession = await Promise.all(
    sessions.map(s => computeMetricSeriesAsync(metric, s))
  );

  if (myGen !== chartGen) return; // stale — a newer render() call took over

  const legendEl = document.getElementById(`legend_${metric}`);
  if (legendEl) {
    legendEl.innerHTML = sessions.map((s, i) => {
      const c   = PALETTE[i % PALETTE.length];
      const avg = meanOf(Array.from(seriesPerSession[i]));
      const dur = (s.durationSec / 60).toFixed(1);
      return `<span class="leg-item">
                <span class="leg-dot" style="background:${c.hex}"></span>
                ${s.name} (${dur}min) — avg ${avg.toFixed(3)}
              </span>`;
    }).join('');
  }

  const ctx = document.getElementById(cid);
  if (!ctx) return; // card was removed before data arrived

  const datasets = datasetsFromSeries(seriesPerSession);
  const xScale   = buildXScale(cc, isMin, maxMin);

  charts[metric] = new Chart(ctx, {
    type: 'line',
    data: isMin ? { datasets } : { labels: pctLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: { label: c => `${c.dataset.label}: ${(+c.parsed.y).toFixed(4)}` },
        },
        zoom: zoomPanOptions(),
      },
      scales: {
        x: xScale,
        y: {
          ticks: { font: { size: 11 }, color: cc.tick, callback: v => (+v).toFixed(3) },
          grid:  { color: cc.grid },
          title: { display: true, text: m.label, font: { size: 11 }, color: cc.title },
        },
      },
    },
  });

  // Note sessions excluded from PSD slice chart
  const excluded = sessions.filter(s => s.hasPSD === false);
  if (excluded.length) {
    const note = document.createElement('p');
    note.className = 'psd-unavail-note';
    note.innerHTML = `<span>ⓘ</span> ${excluded.map(s => s.name).join(', ')} excluded — pre-computed files have no raw PSD.`;
    //document.getElementById('psdSliceCard').appendChild(note);
  }
}

/* ── Per-file view: bands / chaos / neurofeedback combined per session ───
   The comparison charts above are one-metric-per-chart, multi-session.
   This view instead shows one session at a time with all 5 bands on one
   chart, all 3 chaos/nonlinear-dynamics metrics on one chart, and all 6
   neurofeedback metrics on one chart — useful for reading a single
   recording's internal relationships rather than comparing sessions.
────────────────────────────────────────────────────────────────────── */

const PER_FILE_GROUPS = [
  { key: 'bands', title: 'All frequency bands',       desc: 'δ/θ/α/β/γ band power together, per session.',            metrics: BAND_METRIC_KEYS  },
  { key: 'chaos', title: 'Chaos indices',              desc: 'LLE, correlation dimension & combined chaos index, per session.', metrics: CHAOS_METRIC_KEYS },
  { key: 'neuro', title: 'Neurofeedback metrics',      desc: 'Focus, relaxation, meditation, stress, asymmetry & engagement, per session.', metrics: NEURO_METRIC_KEYS },
];

let activeFileSession = null; // the session object currently shown in the per-file tabs
let perFileGen         = 0;   // stale-render guard, same pattern as chartGen/summaryGen
const perFileCharts     = {}; // "<group>" -> Chart instance, for the shared reset-zoom delegate

function ensurePerFileSection() {
  let section = document.getElementById('perFileSection');
  if (section) return section;

  section = document.createElement('div');
  section.id = 'perFileSection';
  section.className = 'per-file-section';
  section.innerHTML = `
    <div class="per-file-heading">
      <h3>Per-file view</h3>
      <p class="chart-desc">All bands, chaos indices, and neurofeedback metrics for one file at a time.</p>
    </div>
    <div class="per-file-tabs" id="perFileTabs"></div>
    <div class="per-file-body" id="perFileBody"></div>`;

  const stack = document.getElementById('chartStack');
  stack.parentNode.insertBefore(section, stack);
  return section;
}

function renderPerFileView() {
  if (sessions.length === 0) {
    const existing = document.getElementById('perFileSection');
    if (existing) existing.remove();
    Object.values(perFileCharts).forEach(c => c.destroy());
    for (const k of Object.keys(perFileCharts)) delete perFileCharts[k];
    activeFileSession = null;
    return;
  }

  ensurePerFileSection();

  // Keep the same session selected across re-renders if it still exists,
  // otherwise fall back to the first session.
  if (!activeFileSession || !sessions.includes(activeFileSession)) {
    activeFileSession = sessions[0];
  }

  const tabsEl = document.getElementById('perFileTabs');
  tabsEl.innerHTML = sessions.map((s, i) => {
    const c      = PALETTE[i % PALETTE.length];
    const active = s === activeFileSession;
    return `<button class="per-file-tab${active ? ' active' : ''}" data-idx="${i}" style="--tab-color:${c.hex}">
              <span class="pill-dot" style="background:${c.hex}"></span>${s.name}
            </button>`;
  }).join('');

  renderPerFileBody();
}

async function renderPerFileBody() {
  const myGen   = ++perFileGen;
  const session = activeFileSession;
  const bodyEl  = document.getElementById('perFileBody');
  if (!session || !bodyEl) return;

  Object.values(perFileCharts).forEach(c => c.destroy());
  for (const k of Object.keys(perFileCharts)) delete perFileCharts[k];

  const cc        = chartColors();
  const isMin     = timeMode === 'min';
  const pctLabels = Array.from({ length: 120 }, (_, i) => Math.round(i * 100 / 119) + '%');
  const maxMin    = Math.ceil((session.durationSec / 60) * 10) / 10;

  bodyEl.innerHTML = PER_FILE_GROUPS.map(g => `
    <div class="chart-card">
      <div class="chart-toolbar">
        <div>
          <div class="chart-title">${g.title}</div>
          <div class="chart-desc">${g.desc}</div>
        </div>
        <button class="zoom-reset-btn" data-registry="perfile" data-chart-key="${g.key}">Reset zoom</button>
      </div>
      <div class="chart-wrap"><canvas id="perfile_${g.key}"></canvas></div>
      <div class="legend" id="perfile_legend_${g.key}"><span class="leg-item leg-loading">Computing…</span></div>
      <div class="zoom-hint">Scroll to zoom · drag to select a region · ctrl+drag to pan</div>
    </div>
  `).join('');

  await Promise.all(
    PER_FILE_GROUPS.map(g => renderPerFileGroup(g, session, myGen, isMin, maxMin, pctLabels, cc))
  );
}

/**
 * Fetches one group's (bands/chaos/neuro) per-metric series for a single
 * session, off the main thread when possible, then fills in its legend and
 * Chart.js instance. Bails out if the tab was switched or a newer body
 * render superseded this one (checked via `myGen`/`activeFileSession`).
 */
async function renderPerFileGroup(group, session, myGen, isMin, maxMin, pctLabels, cc) {
  const seriesPerMetric = await Promise.all(
    group.metrics.map(metric => computeMetricSeriesAsync(metric, session))
  );

  if (myGen !== perFileGen || activeFileSession !== session) return; // stale

  const legendEl = document.getElementById(`perfile_legend_${group.key}`);
  if (legendEl) {
    legendEl.innerHTML = group.metrics.map((metric, i) => {
      const c    = PALETTE[i % PALETTE.length];
      const avgV = meanOf(Array.from(seriesPerMetric[i]));
      return `<span class="leg-item">
                <span class="leg-dot" style="background:${c.hex}"></span>
                ${METRICS[metric].label} — avg ${avgV.toFixed(3)}
              </span>`;
    }).join('');
  }

  const ctx = document.getElementById(`perfile_${group.key}`);
  if (!ctx) return; // card no longer in DOM (tab switched away)

  const datasets = group.metrics.map((metric, i) => {
    const c = PALETTE[i % PALETTE.length];
    return seriesToDataset(session, METRICS[metric].label, c.hex, seriesPerMetric[i]);
  });
  const xScale = buildXScale(cc, isMin, maxMin);

  perFileCharts[group.key] = new Chart(ctx, {
    type: 'line',
    data: isMin ? { datasets } : { labels: pctLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: { label: c => `${c.dataset.label}: ${(+c.parsed.y).toFixed(4)}` },
        },
        zoom: zoomPanOptions(),
      },
      scales: {
        x: xScale,
        y: {
          ticks: { font: { size: 11 }, color: cc.tick, callback: v => (+v).toFixed(3) },
          grid:  { color: cc.grid },
          title: { display: true, text: group.title, font: { size: 11 }, color: cc.title },
        },
      },
    },
  });
}

// Single delegated listener for per-file tab clicks and every chart's
// reset-zoom button (comparison view + per-file view), since both rebuild
// their DOM on every render and per-element listeners would leak/duplicate.
document.addEventListener('click', e => {
  const tabBtn = e.target.closest('.per-file-tab');
  if (tabBtn) {
    activeFileSession = sessions[+tabBtn.dataset.idx];
    document.querySelectorAll('.per-file-tab').forEach(b => b.classList.remove('active'));
    tabBtn.classList.add('active');
    renderPerFileBody();
    return;
  }

  const zoomBtn = e.target.closest('.zoom-reset-btn');
  if (zoomBtn) {
    const registry = zoomBtn.dataset.registry === 'perfile' ? perFileCharts : charts;
    const chart    = registry[zoomBtn.dataset.chartKey];
    if (chart) chart.resetZoom();
  }
});

/* ── Time mode toggle ──────────────────────────────────────────── */

document.querySelectorAll('.tgl').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tgl').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    timeMode = btn.dataset.mode;
    if (sessions.length > 0) { renderCharts(); renderPerFileBody(); }
  });
});

/* ── Chaos metric checkboxes — injected dynamically ───────────── */

(function injectChaosControls() {
  // Wait for DOM to be ready then insert the chaos group after existing controls
  function tryInject() {
    const section = document.getElementById('controlsSection');
    if (!section) { setTimeout(tryInject, 50); return; }

    // Don't double-inject
    if (document.getElementById('chaosMetricGroup')) return;

    const group = document.createElement('div');
    group.id = 'chaosMetricGroup';
    group.style.cssText = 'margin-top:12px; padding-top:12px; border-top: 1px solid var(--border, rgba(255,255,255,0.08));';

    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--text-muted,#888); margin-bottom:8px;';
    heading.textContent = 'Chaos / Nonlinear Dynamics';
    group.appendChild(heading);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px;';

    CHAOS_METRIC_KEYS.forEach(key => {
      const m = METRICS[key];
      const label = document.createElement('label');
      label.style.cssText = 'display:flex; align-items:center; gap:5px; cursor:pointer; font-size:13px;';
      label.title = m.desc;

      const cb = document.createElement('input');
      cb.type  = 'checkbox';
      cb.value = key;
      cb.addEventListener('change', () => { if (sessions.length > 0) renderCharts(); });

      label.appendChild(cb);
      label.appendChild(document.createTextNode(m.label));
      row.appendChild(label);
    });

    group.appendChild(row);
    section.appendChild(group);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInject);
  } else {
    tryInject();
  }
})();

/* ── Drop zone / file input ────────────────────────────────────── */

const dropZone  = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFiles([...e.target.files]));

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave',  () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('over');
  handleFiles([...e.dataTransfer.files]);
});