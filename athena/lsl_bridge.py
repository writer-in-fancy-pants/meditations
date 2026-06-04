#!/usr/bin/env python3
"""
bridge.py — OpenMuse / MNE-LSL → WebSocket bridge  (Muse S Athena edition)
OpenMuse fork - https://github.com/writer-in-fancy-pants/OpenMuse.git

Reads all LSL streams produced by OpenMuse (EEG, PPG/fNIRS optics,
ACC/GYRO, Battery) and pushes JSON frames to every connected WebSocket client.

Sensor inventory (Muse S Athena, preset p1041):
  EEG       – TP9, AF7, AF8, TP10 + 4 Aux channels  @256 Hz
  Optics    – 16 channels (fNIRS × 5 optodes + PPG IR/NIR/Red) @64 Hz
  ACC/GYRO  – 3-axis accelerometer + 3-axis gyroscope @52 Hz
  Battery   – battery percentage (event-driven)

Install:
  pip install mne-lsl websockets neurokit2 numpy scipy

Run:
  OpenMuse stream --address <address from 'OpenMuse find'> --auto-reconnect
  python lsl_bridge.py [--host localhost] [--port 8765]
"""

import argparse
import asyncio
import json
import logging
import math
import time
import threading
from collections import deque
from typing import Any

import numpy as np
import nolds

try:
    from mne_lsl.lsl import StreamInlet, resolve_streams
    _MNE_LSL = True
except ImportError:
    try:
        from pylsl import StreamInlet, resolve_byprop
        _MNE_LSL = False
    except ImportError:
        raise SystemExit(
            "Install mne-lsl (preferred) or pylsl:\n"
            "  pip install mne-lsl   OR   pip install pylsl"
        )

try:
    import websockets
except ImportError:
    raise SystemExit("Install websockets: pip install websockets")

try:
    import neurokit2 as nk
    NK2_AVAILABLE = True
except ImportError:
    NK2_AVAILABLE = False
    logging.warning(
        "neurokit2 not installed – HRV/fNIRS metrics disabled. "
        "Run: pip install neurokit2"
    )

# Local
from neurofeedback import FeedbackEngine, get_feedback
from record import FrameRecorder

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bridge")

import warnings
warnings.filterwarnings("ignore")

# ── EEG config ────────────────────────────────────────────────────────────────
EEG_FS         = 256
WIN_SEC        = 4
STEP_SEC       = 0.25
WIN_SAMPLES    = int(EEG_FS * WIN_SEC)
STEP_SAMPLES   = int(EEG_FS * STEP_SEC)

EEG_CHANNELS   = ["TP9", "AF7", "AF8", "TP10", "AUX1", "AUX2", "AUX3", "AUX4"]
N_EEG_CH       = 8          # Athena exposes 8 EEG (4 standard + 4 Aux)
N_PRIMARY_CH   = 4          # use only primary electrodes for band metrics

BANDS = {
    "delta": (0.75,  4.0),
    "theta": (4.0,  8.0),
    "alpha": (8.0,  13.0),
    "beta":  (13.0, 30.0),
    "gamma": (30.0, 44.0),
}

# ── Optics / PPG / fNIRS config ───────────────────────────────────────────────
OPTICS_FS          = 64
PPG_WIN_SEC        = 30
PPG_STEP_SEC       = 2
PPG_WIN_SAMPLES    = int(OPTICS_FS * PPG_WIN_SEC)
PPG_STEP_SAMPLES   = int(OPTICS_FS * PPG_STEP_SEC)
MIN_PEAKS_FOR_HRV  = 10

# OpenMuse optics channel layout (preset p1041, 16 channels):
#   0-4   : fNIRS short-separation channels (S1-S5)
#   5-9   : fNIRS long-separation channels  (L1-L5)
#  10-14  : fNIRS second wavelength         (W2_1-W2_5)
#  15     : PPG IR
# We use channel 15 (IR) as the primary cardiac PPG signal.
# NOTE: The exact channel ordering varies by firmware/preset; adjust if needed.
PPG_CH_IR   = 15   # Infrared – best for heartbeat
PPG_CH_NIR  = 14   # Near-IR  (730 nm) – fNIRS haemodynamics
PPG_CH_RED  = 13   # Red      (660 nm) – SpO2 estimation
FNIRS_CHANNELS = list(range(0, 13))   # channels dedicated to fNIRS tissue optics

OPTICS_CHANNEL_NAMES = (
    [f"fNIRS_S{i+1}" for i in range(5)]   # short-sep optodes
  + [f"fNIRS_L{i+1}" for i in range(5)]   # long-sep optodes
  + [f"fNIRS_W2_{i+1}" for i in range(3)] # second wavelength
  + ["PPG_Red", "PPG_NIR", "PPG_IR"]      # tri-wavelength PPG
)

# ── ACC / GYRO config ─────────────────────────────────────────────────────────
IMU_FS          = 52
IMU_WIN_SEC     = 2
IMU_STEP_SEC    = 0.5
IMU_WIN_SAMPLES = int(IMU_FS * IMU_WIN_SEC)
IMU_STEP_SAMPLES= int(IMU_FS * IMU_STEP_SEC)
IMU_CHANNELS    = ["ACC_X", "ACC_Y", "ACC_Z", "GYRO_X", "GYRO_Y", "GYRO_Z"]
N_IMU_CH        = 6

# ── Shared ring buffers ───────────────────────────────────────────────────────
eeg_buffers     = [deque(maxlen=WIN_SAMPLES)       for _ in range(N_EEG_CH)]
optics_buffers  = [deque(maxlen=PPG_WIN_SAMPLES)   for _ in range(16)]
imu_buffers     = [deque(maxlen=IMU_WIN_SAMPLES)   for _ in range(N_IMU_CH)]

latest_eeg_frame    = None
latest_ppg_frame    = None
latest_fnirs_frame  = None
latest_imu_frame    = None
latest_battery      = None
latest_marker       = None  # Separate marker stream to mark events on the EEG timeline

clients      = set()
clients_lock = asyncio.Lock()

# Neurofeedback
engine = FeedbackEngine(pacer_bpm=5.5)

# record frames
recorder = None
eeg_recorder = None
ppg_recorder = None

# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_float(value: Any) -> float | None:
    try:
        f = float(value)
        return None if (f != f) else round(f, 4)
    except (TypeError, ValueError):
        return None

def _resolve(stream_name: str, stream_type: str, timeout: float = 10):
    """Resolve an LSL stream, supporting both mne-lsl and pylsl."""
    if _MNE_LSL:
        streams = resolve_streams(timeout=timeout, name=stream_name)
        if not streams:
            # resolve by type
            streams = resolve_streams(timeout=timeout, stype=stream_type)
    else:
        streams = resolve_byprop("name", stream_name, timeout=timeout)
        
    if not streams:
        print(resolve_streams(timeout=1.0))
        log.warning(f"LSL stream '{stream_name}' not found (type={stream_type}). "
                    "Is OpenMuse streaming?")
        return None
    
    try:
        inlet = StreamInlet(streams[0])
        inlet.open_stream()
        info  = inlet.get_sinfo() if _MNE_LSL else inlet.info()
        name  = info.name if _MNE_LSL else info.name()
        srate = info.sfreq if _MNE_LSL else info.nominal_srate()
        nch   = info.n_channels if _MNE_LSL else info.channel_count()
        log.info(f"Connected: '{name}' @ {srate} Hz, {nch} ch")
    except:
        log.warning(f"No stream '{stream_name}'")
    return inlet

def _pull_chunk(inlet):
    """Normalise pull_chunk across mne-lsl / pylsl."""
    if _MNE_LSL:
        samples, ts = inlet.pull_chunk(timeout=0.001)
        out = (samples.T.tolist() if samples is not None and len(samples) else []), ts
    else:
        out = inlet.pull_chunk(timeout=0.001, max_samples=32)
    
    return out

# ── DSP — EEG ─────────────────────────────────────────────────────────────────

def hann(n):
    return 0.5 * (1 - np.cos(2 * np.pi * np.arange(n) / (n - 1)))

def welch_psd(signal, seg_len=512, overlap=256, fs=EEG_FS):
    step  = seg_len - overlap
    win   = hann(seg_len)
    n_seg = (len(signal) - overlap) // step
    if n_seg < 1:
        return None, None
    psd   = np.zeros(seg_len // 2 + 1)
    count = 0
    for s in range(n_seg):
        start = s * step
        if start + seg_len > len(signal):
            break
        seg    = signal[start:start + seg_len] * win
        fft    = np.fft.rfft(seg, n=seg_len)
        psd   += (np.abs(fft) ** 2) / (fs * seg_len)
        count += 1
    if count == 0:
        return None, None
    psd /= count
    psd[1:-1] *= 2
    freqs = np.fft.rfftfreq(seg_len, d=1.0 / fs)
    return psd, freqs

def band_power(psd, freqs, flo, fhi):
    mask = (freqs >= flo) & (freqs <= fhi)
    return float(np.mean(psd[mask])) if mask.any() else 0.0

def compute_bands(signal, fs=EEG_FS):
    psd, freqs = welch_psd(np.array(signal), fs=fs)
    if psd is None:
        return {b: 0.0 for b in BANDS}
    return {b: band_power(psd, freqs, lo, hi) for b, (lo, hi) in BANDS.items()}
 
# Non-linear features
def embed_phase_space(signal: np.ndarray, m: int = 3, tau: int = 3) -> np.ndarray:
    """Create delay-coordinate embedding.
    Returns an (N, m) array where N = len(signal) - (m-1)*tau.
    """
    signal = np.asarray(signal, dtype=np.float64)
    window = (m - 1) * tau
    N = len(signal) - window
    if N <= 0:
        return np.empty((0, m))
    return np.array([signal[i:i + window + 1:tau] for i in range(N)])


def euclid_dist(a: np.ndarray, b: np.ndarray) -> float:
    """Euclidean distance between two same-length arrays : redundant"""
    return float(np.linalg.norm(a - b))
    #return float(np.sqrt(np.sum((a - b) ** 2))) 

def lle(
    signal: np.ndarray,
    m: int = 3,
    tau: int = 3,
    theiler_w: int = 20,
    evolve_steps: int = 20,
):
    pts = embed_phase_space(signal, m, tau)
    n_pts = len(pts)
    if n_pts < evolve_steps + 2:
        return 0.0
    
    # Accumulate mean-log divergence
    indices = np.arange(0, n_pts)
    div_sum = np.zeros(evolve_steps, dtype=np.float64)
    div_count = np.zeros(evolve_steps, dtype=np.float64)
    valid = []
    
    for qi in indices:
        # Nearest neighbor outside Theiler window
        nni = -1
        nnval = -1
        
        for ri in range(n_pts):
            if abs(ri - qi) <= theiler_w:
                continue
            d = euclid_dist(pts[ri], pts[qi])
            if 0 < d < nnval:
                nnval = d
                nni = ri
        
        if nni < 0 or nnval == 0:
            continue
        
        # Divergence over evolve_steps
        for k in range(0, evolve_steps):
            qi2 = qi+k+1
            ri2 = nni+k+1
            
            if qi2 >= n_pts or ri2 >= n_pts:
                continue
            
            dk = euclid_dist(pts[ri2], pts[qi2])
            if dk>0:
                div_sum[k] += np.log(dk / nnval)
                div_count[k] += 1
            
    xs = []
    ys = []
    for k in range(evolve_steps):
        if div_count[k]>0:
            xs.append(k+1)
            ys.append(div_sum/div_count)
    
    n = len(xs)
    if n < 3:
        return 0.0
    
    xs = np.array(xs)
    ys = np.array(ys)
    
    sum_x = xs.sum()
    sum_y = ys.sum()
    sum_xy = (xs*ys).sum()
    
    denom = n*np.linalg.norm(xs) - sum_x**2
    if denom == 0:
        return 0
    
    return float((n*sum_xy - sum_x*sum_y) / denom)


def lle_multi(bands:dict, 
        m: int = 10,
        tau: int = 3,
        theiler_w: int = 20,
        evolve_steps: int = 20
        ):
    """Per-channel LLE"""
    res = {}
    for ch in bands:
        eeg = np.asarray(bands[ch], dtype=np.float64)

        res[ch] = nolds.lyap_r(eeg, emb_dim=m, lag=None, min_tsep=None,
                       tau=tau, min_neighbors=theiler_w,
                       trajectory_len=evolve_steps, fit='RANSAC')
        #res[ch] = lle(eeg, m, tau, theiler_w, evolve_steps) 
    return res   

def katz(bands:dict):
    """Per-channel Katz"""
    res = {}
    for ch in bands:
        eeg = np.asarray(bands[ch], dtype=np.float64)
        sl = eeg.shape[0]
        nbr = np.linalg.norm(np.diff(eeg)).sum()
        sa = nbr.mean()
        l = nbr.sum()
        a = np.linalg.norm(eeg - eeg[0]).max()
        s = sl/sa
        res[ch] = np.log(s) / (np.log(s) + np.log(a/l))
        print(f"Katz {ch}, {res[ch]}")
    return res 

def higuchi(bands:dict, k = 8):
    """Per-channel Katz"""
    res = {}
    for ch in bands:
        eeg = np.asarray(bands[ch], dtype=np.float64)
        n = eeg.shape[0]
        l = np.zeros(k)
        for j in range(k):
            #for i in range(np.floor(n-j)/k)):
            r1 = np.arange(j+k, n, k)
            r2= np.arange(j, n-k, k)
            l[j] = np.linalg.norm((eeg[r1] - eeg[r2]), 1)*(n-1)/((n-j)*(k**2))
        res[ch] = np.log(l.sum())/ np.log(1/k)
        print(f"Higuchi {ch}, {res[ch]}")
    return res 
   
def compute_eeg_frame():
    if len(eeg_buffers[0]) < WIN_SAMPLES:
        return None

    bp  = {}
    raw = {}
    for i, ch in enumerate(EEG_CHANNELS):
        bp[ch.lower()] = compute_bands(list(eeg_buffers[i]))
        raw[ch.lower()] = list(eeg_buffers[i])

    tp9, af7, af8, tp10 = bp["tp9"], bp["af7"], bp["af8"], bp["tp10"]
    eps = 1e-12

    def avg(*v): return sum(v) / len(v)

    # Aux channel aggregate (basic noise / muscle artefact proxy)
    aux_beta_avg = avg(
        bp["aux1"]["beta"], bp["aux2"]["beta"],
        bp["aux3"]["beta"], bp["aux4"]["beta"],
    )
    
    metrics = {
        "focus":      avg(af7["beta"],  af8["beta"]) /
                      (avg(af7["alpha"], af8["alpha"]) + avg(af7["theta"], af8["theta"]) + eps),
        "relaxation": avg(tp9["alpha"], tp10["alpha"]),
        "meditation": avg(af7["theta"], af8["theta"], tp9["theta"], tp10["theta"]) /
                      (avg(af7["alpha"], af8["alpha"], tp9["alpha"], tp10["alpha"]) + eps),
        "stress":     (avg(af7["beta"],  af8["beta"])  + avg(af7["gamma"], af8["gamma"])) /
                      (avg(af7["alpha"], af8["alpha"]) + avg(af7["theta"], af8["theta"]) + eps),
        "engagement": avg(af7["beta"],  af8["beta"],  tp9["beta"],  tp10["beta"]) /
                      (avg(af7["alpha"], af8["alpha"], tp9["alpha"], tp10["alpha"]) +
                       avg(af7["theta"], af8["theta"], tp9["theta"], tp10["theta"]) + eps),
        # Theta/alpha ratio — Peniston-Kulkosky protocol
        "at_ratio":   avg(af7["theta"], af8["theta"], tp9["theta"], tp10["theta"]) /
                      (avg(af7["alpha"], af8["alpha"], tp9["alpha"], tp10["alpha"]) + eps),
        # Frontal alpha asymmetry: ln(AF8α) − ln(AF7α)  (approach vs withdrawal)
        "faa":        math.log(max(af8["alpha"], 1e-12)) - math.log(max(af7["alpha"], 1e-12)),
        # Custom meditation scores
        "vipScore": avg(tp9["alpha"], tp10["alpha"])/
                        (avg(af7["delta"], af8["delta"], tp9["delta"], tp10["delta"],
                           af7["beta"], af8["beta"], tp9["beta"], tp10["beta"],
                           af7["gamma"], af8["gamma"], tp9["gamma"], tp10["gamma"]) + eps),
        "emdrScore": avg(af7["theta"], af8["theta"], tp9["theta"], tp10["theta"],
                         af7['alpha'], af8['alpha']) /
                      (avg(af7["alpha"], af8["alpha"], tp9["alpha"], tp10["alpha"],
                           af7["delta"], af8["delta"], tp9["delta"], tp10["delta"],
                           af7["beta"], af8["beta"], tp9["beta"], tp10["beta"],
                           af7["gamma"], af8["gamma"], tp9["gamma"], tp10["gamma"]) + eps),
        # Mu rhythm (sensorimotor alpha, 8-12 Hz) from Aux electrodes if worn over C3/C4
        "mu_suppression_proxy": aux_beta_avg /
                                (avg(bp["aux1"]["alpha"], bp["aux2"]["alpha"],
                                     bp["aux3"]["alpha"], bp["aux4"]["alpha"]) + eps),
        # Gamma coherence proxy (memory/binding)
        "frontal_gamma":        avg(af7["gamma"], af8["gamma"]),
        # # correlation metrics
        # "band_correlations" :   calculate_band_to_band_correlations(bp),
        # "channel_correlations": calculate_channel_to_channel_correlations(bp),
        
        # Non-linear
        # Largest Lyapunov Exp', desc: 'Mean LLE across all 4 channels — positive = chaotic dynamics, near-zero = ordered/periodic brain state'
        "lle": lle_multi(raw),
        # Katz dimension 
        'katz': katz(raw),
        # higuchi dimension
        'higuchi' : higuchi(raw)
        
        # Correlation dimension : Mean fractal dimension D₂ (Grassberger–Procaccia) — reflects complexity / degrees of freedom in the EEG attractor
       #"corr_dim" : 0,
        # Chaos index : Composite nonlinear score: normalised LLE × D₂ × spectral entropy — near-perfect state classifier
        #"chaos_index" : 0
    }
         
    return {"type": "eeg", "bands": bp, "metrics": metrics, "ts": 0}

# ── DSP — PPG / HRV ──────────────────────────────────────────────────────────

def process_ppg_for_hrv() -> dict[str, Any] | None:
    """
    Run NeuroKit2 PPG pipeline on the IR channel ring buffer.
    Returns time- and frequency-domain HRV metrics.
    """
    if not NK2_AVAILABLE:
        return None

    signal = np.asarray(optics_buffers[PPG_CH_RED], dtype=float)
    ts = np.asarray(optics_buffers[-1], dtype=float)
    if len(signal) < OPTICS_FS * 10:
        return None

    try:
        signals_df, info = nk.ppg_process(signal, sampling_rate=OPTICS_FS)
        peak_indices = info["PPG_Peaks"]
        if len(peak_indices) < MIN_PEAKS_FOR_HRV:
            return None

        rr_ms     = (np.diff(peak_indices) / OPTICS_FS * 1000).tolist()
        hrv_time  = nk.hrv_time(signals_df, sampling_rate=OPTICS_FS, show=False)

        lf_power = hf_power = lf_hf = float("nan")
        if len(signal) >= OPTICS_FS * 30:
            try:
                hrv_freq = nk.hrv_frequency(signals_df, sampling_rate=OPTICS_FS, show=False)
                lf_power = float(hrv_freq.get("HRV_LF",   [float("nan")]).iloc[0])
                hf_power = float(hrv_freq.get("HRV_HF",   [float("nan")]).iloc[0])
                #lf_hf    = float(hrv_freq.get("HRV_LFHF", [float("nan")]).iloc[0])
            except Exception as e:
                log.warning("Freq-domain HRV failed: %s", e)

        metrics = {
            "timestamp":    time.time(),
            "rr_ms":        _safe_float(hrv_time.get("HRV_MeanNN", [float("nan")]).iloc[0]),
            "sdnn_ms":      _safe_float(hrv_time.get("HRV_SDNN",   [float("nan")]).iloc[0]),
            "rmssd_ms":     _safe_float(hrv_time.get("HRV_RMSSD",  [float("nan")]).iloc[0]),
            "pnn50":        _safe_float(hrv_time.get("HRV_pNN50",  [float("nan")]).iloc[0]),
            "mean_hr_bpm":  _safe_float(signals_df.get("PPG_Rate",  [float("nan")]).iloc[-1]),
            "lf_power":     _safe_float(lf_power),
            "hf_power":     _safe_float(hf_power),
            #"lf_hf_ratio":  _safe_float(lf_hf),
            "rr_intervals_ms": rr_ms,
            "peak_count":   len(peak_indices),
        }
        log.info("HRV | HR=%.1f bpm  RMSSD=%.1f ms  SDNN=%.1f ms",
                 metrics["mean_hr_bpm"] or 0,
                 metrics["rmssd_ms"]    or 0,
                 metrics["sdnn_ms"]     or 0)
        return metrics

    except Exception as e:
        log.error("process_ppg_for_hrv failed: %s", e, exc_info=True)
        return None

# ── DSP — fNIRS ───────────────────────────────────────────────────────────────

def compute_fnirs_frame() -> dict[str, Any] | None:
    """
    Very lightweight fNIRS haemodynamics processing.

    The Muse S Athena has 5 bilateral frontal optodes.  We compute:
      • Raw signal means per optode for both wavelengths.
      • A delta-OD (change in optical density) proxy as a slow-drift indicator.
      • Frontal left/right asymmetry in oxygenation proxy.

    Full modified Beer-Lambert (mBLL) conversion requires per-optode
    differential path-length factors (DPF) and source-detector distances
    that are device-specific; those constants should be calibrated per
    subject.  This implementation uses a simplified delta-OD approach
    suitable for relative neurofeedback rather than quantitative haemodynamics.
    """
    min_len = int(OPTICS_FS * 5)          # need ≥ 5 s of data
    if len(optics_buffers[0]) < min_len:
        return None

    try:
        # Short-separation channels (0-4)  → noise/scalp blood flow reference
        # Long-separation channels  (5-9)  → cortical + scalp
        # Difference (long − short)        → cortical proxy
        short_mean = np.array([
            np.mean(list(optics_buffers[i])[-min_len:]) for i in range(5)
        ])
        long_mean  = np.array([
            np.mean(list(optics_buffers[i + 5])[-min_len:]) for i in range(5)
        ])
        cortical_proxy = long_mean - short_mean

        # NIR-channel (PPG_NIR = ch 14) slow trend as oxygenation proxy
        nir_signal = np.array(list(optics_buffers[PPG_CH_NIR])[-min_len:], dtype=float)
        nir_mean   = float(np.mean(nir_signal))
        nir_std    = float(np.std(nir_signal))

        # Frontal hemispheric asymmetry: optodes 0-2 ≈ left, 2-4 ≈ right
        left_proxy  = float(np.mean(cortical_proxy[:2]))
        right_proxy = float(np.mean(cortical_proxy[3:]))
        fnirs_asymmetry = right_proxy - left_proxy

        return {
            "type": "fnirs",
            "optodes": {
                f"optode_{i+1}": {
                    "short_sep": _safe_float(short_mean[i]),
                    "long_sep":  _safe_float(long_mean[i]),
                    "cortical_proxy": _safe_float(cortical_proxy[i]),
                }
                for i in range(5)
            },
            "nir_mean":        _safe_float(nir_mean),
            "nir_std":         _safe_float(nir_std),
            "fnirs_asymmetry": _safe_float(fnirs_asymmetry),
            "ts": time.time(),
        }
    except Exception as e:
        log.error("compute_fnirs_frame failed: %s", e)
        return None

# ── DSP — IMU ─────────────────────────────────────────────────────────────────

def compute_imu_frame() -> dict[str, Any] | None:
    """
    Compute motion metrics from ACC + GYRO ring buffers.
      • RMS acceleration (movement intensity)
      • Tilt angle (pitch / roll from ACC)
      • Angular velocity magnitude (head rotation speed)
      • Motion artefact flag — high movement that may corrupt EEG
    """
    if len(imu_buffers[0]) < IMU_WIN_SAMPLES:
        return None

    try:
        ax = np.array(list(imu_buffers[0]), dtype=float)
        ay = np.array(list(imu_buffers[1]), dtype=float)
        az = np.array(list(imu_buffers[2]), dtype=float)
        gx = np.array(list(imu_buffers[3]), dtype=float)
        gy = np.array(list(imu_buffers[4]), dtype=float)
        gz = np.array(list(imu_buffers[5]), dtype=float)

        acc_magnitude    = np.sqrt(ax**2 + ay**2 + az**2)
        acc_rms          = float(np.sqrt(np.mean(acc_magnitude**2)))
        gyro_magnitude   = np.sqrt(gx**2 + gy**2 + gz**2)
        gyro_rms         = float(np.sqrt(np.mean(gyro_magnitude**2)))

        # Tilt (pitch / roll) from mean ACC — valid only during low-motion
        ax_m, ay_m, az_m = float(np.mean(ax)), float(np.mean(ay)), float(np.mean(az))
        pitch = math.degrees(math.atan2(ax_m, math.sqrt(ay_m**2 + az_m**2)))
        roll  = math.degrees(math.atan2(ay_m, math.sqrt(ax_m**2 + az_m**2)))

        # Motion artefact: flag if RMS acceleration deviates > 0.15 G from 1 G
        # or gyro RMS > 30 deg/s
        motion_artefact = bool(abs(acc_rms - 1.0) > 0.15 or gyro_rms > 30.0)

        return {
            "type":             "imu",
            "acc_rms_g":        _safe_float(acc_rms),
            "gyro_rms_dps":     _safe_float(gyro_rms),
            "pitch_deg":        _safe_float(pitch),
            "roll_deg":         _safe_float(roll),
            "motion_artefact":  motion_artefact,
            "ts":               time.time(),
        }
    except Exception as e:
        log.error("compute_imu_frame failed: %s", e)
        return None

# ── LSL reader threads ────────────────────────────────────────────────────────

def eeg_reader(loop):
    global latest_eeg_frame, engine
    inlet = _resolve("Muse-EEG", "EEG")
    if inlet is None:
        return
    acc = 0
    while True:
        chunk, timestamps = _pull_chunk(inlet)
        if not chunk:
            continue
        
        for channel in chunk:
            for i in range(min(N_EEG_CH, len(channel))):
                eeg_buffers[i].append(channel[i])
                    
        acc += len(timestamps)
                    
        if eeg_recorder:
            arr = np.array2string(
                    np.column_stack([timestamps]+chunk), 
                    separator=',',
                    max_line_width=10000,
                    threshold=1000000,
                    floatmode='unique'
                    ).strip('[]').replace('],\n [', '\n')
            #print(arr)
            eeg_recorder.record(f'{arr}')
        if acc >= STEP_SAMPLES:
            acc = 0
            frame = compute_eeg_frame()
            if frame:
                frame["ts"] = time.time()
                latest_eeg_frame = frame
                # Compute Various Neurofeedback
                # snap = get_feedback(engine, frame, latest_eeg_frame['ts'])
                # if snap:
                #     frame['snapshot'] = snap
                # print(time.time(), acc, len(chunk[0]))
                asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(frame)), loop)


def optics_reader(loop):
    """
    Reads the Muse-OPTICS-named optics stream from OpenMuse.
    OpenMuse names the optics stream 'Muse_Optics'.
    """
    global latest_ppg_frame, latest_fnirs_frame
    inlet = _resolve("Muse-OPTICS", "PPG")
    if inlet is None:
        log.warning("Optics stream unavailable — PPG and fNIRS disabled.")
        return
    ppg_acc = fnirs_acc = 0
    while True:
        chunk, timestamps = _pull_chunk(inlet)
        if not chunk:
            continue
        for sample in chunk:
            for i in range(min(16, len(sample))):
                optics_buffers[i].append(sample[i])
                optics_buffers.append(timestamps)
            ppg_acc   += 1
            fnirs_acc += 1
            
        if ppg_recorder:
            arr = np.array2string(
                    np.column_stack([timestamps]+chunk), 
                    separator=',',
                    max_line_width=10000,
                    threshold=1000000,
                    floatmode='unique'
                    ).strip('[]').replace('],\n [', '\n')
            ppg_recorder.record(f'{arr}')

        if ppg_acc >= PPG_STEP_SAMPLES:
            ppg_acc = 0
            metrics = None
            #metrics = process_ppg_for_hrv()
            if metrics:
                frame = {"type": "ppg", "metrics": metrics, "ts": time.time()}
                latest_ppg_frame = frame
                asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(frame)), loop)

        if fnirs_acc >= int(OPTICS_FS * 1.0):   # fNIRS update @ 1 Hz
            fnirs_acc = 0
            frame = compute_fnirs_frame()
            if frame:
                latest_fnirs_frame = frame
                asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(frame)), loop)


def imu_reader(loop):
    global latest_imu_frame
    inlet = _resolve("Muse-ACCGYRO", "ACCGYRO")
    if inlet is None:
        log.warning("ACC/GYRO stream unavailable — motion metrics disabled.")
        return
    acc = 0
    while True:
        chunk, _ = _pull_chunk(inlet)
        if not chunk:
            continue
        for sample in chunk:
            for i in range(min(N_IMU_CH, len(sample))):
                imu_buffers[i].append(sample[i])
            acc += 1
        if acc >= IMU_STEP_SAMPLES:
            acc = 0
            frame = compute_imu_frame()
            if frame:
                latest_imu_frame = frame
                asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(frame)), loop)


def battery_reader(loop):
    """Reads the Muse_Battery stream (event-driven single float)."""
    global latest_battery
    inlet = _resolve("Muse-BATTERY", "Battery", timeout=5)
    if inlet is None:
        return
    while True:
        sample, _ = (inlet.pull_sample(timeout=5.0)
                     if not _MNE_LSL
                     else inlet.pull_sample(timeout=5.0))
        if sample.size > 0:
            pct = _safe_float(sample[0])
            latest_battery = pct
            frame = {"type": "battery", "percent": pct, "ts": time.time()}
            asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(frame)), loop)
    

# ── WebSocket server ───────────────────────────────────────────────────────────

async def _broadcast(message: str):
    if recorder:
        recorder.record(message)
    async with clients_lock:
        targets = list(clients)
    if targets:
        await asyncio.gather(*[c.send(message) for c in targets],
                             return_exceptions=True)

def recording():
    if recorder:
        recorder.start()
        
    if eeg_recorder:
        eeg_recorder.start()
        eeg_recorder.record('timestamps,TP9,AF7,AF8,TP10,Aux1,Aux2,Aux3,Aux4')

    if ppg_recorder:
        ppg_recorder.start()
        ppg_recorder.record('timestamps,<channel-names>')
    
def stop_recording():
    if recorder:
        recorder.stop()
    if eeg_recorder:
        eeg_recorder.stop()
    if ppg_recorder:
        ppg_recorder.stop()

async def _handle_inbound(ws, message: str):
    """
    Process a message received FROM a WebSocket client (e.g. the VLC plugin).
    Only 'marker' type frames are acted on; everything else is ignored.
    """
    try:
        print(message)
        data = json.loads(message)
    except json.JSONDecodeError:
        log.warning("Received non-JSON message from client: %s", message)
        return

    if data.get("type") != "marker":
        return

    # Normalise: ensure ts is present and is a float
    if "ts" not in data:
        data["ts"] = time.time()

    log.info("VLC marker: event=%s  media=%s  vlc_time_ms=%s",
             data.get("event"), data.get("media"), data.get("vlc_time_ms"))

    serialised = json.dumps(data)

    # Write to the main JSON-lines recorder (same file as EEG/PPG frames)
    # if recorder:
    #    recorder.record(serialised)

    # Broadcast back to all other clients so dashboards see the marker too
    await _broadcast(serialised)


async def _tcp_marker_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    """
    Accepts plain TCP connections from VLC (or any non-WS client).
    Reads newline-delimited JSON lines and passes each to _handle_inbound.
    """
    peer = writer.get_extra_info("peername")
    log.info(f"TCP marker client connected: {peer}")
    try:
        while True:
            line = await reader.readline()
            if not line:          # EOF — client disconnected
                break
            message = line.decode("utf-8").strip()
            if message:
                await _handle_inbound(None, message)
    except asyncio.IncompleteReadError:
        pass
    except Exception as e:
        log.error("TCP marker handler error: %s", e)
    finally:
        writer.close()
        await writer.wait_closed()
        log.info(f"TCP marker client disconnected: {peer}")


async def handler(ws):
    async with clients_lock:
        clients.add(ws)
    log.info(f"Client connected: {ws.remote_address}  total={len(clients)}")
    try:
        # Send the latest known frames so the UI isn't blank on connect
        for frame in [latest_eeg_frame, latest_ppg_frame,
                      latest_fnirs_frame, latest_imu_frame]:
            if frame:
                await ws.send(json.dumps(frame))
        if latest_battery is not None:
            await ws.send(json.dumps(
                {"type": "battery", "percent": latest_battery, "ts": time.time()}
            ))
        #async for message in ws:
        #    await _handle_inbound(ws, message)
        await ws.wait_closed()
    finally:
        async with clients_lock:
            clients.discard(ws)
        stop_recording()
        log.info(f"Client disconnected: {ws.remote_address}  total={len(clients)}")


async def main(host: str, port: int):
    loop = asyncio.get_running_loop()

    # The endpoints require these streams
    processes = [
        ("EEG reader",     eeg_reader),
        ("Optics reader",  optics_reader),
        ("IMU reader",     imu_reader),
        ("Battery reader", battery_reader),
        #('Markers',        marker_incoming),
    ]
    
    for name, fn in processes:
        t = threading.Thread(target=fn, args=(loop,), daemon=True, name=name)
        t.start()
    
    recording()

    # Plain TCP marker server (for VLC / non-WS clients)
    tcp_server = await asyncio.start_server(
        _tcp_marker_handler, host, args.tcp_port
    )
    log.info(f"TCP marker server listening on {host}:{args.tcp_port}")
    log.info(f"WebSocket server listening on ws://{host}:{port}")
    async with websockets.serve(handler, host, port), tcp_server:
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    p = argparse.ArgumentParser(
        description="Muse S Athena → WebSocket bridge (OpenMuse / MNE-LSL)"
    )
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--tcp-port", type=int, default=8766)
    p.add_argument("--record-path", type=str, default="", help="recording location")
    args = p.parse_args()
    
    if args.record_path != '':
        recorder = FrameRecorder(path=args.record_path)
        eeg_recorder = FrameRecorder(path=f"{args.record_path.rsplit('.',1)[0]}_eeg.csv")
        ppg_recorder = FrameRecorder(path=f"{args.record_path.rsplit('.',1)[0]}_ppg.csv")
    asyncio.run(main(args.host, args.port))
