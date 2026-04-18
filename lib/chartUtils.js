/**
 * lib/chartUtils.js — Chart.js helpers shared across all modes.
 *
 * Exported API:
 *   ChartUtils.colors()           → { grid, tick, title }
 *   ChartUtils.makeDataset(label, color, data, yAxisID?)
 *   ChartUtils.scaleX(cc, label?)
 *   ChartUtils.scaleY(cc, label, cb?)
 *   ChartUtils.destroyAll(chartMap)
 *   ChartUtils.rollingPush(arr, val, maxLen)
 *   ChartUtils.opts(cc, yLabel, cb)
 *   ChartUtils.buildChart(canvas, data)
 *   ChartUtils.wrapExistingChart(chart, saveFilename)
 *   ChartUtils.enableResetZoomShortcut(charts)
 */

'use strict';

const ChartUtils = (() => {

  function colors() {
    const s = getComputedStyle(document.documentElement);
    return {
      grid:  s.getPropertyValue('--chart-grid').trim()  || 'rgba(255,255,255,0.06)',
      tick:  s.getPropertyValue('--chart-tick').trim()  || '#666',
      title: s.getPropertyValue('--chart-title').trim() || '#888',
    };
  }

  function makeDataset(label, color, data = [], yAxisID = 'y', extra = {}) {
    return {
      label, data,
      borderColor:     color,
      backgroundColor: color + '18',
      borderWidth:     1.5,
      pointRadius:     0,
      tension:         0.35,
      fill:            false,
      spanGaps:        true,
      yAxisID,
      ...extra,
    };
  }

  function scaleX(cc, label = 'Time (s)') {
    return {
      ticks:  { font: { size: 10 }, color: cc.tick, maxTicksLimit: 10 },
      grid:   { color: cc.grid },
      title:  { display: true, text: label, font: { size: 10 }, color: cc.title },
    };
  }

  function scaleY(cc, label, callback) {
    return {
      ticks: {
        font: { size: 10 }, color: cc.tick,
        callback: callback || (v => v.toExponential(1)),
      },
      grid:  { color: cc.grid },
      title: { display: true, text: label, font: { size: 10 }, color: cc.title },
    };
  }

  function destroyAll(chartMap) {
    Object.values(chartMap).forEach(c => { if (c) c.destroy(); });
    Object.keys(chartMap).forEach(k => { chartMap[k] = null; });
  }

  /**
   * Push a value onto a rolling array, dropping the oldest if over maxLen.
   * Mutates the array in place and returns it.
   */
  function rollingPush(arr, val, maxLen) {
    arr.push(val);
    if (arr.length > maxLen) arr.shift();
    return arr;
  }

/**
 * Utilities for creating and managing Chart.js charts with
 * horizontal/vertical zoom, scroll (pan), and PNG save support.
 *
 * Dependencies (add to index.html before this file):
 *   - Chart.js  (already present)
 *   - chartjs-plugin-zoom  (wraps hammerjs + panzoom)
 *       <script src="https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js"></script>
 *       <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"></script>
 */

// ─── Default zoom / pan plugin config ────────────────────────────────────────

  /**
   * Returns a zoom-plugin options block that enables:
   *   • Wheel  → horizontal zoom  (hold Shift for vertical zoom)
   *   • Drag   → horizontal + vertical pan
   *
   * Merge this into chart.options.plugins.zoom when building a chart.
   *
   * @param {object} overrides  Optional partial override of the returned object.
   */
  function defaultZoomOptions(overrides = {}) {
    return {
      pan: {
        enabled: true,
        mode: 'xy',          // allow both axes
        threshold: 5,
      },
      zoom: {
        wheel: {
          enabled: true,
          modifierKey: null, // no modifier → zoom X; hold Shift → zoom Y handled below
        },
        pinch: {
          enabled: true,
        },
        mode: 'x',           // default wheel zooms X axis
        onZoomStart({ chart, event }) {
          // If Shift is held, switch to Y-only zoom on-the-fly
          if (event && event.shiftKey) {
            chart.options.plugins.zoom.zoom.mode = 'y';
          } else {
            chart.options.plugins.zoom.zoom.mode = 'x';
          }
        },
      },
      limits: {
        x: { minRange: 10 },
        y: { minRange: 0.01 },
      },
      ...overrides,
    };
  }

  // ─── Chart factory ────────────────────────────────────────────────────────────

  /**
   * Creates (or replaces) a Chart.js line chart on the given canvas.
   *
   * @param {HTMLCanvasElement} canvas   Target <canvas> element.
   * @param {object}            config   Chart.js config object.
   *                                     plugins.zoom is injected automatically.
   * @param {object}            zoomOpts Optional overrides passed to defaultZoomOptions().
   * @returns {Chart}
   */
  function createZoomableChart(canvas, config, zoomOpts = {}) {
    // Destroy any existing chart on this canvas
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    // Deep-merge zoom plugin options
    config.options = config.options || {};
    config.options.plugins = config.options.plugins || {};
    config.options.plugins.zoom = defaultZoomOptions(zoomOpts);

    return new Chart(canvas, config);
  }

  // ─── Zoom helpers ─────────────────────────────────────────────────────────────

  /**
   * Reset zoom on a chart instance back to the original data extents.
   * @param {Chart} chart
   */
  function resetZoom(chart) {
    if (chart && typeof chart.resetZoom === 'function') {
      chart.resetZoom();
    }
  }

  /**
   * Programmatically zoom in a chart on the X axis by a given factor.
   * @param {Chart} chart
   * @param {number} factor  e.g. 1.2 zooms in 20%, 0.8 zooms out 20%
   */
  function zoomX(chart, factor = 1.2) {
    if (chart) chart.zoom({ x: factor });
  }

  /**
   * Programmatically zoom in a chart on the Y axis by a given factor.
   * @param {Chart} chart
   * @param {number} factor
  */
  function zoomY(chart, factor = 1.2) {
    if (chart) chart.zoom({ y: factor });
  }

// ─── Save helper ─────────────────────────────────────────────────────────────

  /**
   * Save the current chart view as a PNG file download.
   *
   * @param {Chart}  chart     Chart instance.
   * @param {string} filename  Desired file name (default: "chart.png").
   */
  function saveChartAsPng(chart, filename = 'chart.png') {
    if (!chart) return;

    const url = chart.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  // ─── Convenience: attach control buttons to a chart container ────────────────

  /**
   * Injects a small toolbar (Reset / Zoom X+ / Zoom X- / Zoom Y+ / Zoom Y- / Save)
   * immediately above the given canvas element.
   *
   * The toolbar uses the class "chart-controls" so you can style it via CSS.
   *
   * @param {Chart}  chart
   * @param {object} opts
   * @param {string} opts.saveFilename   PNG filename (default: "chart.png")
   * @param {string} opts.containerId    If provided, toolbar is appended to that
   *                                     element instead of canvas.parentNode.
   */
  function attachChartControls(chart, opts = {}) {
    const { saveFilename = 'chart.png', containerId } = opts;

    const container = containerId
      ? document.getElementById(containerId)
      : chart.canvas.parentNode;

    if (!container) {
      console.warn('attachChartControls: no container found');
      return;
    }

    // Avoid duplicating toolbars
    const existingBar = container.querySelector('.chart-controls');
    if (existingBar) existingBar.remove();

    const bar = document.createElement('div');
    bar.className = 'chart-controls';
    bar.style.cssText =
      'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;align-items:center;';

    const btn = (label, title, handler) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText =
        'padding:3px 8px;font-size:12px;cursor:pointer;background: var(--bg-elevated); color: var(--text-primary);';
      b.addEventListener('click', handler);
      return b;
    };

    bar.append(
      btn('↺ Reset',    'Reset zoom',             () => resetZoom(chart)),
      btn('→ X+',       'Zoom in  (X axis)',       () => zoomX(chart, 1.3)),
      btn('← X−',       'Zoom out (X axis)',       () => zoomX(chart, 0.77)),
      btn('↑ Y+',       'Zoom in  (Y axis)',       () => zoomY(chart, 1.3)),
      btn('↓ Y−',       'Zoom out (Y axis)',       () => zoomY(chart, 0.77)),
      btn('💾 Save',    'Save chart as PNG',       () => saveChartAsPng(chart, saveFilename)),
    );

    // Insert toolbar before the canvas
    container.insertBefore(bar, chart.canvas);
  }

  function opts(cc, yLabel, cb) {
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { mode:'index', intersect:false } },
      scales: {
        x: ChartUtils.scaleX(cc),
        y: ChartUtils.scaleY(cc, yLabel, cb),
      },
    };
  }

  function buildChart(canvas, config) {  
    const chart = createZoomableChart(canvas, config);
  
    // Attach Reset / Zoom X± / Zoom Y± / 💾 Save toolbar above the canvas
    if (canvas !== null) {
      attachChartControls(chart, { saveFilename: `${canvas.id}.png` });
    }
    return chart;
  }
 
  // ─── Helper: retrofit zoom onto a chart that already exists ──────────────────
 
  /**
   * Call this for any Chart instance that was created before this patch was
   * applied. It injects the zoom plugin options and rebuilds the chart in place.
   *
   * @param {Chart}  chart        Existing Chart.js instance.
   * @param {string} saveFilename PNG filename for the Save button.
   */
  function wrapExistingChart(chart, saveFilename = 'chart.png') {
    chart.options.plugins = chart.options.plugins || {};
    chart.options.plugins.zoom = defaultZoomOptions();
    chart.update();
    attachChartControls(chart, { saveFilename });
  }
 
  // ─── Keyboard shortcut: R → reset zoom on focused chart ──────────────────────
  //
  // Optional convenience: press R while hovering over a canvas to reset zoom.
  // Add this block once in your DOMContentLoaded handler.
  
  function enableResetZoomShortcut(charts) {
    // charts: object/map of { chartId: chartInstance }
    let activeChart = null;
  
    Object.values(charts).forEach((chart) => {
      chart.canvas.addEventListener('mouseenter', () => { activeChart = chart; });
      chart.canvas.addEventListener('mouseleave', () => { activeChart = null; });
    });
  
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'r' || e.key === 'R') && activeChart) {
        resetZoom(activeChart);
      }
      if ((e.key === 's' || e.key === 'S') && e.ctrlKey && activeChart) {
        e.preventDefault();
        saveChartAsPng(activeChart, 'chart.png');
      }
    });
  }

  return { colors, makeDataset, scaleX, scaleY, destroyAll, opts,
    rollingPush, buildChart, wrapExistingChart, enableResetZoomShortcut };
})();
