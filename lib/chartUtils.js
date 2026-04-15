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

  return { colors, makeDataset, scaleX, scaleY, destroyAll, rollingPush };

})();
