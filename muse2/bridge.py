#!/usr/bin/env python3
"""
bridge.py — muselsl → WebSocket bridge
Reads the LSL EEG stream (TP9, AF7, AF8, TP10) and pushes
JSON frames to all connected WebSocket clients.

Install:  pip install pylsl websockets neurokit2 numpy scipy
Run:      python bridge.py          (default ws://localhost:8765)
          python bridge.py --port 9000
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
from pylsl import StreamInlet, resolve_byprop

try:
    import websockets
except ImportError:
    raise SystemExit("Install websockets:  pip install websockets")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bridge")

# NeuroKit2 — install with:  pip install neurokit2
try:
    import neurokit2 as nk
    NK2_AVAILABLE = True
except ImportError:
    NK2_AVAILABLE = False
    logging.warning(
        "neurokit2 not installed – HRV/PRV features disabled. "
        "Run:  pip install neurokit2"
    )
    
# ── Config ────────────────────────────────────────────────────────────────────
FS          = 256          # Muse sample rate
WIN_SEC     = 4            # analysis window length (seconds)
STEP_SEC    = 0.25         # push interval (seconds)  → 4 Hz update
WIN_SAMPLES = int(FS * WIN_SEC)
STEP_SAMPLES= int(FS * STEP_SEC)

# Muse 2 PPG
MIN_PEAKS_FOR_HRV: int = 10
PPG_SAMPLE_RATE: int = 64
PPG_WIN_SEC: int = 30
PPG_STEP_SEC: int = 2
PPG_WIN_SAMPLES: int = int(PPG_SAMPLE_RATE*PPG_WIN_SEC)
PPG_STEP_SAMPLES: int = int(PPG_SAMPLE_RATE*PPG_STEP_SEC)
PPG_CH_IDX = 1

#PPG_METRICS = {}

CHANNELS    = ["TP9", "AF7", "AF8", "TP10"]
N_CH        = 4

BANDS = {
    "delta": (0.5,  4.0),
    "theta": (4.0,  8.0),
    "alpha": (8.0, 13.0),
    "beta":  (13.0, 30.0),
    "gamma": (30.0, 44.0),
}



# ── Shared state ──────────────────────────────────────────────────────────────
# Ring buffers — one per channel
buffers   = [deque(maxlen=WIN_SAMPLES) for _ in range(N_CH)]
clients   = set()
clients_lock = asyncio.Lock()
latest_frame = None          # most recent computed frame (for late-joining clients)

# ─── Internal ring buffer ────────────────────────────────────────────────────

_ppg_buffer: deque[float] = deque(maxlen=PPG_WIN_SAMPLES + PPG_STEP_SAMPLES)
ppg_latest_frame = None

logger = logging.getLogger(__name__)

# ── DSP ───────────────────────────────────────────────────────────────────────
def _safe_float(value: Any) -> float | None:
    """Convert numpy scalar / NaN to a JSON-serialisable Python float or None."""
    try:
        f = float(value)
        return None if (f != f) else round(f, 4)  # NaN check without math.isnan
    except (TypeError, ValueError):
        return None

def hann(n):
    return 0.5 * (1 - np.cos(2 * np.pi * np.arange(n) / (n - 1)))

def welch_psd(signal, seg_len=512, overlap=256):
    step  = seg_len - overlap
    win   = hann(seg_len)
    n_seg = (len(signal) - overlap) // step
    if n_seg < 1:
        return None, None
    psd = np.zeros(seg_len // 2 + 1)
    count = 0
    for s in range(n_seg):
        start = s * step
        if start + seg_len > len(signal):
            break
        seg = signal[start:start + seg_len] * win
        fft = np.fft.rfft(seg, n=seg_len)
        psd += (np.abs(fft) ** 2) / (FS * seg_len)
        count += 1
    if count == 0:
        return None, None
    psd /= count
    psd[1:-1] *= 2
    freqs = np.fft.rfftfreq(seg_len, d=1.0 / FS)
    return psd, freqs

def band_power(psd, freqs, flo, fhi):
    mask = (freqs >= flo) & (freqs <= fhi)
    return float(np.mean(psd[mask])) if mask.any() else 0.0

def compute_bands(signal):
    psd, freqs = welch_psd(np.array(signal))
    if psd is None:
        return {b: 0.0 for b in BANDS}
    return {b: band_power(psd, freqs, lo, hi) for b, (lo, hi) in BANDS.items()}

def compute_frame():
    """Compute band powers for all channels and derive neurofeedback metrics."""
    if len(buffers[0]) < WIN_SAMPLES:
        return None

    bp = {}
    for i, ch in enumerate(CHANNELS):
        bp[ch.lower()] = compute_bands(list(buffers[i]))

    # Channel name aliases
    tp9, af7, af8, tp10 = bp["tp9"], bp["af7"], bp["af8"], bp["tp10"]
    eps = 1e-12

    def avg(*v): return sum(v) / len(v)

    metrics = {
        "focus":       avg(af7["beta"], af8["beta"]) /
                       (avg(af7["alpha"], af8["alpha"]) + avg(af7["theta"], af8["theta"]) + eps),
        "relaxation":  avg(tp9["alpha"], tp10["alpha"]),
        "meditation":  avg(af7["theta"], af8["theta"], tp9["theta"], tp10["theta"]) /
                       (avg(af7["alpha"], af8["alpha"], tp9["alpha"], tp10["alpha"]) + eps),
        "stress":      (avg(af7["beta"], af8["beta"]) + avg(af7["gamma"], af8["gamma"])) /
                       (avg(af7["alpha"], af8["alpha"]) + avg(af7["theta"], af8["theta"]) + eps),
        "engagement":  avg(af7["beta"], af8["beta"], tp9["beta"], tp10["beta"]) /
                       (avg(af7["alpha"], af8["alpha"], tp9["alpha"], tp10["alpha"]) +
                        avg(af7["theta"], af8["theta"], tp9["theta"], tp10["theta"]) + eps),
        # A/T training: theta/alpha ratio (Peniston protocol)
        "at_ratio":    avg(af7["theta"], af8["theta"], tp9["theta"], tp10["theta"]) /
                       (avg(af7["alpha"], af8["alpha"], tp9["alpha"], tp10["alpha"]) + eps),
        # Frontal alpha asymmetry: ln(AF8α) − ln(AF7α)
        "faa":         math.log(max(af8["alpha"], 1e-12)) - math.log(max(af7["alpha"], 1e-12)),
    }

    return {
        "type":    "eeg",
        "bands":   bp,
        "metrics": metrics,
        "ts":      0,   # filled by caller
    }
    
# ─── Core HRV / PRV processing ───────────────────────────────────────────────

def process_ppg_for_hrv() -> dict[str, Any] | None:
    """
    Detect peaks in a PPG signal and compute HRV / PRV metrics.

    Uses NeuroKit2's ``nk.ppg_process()`` pipeline which handles:
      1. Bandpass filtering (0.5–8 Hz)
      2. Peak detection (systolic peaks)
      3. RR / IBI interval extraction
      4. Time-domain HRV: SDNN, RMSSD, pNN50, mean HR
      5. Frequency-domain HRV: LF, HF, LF/HF ratio

    Parameters
    ----------
    _ppg_buffer    : 1-D array-like of raw PPG amplitudes.
    sampling_rate : Sampling rate in Hz (default 64 for Muse 2).

    Returns
    -------
    dict with keys:
        timestamp   – Unix time of analysis
        mean_rr_ms  – Mean RR interval (ms)
        sdnn_ms     – SDNN (ms)
        rmssd_ms    – RMSSD (ms)
        pnn50       – pNN50 (proportion 0–1)
        mean_hr_bpm – Mean heart rate (bpm)
        lf_power    – LF power (ms²)
        hf_power    – HF power (ms²)
        lf_hf_ratio – LF/HF ratio
        rr_intervals_ms – list of individual RR intervals (ms)
        ibi_ms      – alias for rr_intervals_ms (inter-beat intervals)
    Returns ``None`` if analysis fails or neurokit2 is not installed.
    """
    if not NK2_AVAILABLE:
        return None
    
    sampling_rate = PPG_SAMPLE_RATE

    signal = np.asarray(_ppg_buffer, dtype=float)
    if len(signal) < sampling_rate * 10:
        logger.debug("PPG window too short for HRV analysis")
        return None

    try:
        # ── NeuroKit2 PPG pipeline ──────────────────────────────────────────
        signals_df, info = nk.ppg_process(signal, sampling_rate=sampling_rate)

        # Peak indices (systolic peaks)
        peak_indices = info["PPG_Peaks"]

        if len(peak_indices) < MIN_PEAKS_FOR_HRV:
            logger.debug(
                "Too few PPG peaks detected (%d) for reliable HRV", len(peak_indices)
            )
            return None

        # ── RR intervals (ms) ───────────────────────────────────────────────
        rr_intervals_ms = (np.diff(peak_indices) / sampling_rate * 1000).tolist()

        # ── Time-domain metrics ─────────────────────────────────────────────
        hrv_time = nk.hrv_time(signals_df, sampling_rate=sampling_rate, show=False)

        mean_rr_ms  = float(hrv_time.get("HRV_MeanNN",  [np.nan]).iloc[0])
        sdnn_ms     = float(hrv_time.get("HRV_SDNN",    [np.nan]).iloc[0])
        rmssd_ms    = float(hrv_time.get("HRV_RMSSD",   [np.nan]).iloc[0])
        pnn50       = float(hrv_time.get("HRV_pNN50",   [np.nan]).iloc[0])
        mean_hr_bpm = float(signals_df.get("PPG_Rate",   [np.nan]).iloc[-1])

        # ── Frequency-domain metrics (requires ≥ 30 s window) ──────────────
        lf_power    = np.nan
        hf_power    = np.nan
        lf_hf_ratio = np.nan

        if len(signal) >= sampling_rate * 30:
            try:
                hrv_freq = nk.hrv_frequency(
                    signals_df, sampling_rate=sampling_rate, show=False
                )
                lf_power    = float(hrv_freq.get("HRV_LF",    [np.nan]).iloc[0])
                hf_power    = float(hrv_freq.get("HRV_HF",    [np.nan]).iloc[0])
                lf_hf_ratio = float(hrv_freq.get("HRV_LFHF",  [np.nan]).iloc[0])
            except Exception as freq_err:
                logger.warning("Frequency-domain HRV failed: %s", freq_err)

        metrics: dict[str, Any] = {
            "timestamp":        time.time(),
            "rr_ms":            _safe_float(mean_rr_ms),
            "sdnn_ms":          _safe_float(sdnn_ms),
            "rmssd_ms":         _safe_float(rmssd_ms),
            "pnn50":            _safe_float(pnn50),
            "mean_hr_bpm":      _safe_float(mean_hr_bpm),
            "lf_power":         _safe_float(lf_power),
            "hf_power":         _safe_float(hf_power),
            #"lf_hf_ratio":      _safe_float(lf_hf_ratio),
            "rr_intervals_ms":  rr_intervals_ms,
            "ibi_ms":           rr_intervals_ms,  # alias
            "peak_count":       len(peak_indices),
        }

        logger.info(
            "HRV | HR=%.1f bpm  RMSSD=%.1f ms  SDNN=%.1f ms",#  LF/HF=%.2f",
            metrics["mean_hr_bpm"],
            metrics["rmssd_ms"],
            metrics["sdnn_ms"],
            #metrics["lf_hf_ratio"] if not np.isnan(metrics["lf_hf_ratio"]) else -1,
        )
        return metrics

    except Exception as exc:
        logger.error("process_ppg_for_hrv failed: %s", exc, exc_info=True)
        return None


# ── LSL reader thread ──────────────────────────────────────────────────────────

def lsl_reader(loop):
    """Blocking loop: reads LSL, fills ring buffers, schedules frame pushes."""
    global latest_frame

    log.info("Searching for LSL EEG stream (type='EEG')…")
    streams = resolve_byprop("type", "EEG", timeout=10)
    if not streams:
        log.error("No LSL EEG stream found. Is muselsl streaming?")
        return

    inlet    = StreamInlet(streams[0], max_chunklen=12)
    info     = inlet.info()
    log.info(f"Connected to '{info.name()}' @ {info.nominal_srate()} Hz, "
             f"{info.channel_count()} channels")
    
    sample_acc = 0  # samples accumulated since last push

    while True:
        chunk, timestamps = inlet.pull_chunk(timeout=0.02, max_samples=12)
        if not chunk:
            continue

        for sample in chunk:
            for i in range(N_CH):
                buffers[i].append(sample[i])
            sample_acc += 1

        if sample_acc >= STEP_SAMPLES:
            sample_acc = 0
            frame = compute_frame()
            if frame:
                frame["ts"] = time.time()
                latest_frame = frame
                asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(frame)), loop)
                
        
def ppg_lsl_reader(loop):
    """Blocking loop: reads LSL, fills ring buffers, schedules frame pushes."""
    global ppg_latest_frame
    log.info("Searching for LSL EEG stream (type='EEG')…")
    streams = resolve_byprop("type", "PPG", timeout=10)
    if not streams:
        log.error("No LSL PPG stream found. Is muselsl streaming?")
        return

    inlet    = StreamInlet(streams[0], max_chunklen=12)
    info     = inlet.info()
    log.info(f"Connected to '{info.name()}' @ {info.nominal_srate()} Hz, "
             f"{info.channel_count()} channels")
    
    sample_acc = 0  # samples accumulated since last push

    while True:
        chunk, timestamps = inlet.pull_chunk(timeout=0.02, max_samples=12)
        if not chunk:
            continue
        
        samples    = np.array(chunk, dtype=np.float64)    # (n, 3)
        #timestamps = np.array(timestamps, dtype=np.float64)

        for sample in samples:
            _ppg_buffer.append(sample[PPG_CH_IDX])
            sample_acc += 1

        if sample_acc >= PPG_STEP_SAMPLES:
            sample_acc = 0
            metrics = process_ppg_for_hrv()
            if metrics:
                ppg_latest_frame = {
                    "type":    "ppg",
                    "metrics": metrics,
                    "ts":      time.time(),
                }
                asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(ppg_latest_frame)), loop)        
            

# ── WebSocket server ───────────────────────────────────────────────────────────

async def _broadcast(message):
    async with clients_lock:
        targets = list(clients)
    if targets:
        await asyncio.gather(*[c.send(message) for c in targets], return_exceptions=True)

async def handler(ws):
    async with clients_lock:
        clients.add(ws)
    log.info(f"Client connected: {ws.remote_address}  total={len(clients)}")
    try:
        # Send the latest frame immediately so the UI isn't blank
        if latest_frame:
            await ws.send(json.dumps(latest_frame))
        await ws.wait_closed()
    finally:
        async with clients_lock:
            clients.discard(ws)
        log.info(f"Client disconnected: {ws.remote_address}  total={len(clients)}")

async def main(host, port):
    loop = asyncio.get_running_loop()
    # Start LSL reader in background thread
    t = threading.Thread(target=lsl_reader, args=(loop,), daemon=True)
    t.start()
    
    # Start PPG LSL reader in another background thread
    p = threading.Thread(target=ppg_lsl_reader, args=(loop,), daemon=True)
    p.start()

    log.info(f"WebSocket server listening on ws://{host}:{port}")
    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--ppg-ch", default=1, type=int, choices=[0,1,2],
                   help="PPG Channel to use. 0 : Ambient light, 1 : Infrared, 2: Red light")
    args = p.parse_args()
    PPG_CH_IDX = args.ppg_ch
    asyncio.run(main(args.host, args.port))
