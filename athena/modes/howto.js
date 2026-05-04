/**
 * modes/howto.js — How To tab
 * Renders a static educational panel explaining training methodology,
 * expectations, and practical guidance for both AT and HRV modes.
 *
 * Public API:
 *   HowTo.mount()
 *   HowTo.unmount()
 */

'use strict';

const HowTo = (() => {

  const TEMPLATE = `
<article class="howto">

  <header class="howto-hero">
    <h1 class="howto-h1">Using this tool</h1>
    <p class="howto-lead">
      Two neurofeedback protocols, one interface.
      Both train the same underlying system — the balance between sympathetic arousal and
      parasympathetic calm — through different physiological entry points.
    </p>
  </header>

  <div class="howto-grid">

    <!-- ── Overview ─────────────────────────────────────── -->
    <section class="howto-card">
      <h2 class="howto-h2">
        <span class="howto-icon" style="--ic:#7c75e0">θ</span>
        Alpha/Theta EEG training
      </h2>
      <p>
        Targets the <strong>crossover state</strong> — the hypnagogic threshold where theta power
        (4–8 Hz, deep relaxation and imagery) gradually rises above alpha (8–13 Hz, relaxed
        wakefulness). Originally formalised by Peniston & Kulkosky (1989) for addiction recovery,
        it has since been validated for anxiety, PTSD, performance enhancement, and creativity.
      </p>
      <h3 class="howto-h3">What you are aiming for</h3>
      <ul class="howto-list">
        <li>The <strong>θ/α ratio chart</strong> line rising steadily above 1.0 and staying there.</li>
        <li>The <strong>crossover badge</strong> (θ &gt; α) appearing — this is the target state.</li>
        <li>Baseline calibration sets your personal starting threshold at 95% of your resting ratio.</li>
        <li>The threshold auto-adjusts each 60-second block to keep training optimally challenging.</li>
      </ul>
      <h3 class="howto-h3">Procedure</h3>
      <ol class="howto-list howto-ol">
        <li>Connect to the mnelsl bridge (<code>python bridge.py</code>) from the topbar.</li>
        <li>Sit comfortably, eyes closed, and click <strong>Calibrate baseline</strong>. Hold still for 60 s.</li>
        <li>Choose preferred music, if needed. Adjust volume. The volume will drop lower as you go deeper. That's the feedback. </li>
        <li> Enable "Auto-adjust threshold" to make the training adapt to you - also resets the volume. Disable it if you know what you're doing.</li>
        <li>Click <strong>Start training</strong>. Eyes remain closed throughout.</li>
        <li>Aim to enter a passive, daydream-like state — do not actively try to control anything.</li>
        <li>The crossover chime and tone feedback guide you without requiring visual monitoring.</li>
        <li>Sessions of 20–40 min, repeated over 10–20 sessions, produce cumulative effects.</li>
      </ol>
      <div class="howto-note">
        <strong>Caveats:</strong> Effects require consistent practice over multiple weeks. A single
        session produces a transient state shift only. Alpha/theta work is most appropriate for
        healthy adults. If you have a history of psychosis, seizures, or severe dissociation,
        consult a professional before attempting deep-state EEG training.
      </div>
    </section>

    <!-- ── HRV ───────────────────────────────────────────── -->
    <section class="howto-card">
      <h2 class="howto-h2">
        <span class="howto-icon" style="--ic:#2db891">♥</span>
        HRV coherence training
      </h2>
      <p>
        Targets <strong>cardiac coherence</strong> — the state where your heart rate oscillates
        in a smooth, large-amplitude sine wave synchronised with your breathing. This engages the
        baroreflex and strengthens vagal tone, producing documented effects on stress resilience,
        emotion regulation, blood pressure, and cognitive performance (Lehrer et al. 2021;
        Frontiers in Neuroscience 2020).
      </p>
      <h3 class="howto-h3">What you are aiming for</h3>
      <ul class="howto-list">
        <li>The <strong>RR tachogram</strong> forming a slow, regular sine wave — rising 5 s, falling 5 s.</li>
        <li><strong>RMSSD rising above your calibrated baseline</strong> — the coherence chime signals this.</li>
        <li>The <strong>coherence gauge</strong> moving into the green zone (high LF/total power ratio).</li>
        <li>The gauge number stabilising, not jumping — stability indicates true resonance.</li>
      </ul>
      <h3 class="howto-h3">Procedure</h3>
      <ol class="howto-list howto-ol">
        <li>Connect the bridge (<code>python bridge.py</code> via mnelsl for Muse S Athena PPG).</li>
        <li>Click <strong>Calibrate baseline</strong> - Sit still, eyes closed for 2 minutes.</li>
        <li>Enable the <strong>breathing pacer</strong> and start at 5.5 breaths/min.</li>
        <li>Choose a different breathing setting if needed, whichever feels natural.</li>
        <li>Breathe slowly and deeply into the belly — abdomen expands on inhale, relaxes on exhale.</li>
        <li>Click <strong>Start training</strong>. Adjust the pacer rate ±0.5 /min until the gauge peaks.</li>
        <li>Sessions of 20 min daily, 10+ sessions over 5 weeks, are the standard protocol.</li>
      </ol>
      <div class="howto-note">
        <strong>Caveats:</strong> If 4.5 breaths/min feels forced or anxious, start higher (6–6.5)
        and decrease gradually. People on beta-blockers or with autonomic neuropathy should consult
        a physician first, as these conditions alter the variability this training relies on.
        Cognitive benefits (memory, attention) are less robustly replicated than stress/emotion effects.
      </div>
    </section>

  </div><!-- /.howto-grid -->

  <!-- ── Comparison table ──────────────────────────────── -->
  <section class="howto-card howto-full">
    <h2 class="howto-h2">Comparison</h2>
    <div class="howto-table-wrap">
      <table class="howto-table">
        <thead>
          <tr>
            <th></th>
            <th>α/θ EEG (this tool)</th>
            <th>HRV biofeedback (this tool)</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Signal source</td><td>EEG — cortical (central)</td><td>PPG / ECG — cardiac (peripheral)</td></tr>
          <tr><td>Primary target</td><td>Thalamocortical theta/alpha balance</td><td>Baroreflex, vagal tone</td></tr>
          <tr><td>Active ingredient</td><td>Passive theta state induction</td><td>Slow resonant-frequency breathing</td></tr>
          <tr><td>Eyes during session</td><td>Closed throughout</td><td>Closed; pacer guides breathing</td></tr>
          <tr><td>Metric to watch</td><td>θ/α ratio rising above 1.0</td><td>RMSSD above baseline; coherence gauge</td></tr>
          <tr><td>Typical session</td><td>20–40 min</td><td>20 min</td></tr>
          <tr><td>Typical course</td><td>20–40 sessions over months</td><td>10–20 sessions over 5–10 weeks</td></tr>
          <tr><td>Best evidence for</td><td>PTSD, addiction, creativity, peak performance</td><td>Anxiety, stress, cardiovascular, resilience</td></tr>
          <tr><td>EEG crossover?</td><td>Primary target</td><td>Occurs as secondary effect</td></tr>
          <tr><td>Hardware</td><td>Muse S Athena + mnelsl + bridge.py</td><td>Muse S Athena PPG, or WHOOP via bridge.py</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- ── Quick start ────────────────────────────────────── -->
  <section class="howto-card howto-full">
    <h2 class="howto-h2">Quick start checklist</h2>
    <div class="howto-checks">
      <label class="howto-check"><input type="checkbox" /> Muse S Athena charged and paired via Bluetooth</label>
      <label class="howto-check"><input type="checkbox" /> mnelsl installed: <code>pip install mnelsl</code></label>
      <label class="howto-check"><input type="checkbox" /> Bridge running: <code>mnelsl stream</code> + <code>python bridge.py</code></label>
      <label class="howto-check"><input type="checkbox" /> Click <strong>Connect</strong> in topbar → enter <code>ws://localhost:8765</code></label>
      <label class="howto-check"><input type="checkbox" /> Choose α/θ or HRV tab → Calibrate baseline → Start</label>
      <label class="howto-check"><input type="checkbox" /> Eyes closed, comfortable seated posture, minimal movement</label>
    </div>
    <p style="margin-top:1rem;font-size:12px;color:var(--text-tertiary)">
      Testing without hardware?
      Run <code>python hr_rr_simulator.py --scenario meditation --loop</code> to generate realistic HRV data,
      or use the mnelsl simulator for EEG. Connect on the same port.
    </p>
  </section>

</article>`;

  /* ── Styles injected once ──────────────────────────────────────── */
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
.howto-card {
  background: var(--bg-surface);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 1.25rem 1.5rem;
  transition: background var(--transition);
}
.howto-full { grid-column: 1 / -1; }
.howto-h2 { font-size: 15px; font-weight: 500; margin-bottom: .75rem; display: flex; align-items: center; gap: 8px; color: var(--text-primary); }
.howto-h3 { font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: .05em; color: var(--text-tertiary); margin: 1rem 0 .4rem; }
.howto-icon {
  width: 26px; height: 26px; border-radius: 6px;
  background: color-mix(in srgb, var(--ic) 15%, transparent);
  color: var(--ic); font-size: 14px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.howto-card p { font-size: 13px; color: var(--text-secondary); line-height: 1.7; margin-bottom: .5rem; }
.howto-list { font-size: 13px; color: var(--text-secondary); line-height: 1.8; padding-left: 1.25rem; }
.howto-ol { list-style: decimal; }
.howto-list li { margin-bottom: 1px; }
.howto-note {
  margin-top: .75rem; font-size: 12px; color: var(--text-tertiary);
  border-left: 2px solid var(--border-default); padding-left: .75rem; line-height: 1.6;
}
.howto-note strong { color: var(--text-secondary); }
.howto-table-wrap { overflow-x: auto; }
.howto-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.howto-table th { text-align: left; font-weight: 500; color: var(--text-secondary); padding: 6px 10px; border-bottom: 0.5px solid var(--border-default); white-space: nowrap; }
.howto-table td { padding: 6px 10px; color: var(--text-secondary); border-bottom: 0.5px solid var(--border-subtle); vertical-align: top; }
.howto-table td:first-child { color: var(--text-tertiary); white-space: nowrap; }
.howto-table tr:last-child td { border-bottom: none; }
.howto-checks { display: flex; flex-direction: column; gap: 6px; }
.howto-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer; }
.howto-check input { accent-color: var(--accent); cursor: pointer; }
.howto-check code { background: var(--bg-elevated); padding: 1px 5px; border-radius: 4px; font-size: 11px; color: var(--accent); }
code { background: var(--bg-elevated); padding: 1px 5px; border-radius: 4px; font-size: 11px; color: var(--accent); font-family: var(--font-mono); }
    `;
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
