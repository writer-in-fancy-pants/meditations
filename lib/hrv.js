/**
 * lib/hrv.js — Shared HRV computation, charting, and gauge
 *
 * Used by: whoop/modes/hrv.js, muse2/modes/hrv.js, device/modes/hrv.js
 * Depends on: lib/chartUtils.js (ChartUtils global)
 *
 * Exported API (HrvLib namespace):
 *
 *   Math:
 *     HrvLib.rmssd(rrArr)                   → number|null
 *     HrvLib.pnn50(rrArr)                   → number|null
 *     HrvLib.coherenceIndex(rrArr)          → number 0–1
 *     HrvLib.parseGattHrMeasurement(dv)     → {bpm, rrIntervals}
 *
 *   Charts (init once, update on each frame):
 *     HrvLib.initCharts({hrId, rrId, rmssdId, maxPts?})  → chartMap
 *     HrvLib.updateCharts(chartMap, hist, baselineRMSSD)
 *     HrvLib.destroyCharts(chartMap)
 *
 *   Gauge:
 *     HrvLib.drawGauge(canvasId, coherence, rv, baselineRMSSD)
 *
 *   Rolling history helpers:
 *     HrvLib.makeHist()                     → fresh hist object
 *     HrvLib.pushHist(hist, {label,hr,rr,rv}, maxPts)
 *
 *   Session summary:
 *     HrvLib.sessionSummary(rrBuffer, hist, elapsedSec, baselineRMSSD) → HTML string
 */

'use strict';
const HrvLib = (() => {

  /* ── Constants ────────────────────────────────────────────────── */

  const RR_WINDOW      = 30;
  const COHERENCE_WIN  = 60;
  const DEFAULT_MAX    = 300;

  /* ── HRV Math ─────────────────────────────────────────────────── */

  function rmssd(rr) {
    if (!rr || rr.length < 2) return null;
    let sum = 0;
    for (let i = 1; i < rr.length; i++) { const d = rr[i] - rr[i-1]; sum += d*d; }
    return Math.sqrt(sum / (rr.length - 1));
  }

  function pnn50(rr) {
    if (!rr || rr.length < 2) return null;
    let n = 0;
    for (let i = 1; i < rr.length; i++) if (Math.abs(rr[i]-rr[i-1]) > 50) n++;
    return (n / (rr.length - 1)) * 100;
  }

  /**
   * Coherence index: fraction of RR spectrum power in the LF band (0.04–0.15 Hz).
   * Higher = more synchronised with resonant-frequency breathing (~0.1 Hz).
   * Uses a naive DFT — accurate enough for 30–60 beat windows.
   */
  function coherenceIndex(rr) {
    const seg = rr.slice(-Math.min(rr.length, COHERENCE_WIN));
    if (seg.length < 20) return 0;
    const meanRR = seg.reduce((a,b)=>a+b,0) / seg.length / 1000;
    const fs = 1 / meanRR;
    const N  = seg.length;
    let total = 0, lf = 0;
    for (let k = 0; k < N/2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const a = -2 * Math.PI * k * n / N;
        re += seg[n] * Math.cos(a);
        im += seg[n] * Math.sin(a);
      }
      const pow  = (re*re + im*im) / N;
      const freq = k * fs / N;
      total += pow;
      if (freq >= 0.04 && freq <= 0.15) lf += pow;
    }
    return total > 0 ? Math.min(lf / total, 1) : 0;
  }

  /**
   * Parse Bluetooth GATT Heart Rate Measurement characteristic (0x2A37).
   * WHOOP sends RR in milliseconds directly (not Polar's 1/1024 s).
   * @param {DataView} dataView
   * @returns {{ bpm: number, rrIntervals: number[] }}
   */
  function parseGattHrMeasurement(dataView) {
    const flags    = dataView.getUint8(0);
    const hr16     = flags & 0x01;
    const rrFlag   = !!(flags & 0x10);
    let   offset   = 1;
    const bpm      = hr16 ? dataView.getUint16(offset++, true) : dataView.getUint8(offset++);
    if (hr16) offset++;           // already consumed 2 bytes above for uint16
    if (flags & 0x08) offset += 2; // energy expended field

    const rr = [];
    if (rrFlag) {
      while (offset + 1 < dataView.byteLength) {
        const raw = dataView.getUint16(offset, true);
        offset += 2;
        if (raw >= 300 && raw <= 2000) rr.push(raw);
      }
    }
    return { bpm, rrIntervals: rr };
  }

  /* ── Rolling history ──────────────────────────────────────────── */

  function makeHist() {
    return { labels: [], hr: [], rr: [], rmssd: [] };
  }

  function pushHist(hist, { label, hr, rr, rv }, maxPts = DEFAULT_MAX) {
    const push = (arr, v) => { arr.push(v); if (arr.length > maxPts) arr.shift(); };
    push(hist.labels, label ?? '');
    push(hist.hr,     hr    ?? null);
    push(hist.rr,     rr    ?? null);
    push(hist.rmssd,  rv    ?? null);
  }

  /* ── Charts ───────────────────────────────────────────────────── */

  /**
   * Initialise the three HRV charts.
   * @param {{ hrId, rrId, rmssdId, maxPts? }} ids  — canvas element IDs
   * @returns {Object} chartMap keyed by 'hr'|'rr'|'rmssd'
   */
  function initCharts({ hrId, rrId, rmssdId, maxPts = DEFAULT_MAX }) {
    const cc    = ChartUtils.colors();
    const empty = () => Array(maxPts).fill(null);
    const intCb = v => Math.round(v);

    const charts = {};

    if (hrId && document.getElementById(hrId)) {
      charts.hr = ChartUtils.buildChart(document.getElementById(hrId), {
        type: 'line',
        data: { labels: empty(), datasets: [ChartUtils.makeDataset('HR','#e07050',empty())] },
        options: ChartUtils.opts(cc, 'BPM', intCb),
      });
    }

    if (rrId && document.getElementById(rrId)) {
      charts.rr = ChartUtils.buildChart(document.getElementById(rrId), {
        type: 'line',
        data: { labels: empty(), datasets: [ChartUtils.makeDataset('RR','#7c75e0',empty())] },
        options: ChartUtils.opts(cc, 'ms', intCb),
      });
    }

    if (rmssdId && document.getElementById(rmssdId)) {
      charts.rmssd = ChartUtils.buildChart(document.getElementById(rmssdId), {
        type: 'line',
        data: {
          labels: empty(),
          datasets: [
            ChartUtils.makeDataset('RMSSD', '#2db891', empty()),
            ChartUtils.makeDataset('Baseline', 'rgba(255,140,60,0.55)', empty(), 'y',
              { borderDash:[5,4], spanGaps:false, backgroundColor:'transparent' }),
          ],
        },
        options: ChartUtils.opts(cc, 'RMSSD (ms)', intCb),
      });
    }

    ChartUtils.enableResetZoomShortcut(charts);

    return charts;
  }

  /**
   * Update all three charts from rolling history arrays.
   * @param {Object}   chartMap      — from initCharts()
   * @param {Object}   hist          — { labels, hr, rr, rmssd }
   * @param {number|null} baselineRMSSD
   */
  function updateCharts(chartMap, hist, baselineRMSSD) {
    const L = [...hist.labels];

    if (chartMap.hr) {
      chartMap.hr.data.labels = L;
      chartMap.hr.data.datasets[0].data = [...hist.hr];
      chartMap.hr.update('none');
    }

    if (chartMap.rr) {
      chartMap.rr.data.labels = L;
      chartMap.rr.data.datasets[0].data = [...hist.rr];
      chartMap.rr.update('none');
    }

    if (chartMap.rmssd) {
      chartMap.rmssd.data.labels = L;
      chartMap.rmssd.data.datasets[0].data = [...hist.rmssd];
      chartMap.rmssd.data.datasets[1].data = new Array(L.length).fill(baselineRMSSD ?? null);
      chartMap.rmssd.update('none');
    }
  }

  function destroyCharts(chartMap) {
    ChartUtils.destroyAll(chartMap);
  }

  /* ── Semicircular coherence gauge ─────────────────────────────── */

  /**
   * Draw the HRV coherence semicircle gauge on a canvas element.
   * @param {string}      canvasId
   * @param {number}      coherence     0–1
   * @param {number|null} rv            current RMSSD ms
   * @param {number|null} baselineRMSSD calibrated baseline
   */
  function drawGauge(canvasId, coherence, rv, baselineRMSSD) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx   = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cx = w/2, cy = h/2 + 10, r = 70;
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

    ctx.clearRect(0, 0, w, h);

    // Track
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth   = 12;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Value arc
    const arcColor = coherence > 0.55 ? (isDark ? '#2db891' : '#1a9e75')
                   : coherence > 0.30 ? (isDark ? '#d0901a' : '#b07010')
                   :                    (isDark ? '#e05050' : '#c03030');
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, Math.PI + coherence * Math.PI);
    ctx.strokeStyle = arcColor;
    ctx.lineWidth   = 12;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Needle
    const na = Math.PI + coherence * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (r-8)*Math.cos(na), cy + (r-8)*Math.sin(na));
    ctx.strokeStyle = isDark ? '#e8eaf0' : '#111827';
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI*2);
    ctx.fillStyle = isDark ? '#e8eaf0' : '#111827';
    ctx.fill();

    // Labels
    ctx.font      = '10px monospace';
    ctx.fillStyle = isDark ? '#555d78' : '#9ca3af';
    ctx.textAlign = 'left';  ctx.fillText('low',  cx-r-2, cy+18);
    ctx.textAlign = 'right'; ctx.fillText('high', cx+r+2, cy+18);
    ctx.textAlign = 'center';
    ctx.font      = '13px monospace';
    ctx.fillStyle = isDark ? '#e8eaf0' : '#111827';
    ctx.fillText((coherence*100).toFixed(0) + '%', cx, cy - r + 18);
  }

  /**
   * Update the state badge element next to the gauge.
   * @param {string}      badgeId
   * @param {number|null} rv
   * @param {number|null} baselineRMSSD
   */
  function updateStateBadge(badgeId, rv, baselineRMSSD) {
    const badge = document.getElementById(badgeId);
    if (!badge) return;
    if (rv === null || baselineRMSSD === null) {
      badge.textContent = 'Waiting for data';
      badge.className   = 'hrv-state-badge';
      return;
    }
    if (rv >= baselineRMSSD * 1.1) {
      badge.textContent = 'High coherence ↑';
      badge.className   = 'hrv-state-badge good';
    } else if (rv < baselineRMSSD * 0.85) {
      badge.textContent = 'Below baseline ↓';
      badge.className   = 'hrv-state-badge low';
    } else {
      badge.textContent = 'Near baseline →';
      badge.className   = 'hrv-state-badge';
    }
  }

  /* ── Session summary HTML ─────────────────────────────────────── */

  function sessionSummary(rrBuffer, hist, elapsedSec, baselineRMSSD) {
    const recent = rrBuffer.slice(-Math.min(rrBuffer.length, 300));
    const rv   = rmssd(recent);
    const pv   = pnn50(recent);
    const ci   = coherenceIndex(recent);
    const hrVals = hist.hr.filter(Boolean);
    const avgHR  = hrVals.length
      ? (hrVals.reduce((a,b)=>a+b,0)/hrVals.length).toFixed(0) + ' bpm' : '—';
    const fmt = s => String(Math.floor(s/60)) + ':' + String(s%60).padStart(2,'0');

    const row = (l, v) =>
      `<div class="end-stat-row">
         <span class="end-stat-label">${l}</span>
         <span class="end-stat-value">${v}</span>
       </div>`;

    return [
      row('Duration',          fmt(elapsedSec)),
      row('Avg heart rate',    avgHR),
      row('RMSSD (session)',   rv  ? rv.toFixed(1) + ' ms' : '—'),
      row('pNN50',             pv  ? pv.toFixed(1) + ' %'  : '—'),
      row('Coherence index',   ci.toFixed(3)),
      baselineRMSSD
        ? row('vs baseline RMSSD', rv
            ? ((rv - baselineRMSSD >= 0 ? '+' : '') + (rv - baselineRMSSD).toFixed(1) + ' ms')
            : '—')
        : '',
    ].join('');
  }

  /* ── Baseline helpers ─────────────────────────────────────────── */

  /**
   * Compute baseline RMSSD from a buffer of at least `minBeats` RR intervals.
   * Returns null if not enough data.
   */
  function computeBaseline(rrBuffer, minBeats = 60) {
    if (rrBuffer.length < minBeats) return null;
    return rmssd(rrBuffer.slice(-minBeats));
  }

  return {
    // Math
    rmssd,
    pnn50,
    coherenceIndex,
    parseGattHrMeasurement,
    // History
    makeHist,
    pushHist,
    // Charts
    initCharts,
    updateCharts,
    destroyCharts,
    // Gauge
    drawGauge,
    updateStateBadge,
    // Summary
    sessionSummary,
    computeBaseline,
    // Constants (exposed so modes can read them)
    RR_WINDOW,
    COHERENCE_WIN,
  };

})();
