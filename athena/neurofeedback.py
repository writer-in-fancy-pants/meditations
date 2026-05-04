#!/usr/bin/env python3
"""
neurofeedback.py — Neurofeedback & Biofeedback Algorithms
==========================================================
Connects to the Muse S Athena bridge (bridge.py) WebSocket, consumes
all sensor frames and runs a suite of clinically-grounded feedback protocols.

Protocols implemented
─────────────────────
NEUROFEEDBACK (EEG-based)
  1.  Alpha/Theta Training        (Peniston-Kulkosky)
  2.  SMR Enhancement             (12-15 Hz sensorimotor rhythm)
  3.  Frontal Alpha Asymmetry     (approach/withdrawal motivation)
  4.  Beta Suppression            (anxiety / hyperarousal reduction)
  5.  Gamma Coherence Proxy       (cognitive binding, memory)
  6.  Frontal Theta Enhancement   (deep meditation / creativity)
  7.  Neurofeedback Score         (composite wellbeing index)

BIOFEEDBACK (PPG/HRV-based)
  8.  HRV Coherence               (Heartmath-style LF coherence)
  9.  Resonance Frequency Pacer   (5-6 breath/min pacing)
 10.  Stress Index                (sympathovagal balance via LF/HF)
 11.  Recovery Score              (RMSSD-based parasympathetic tone)
 12.  Cardiac Coherence Ratio     (ratio of HF to total HRV power)

MOTION GATING (IMU-based)
 13.  Artefact rejection          (suppress feedback during movement)

FNIRS OVERLAY (haemodynamics)
 14.  Frontal Oxygenation Trend   (relative HbO proxy)
 15.  Hemispheric Asymmetry       (left vs right frontal activation)

Usage
─────
  python neurofeedback.py [--url ws://localhost:8765] [--verbose]

Output
──────
A JSON snapshot is printed to stdout every update cycle.
Integrate the `FeedbackEngine` class into your own UI / sonification layer.

Install
───────
  pip install websockets numpy scipy
"""

import argparse
import asyncio
import json
import logging
import math
import time
from collections import deque
from dataclasses import dataclass, field, asdict
from typing import Any

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("neurofeedback")

# ═════════════════════════════════════════════════════════════════════════════
# Data structures
# ═════════════════════════════════════════════════════════════════════════════

@dataclass
class EEGSnapshot:
    bands: dict          # {channel: {band: power}}
    metrics: dict        # raw metrics from bridge
    ts: float = 0.0


@dataclass
class PPGSnapshot:
    rr_ms: float         = float("nan")
    sdnn_ms: float       = float("nan")
    rmssd_ms: float      = float("nan")
    pnn50: float         = float("nan")
    mean_hr_bpm: float   = float("nan")
    lf_power: float      = float("nan")
    hf_power: float      = float("nan")
    lf_hf_ratio: float   = float("nan")
    rr_intervals_ms: list = field(default_factory=list)
    ts: float            = 0.0


@dataclass
class IMUSnapshot:
    acc_rms_g: float     = 0.0
    gyro_rms_dps: float  = 0.0
    pitch_deg: float     = 0.0
    roll_deg: float      = 0.0
    motion_artefact: bool = False
    ts: float            = 0.0


@dataclass
class FNIRSSnapshot:
    optodes: dict        = field(default_factory=dict)
    nir_mean: float      = float("nan")
    fnirs_asymmetry: float = 0.0
    ts: float            = 0.0


@dataclass
class FeedbackOutput:
    """All protocol outputs packed into a single serialisable container."""
    ts: float = 0.0
    motion_artefact: bool = False

    # ── Neurofeedback ─────────────────────────────────────────────────────────
    alpha_theta_ratio: float  = float("nan")   # Protocol 1
    alpha_theta_state: str    = "unknown"       # "alpha", "theta", "transition"
    smr_power: float          = float("nan")   # Protocol 2
    smr_score: float          = float("nan")   # normalised 0-1
    faa_score: float          = float("nan")   # Protocol 3  (positive = approach)
    faa_valence: str          = "neutral"       # "positive", "negative", "neutral"
    beta_suppression: float   = float("nan")   # Protocol 4  (high = more suppressed)
    gamma_coherence: float    = float("nan")   # Protocol 5
    frontal_theta: float      = float("nan")   # Protocol 6
    nf_score: float           = float("nan")   # Protocol 7  (composite 0-100)

    # ── Biofeedback ───────────────────────────────────────────────────────────
    hrv_coherence: float      = float("nan")   # Protocol 8  (0-1)
    coherence_level: str      = "unknown"       # "high", "medium", "low"
    pacer_phase: str          = "inhale"        # Protocol 9
    pacer_bpm: float          = 5.5             # resonance frequency
    stress_index: float       = float("nan")   # Protocol 10
    stress_level: str         = "unknown"       # "low", "moderate", "high"
    recovery_score: float     = float("nan")   # Protocol 11 (0-100)
    cardiac_coherence_ratio: float = float("nan") # Protocol 12

    # ── fNIRS overlay ────────────────────────────────────────────────────────
    frontal_oxy_trend: float  = float("nan")   # Protocol 14
    fnirs_asymmetry: float    = float("nan")   # Protocol 15


# ═════════════════════════════════════════════════════════════════════════════
# Utility
# ═════════════════════════════════════════════════════════════════════════════
def _nan_safe(v) -> float:
    """Return float or nan; never raises."""
    try:
        f = float(v)
        return f if math.isfinite(f) else float("nan")
    except (TypeError, ValueError):
        return float("nan")

def _norm(value: float, lo: float, hi: float) -> float:
    """Clamp-normalise value into [0, 1]."""
    if hi == lo:
        return 0.0
    return max(0.0, min(1.0, (value - lo) / (hi - lo)))

def _exp_smooth(prev: float, new: float, alpha: float = 0.2) -> float:
    """Exponential smoothing; handles NaN gracefully."""
    if math.isnan(prev):
        return new
    if math.isnan(new):
        return prev
    return alpha * new + (1.0 - alpha) * prev


# ═════════════════════════════════════════════════════════════════════════════
# Baseline tracker
# ═════════════════════════════════════════════════════════════════════════════

class BaselineTracker:
    """
    Online mean/std tracker using Welford's algorithm.
    Used to z-score raw EEG band powers for normalised feedback.
    """
    def __init__(self, warmup_samples: int = 60):
        self._n    = 0
        self._mean = 0.0
        self._M2   = 0.0
        self._warmup = warmup_samples

    def update(self, x: float) -> None:
        if math.isnan(x):
            return
        self._n    += 1
        delta       = x - self._mean
        self._mean += delta / self._n
        self._M2   += delta * (x - self._mean)

    @property
    def mean(self) -> float:
        return self._mean

    @property
    def std(self) -> float:
        return math.sqrt(self._M2 / self._n) if self._n > 1 else 1.0

    @property
    def ready(self) -> bool:
        return self._n >= self._warmup

    def zscore(self, x: float) -> float:
        return (x - self.mean) / max(self.std, 1e-12)


# ═════════════════════════════════════════════════════════════════════════════
# Protocol implementations
# ═════════════════════════════════════════════════════════════════════════════

class AlphaThetaProtocol:
    """
    Protocol 1 — Alpha/Theta Training (Peniston-Kulkosky, 1991)
    ──────────────────────────────────────────────────────────────
    Rewards theta (4-8 Hz) over alpha (8-13 Hz) to facilitate deep
    hypnagogic imagery and emotional processing.  A theta/alpha ratio
    above the threshold indicates a successful theta state.
    """
    THRESHOLD    = 1.0    # theta/alpha > 1 → theta-dominant
    HYSTERESIS   = 0.1

    def __init__(self):
        self._state    = "alpha"
        self._ratio_ema = float("nan")

    def update(self, eeg: EEGSnapshot) -> tuple[float, str]:
        ratio = _nan_safe(eeg.metrics.get("at_ratio", float("nan")))
        self._ratio_ema = _exp_smooth(self._ratio_ema, ratio, alpha=0.15)

        if math.isnan(self._ratio_ema):
            return float("nan"), "unknown"

        # Hysteretic state machine
        if self._state == "alpha" and self._ratio_ema > self.THRESHOLD + self.HYSTERESIS:
            self._state = "theta"
        elif self._state == "theta" and self._ratio_ema < self.THRESHOLD - self.HYSTERESIS:
            self._state = "alpha"
        elif abs(self._ratio_ema - self.THRESHOLD) <= self.HYSTERESIS:
            self._state = "transition"

        return round(self._ratio_ema, 4), self._state


class SMRProtocol:
    """
    Protocol 2 — Sensorimotor Rhythm (SMR) Enhancement
    ────────────────────────────────────────────────────
    SMR (12-15 Hz) is extracted from the Aux channels which, if
    electrodes are placed near C3/C4, capture sensorimotor cortex.
    Enhanced SMR correlates with focused calm and reduced hyperactivity.
    Returns normalised score (0-1, higher = more SMR).
    """
    SMR_LO = 12.0
    SMR_HI = 15.0

    def __init__(self):
        self._baseline = BaselineTracker(warmup_samples=30)
        self._smr_ema  = float("nan")

    def _extract_smr(self, eeg: EEGSnapshot) -> float:
        # Average SMR over aux channels; fall back to temporal channels
        vals = []
        for ch in ["aux1", "aux2", "tp9", "tp10"]:
            bands = eeg.bands.get(ch, {})
            # SMR sits within the lower beta band — approximate from beta
            b = _nan_safe(bands.get("beta", float("nan")))
            if not math.isnan(b):
                vals.append(b)
        return float(np.mean(vals)) if vals else float("nan")

    def update(self, eeg: EEGSnapshot) -> tuple[float, float]:
        smr_raw = self._extract_smr(eeg)
        self._smr_ema = _exp_smooth(self._smr_ema, smr_raw, alpha=0.2)
        self._baseline.update(smr_raw)

        if not self._baseline.ready or math.isnan(self._smr_ema):
            return _nan_safe(smr_raw), float("nan")

        z = self._baseline.zscore(self._smr_ema)
        score = _norm(z, -2.0, 2.0)           # z-score normalised to [0,1]
        return round(self._smr_ema, 6), round(score, 4)


class FrontalAlphaAsymmetry:
    """
    Protocol 3 — Frontal Alpha Asymmetry (FAA)
    ─────────────────────────────────────────────
    FAA = ln(AF8_alpha) − ln(AF7_alpha)
    Positive FAA → greater left frontal activation → approach motivation
    Negative FAA → greater right frontal activation → withdrawal / negative affect
    Smoothed with a 10-sample EMA to reduce noise.
    """
    def __init__(self):
        self._faa_ema = float("nan")

    def update(self, eeg: EEGSnapshot) -> tuple[float, str]:
        faa = _nan_safe(eeg.metrics.get("faa", float("nan")))
        self._faa_ema = _exp_smooth(self._faa_ema, faa, alpha=0.1)

        if math.isnan(self._faa_ema):
            return float("nan"), "neutral"

        if   self._faa_ema >  0.15:   valence = "positive"
        elif self._faa_ema < -0.15:   valence = "negative"
        else:                          valence = "neutral"

        return round(self._faa_ema, 4), valence


class BetaSuppressionProtocol:
    """
    Protocol 4 — Beta Suppression (anxiety / hyperarousal)
    ────────────────────────────────────────────────────────
    High frontal beta (>20 Hz) is associated with anxiety and
    cognitive over-arousal.  We train suppression of frontal beta
    relative to a rolling personal baseline.
    Returns a score in [0,1] where 1 = maximally suppressed (calm).
    """
    def __init__(self):
        self._baseline = BaselineTracker(warmup_samples=40)
        self._beta_ema = float("nan")

    def update(self, eeg: EEGSnapshot) -> float:
        af7 = eeg.bands.get("af7", {})
        af8 = eeg.bands.get("af8", {})
        beta_raw = float(
            np.mean([_nan_safe(af7.get("beta", float("nan"))),
                     _nan_safe(af8.get("beta", float("nan")))])
        )
        self._beta_ema = _exp_smooth(self._beta_ema, beta_raw, alpha=0.2)
        self._baseline.update(beta_raw)

        if not self._baseline.ready or math.isnan(self._beta_ema):
            return float("nan")

        z = self._baseline.zscore(self._beta_ema)
        # Invert so high score = low beta = suppressed
        return round(_norm(-z, -2.0, 2.0), 4)


class GammaCoherenceProtocol:
    """
    Protocol 5 — Gamma Coherence Proxy
    ────────────────────────────────────
    Frontal gamma (30-44 Hz) is associated with binding, working memory,
    and high-level cognitive integration.  We track the smoothed mean
    across AF7/AF8 as a proxy for cognitive engagement quality.
    """
    def __init__(self):
        self._gamma_ema = float("nan")

    def update(self, eeg: EEGSnapshot) -> float:
        g = _nan_safe(eeg.metrics.get("frontal_gamma", float("nan")))
        self._gamma_ema = _exp_smooth(self._gamma_ema, g, alpha=0.15)
        return round(self._gamma_ema, 6) if not math.isnan(self._gamma_ema) else float("nan")


class FrontalThetaEnhancement:
    """
    Protocol 6 — Frontal Theta Enhancement
    ────────────────────────────────────────
    Fz/AF7/AF8 theta (4-8 Hz) is associated with deep meditation,
    creativity (Berkowitz et al.) and internal focus.
    Returns normalised score (0-1).
    """
    def __init__(self):
        self._baseline = BaselineTracker(warmup_samples=30)
        self._theta_ema = float("nan")

    def update(self, eeg: EEGSnapshot) -> float:
        af7 = eeg.bands.get("af7", {})
        af8 = eeg.bands.get("af8", {})
        theta_raw = float(
            np.mean([_nan_safe(af7.get("theta", float("nan"))),
                     _nan_safe(af8.get("theta", float("nan")))])
        )
        self._theta_ema = _exp_smooth(self._theta_ema, theta_raw, alpha=0.15)
        self._baseline.update(theta_raw)
        if not self._baseline.ready or math.isnan(self._theta_ema):
            return float("nan")
        z = self._baseline.zscore(self._theta_ema)
        return round(_norm(z, -2.0, 2.0), 4)


class CompositeNFScore:
    """
    Protocol 7 — Composite Neurofeedback Score (0-100)
    ────────────────────────────────────────────────────
    Weighted blend of individual protocol scores tuned for
    a general "calm, focused wellbeing" objective.

    Weights:
      relaxation (alpha)    : 0.30
      frontal theta         : 0.20
      FAA (positive valence): 0.15
      beta suppression      : 0.20
      SMR                   : 0.15
    """
    W_RELAX  = 0.30
    W_THETA  = 0.20
    W_FAA    = 0.15
    W_BETA   = 0.20
    W_SMR    = 0.15

    def compute(
        self,
        relaxation: float,
        frontal_theta: float,
        faa_raw: float,
        beta_suppression: float,
        smr_score: float,
    ) -> float:
        # FAA mapped to [0,1]:  -1.0 → 0.0  to  +1.0 → 1.0
        faa_norm = _norm(_nan_safe(faa_raw), -1.0, 1.0)

        components = [
            (self.W_RELAX, _nan_safe(relaxation)),
            (self.W_THETA, _nan_safe(frontal_theta)),
            (self.W_FAA,   faa_norm),
            (self.W_BETA,  _nan_safe(beta_suppression)),
            (self.W_SMR,   _nan_safe(smr_score)),
        ]
        total_w = total_v = 0.0
        for w, v in components:
            if not math.isnan(v):
                total_w += w
                total_v += w * v
        if total_w < 1e-6:
            return float("nan")
        return round((total_v / total_w) * 100, 1)


# ── Biofeedback protocols ─────────────────────────────────────────────────────

class HRVCoherenceProtocol:
    """
    Protocol 8 — HRV Coherence (HeartMath-inspired)
    ─────────────────────────────────────────────────
    Computes coherence from successive RR-interval differences.
    High coherence = smooth, sinusoidal RR oscillation ≈ resonance frequency.

    Formula:  coherence = peak_LF_power / (total_power − peak_LF_power + ε)
    (requires LF/HF data from the bridge; falls back to a RMSSD proxy)
    """
    def __init__(self):
        self._coherence_ema = float("nan")

    def update(self, ppg: PPGSnapshot) -> tuple[float, str]:
        lf = _nan_safe(ppg.lf_power)
        hf = _nan_safe(ppg.hf_power)

        if not math.isnan(lf) and not math.isnan(hf):
            total   = lf + hf + 1e-12
            # HRV coherence biased toward LF (0.04-0.15 Hz), which is the
            # resonance frequency band for coherent breathing (~5-6 bpm)
            raw_coh = lf / total
        elif not math.isnan(ppg.rmssd_ms):
            # RMSSD proxy: normalise to [0,1] with 60 ms as a high-coherence value
            raw_coh = _norm(ppg.rmssd_ms, 10.0, 80.0)
        else:
            return float("nan"), "unknown"

        self._coherence_ema = _exp_smooth(self._coherence_ema, raw_coh, alpha=0.1)
        coh = self._coherence_ema

        if   coh > 0.65:  level = "high"
        elif coh > 0.40:  level = "medium"
        else:             level = "low"

        return round(coh, 4), level


class ResonanceFrequencyPacer:
    """
    Protocol 9 — Resonance Frequency Breathing Pacer
    ──────────────────────────────────────────────────
    Generates a breathing phase cue (inhale / exhale) at the target
    resonance frequency (default 5.5 bpm ≈ 10.9 s cycle).
    The phase is a continuous sinusoid; amplitude > 0 = inhale.
    """
    def __init__(self, bpm: float = 5.5):
        self.bpm          = bpm
        self._start_time  = time.time()

    @property
    def phase(self) -> tuple[str, float]:
        """Returns (phase_label, sine_value in [-1,1])."""
        elapsed   = time.time() - self._start_time
        period_s  = 60.0 / self.bpm
        sine_val  = math.sin(2 * math.pi * elapsed / period_s)
        phase_lbl = "inhale" if sine_val >= 0 else "exhale"
        return phase_lbl, round(sine_val, 4)


class StressIndexProtocol:
    """
    Protocol 10 — Stress Index (sympathovagal balance)
    ─────────────────────────────────────────────────────
    LF/HF ratio: values > 2.0 typically indicate sympathetic dominance.
    Falls back to a beta/alpha EEG ratio if PPG data is unavailable.
    """
    def __init__(self):
        self._stress_ema = float("nan")

    def update(self, ppg: PPGSnapshot | None, eeg: EEGSnapshot | None) -> tuple[float, str]:
        raw_stress = float("nan")

        if ppg and not math.isnan(ppg.lf_hf_ratio):
            # Map LF/HF: 0.5 → low stress (0), 4.0 → high stress (1)
            raw_stress = _norm(ppg.lf_hf_ratio, 0.5, 4.0)
        elif eeg:
            raw_stress = _nan_safe(eeg.metrics.get("stress", float("nan")))
            # Raw EEG stress ratio is unbounded; normalise empirically
            raw_stress = _norm(raw_stress, 0.5, 5.0)

        self._stress_ema = _exp_smooth(self._stress_ema, raw_stress, alpha=0.12)

        if math.isnan(self._stress_ema):
            return float("nan"), "unknown"

        if   self._stress_ema < 0.35:  level = "low"
        elif self._stress_ema < 0.65:  level = "moderate"
        else:                           level = "high"

        return round(self._stress_ema, 4), level


class RecoveryScoreProtocol:
    """
    Protocol 11 — Recovery Score (parasympathetic tone, 0-100)
    ────────────────────────────────────────────────────────────
    Based on RMSSD (root mean square of successive RR differences).
    RMSSD > 50 ms is considered high parasympathetic tone (good recovery).
    Score is personalised using a rolling 20-sample baseline.
    """
    def __init__(self):
        self._rmssd_history: deque[float] = deque(maxlen=20)
        self._score_ema = float("nan")

    def update(self, ppg: PPGSnapshot) -> float:
        rmssd = _nan_safe(ppg.rmssd_ms)
        if math.isnan(rmssd):
            return float("nan")

        self._rmssd_history.append(rmssd)
        if len(self._rmssd_history) < 3:
            return float("nan")

        personal_max = max(self._rmssd_history)
        personal_min = min(self._rmssd_history)
        score = _norm(rmssd, personal_min, personal_max) * 100
        self._score_ema = _exp_smooth(self._score_ema, score, alpha=0.2)
        return round(self._score_ema, 1)


class CardiacCoherenceRatio:
    """
    Protocol 12 — Cardiac Coherence Ratio
    ───────────────────────────────────────
    HF / (LF + HF) — proportion of HRV variance in the parasympathetic
    high-frequency band (0.15-0.40 Hz).  High ratio = vagal dominance.
    """
    def __init__(self):
        self._ratio_ema = float("nan")

    def update(self, ppg: PPGSnapshot) -> float:
        lf = _nan_safe(ppg.lf_power)
        hf = _nan_safe(ppg.hf_power)
        if math.isnan(lf) or math.isnan(hf):
            return float("nan")
        total = lf + hf + 1e-12
        ratio = hf / total
        self._ratio_ema = _exp_smooth(self._ratio_ema, ratio, alpha=0.1)
        return round(self._ratio_ema, 4)


# ═════════════════════════════════════════════════════════════════════════════
# Main engine
# ═════════════════════════════════════════════════════════════════════════════

class FeedbackEngine:
    """
    Aggregates all protocols and produces a FeedbackOutput snapshot
    on every call to `process()`.
    """
    def __init__(self, pacer_bpm: float = 5.5):
        # Neurofeedback
        self.at        = AlphaThetaProtocol()
        self.smr       = SMRProtocol()
        self.faa       = FrontalAlphaAsymmetry()
        self.beta_supp = BetaSuppressionProtocol()
        self.gamma     = GammaCoherenceProtocol()
        self.f_theta   = FrontalThetaEnhancement()
        self.nf_score  = CompositeNFScore()

        # Biofeedback
        self.hrv_coh   = HRVCoherenceProtocol()
        self.pacer     = ResonanceFrequencyPacer(bpm=pacer_bpm)
        self.stress    = StressIndexProtocol()
        self.recovery  = RecoveryScoreProtocol()
        self.coh_ratio = CardiacCoherenceRatio()

        # State
        self._latest_eeg:   EEGSnapshot   | None = None
        self._latest_ppg:   PPGSnapshot   | None = None
        self._latest_imu:   IMUSnapshot   | None = None
        self._latest_fnirs: FNIRSSnapshot | None = None
        self._fnirs_trend_ema: float = float("nan")

    # ── Ingest frames from WebSocket ─────────────────────────────────────────

    def ingest(self, frame: dict) -> None:
        ftype = frame.get("type")

        if ftype == "eeg":
            self._latest_eeg = EEGSnapshot(
                bands   = frame.get("bands", {}),
                metrics = frame.get("metrics", {}),
                ts      = frame.get("ts", 0),
            )

        elif ftype == "ppg":
            m = frame.get("metrics", {})
            self._latest_ppg = PPGSnapshot(
                rr_ms           = _nan_safe(m.get("rr_ms")),
                sdnn_ms         = _nan_safe(m.get("sdnn_ms")),
                rmssd_ms        = _nan_safe(m.get("rmssd_ms")),
                pnn50           = _nan_safe(m.get("pnn50")),
                mean_hr_bpm     = _nan_safe(m.get("mean_hr_bpm")),
                lf_power        = _nan_safe(m.get("lf_power")),
                hf_power        = _nan_safe(m.get("hf_power")),
                lf_hf_ratio     = _nan_safe(m.get("lf_hf_ratio")),
                rr_intervals_ms = m.get("rr_intervals_ms", []),
                ts              = frame.get("ts", 0),
            )

        elif ftype == "imu":
            self._latest_imu = IMUSnapshot(
                acc_rms_g       = frame.get("acc_rms_g", 0),
                gyro_rms_dps    = frame.get("gyro_rms_dps", 0),
                pitch_deg       = frame.get("pitch_deg", 0),
                roll_deg        = frame.get("roll_deg", 0),
                motion_artefact = frame.get("motion_artefact", False),
                ts              = frame.get("ts", 0),
            )

        elif ftype == "fnirs":
            self._latest_fnirs = FNIRSSnapshot(
                optodes         = frame.get("optodes", {}),
                nir_mean        = _nan_safe(frame.get("nir_mean")),
                fnirs_asymmetry = _nan_safe(frame.get("fnirs_asymmetry")),
                ts              = frame.get("ts", 0),
            )

    # ── Compute one feedback snapshot ────────────────────────────────────────

    def process(self) -> FeedbackOutput | None:
        out = FeedbackOutput(ts=time.time())

        # Motion gating — suppress noisy feedback during head movement
        if self._latest_imu:
            out.motion_artefact = self._latest_imu.motion_artefact

        eeg = self._latest_eeg
        ppg = self._latest_ppg

        # ── Neurofeedback ────────────────────────────────────────────────────
        if eeg:
            out.alpha_theta_ratio, out.alpha_theta_state = self.at.update(eeg)
            out.smr_power, out.smr_score                 = self.smr.update(eeg)
            out.faa_score, out.faa_valence               = self.faa.update(eeg)
            out.beta_suppression                         = self.beta_supp.update(eeg)
            out.gamma_coherence                          = self.gamma.update(eeg)
            out.frontal_theta                            = self.f_theta.update(eeg)

            relaxation = _nan_safe(eeg.metrics.get("relaxation", float("nan")))
            # Normalise relaxation: empirical range 0.01–2.0 µV²
            relax_norm = _norm(relaxation, 0.0, 2.0)

            out.nf_score = self.nf_score.compute(
                relaxation       = relax_norm,
                frontal_theta    = out.frontal_theta,
                faa_raw          = out.faa_score,
                beta_suppression = out.beta_suppression,
                smr_score        = out.smr_score,
            )

        # ── Biofeedback ──────────────────────────────────────────────────────
        if ppg:
            out.hrv_coherence, out.coherence_level = self.hrv_coh.update(ppg)
            out.stress_index,  out.stress_level    = self.stress.update(ppg, eeg)
            out.recovery_score                     = self.recovery.update(ppg)
            out.cardiac_coherence_ratio            = self.coh_ratio.update(ppg)
        elif eeg:
            # EEG-only stress estimate when PPG unavailable
            out.stress_index, out.stress_level = self.stress.update(None, eeg)

        # Pacer is always ticking
        out.pacer_phase, _ = self.pacer.phase
        out.pacer_bpm      = self.pacer.bpm

        # ── fNIRS overlay ────────────────────────────────────────────────────
        if self._latest_fnirs:
            nir = _nan_safe(self._latest_fnirs.nir_mean)
            self._fnirs_trend_ema = _exp_smooth(self._fnirs_trend_ema, nir, alpha=0.05)
            out.frontal_oxy_trend  = round(self._fnirs_trend_ema, 4)
            out.fnirs_asymmetry    = _nan_safe(self._latest_fnirs.fnirs_asymmetry)

        return out


# ═════════════════════════════════════════════════════════════════════════════
# CLI — WebSocket consumer
# ═════════════════════════════════════════════════════════════════════════════
def get_feedback(engine, frame, last_out, verbose=True, delay=0.25):
    engine.ingest(frame)
    # Print a full snapshot ~4 Hz regardless of frame type
    now = time.time()
    if now - last_out >= delay:
        last_out = now
        out = engine.process()
        if out:
            snapshot = _format_output(out, verbose)
            # print(snapshot, flush=True)
            return snapshot
    return None
    
async def run_consumer(url: str, verbose: bool, pacer_bpm: float) -> None:
    engine   = FeedbackEngine(pacer_bpm=pacer_bpm)
    last_out = time.time()

    log.info(f"Connecting to bridge at {url} …")

    async for ws in _connect_with_retry(url):
        try:
            async for message in ws:
                frame = json.loads(message)
                snapshot = get_feedback(engine, frame, last_out, verbose)
        except websockets.ConnectionClosed:
            log.warning("Connection closed — retrying …")
            await asyncio.sleep(2)


async def _connect_with_retry(url: str):
    """Yield websocket connections, retrying on failure."""
    try:
        import websockets
    except ImportError:
        raise SystemExit("Install websockets: pip install websockets")
    while True:
        try:
            async with websockets.connect(url) as ws:
                yield ws
        except (OSError, websockets.WebSocketException) as e:
            log.error(f"Connection error: {e}  — retrying in 3 s")
            await asyncio.sleep(3)


def _format_output(out: FeedbackOutput, verbose: bool) -> str:
    """Format FeedbackOutput as a pretty JSON string."""
    d = asdict(out)

    # Replace NaN with null for valid JSON
    def clean(obj):
        if isinstance(obj, dict):
            return {k: clean(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [clean(v) for v in obj]
        if isinstance(obj, float) and math.isnan(obj):
            return None
        return obj

    d = clean(d)

    if not verbose:
        # Compact summary: only high-level fields
        keys = [
            "ts", "motion_artefact",
            "nf_score", "alpha_theta_state", "faa_valence",
            "stress_level", "coherence_level", "recovery_score",
            "pacer_phase", "pacer_bpm",
            "frontal_oxy_trend", "fnirs_asymmetry",
        ]
        d = {k: d[k] for k in keys if k in d}

    return json.dumps(d, indent=2)


if __name__ == "__main__":
    import websockets

    p = argparse.ArgumentParser(
        description="Neurofeedback & Biofeedback engine for Muse S Athena"
    )
    p.add_argument("--url",       default="ws://localhost:8765",
                   help="Bridge WebSocket URL")
    p.add_argument("--verbose",   action="store_true",
                   help="Print full metric snapshot (not just summary)")
    p.add_argument("--pacer-bpm", type=float, default=5.5,
                   help="Resonance frequency pacer rate (default 5.5 bpm)")
    args = p.parse_args()

    try:
        asyncio.run(run_consumer(args.url, args.verbose, args.pacer_bpm))
    except KeyboardInterrupt:
        log.info("Stopped.")
