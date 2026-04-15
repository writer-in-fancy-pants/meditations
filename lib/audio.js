/**
 * lib/audio.js — Shared Web Audio engine
 * Provides: sound generators (waves/brook/gong/generative/upload),
 *           tone feedback, adaptive volume, and master gain control.
 * All functions are pure and side-effect-free except for the shared
 * audioCtx / masterGain which are module-level singletons.
 *
 * Exported API:
 *   Audio.ensureCtx()
 *   Audio.setMasterVolume(v, rampMs?)
 *   Audio.startSound(type)        — type: 'waves'|'brook'|'gong'|'generative'|'upload'
 *   Audio.stopSound()
 *   Audio.setUploadedBuffer(buf)
 *   Audio.playTone(hz, durationMs?, gain?)
 *   Audio.crossoverChime()
 *   Audio.coherenceChime()
 *   Audio.performanceTone(score, threshold)  — generic: above=660Hz, below=330Hz
 *   Audio.endAlarm()
 *   Audio.scheduleBeep(intervalSec, getScoreFn, isActiveFn)
 *   Audio.cancelBeep()
 *   Audio.adaptVolume(score, baseline, targetVolume)
 */

'use strict';

const Audio = (() => {

  /* ── Singleton state ──────────────────────────────────────────── */
  let audioCtx       = null;
  let masterGain     = null;
  let currentSource  = null;   // teardown fn for procedural sources
  let generativeStop = null;   // teardown fn for generative synth
  let uploadedBuffer = null;
  let _beepTimer     = null;

  /* ── Context ──────────────────────────────────────────────────── */

  function ensureCtx() {
    if (audioCtx) return;
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(audioCtx.destination);
  }

  function setMasterVolume(v, rampMs = 1000) {
    if (!masterGain) return;
    masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, rampMs / 1000);
  }

  /* ── Pink noise helper ────────────────────────────────────────── */

  function _makePinkNoise(ctx, durationSec = 4) {
    const bufSize = durationSec * ctx.sampleRate;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
      b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
      b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
      d[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11;
      b6 = w*0.115926;
    }
    return buf;
  }

  /* ── Sound generators ─────────────────────────────────────────── */

  function _startWaves() {
    ensureCtx();
    const ctx = audioCtx;
    const buf = _makePinkNoise(ctx, 4);
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const lpf = ctx.createBiquadFilter(); lpf.type='lowpass'; lpf.frequency.value=400; lpf.Q.value=0.7;
    const lfo  = ctx.createOscillator();  lfo.frequency.value = 0.08;
    const lfoG = ctx.createGain();        lfoG.gain.value = 0.35;
    const swG  = ctx.createGain();        swG.gain.value  = 0.65;
    lfo.connect(lfoG); lfoG.connect(swG.gain);
    src.connect(lpf); lpf.connect(swG); swG.connect(masterGain);
    src.start(); lfo.start();
    return () => [src, lfo].forEach(n => { try { n.stop(); } catch(e){} });
  }

  function _startBrook() {
    ensureCtx();
    const ctx = audioCtx;
    const bufSize = 2 * ctx.sampleRate;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const hpf = ctx.createBiquadFilter(); hpf.type='highpass'; hpf.frequency.value=600; hpf.Q.value=0.5;
    const bpf = ctx.createBiquadFilter(); bpf.type='bandpass'; bpf.frequency.value=1200; bpf.Q.value=2;
    const g = ctx.createGain(); g.gain.value = 0.12;
    src.connect(hpf); hpf.connect(bpf); bpf.connect(g); g.connect(masterGain);
    src.start();
    return () => { try { src.stop(); } catch(e){} };
  }

  function _startGong() {
    // Tibetan singing bowl — accurate long sustain model.
    //
    // A real singing bowl has:
    //   • Fundamental (f1) + 2nd partial (f2 ≈ 2.756×f1) + 3rd (f3 ≈ 5.075×f1)
    //   • Each partial has its own decay rate: fundamentals sustain the longest
    //   • A soft "knock" transient at strike: noise burst through a resonant BPF
    //   • Warm chorus: two slightly detuned oscillators per partial (+/- 0.4 Hz)
    //
    // References: Rossing (1992) "Acoustics of the Glass Harmonica";
    //             Giordano (2010) "Physics of the Guitar" (drum/bell analogy)
    ensureCtx();
    const ctx = audioCtx;
    let running = true;
    // activeNodes: per-strike oscillators — kept so we can stop on teardown
    const activeNodes = [];

    function strike() {
      if (!running) return;
      const now = ctx.currentTime;

      // Singing bowl partials (frequency, peak gain, decay time in seconds, detune cents)
      const partials = [
        { freq: 220,   gain: 0.28, decay: 20, detune:  0   },
        { freq: 220,   gain: 0.12, decay: 18, detune:  0.8 },  // chorus
        { freq: 606.3, gain: 0.14, decay: 14, detune:  0   },  // 2nd partial (2.756×)
        { freq: 606.3, gain: 0.06, decay: 12, detune: -0.6 },  // chorus
        { freq: 1116,  gain: 0.06, decay:  8, detune:  0   },  // 3rd partial
        { freq: 1116,  gain: 0.03, decay:  6, detune:  0.4 },  // chorus
      ];

      partials.forEach(p => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = p.freq;
        osc.detune.value    = p.detune;

        const env = ctx.createGain();
        // Smooth strike onset (2 ms ramp) then long exponential decay
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(p.gain, now + 0.002);
        env.gain.setTargetAtTime(0.0001, now + 0.1, p.decay / 5);

        osc.connect(env);
        env.connect(masterGain);
        osc.start(now);
        // Stop well after decay to avoid abrupt cutoff
        osc.stop(now + p.decay + 2);
        activeNodes.push(osc);
      });

      // Mallet knock: filtered noise burst (5 ms, centred at 800 Hz)
      const knockBuf  = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.012), ctx.sampleRate);
      const knockData = knockBuf.getChannelData(0);
      for (let i = 0; i < knockData.length; i++) knockData[i] = Math.random() * 2 - 1;
      const knockSrc  = ctx.createBufferSource(); knockSrc.buffer = knockBuf;
      const knockBpf  = ctx.createBiquadFilter();
      knockBpf.type = 'bandpass'; knockBpf.frequency.value = 800; knockBpf.Q.value = 3;
      const knockEnv  = ctx.createGain();
      knockEnv.gain.setValueAtTime(0.08, now);
      knockEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.012);
      knockSrc.connect(knockBpf); knockBpf.connect(knockEnv); knockEnv.connect(masterGain);
      knockSrc.start(now);
      activeNodes.push(knockSrc);

      // Schedule next strike: 25–30 s (long enough to hear the full decay)
      const next = 25000 + Math.random() * 5000;
      setTimeout(strike, next);
    }

    strike();

    return () => {
      running = false;
      activeNodes.forEach(n => { try { n.stop(); } catch(e){} });
      activeNodes.length = 0;
    };
  }

  function _startGenerative() {
    ensureCtx();
    const ctx = audioCtx;
    const nodes = [];
    const padGain = ctx.createGain(); padGain.gain.value=0.18; padGain.connect(masterGain);
    [
      { freq:432, detune:0,   lfoRate:0.07, lfoDepth:0.25 },
      { freq:528, detune:3,   lfoRate:0.11, lfoDepth:0.18 },
      { freq:324, detune:-2,  lfoRate:0.05, lfoDepth:0.20 },
    ].forEach(p => {
      const osc = ctx.createOscillator(); osc.type='sine'; osc.frequency.value=p.freq; osc.detune.value=p.detune;
      const lfo = ctx.createOscillator(); lfo.frequency.value=p.lfoRate;
      const lfoG = ctx.createGain(); lfoG.gain.value=p.lfoDepth;
      const envG = ctx.createGain(); envG.gain.value=1.0;
      lfo.connect(lfoG); lfoG.connect(envG.gain);
      osc.connect(envG); envG.connect(padGain);
      osc.start(); lfo.start();
      nodes.push(osc, lfo);
    });
    // Pink noise sub-bass
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = _makePinkNoise(ctx, 4); noiseSrc.loop=true;
    const bpf = ctx.createBiquadFilter(); bpf.type='bandpass'; bpf.frequency.value=180; bpf.Q.value=0.5;
    const nG  = ctx.createGain(); nG.gain.value=0.06;
    noiseSrc.connect(bpf); bpf.connect(nG); nG.connect(masterGain);
    noiseSrc.start();
    nodes.push(noiseSrc);
    return () => nodes.forEach(n => { try { n.stop(); } catch(e){} });
  }

  function _startUpload() {
    if (!uploadedBuffer) return null;
    ensureCtx();
    const src = audioCtx.createBufferSource();
    src.buffer = uploadedBuffer; src.loop = true;
    src.connect(masterGain); src.start();
    return () => { try { src.stop(); } catch(e){} };
  }

  /* ── Public sound API ─────────────────────────────────────────── */

  function stopSound() {
    if (currentSource)  { currentSource();  currentSource  = null; }
    if (generativeStop) { generativeStop(); generativeStop = null; }
  }

  function startSound(type) {
    stopSound();
    ensureCtx();
    audioCtx.resume();
    setMasterVolume(0, 0);
    switch (type) {
      case 'waves':      currentSource  = _startWaves();      break;
      case 'brook':      currentSource  = _startBrook();      break;
      case 'gong':       currentSource  = _startGong();       break;
      case 'generative': generativeStop = _startGenerative(); break;
      case 'upload':     currentSource  = _startUpload();     break;
    }
    // Volume will be ramped up by caller via setMasterVolume
  }

  function setUploadedBuffer(buf) { uploadedBuffer = buf; }

  /* ── Tone feedback ────────────────────────────────────────────── */

  function playTone(hz, durationMs = 200, gainVal = 0.08) {
    ensureCtx();
    audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const g   = audioCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = hz;
    const now = audioCtx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gainVal, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationMs/1000);
    osc.connect(g); g.connect(audioCtx.destination);
    osc.start(now); osc.stop(now + durationMs/1000 + 0.05);
  }

  // α/θ crossover moment
  function crossoverChime() {
    playTone(528, 400, 0.06);
    setTimeout(() => playTone(660, 300, 0.04), 220);
  }

  // HRV coherence entry moment
  function coherenceChime() {
    playTone(528, 350, 0.06);
    setTimeout(() => playTone(660, 280, 0.04), 200);
  }

  // Generic performance tone: above threshold → bright, below → low
  function performanceTone(score, threshold) {
    const hz = score >= threshold ? 660 : 330;
    playTone(hz, 250, 0.07);
  }

  // Session end — gentle ascending 3-note sequence
  function endAlarm() {
    [440, 528, 660].forEach((hz, i) => {
      setTimeout(() => playTone(hz, 600, 0.08), i * 500);
    });
    setTimeout(() => {
      [440, 528, 660].forEach((hz, i) => {
        setTimeout(() => playTone(hz, 400, 0.05), i * 300);
      });
    }, 2000);
  }

  /* ── Adaptive volume ──────────────────────────────────────────── */

  /**
   * Gently reduce music volume when score exceeds baseline (desired state).
   * Shared by both AT (θ/α above threshold) and HRV (RMSSD above baseline).
   * @param {number} score        — current metric value
   * @param {number} baseline     — calibrated baseline for this metric
   * @param {number} targetVolume — user's chosen master volume (0–1)
   * @returns {number} adapted volume applied
   */
  function adaptVolume(score, baseline, targetVolume) {
    if (!baseline || !masterGain) return targetVolume;
    const ratio     = score / (baseline + 1e-12);
    const reduction = Math.min(Math.max((ratio - 1) * 0.3, 0), 0.35);
    const adapted   = targetVolume * (1 - reduction);
    setMasterVolume(adapted, 2000);
    return adapted;
  }

  /* ── Periodic beep scheduler ──────────────────────────────────── */

  function scheduleBeep(intervalSec, getScoreFn, isActiveFn) {
    cancelBeep();
    if (intervalSec <= 0) return;
    _beepTimer = setInterval(() => {
      if (!isActiveFn()) return;
      const { score, threshold } = getScoreFn();
      if (score !== null) performanceTone(score, threshold);
    }, intervalSec * 1000);
  }

  function cancelBeep() {
    clearInterval(_beepTimer);
    _beepTimer = null;
  }

  return {
    ensureCtx,
    setMasterVolume,
    startSound,
    stopSound,
    setUploadedBuffer,
    playTone,
    crossoverChime,
    coherenceChime,
    performanceTone,
    endAlarm,
    adaptVolume,
    scheduleBeep,
    cancelBeep,
  };

})();
