/**
 * whoop/modes/howto.js — WHOOP-specific How To tab
 * Covers BLE vs bridge connection, HRV methodology, and training procedure.
 */

'use strict';

const HowTo = (() => {

  const TEMPLATE = `
<article class="howto">

  <header class="howto-hero">
    <h1 class="howto-h1">WHOOP HRV Training</h1>
    <p class="howto-lead">
      Use your WHOOP's real-time heart rate broadcast for resonant-frequency
      HRV biofeedback training — directly from the browser via Bluetooth,
      or via the Python bridge on any browser.
    </p>
  </header>

  <div class="howto-grid">

    <section class="howto-card">
      <h2 class="howto-h2">
        <span class="howto-icon" style="--ic:#2db891">BT</span>
        Connecting your WHOOP
      </h2>
      <h3 class="howto-h3">Direct Bluetooth (Chrome / Edge)</h3>
      <ol class="howto-list howto-ol">
        <li>Open the WHOOP app → <strong>Device Settings → HR Broadcast → ON</strong>.</li>
        <li>Click <strong>Connect WHOOP</strong> in the topbar.</li>
        <li>Select your WHOOP from the browser's Bluetooth picker.</li>
        <li>Heart rate data streams immediately — no Python required.</li>
      </ol>
      <h3 class="howto-h3">Python bridge (Firefox / Safari / all browsers)</h3>
      <ol class="howto-list howto-ol">
        <li>Install: <code>pip install bleak websockets</code></li>
        <li>Enable HR Broadcast on your WHOOP (same as above).</li>
        <li>Run: <code>python bridge.py</code></li>
        <li>Click <strong>Bridge</strong> → enter <code>ws://localhost:8765</code> → Connect.</li>
      </ol>
      <h3 class="howto-h3">Testing without hardware</h3>
      <p>Run the physiological simulator to generate realistic HRV data on any scenario:</p>
      <p><code>python hr_rr_simulator.py --scenario meditation --loop</code></p>
      <div class="howto-note">
        WHOOP sends RR intervals in milliseconds directly over BLE GATT (0x2A37), unlike
        Polar devices which use 1/1024 s units. The BLE client handles this automatically.
      </div>
    </section>

    <section class="howto-card">
      <h2 class="howto-h2">
        <span class="howto-icon" style="--ic:#7c75e0">♥</span>
        HRV biofeedback training
      </h2>
      <p>
        The goal is <strong>cardiac coherence</strong>: a large, smooth, regular heart rate
        oscillation synchronised with your breathing. This engages the baroreflex, strengthens
        vagal tone, and produces documented improvements in stress resilience, emotion regulation,
        and cardiovascular health (Lehrer et al. 2021).
      </p>
      <h3 class="howto-h3">What to aim for</h3>
      <ul class="howto-list">
        <li>RR tachogram forming a <strong>slow sine wave</strong> — rising for ~5 s, falling for ~5 s.</li>
        <li>RMSSD rising above your <strong>calibrated baseline</strong> — coherence chime signals this.</li>
        <li>Coherence gauge moving into the <strong>green zone</strong> (high LF/total power).</li>
        <li>Heart rate oscillating visibly between ~58 and ~72 bpm with each breath.</li>
      </ul>
      <h3 class="howto-h3">Session procedure</h3>
      <ol class="howto-list howto-ol">
        <li>Connect WHOOP. Sit comfortably, eyes closed.</li>
        <li>Click <strong>Calibrate baseline</strong> — rest quietly for 2 min.</li>
        <li>Set session duration (default 20 min) and click <strong>Start training</strong>.</li>
        <li>Breathe slowly and deeply at <strong>5–6 breaths per minute</strong> (roughly 5 s in, 5 s out).</li>
        <li>Don't strain — let the breathing become automatic. The coherence chime confirms the state.</li>
        <li>The end alarm signals completion with a gentle ascending chime.</li>
      </ol>
      <div class="howto-note">
        <strong>Caveats:</strong> A single session produces only a transient effect. Cumulative
        benefits accrue over 10+ sessions (5 weeks). People on beta-blockers or with autonomic
        neuropathy should consult a physician first, as these conditions alter the heart rate
        variability this training depends on.
      </div>
    </section>

  </div>

  <section class="howto-card howto-full">
    <h2 class="howto-h2">Metrics explained</h2>
    <div class="howto-table-wrap">
      <table class="howto-table">
        <thead><tr><th>Metric</th><th>What it measures</th><th>During training</th></tr></thead>
        <tbody>
          <tr><td>RMSSD</td><td>Root mean square of successive RR differences — primary vagal tone marker</td><td>Rises as parasympathetic activity increases</td></tr>
          <tr><td>pNN50</td><td>Percentage of adjacent RR pairs differing by >50 ms</td><td>Rises with RMSSD; sensitive to acute changes</td></tr>
          <tr><td>Coherence index</td><td>Fraction of HRV power concentrated in the LF band (0.04–0.15 Hz)</td><td>Peaks when breathing matches resonant frequency (~0.1 Hz)</td></tr>
          <tr><td>Baseline RMSSD</td><td>Your personal resting HRV from the calibration period</td><td>Reference point for adaptive volume and coherence chime</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="howto-card howto-full">
    <h2 class="howto-h2">Quick start</h2>
    <div class="howto-checks">
      <label class="howto-check"><input type="checkbox" /> WHOOP charged and worn</label>
      <label class="howto-check"><input type="checkbox" /> HR Broadcast enabled in WHOOP app</label>
      <label class="howto-check"><input type="checkbox" /> Connected via Bluetooth or bridge</label>
      <label class="howto-check"><input type="checkbox" /> Baseline calibrated (2 min quiet rest)</label>
      <label class="howto-check"><input type="checkbox" /> Session duration set, training started</label>
      <label class="howto-check"><input type="checkbox" /> Eyes closed, breathing at ~5.5 /min</label>
    </div>
  </section>

</article>`;

  function _injectStyles() {
    if (document.getElementById('howtoStyles')) return;
    const s = document.createElement('style');
    s.id = 'howtoStyles';
    s.textContent = `
.howto { max-width: 900px; padding-bottom: 3rem; }
.howto-hero { margin-bottom: 1.5rem; }
.howto-h1 { font-size: 22px; font-weight: 500; margin-bottom: .5rem; color: var(--text-primary); }
.howto-lead { font-size: 14px; color: var(--text-secondary); line-height: 1.7; max-width: 640px; }
.howto-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
@media (max-width: 680px) { .howto-grid { grid-template-columns: 1fr; } }
.howto-card { background: var(--bg-surface); border: 0.5px solid var(--border-subtle); border-radius: var(--radius-lg); padding: 1.25rem 1.5rem; transition: background var(--transition); }
.howto-full { grid-column: 1 / -1; }
.howto-h2 { font-size: 15px; font-weight: 500; margin-bottom: .75rem; display: flex; align-items: center; gap: 8px; color: var(--text-primary); }
.howto-h3 { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .05em; color: var(--text-tertiary); margin: 1rem 0 .4rem; }
.howto-icon { width: 26px; height: 26px; border-radius: 6px; background: color-mix(in srgb, var(--ic) 15%, transparent); color: var(--ic); font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.howto-card p { font-size: 13px; color: var(--text-secondary); line-height: 1.7; margin-bottom: .5rem; }
.howto-list { font-size: 13px; color: var(--text-secondary); line-height: 1.8; padding-left: 1.25rem; }
.howto-ol { list-style: decimal; }
.howto-note { margin-top: .75rem; font-size: 12px; color: var(--text-tertiary); border-left: 2px solid var(--border-default); padding-left: .75rem; line-height: 1.6; }
.howto-note strong { color: var(--text-secondary); }
.howto-table-wrap { overflow-x: auto; }
.howto-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.howto-table th { text-align: left; font-weight: 500; color: var(--text-secondary); padding: 6px 10px; border-bottom: 0.5px solid var(--border-default); }
.howto-table td { padding: 6px 10px; color: var(--text-secondary); border-bottom: 0.5px solid var(--border-subtle); vertical-align: top; }
.howto-table td:first-child { color: var(--text-tertiary); font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
.howto-table tr:last-child td { border-bottom: none; }
.howto-checks { display: flex; flex-direction: column; gap: 6px; }
.howto-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer; }
.howto-check input { accent-color: var(--accent); cursor: pointer; }
code { background: var(--bg-elevated); padding: 1px 5px; border-radius: 4px; font-size: 11px; color: var(--accent); font-family: var(--font-mono); }`;
    document.head.appendChild(s);
  }

  function mount() {
    _injectStyles();
    document.getElementById('modePanel').innerHTML = TEMPLATE;
  }

  function unmount() {
    document.getElementById('modePanel').innerHTML = '';
  }

  return { mount, unmount };
})();
