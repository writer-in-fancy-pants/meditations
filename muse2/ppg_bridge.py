#!/usr/bin/env python3
"""
ppg_bridge.py — Muse 2 PPG → Heart Rate → WebSocket bridge
============================================================
Reads the PPG LSL stream produced by muselsl (3 channels at 64 Hz),
detects systolic peaks on the infrared (PPG2) channel, derives
beat-to-beat RR intervals and BPM, and broadcasts JSON frames to all
connected WebSocket clients in the same format as bridge.py:

    { "type": "rr", "bpm": 72, "rr_ms": [820, 815], "ts": 1234567890.0 }

Also emits raw BVP frames for the browser's own peak detector fallback:

    { "type": "ppg", "ppg_bvp": [0.12, 0.14, ...], "ts": 1234567890.0 }

Muse 2 PPG spec
───────────────
  Channel 0 (PPG1):  ambient light reference     → used for noise subtraction
  Channel 1 (PPG2):  infrared (940 nm)           → primary HR signal
  Channel 2 (PPG3):  red (660 nm)                → secondary HR / SpO₂
  Sample rate:       64 Hz
  LSL stream:        name="Muse", type="PPG", 3 channels

Signal processing pipeline
──────────────────────────
  1. DC removal:       subtract running mean (2-second window)
  2. Ambient subtract: PPG2 − PPG1 to cancel common-mode noise
  3. Bandpass filter:  0.5–4 Hz (Butterworth 2nd order) — captures 30–240 bpm
  4. Normalise:        divide by rolling RMS (5-second window) for gain stability
  5. Peak detection:   adaptive threshold, min distance 300 ms, min prominence
  6. RR validation:    physiological bounds 300–2000 ms, ectopic detection
  7. Broadcast:        emit on every new confirmed peak (~1 Hz at rest)

Usage
─────
  # 1. Start muselsl PPG stream (Muse 2 only):
  muselsl stream --ppg

  # 2. Start this bridge:
  python ppg_bridge.py

  # Options:
  python ppg_bridge.py --port 8765 --host localhost --channel ir
  python ppg_bridge.py --raw           # also emit raw BVP frames
  python ppg_bridge.py --debug         # verbose peak detection logging

Install:  pip install pylsl websockets numpy scipy
"""

import argparse
import asyncio
import json
import logging
import math
import threading
import time
from collections import deque

import numpy as np
from scipy.signal import butter, sosfilt, sosfilt_zi

try:
    from pylsl import StreamInlet, resolve_byprop
except ImportError:
    raise SystemExit("Install pylsl:  pip install pylsl")

try:
    import websockets
except ImportError:
    raise SystemExit("Install websockets:  pip install websockets")

# ── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ppg-bridge")

# ── Constants ──────────────────────────────────────────────────────────────
PPG_FS             = 64        # Muse 2 PPG sample rate (Hz)
PPG_CH_AMBIENT     = 0         # PPG1 — ambient reference
PPG_CH_IR          = 1         # PPG2 — infrared (primary)
PPG_CH_RED         = 2         # PPG3 — red (secondary)

BANDPASS_LO        = 0.5       # Hz — low cutoff (removes baseline wander)
BANDPASS_HI        = 4.0       # Hz — high cutoff (removes motion at >240 bpm)
BANDPASS_ORDER     = 2         # Butterworth order (light phase distortion)

DC_WINDOW_S        = 2.0       # seconds for DC removal rolling mean
RMS_WINDOW_S       = 5.0       # seconds for gain normalisation window
PEAK_MIN_DIST_S    = 0.30      # minimum inter-peak interval (300 ms = 200 bpm max)
PEAK_PROMINENCE    = 0.4       # fraction of recent signal range (adaptive threshold)
RR_MIN_MS          = 300       # physiological lower bound
RR_MAX_MS          = 2000      # physiological upper bound

# Ectopic beat rejection: if successive RR differs by >ECTOPIC_THRESH × median, flag it
ECTOPIC_THRESH     = 0.25      # 25% deviation from rolling median

BROADCAST_MIN_S    = 0.5       # don't broadcast more often than this (anti-flood)
RAW_CHUNK_S        = 0.25      # emit raw BVP frames at 4 Hz intervals

# ── Signal processor ───────────────────────────────────────────────────────

class PPGProcessor:
    """
    Stateful per-session PPG signal processor.
    Accepts chunks of samples from the LSL callback thread
    and emits (bpm, rr_ms_list) tuples when new peaks are detected.
    """

    def __init__(self, channel: str = "ir", emit_raw: bool = False,
                 debug: bool = False):
        self.channel    = PPG_CH_IR if channel == "ir" else PPG_CH_RED
        self.emit_raw   = emit_raw
        self.debug      = debug

        # ── Filter coefficients (computed once) ─────────────────────────
        self._sos, self._zi = self._make_bandpass()

        # ── Ring buffers ────────────────────────────────────────────────
        self._dc_buf  = deque(maxlen=int(PPG_FS * DC_WINDOW_S))
        self._rms_buf = deque(maxlen=int(PPG_FS * RMS_WINDOW_S))

        # ── Peak / RR state ─────────────────────────────────────────────
        self._buf               = deque()          # filtered signal ring
        self._buf_times         = deque()          # LSL timestamps for each sample
        self._sample_idx        = 0                # absolute sample counter
        self._last_peak_idx     = -1               # sample index of last valid peak
        self._last_peak_time    = None             # LSL time of last valid peak
        self._rr_history        = deque(maxlen=32) # recent RR intervals (ms)
        self._pending_rr        = []               # RR intervals since last broadcast
        self._last_broadcast_t  = 0.0

        # Raw BVP chunk accumulator
        self._raw_chunk         = []
        self._last_raw_t        = 0.0

        # Stats
        self._total_peaks       = 0
        self._rejected_peaks    = 0

    # ── Filter construction ──────────────────────────────────────────────

    def _make_bandpass(self):
        nyq = PPG_FS / 2
        lo  = BANDPASS_LO / nyq
        hi  = min(BANDPASS_HI / nyq, 0.99)
        sos = butter(BANDPASS_ORDER, [lo, hi], btype="band", output="sos")
        zi  = sosfilt_zi(sos) * 0.0     # zero initial conditions
        # zi shape: (n_sections, 2) — expand for single-sample filtering
        return sos, zi

    # ── Public API ───────────────────────────────────────────────────────

    def push(self, samples: np.ndarray, timestamps: np.ndarray):
        """
        Process a chunk of PPG samples (shape: [n_samples, n_channels]).
        Returns a list of broadcast-ready JSON-serialisable dicts, or empty list.
        """
        results = []
        ambient = samples[:, PPG_CH_AMBIENT]
        primary = samples[:, self.channel]

        # ── Ambient noise subtraction ────────────────────────────────────
        # Infrared and ambient share common-mode interference (fluorescent
        # lights, motion). Subtracting ambient improves SNR.
        signal = primary - ambient

        # ── Process sample-by-sample to keep filter state consistent ────
        for i, (s, t) in enumerate(zip(signal, timestamps)):
            result = self._process_sample(float(s), float(t))
            if result:
                results.append(result)

        # ── Raw BVP frame (for browser fallback peak detector) ──────────
        if self.emit_raw:
            self._raw_chunk.extend(signal.tolist())
            now = time.time()
            if now - self._last_raw_t >= RAW_CHUNK_S and self._raw_chunk:
                results.append({
                    "type":    "ppg",
                    "ppg_bvp": self._raw_chunk[-int(PPG_FS * RAW_CHUNK_S):],
                    "ts":      now,
                })
                self._last_raw_t = now

        return results

    # ── Per-sample processing ────────────────────────────────────────────

    def _process_sample(self, raw: float, lsl_time: float):
        """Apply filter chain and attempt peak detection. Returns dict or None."""

        # 1. DC removal (subtract rolling mean)
        self._dc_buf.append(raw)
        dc   = sum(self._dc_buf) / len(self._dc_buf)
        demeaned = raw - dc

        # 2. Bandpass (online single-sample sosfilt)
        filtered, self._zi = sosfilt(self._sos, [[demeaned]], zi=self._zi[:, :, np.newaxis])
        filtered = float(filtered[0, 0])

        # 3. Gain normalisation (divide by rolling RMS)
        self._rms_buf.append(filtered ** 2)
        rms = math.sqrt(sum(self._rms_buf) / len(self._rms_buf)) if self._rms_buf else 1.0
        normalised = filtered / (rms + 1e-9)

        # Store in ring buffer (keep 10 s)
        max_buf = int(PPG_FS * 10)
        self._buf.append(normalised)
        self._buf_times.append(lsl_time)
        if len(self._buf) > max_buf:
            self._buf.popleft()
            self._buf_times.popleft()
            if self._last_peak_idx >= 0:
                self._last_peak_idx -= 1

        self._sample_idx += 1

        # 4. Peak detection
        return self._detect_peak()

    def _detect_peak(self):
        """
        Look for a systolic peak at the current tail of the buffer.
        Uses an adaptive threshold: PEAK_PROMINENCE × (max − min) of the
        last 2-second window.
        """
        buf  = self._buf
        n    = len(buf)
        if n < 3:
            return None

        # Minimum peak distance in samples
        min_dist = int(PPG_FS * PEAK_MIN_DIST_S)

        # Only consider a peak at position n-2 (one sample before current end)
        # so we can compare with both neighbours
        i    = n - 2
        prev = buf[i - 1]
        curr = buf[i]
        nxt  = buf[i + 1]

        if not (curr > prev and curr > nxt):
            return None

        # Distance from last peak
        dist = i - self._last_peak_idx
        if dist < min_dist:
            return None

        # Adaptive amplitude threshold (must exceed PEAK_PROMINENCE of recent range)
        window_start = max(0, i - int(PPG_FS * 2))
        window = list(buf)[window_start:i + 1]
        mn, mx  = min(window), max(window)
        rng     = mx - mn
        if rng < 1e-6:
            return None
        if (curr - mn) < PEAK_PROMINENCE * rng:
            return None

        # ── Valid peak — compute RR ──────────────────────────────────────
        peak_time = self._buf_times[i]
        self._total_peaks += 1

        if self._last_peak_time is not None:
            rr_ms = (peak_time - self._last_peak_time) * 1000.0

            # Physiological bounds check
            if not (RR_MIN_MS <= rr_ms <= RR_MAX_MS):
                if self.debug:
                    log.debug(f"  Rejected RR={rr_ms:.0f} ms (out of bounds)")
                self._rejected_peaks += 1
                # Still update peak position to avoid cascade rejections
                self._last_peak_idx  = i
                self._last_peak_time = peak_time
                return None

            # Ectopic beat check (>25% deviation from rolling median)
            if len(self._rr_history) >= 4:
                med = sorted(self._rr_history)[len(self._rr_history) // 2]
                if abs(rr_ms - med) / (med + 1e-9) > ECTOPIC_THRESH:
                    if self.debug:
                        log.debug(f"  Ectopic: RR={rr_ms:.0f} ms, median={med:.0f} ms")
                    self._rejected_peaks += 1
                    self._last_peak_idx  = i
                    self._last_peak_time = peak_time
                    return None

            self._rr_history.append(rr_ms)
            self._pending_rr.append(int(round(rr_ms)))

        self._last_peak_idx  = i
        self._last_peak_time = peak_time

        # ── Broadcast throttle ───────────────────────────────────────────
        now = time.time()
        if self._pending_rr and (now - self._last_broadcast_t) >= BROADCAST_MIN_S:
            bpm = self._compute_bpm()
            frame = {
                "type":   "rr",
                "bpm":    bpm,
                "rr_ms":  self._pending_rr[:],
                "ts":     now,
            }
            self._pending_rr = []
            self._last_broadcast_t = now

            if self.debug or self._total_peaks % 10 == 0:
                accept_rate = 100 * (1 - self._rejected_peaks /
                              max(1, self._total_peaks))
                log.info(f"  Peak #{self._total_peaks}  BPM={bpm:3d}  "
                         f"RR={frame['rr_ms']}  accept={accept_rate:.0f}%")
            return frame

        return None

    def _compute_bpm(self):
        """BPM from the median of recent RR history."""
        rr = list(self._rr_history)
        if not rr:
            return 0
        med = sorted(rr)[len(rr) // 2]
        return int(round(60000.0 / max(med, 1)))

    def reset(self):
        """Reset all state (called on LSL reconnect)."""
        self.__init__(
            channel  = "ir" if self.channel == PPG_CH_IR else "red",
            emit_raw = self.emit_raw,
            debug    = self.debug,
        )


# ── WebSocket server ───────────────────────────────────────────────────────

clients      = set()
clients_lock = asyncio.Lock()
latest_frame = None
_loop        = None


async def _broadcast(message: str):
    async with clients_lock:
        targets = list(clients)
    if not targets:
        return
    results = await asyncio.gather(
        *[c.send(message) for c in targets],
        return_exceptions=True,
    )
    for r in results:
        if isinstance(r, Exception):
            log.debug(f"WS send error: {r}")


async def ws_handler(websocket):
    global clients
    async with clients_lock:
        clients.add(websocket)
    remote = websocket.remote_address
    log.info(f"WS client connected:    {remote}  ({len(clients)} total)")
    try:
        if latest_frame:
            await websocket.send(json.dumps(latest_frame))
        await websocket.wait_closed()
    finally:
        async with clients_lock:
            clients.discard(websocket)
        log.info(f"WS client disconnected: {remote}  ({len(clients)} total)")


# ── LSL reader thread ──────────────────────────────────────────────────────

def lsl_reader(processor: PPGProcessor, loop: asyncio.AbstractEventLoop):
    """
    Blocking loop: resolve the Muse PPG LSL stream, read chunks, process,
    and schedule WebSocket broadcasts on the asyncio event loop.
    """
    global latest_frame

    while True:
        log.info("Searching for Muse PPG LSL stream (type='PPG')…")
        log.info("  Make sure muselsl is running with PPG enabled:")
        log.info("    muselsl stream --ppg")

        streams = resolve_byprop("type", "PPG", timeout=10)

        if not streams:
            log.warning("  No PPG stream found — retrying in 5 s")
            time.sleep(5)
            processor.reset()
            continue

        inlet = StreamInlet(streams[0], max_chunklen=16)
        info  = inlet.info()
        fs    = info.nominal_srate()
        log.info(f"Connected: '{info.name()}' · {info.channel_count()} ch · {fs:.0f} Hz")

        if info.channel_count() < 3:
            log.error("Expected 3 PPG channels (ambient, IR, red). Got "
                      f"{info.channel_count()}. Is this a Muse 2?")
            time.sleep(5)
            continue

        processor.reset()
        log.info("Streaming PPG → peak detection → WebSocket")

        try:
            while True:
                chunk, timestamps = inlet.pull_chunk(timeout=0.05, max_samples=16)
                if not chunk:
                    continue

                samples    = np.array(chunk, dtype=np.float64)    # (n, 3)
                timestamps = np.array(timestamps, dtype=np.float64)

                frames = processor.push(samples, timestamps)

                for frame in frames:
                    latest_frame = frame
                    asyncio.run_coroutine_threadsafe(
                        _broadcast(json.dumps(frame)), loop
                    )

        except Exception as exc:
            log.warning(f"LSL stream error: {exc} — reconnecting")
            processor.reset()
            time.sleep(2)


# ── Main ───────────────────────────────────────────────────────────────────

async def main(args):
    global _loop
    _loop = asyncio.get_running_loop()

    log.info("=" * 56)
    log.info("  Muse 2 PPG → Heart Rate → WebSocket bridge")
    log.info("=" * 56)
    log.info(f"  Channel:    {'infrared (PPG2)' if args.channel == 'ir' else 'red (PPG3)'}")
    log.info(f"  Raw frames: {'yes' if args.raw else 'no'}")
    log.info(f"  WebSocket:  ws://{args.host}:{args.port}")
    log.info(f"  Bandpass:   {BANDPASS_LO}–{BANDPASS_HI} Hz")
    log.info(f"  Min RR:     {RR_MIN_MS}–{RR_MAX_MS} ms  ({60000//RR_MAX_MS}–{60000//RR_MIN_MS} bpm)")
    log.info("─" * 56)

    processor = PPGProcessor(
        channel  = args.channel,
        emit_raw = args.raw,
        debug    = args.debug,
    )

    # Start LSL reader in background thread
    t = threading.Thread(
        target=lsl_reader,
        args=(processor, _loop),
        daemon=True,
    )
    t.start()

    log.info(f"WebSocket server listening on ws://{args.host}:{args.port}")
    async with websockets.serve(ws_handler, args.host, args.port):
        await asyncio.Future()   # run forever


def parse_args():
    p = argparse.ArgumentParser(
        description="Muse 2 PPG LSL stream → Heart Rate → WebSocket",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--host",    default="localhost",
                   help="WebSocket bind host")
    p.add_argument("--port",    type=int, default=8765,
                   help="WebSocket port (matches bridge.py default)")
    p.add_argument("--channel", choices=["ir", "red"], default="ir",
                   help="PPG channel: ir=infrared (PPG2, recommended) | red=red (PPG3)")
    p.add_argument("--raw",     action="store_true",
                   help="Also emit raw BVP frames (type='ppg') for browser peak detector")
    p.add_argument("--debug",   action="store_true",
                   help="Verbose peak detection logging")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        log.info("Stopped.")
