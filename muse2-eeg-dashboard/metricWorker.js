/* ================================================================
   metricWorker.js — off-main-thread metric computation for the
   EEG Session Comparator.

   This worker owns a per-session cache of frame data (band powers,
   raw segments, PSDs) and computes computeMetric() series on request.
   The chaos/nonlinear-dynamics metrics (lle, corr_dim, chaos_index)
   are O(N²) per 4-second frame — expensive enough to freeze the UI
   thread if run inline, so they live here instead.

   Protocol (all messages are structured-clone objects):
     → { id, type: 'registerSession', sessionName, frames }
     ← { id, ok: true }
     → { type: 'dropSession', sessionName }                (no reply)
     → { id, type: 'computeSeries', metric, sessionName }
     ← { id, ok: true, result: Float64Array }
     ← { id, ok: false, error: string }
   ================================================================ */
'use strict';

/* ── Per-session frame cache ──────────────────────────────────── */

const sessionStore = new Map(); // sessionName -> frames[]

/* ── Chaos / nonlinear-dynamics helpers (mirrors app.js) ─────────
   Duplicated here (rather than imported) so this file works as a
   plain classic Worker with no bundler/module step required. ──── */

/**
 * Time-delay embedding of a 1-D signal into m-dimensional phase space.
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
 */
function largestLyapunovExponent(signal, m = 3, tau = 3, theilerW = 20, evolveSteps = 20) {
  const MAX_PTS = 300; // cap for speed
  const pts = embedPhaseSpace(signal, m, tau);
  if (pts.length < evolveSteps + 2) return 0;

  const step = pts.length > MAX_PTS ? Math.floor(pts.length / MAX_PTS) : 1;
  const subset = [];
  for (let i = 0; i < pts.length; i += step) subset.push({ pt: pts[i], idx: i });

  const divSum   = new Float64Array(evolveSteps);
  const divCount = new Int32Array(evolveSteps);

  for (let qi = 0; qi < subset.length; qi++) {
    const { pt: q, idx: qIdx } = subset[qi];

    let nnIdx = -1, nnDist = Infinity;
    for (let ri = 0; ri < pts.length; ri++) {
      if (Math.abs(ri - qIdx) <= theilerW) continue;
      const d = euclidDist(q, pts[ri]);
      if (d < nnDist && d > 0) { nnDist = d; nnIdx = ri; }
    }
    if (nnIdx < 0 || nnDist === 0) continue;

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
 */
function correlationDimension(signal, m = 3, tau = 3, nR = 20) {
  const MAX_PTS = 200;
  const pts = embedPhaseSpace(signal, m, tau);
  if (pts.length < 10) return 0;

  const step = pts.length > MAX_PTS ? Math.floor(pts.length / MAX_PTS) : 1;
  const sub  = [];
  for (let i = 0; i < pts.length; i += step) sub.push(pts[i]);

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

  const logMin = Math.log(rMin), logMax = Math.log(rMax);
  const logR = Array.from({ length: nR }, (_, k) => logMin + k * (logMax - logMin) / (nR - 1));

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
 * Cache for per-frame chaos values (LLE + D₂), local to this worker,
 * so repeated requests for the same session/metric are near-instant.
 */
const chaosCache = new Map();

function cachedChaos(rawSeg, cacheKey) {
  if (chaosCache.has(cacheKey)) return chaosCache.get(cacheKey);
  const result = {
    lle: largestLyapunovExponent(rawSeg),
    d2:  correlationDimension(rawSeg),
  };
  chaosCache.set(cacheKey, result);
  return result;
}

/* ── Neurofeedback metric formulas (mirrors app.js) ──────────────── */

const avg = (...v) => v.reduce((a, b) => a + b, 0) / v.length;
const safeLog = v => Math.log(Math.max(v, 1e-12));

/**
 * Derive a scalar score from per-channel band powers (and optionally raw segments).
 * Identical logic to computeMetric() in app.js.
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
        if (frame.psds && frame.psds[ch]) seSum += spectralEntropy(frame.psds[ch]);
      }
      lleMean /= channels.length;
      d2Mean  /= channels.length;
      seSum   /= channels.length; // normalised [0,1]

      const lleNorm = Math.max(0, Math.min(lleMean, 0.5)) / 0.5;
      const d2Norm  = Math.max(0, Math.min(d2Mean, 5))   / 5;
      return Math.pow(lleNorm * d2Norm * seSum, 1 / 3);
    }

    default: return 0;
  }
}

/* ── Message handling ─────────────────────────────────────────── */

self.addEventListener('message', e => {
  const msg = e.data || {};

  try {
    switch (msg.type) {

      case 'registerSession': {
        sessionStore.set(msg.sessionName, msg.frames);
        self.postMessage({ id: msg.id, ok: true });
        break;
      }

      case 'dropSession': {
        sessionStore.delete(msg.sessionName);
        // Best-effort cleanup of that session's chaos cache entries.
        const prefix = `${msg.sessionName}::`;
        for (const key of chaosCache.keys()) {
          if (key.startsWith(prefix)) chaosCache.delete(key);
        }
        break; // fire-and-forget — no reply expected
      }

      case 'computeSeries': {
        const frames = sessionStore.get(msg.sessionName);
        if (!frames) {
          self.postMessage({ id: msg.id, ok: false, error: `session not registered: ${msg.sessionName}` });
          break;
        }
        const result = new Float64Array(frames.length);
        for (let i = 0; i < frames.length; i++) {
          const fr = frames[i];
          result[i] = computeMetric(msg.metric, fr.bp, fr, msg.sessionName, i);
        }
        // Transfer the buffer back — it's a fresh array, so no aliasing risk.
        self.postMessage({ id: msg.id, ok: true, result }, [result.buffer]);
        break;
      }

      default:
        if (msg.id != null) {
          self.postMessage({ id: msg.id, ok: false, error: `unknown message type: ${msg.type}` });
        }
    }
  } catch (err) {
    if (msg.id != null) {
      self.postMessage({ id: msg.id, ok: false, error: (err && err.message) || String(err) });
    }
  }
});
