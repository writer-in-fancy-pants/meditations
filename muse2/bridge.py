#!/usr/bin/env python3
"""
bridge.py — muselsl → WebSocket bridge
Reads the LSL EEG stream (TP9, AF7, AF8, TP10) and pushes
JSON frames to all connected WebSocket clients.

Install:  pip install pylsl websockets numpy
Run:      python bridge.py          (default ws://localhost:8765)
          python bridge.py --port 9000
"""

import argparse
import asyncio
import json
import logging
import math
import threading
from collections import deque

import numpy as np
from pylsl import StreamInlet, resolve_byprop

try:
    import websockets
except ImportError:
    raise SystemExit("Install websockets:  pip install websockets")

# ── Config ────────────────────────────────────────────────────────────────────
FS          = 256          # Muse sample rate
WIN_SEC     = 4            # analysis window length (seconds)
STEP_SEC    = 0.25         # push interval (seconds)  → 4 Hz update
WIN_SAMPLES = int(FS * WIN_SEC)
STEP_SAMPLES= int(FS * STEP_SEC)
CHANNELS    = ["TP9", "AF7", "AF8", "TP10"]
N_CH        = 4

BANDS = {
    "delta": (0.5,  4.0),
    "theta": (4.0,  8.0),
    "alpha": (8.0, 13.0),
    "beta":  (13.0, 30.0),
    "gamma": (30.0, 44.0),
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bridge")

# ── Shared state ──────────────────────────────────────────────────────────────
# Ring buffers — one per channel
buffers   = [deque(maxlen=WIN_SAMPLES) for _ in range(N_CH)]
clients   = set()
clients_lock = asyncio.Lock()
latest_frame = None          # most recent computed frame (for late-joining clients)

# ── DSP ───────────────────────────────────────────────────────────────────────

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
                import time
                frame["ts"] = time.time()
                latest_frame = frame
                asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(frame)), loop)

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

    log.info(f"WebSocket server listening on ws://{host}:{port}")
    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()
    asyncio.run(main(args.host, args.port))
