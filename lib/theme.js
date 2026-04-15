/**
 * lib/theme.js — Shared dark/light theme toggle.
 * Reads/writes to localStorage key 'nf-theme'.
 * Calls an optional onToggle callback so modes can rebuild charts.
 *
 * Exported API:
 *   Theme.init(onToggle?)
 *   Theme.toggle()
 *   Theme.current()   → 'dark'|'light'
 */

'use strict';

const Theme = (() => {

  let _onToggle = null;

  function init(onToggle) {
    _onToggle = onToggle || null;
    const saved = localStorage.getItem('nf-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    document.getElementById('themeBtn').addEventListener('click', toggle);
  }

  function toggle() {
    const html = document.documentElement;
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('nf-theme', next);
    if (_onToggle) _onToggle(next);
  }

  function current() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  return { init, toggle, current };

})();
