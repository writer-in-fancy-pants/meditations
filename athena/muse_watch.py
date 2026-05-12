#!/usr/bin/env python3
"""
muse_watch.py — Muse S / Muse 2 EEG for Termux / Android
====================================================================
Replaces bleak-based OpenMuse/athena with a pure-Python BLE client
built on the reverse-engineered Athena protocol (amused-py).

Requirements (Termux):
    pkg install python bluetooth
    pip install bleak numpy scipy rich textual

For older Muse 2 (non-Athena):
    The same BLE characteristic layout applies; just use preset p50.

Usage:
    python muse_watch.py [--address AA:BB:CC:DD:EE:FF]
    python muse_watch.py --scan          # scan & pick device interactively
    python muse_watch.py --demo          # run with simulated data (no BLE)
"""

import argparse
import asyncio
import csv
import json
import os
import struct
import sys
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

# ---------------------------------------------------------------------------
# Optional imports — degrade gracefully so the logic layer always works
# ---------------------------------------------------------------------------
try:
    from bleak import BleakClient, BleakScanner
    BLEAK_AVAILABLE = True
except ImportError:
    BLEAK_AVAILABLE = False

try:
    from scipy.signal import welch, butter, sosfilt
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False

try:
    from rich.console import Console
    from rich.live import Live
    from rich.table import Table
    from rich.layout import Layout
    from rich.panel import Panel
    from rich.progress import BarColumn, Progress, TextColumn
    from rich.text import Text
    RICH_AVAILABLE = True
    console = Console()
except ImportError:
    RICH_AVAILABLE = False
    console = None


# ===========================================================================
# PROTOCOL CONSTANTS
# ===========================================================================

# BLE UUIDs used by Muse S / Muse 2 / Muse S Athena
UUID_CONTROL   = "273e0001-4e6f-72-6f-5265-7365617263-68"  # write commands
UUID_DATA      = "273e0013-4e6f-726f-5265-73656172636-8"   # all sensor data (Athena)
# Muse 2 / legacy channels
UUID_EEG       = "273e0003-4e6f-726f-5265-736561726368"
UUID_PPG1      = "273e000f-4e6f-726f-5265-736561726368"
UUID_PPG2      = "273e0010-4e6f-726f-5265-736561726368"
UUID_PPG3      = "273e0011-4e6f-726f-5265-736561726368"
UUID_ACC       = "273e000a-4e6f-726f-5265-736561726368"
UUID_GYRO      = "273e0009-4e6f-726f-5265-736561726368"
UUID_TELEMETRY = "273e0004-4e6f-726f-5265-736561726368"

# Athena subpacket TAGs
TAG_EEG4   = 0x11   # 4-ch EEG, 4 samples/pkt, 256 Hz
TAG_EEG8   = 0x12   # 8-ch EEG, 2 samples/pkt, 256 Hz
TAG_ACCGYR = 0x47   # 6-ch IMU (ACC+GYR), 3 samples/pkt, 52 Hz
TAG_OPT4   = 0x34   # 4-ch optics (PPG/fNIRS), 3 samples/pkt, 64 Hz
TAG_OPT8   = 0x35   # 8-ch optics, 2 samples/pkt, 64 Hz
TAG_OPT16  = 0x36   # 16-ch optics, 1 sample/pkt, 64 Hz

# Signal parameters
EEG_SR    = 256          # Hz
EEG_SCALE = 1450 / 16383 # µV per bit (14-bit)
ACC_SCALE = 0.0000610352  # g / bit
GYR_SCALE = -0.0074768    # deg/s / bit
OPT_SCALE = 1.0           # raw counts (20-bit)

EEG_CHANNELS = ["TP9", "AF7", "AF8", "TP10"]
PPG_CHANNELS = ["IR_inner", "IR_outer", "NearIR_inner", "NearIR_outer",
                "Red_inner", "Red_outer", "NearIR2_inner", "NearIR2_outer"]
IMU_CHANNELS = ["acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z"]

# EEG frequency bands  (Hz)
BANDS: Dict[str, Tuple[float, float]] = {
    "delta": (0.5, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta":  (13.0, 30.0),
    "gamma": (30.0, 50.0),
}

# Athena init command sequence
ATHENA_INIT_PRESET = "p21"
ATHENA_FULL_PRESET = "p1035"   # EEG + IMU + PPG/optics
MUSE2_PRESET       = "p50"     # Muse 2 all channels


# ===========================================================================
# SIGNAL PROCESSING
# ===========================================================================

class BandPowerEstimator:
    """Welch PSD → per-band power for one EEG channel."""

    def __init__(self, sr: int = EEG_SR, window_sec: float = 2.0):
        self.sr = sr
        self.n_window = int(sr * window_sec)
        self.buf: deque = deque(maxlen=self.n_window)

    def push(self, sample: float):
        self.buf.append(sample)

    def get_bands(self) -> Dict[str, float]:
        if len(self.buf) < self.n_window // 2:
            return {b: 0.0 for b in BANDS}
        x = np.array(self.buf)
        # detrend
        x = x - np.mean(x)
        if SCIPY_AVAILABLE:
            freqs, psd = welch(x, fs=self.sr, nperseg=min(len(x), self.n_window))
        else:
            # fallback: naive FFT periodogram
            fft = np.fft.rfft(x)
            psd = (np.abs(fft) ** 2) / len(x)
            freqs = np.fft.rfftfreq(len(x), 1.0 / self.sr)
        result = {}
        for band, (lo, hi) in BANDS.items():
            mask = (freqs >= lo) & (freqs <= hi)
            result[band] = float(np.mean(psd[mask])) if np.any(mask) else 0.0
        return result


class HRVMetrics:
    """
    Compute HR and HRV from a PPG signal.
    Uses peak detection on the raw PPG waveform.
    """

    def __init__(self, sr: int = 64, window_sec: float = 10.0):
        self.sr = sr
        self.n_window = int(sr * window_sec)
        self.buf: deque = deque(maxlen=self.n_window)
        self.rr_intervals: deque = deque(maxlen=100)  # seconds
        self._last_peak = -1
        self._min_gap = int(sr * 0.35)   # ~170 bpm max

    def push(self, sample: float):
        self.buf.append(sample)
        self._detect_peak(sample)

    def _detect_peak(self, val: float):
        idx = len(self.buf) - 1
        if idx < 3:
            return
        arr = list(self.buf)
        # local max check (simple 3-point)
        if arr[-2] > arr[-3] and arr[-2] > arr[-1]:
            gap = idx - 1 - self._last_peak
            if gap > self._min_gap:
                rr = gap / self.sr
                if 0.3 < rr < 2.0:  # plausible RR
                    self.rr_intervals.append(rr)
                    self._last_peak = idx - 1

    def get_metrics(self) -> Dict[str, float]:
        rr = np.array(list(self.rr_intervals))
        if len(rr) < 4:
            return {"hr_bpm": 0.0, "sdnn_ms": 0.0, "rmssd_ms": 0.0,
                    "pnn50": 0.0, "lf_hf": 0.0}
        hr = 60.0 / np.mean(rr)
        sdnn = np.std(rr) * 1000
        diff = np.diff(rr) * 1000
        rmssd = float(np.sqrt(np.mean(diff ** 2)))
        pnn50 = float(100 * np.mean(np.abs(diff) > 50))
        # LF/HF ratio from RR tachogram (Lomb–Scargle not available →
        # approximate with band power of evenly resampled RR)
        lf_hf = 0.0
        if len(rr) >= 16:
            try:
                t_rr = np.cumsum(rr)
                t_uniform = np.linspace(t_rr[0], t_rr[-1], len(rr) * 4)
                rr_uniform = np.interp(t_uniform, t_rr, rr)
                fft = np.fft.rfft(rr_uniform - rr_uniform.mean())
                psd = np.abs(fft) ** 2
                resample_sr = 4.0  # Hz
                freqs = np.fft.rfftfreq(len(rr_uniform), 1.0 / resample_sr)
                lf = np.mean(psd[(freqs >= 0.04) & (freqs <= 0.15)])
                hf = np.mean(psd[(freqs >= 0.15) & (freqs <= 0.40)])
                lf_hf = float(lf / hf) if hf > 0 else 0.0
            except Exception:
                pass
        return {"hr_bpm": float(hr), "sdnn_ms": float(sdnn),
                "rmssd_ms": rmssd, "pnn50": pnn50, "lf_hf": lf_hf}


class NeurofeedbackMetrics:
    """
    Derived neurofeedback scores from band powers.
    - focus_index  = beta / (alpha + theta)
    - relaxation   = alpha / (beta + theta)
    - calm_index   = alpha / theta
    - engagement   = beta / alpha
    """

    @staticmethod
    def compute(bands: Dict[str, float]) -> Dict[str, float]:
        a = bands.get("alpha", 1e-9)
        b = bands.get("beta",  1e-9)
        t = bands.get("theta", 1e-9)
        d = bands.get("delta", 1e-9)
        g = bands.get("gamma", 1e-9)
        return {
            "focus_index":  b / max(a + t, 1e-9),
            "relaxation":   a / max(b + t, 1e-9),
            "calm_index":   a / max(t, 1e-9),
            "engagement":   b / max(a, 1e-9),
            "meditation":   t / max(b + g, 1e-9),
        }


# ===========================================================================
# PACKET DECODING  (Athena + Legacy)
# ===========================================================================

def _unpack_14bit_lsb(data: bytes, n_samples: int, n_channels: int) -> List[List[float]]:
    """Unpack 14-bit LSB-first packed EEG samples from data bytes."""
    bits = []
    for byte in data:
        for i in range(8):
            bits.append((byte >> i) & 1)
    samples = []
    idx = 0
    for _ in range(n_samples):
        row = []
        for _ in range(n_channels):
            val = 0
            for b in range(14):
                if idx < len(bits):
                    val |= bits[idx] << b
                    idx += 1
            row.append(val * EEG_SCALE - 1450 * 0.5)  # centre around 0
        samples.append(row)
    return samples


def _unpack_20bit_lsb(data: bytes, n_samples: int, n_channels: int) -> List[List[float]]:
    """Unpack 20-bit LSB-first packed optics samples."""
    bits = []
    for byte in data:
        for i in range(8):
            bits.append((byte >> i) & 1)
    samples = []
    idx = 0
    for _ in range(n_samples):
        row = []
        for _ in range(n_channels):
            val = 0
            for b in range(20):
                if idx < len(bits):
                    val |= bits[idx] << b
                    idx += 1
            row.append(float(val))
        samples.append(row)
    return samples


def decode_athena_packet(data: bytes) -> Dict:
    """
    Decode a BLE notification from UUID_DATA (Athena multiplexed stream).
    Returns dict with keys: eeg, accgyro, optics, timestamp_seq
    """
    out = {"eeg": None, "accgyro": None, "optics": None, "seq": None}
    if len(data) < 3:
        return out
    seq = struct.unpack_from(">H", data, 0)[0]
    out["seq"] = seq
    pos = 2
    while pos < len(data):
        if pos >= len(data):
            break
        tag = data[pos]; pos += 1
        if pos >= len(data):
            break
        length = data[pos]; pos += 1
        payload = data[pos: pos + length]; pos += length

        if tag == TAG_EEG4 and len(payload) >= 28:
            samples = _unpack_14bit_lsb(payload, 4, 4)
            out["eeg"] = {"channels": EEG_CHANNELS[:4], "samples": samples}

        elif tag == TAG_EEG8 and len(payload) >= 28:
            samples = _unpack_14bit_lsb(payload, 2, 8)
            out["eeg"] = {"channels": (EEG_CHANNELS + ["FPz","AUX_R","AUX_L","REF"])[:8],
                          "samples": samples}

        elif tag == TAG_ACCGYR and len(payload) >= 36:
            raw = []
            for i in range(3):  # 3 samples
                row = []
                for j in range(3):  # acc xyz
                    v = struct.unpack_from("<h", payload, i * 12 + j * 2)[0]
                    row.append(v * ACC_SCALE)
                for j in range(3):  # gyr xyz
                    v = struct.unpack_from("<h", payload, i * 12 + 6 + j * 2)[0]
                    row.append(v * GYR_SCALE)
                raw.append(row)
            out["accgyro"] = {"channels": IMU_CHANNELS, "samples": raw}

        elif tag in (TAG_OPT4, TAG_OPT8, TAG_OPT16):
            n_ch = {TAG_OPT4: 4, TAG_OPT8: 8, TAG_OPT16: 16}[tag]
            n_s  = {TAG_OPT4: 3, TAG_OPT8: 2, TAG_OPT16: 1}[tag]
            samples = _unpack_20bit_lsb(payload, n_s, n_ch)
            out["optics"] = {"channels": PPG_CHANNELS[:n_ch], "samples": samples}
    return out


def decode_muse2_eeg(data: bytes) -> Optional[Dict]:
    """Decode legacy Muse 2 EEG characteristic (12 samples × 4 channels)."""
    if len(data) < 2:
        return None
    seq = struct.unpack_from(">H", data, 0)[0]
    samples = []
    for i in range(12):
        row = []
        for ch in range(4):
            offset = 2 + (i * 4 + ch) * 2
            if offset + 1 < len(data):
                v = struct.unpack_from(">H", data, offset)[0]
                row.append((v - 0x6FF) * EEG_SCALE)
            else:
                row.append(0.0)
        samples.append(row)
    return {"seq": seq, "channels": EEG_CHANNELS, "samples": samples}


def decode_muse2_ppg(data: bytes) -> Optional[Dict]:
    """Decode legacy Muse 2 PPG characteristic (6 samples per packet)."""
    if len(data) < 2:
        return None
    seq = struct.unpack_from(">H", data, 0)[0]
    samples = []
    for i in range(6):
        offset = 2 + i * 3
        if offset + 2 < len(data):
            v = (data[offset] << 16 | data[offset+1] << 8 | data[offset+2])
            samples.append([float(v)])
        else:
            samples.append([0.0])
    return {"seq": seq, "channels": ["PPG"], "samples": samples}


# ===========================================================================
# BLE CLIENT (Athena)
# ===========================================================================

class MuseClient:
    """
    Handles BLE connection + streaming for Muse S Athena and Muse 2.
    Calls user-supplied callbacks with decoded data dicts.
    """

    def __init__(self,
                 address: str,
                 device_type: str = "athena",   # "athena" or "muse2"
                 preset: str = ATHENA_FULL_PRESET,
                 on_eeg: Optional[Callable] = None,
                 on_ppg: Optional[Callable] = None,
                 on_imu: Optional[Callable] = None):
        self.address     = address
        self.device_type = device_type
        self.preset      = preset
        self.on_eeg      = on_eeg
        self.on_ppg      = on_ppg
        self.on_imu      = on_imu
        self._client     = None
        self._running    = False

    async def _send(self, cmd: str):
        if self._client:
            # Commands are null-terminated ASCII
            payload = (cmd + "\n").encode()
            await self._client.write_gatt_char(UUID_CONTROL, payload)
            await asyncio.sleep(0.05)

    def _athena_handler(self, _handle: int, data: bytearray):
        pkt = decode_athena_packet(bytes(data))
        ts  = time.time()
        if pkt["eeg"] and self.on_eeg:
            self.on_eeg({"ts": ts, **pkt["eeg"]})
        if pkt["accgyro"] and self.on_imu:
            self.on_imu({"ts": ts, **pkt["accgyro"]})
        if pkt["optics"] and self.on_ppg:
            self.on_ppg({"ts": ts, **pkt["optics"]})

    def _muse2_eeg_handler(self, _handle: int, data: bytearray):
        pkt = decode_muse2_eeg(bytes(data))
        if pkt and self.on_eeg:
            self.on_eeg({"ts": time.time(), **pkt})

    def _muse2_ppg_handler(self, _handle: int, data: bytearray):
        pkt = decode_muse2_ppg(bytes(data))
        if pkt and self.on_ppg:
            self.on_ppg({"ts": time.time(), **pkt})

    async def connect_and_stream(self, duration_sec: Optional[float] = None):
        if not BLEAK_AVAILABLE:
            raise RuntimeError("bleak not installed. Install with: pip install bleak")
        async with BleakClient(self.address, timeout=15.0) as client:
            self._client = client
            self._running = True
            print(f"[+] Connected to {self.address}")

            if self.device_type == "athena":
                await self._athena_init()
                await client.start_notify(UUID_DATA, self._athena_handler)
            else:
                await self._muse2_init()
                await client.start_notify(UUID_EEG,  self._muse2_eeg_handler)
                await client.start_notify(UUID_PPG1, self._muse2_ppg_handler)

            try:
                if duration_sec:
                    await asyncio.sleep(duration_sec)
                else:
                    while self._running:
                        await asyncio.sleep(0.5)
            finally:
                self._running = False
                if self.device_type == "athena":
                    await client.stop_notify(UUID_DATA)
                    await self._send("h")
                else:
                    await client.stop_notify(UUID_EEG)
                    await client.stop_notify(UUID_PPG1)
            self._client = None

    async def _athena_init(self):
        """Athena-specific two-phase init (dc001 sent twice)."""
        await self._send("v6")
        await self._send("s")
        await self._send("h")
        await self._send(ATHENA_INIT_PRESET)
        await asyncio.sleep(0.1)
        await self._send("dc001")
        await self._send("L1")
        await asyncio.sleep(0.2)
        await self._send("h")
        await self._send(self.preset)
        await asyncio.sleep(0.1)
        await self._send("dc001")   # ← critical: must be sent TWICE
        await self._send("L1")
        print("[+] Athena init complete, streaming...")

    async def _muse2_init(self):
        """Muse 2 (legacy) init."""
        await self._send("v6")
        await self._send("s")
        await self._send(self.preset)
        await self._send("d")
        print("[+] Muse 2 init complete, streaming...")

    def stop(self):
        self._running = False


# ===========================================================================
# DEMO DATA GENERATOR (no BLE needed)
# ===========================================================================

class DemoSource:
    """Generate synthetic Muse-like data for testing without hardware."""

    def __init__(self, on_eeg, on_ppg, on_imu):
        self.on_eeg = on_eeg
        self.on_ppg = on_ppg
        self.on_imu = on_imu
        self._running = False
        self._t = 0.0

    async def connect_and_stream(self, duration_sec: Optional[float] = None):
        self._running = True
        print("[*] Running in DEMO mode (simulated data, no BLE)")
        start = time.time()
        while self._running:
            t = self._t
            # Synthesise 4-sample EEG burst at 256 Hz (burst every ~15ms)
            eeg_samples = []
            for s in range(4):
                ts = t + s / EEG_SR
                row = [
                    20 * np.sin(2 * np.pi * 10 * ts) + 5 * np.random.randn(),   # TP9  alpha
                    15 * np.sin(2 * np.pi * 6 * ts)  + 5 * np.random.randn(),   # AF7  theta
                    12 * np.sin(2 * np.pi * 20 * ts) + 5 * np.random.randn(),   # AF8  beta
                    18 * np.sin(2 * np.pi * 10 * ts) + 5 * np.random.randn(),   # TP10 alpha
                ]
                eeg_samples.append(row)
            self.on_eeg({"ts": t, "channels": EEG_CHANNELS, "samples": eeg_samples})

            # PPG burst
            ppg_val = 1_000_000 + 50_000 * np.sin(2 * np.pi * 1.2 * t) + 1000 * np.random.randn()
            self.on_ppg({"ts": t, "channels": PPG_CHANNELS[:4],
                          "samples": [[ppg_val, ppg_val * 0.9, ppg_val * 0.8, ppg_val * 0.7]]})

            # IMU burst
            self.on_imu({"ts": t, "channels": IMU_CHANNELS,
                          "samples": [[0.01 * np.random.randn() for _ in range(6)]]})

            self._t += 4 / EEG_SR   # advance by one EEG packet
            await asyncio.sleep(4 / EEG_SR)

            if duration_sec and (time.time() - start) > duration_sec:
                break
        self._running = False

    def stop(self):
        self._running = False


# ===========================================================================
# DATA RECORDER
# ===========================================================================

class DataRecorder:
    """
    Saves raw frames + computed metrics to CSV files.
    Folder and filename prefix are user-specified.
    """

    def __init__(self, folder: str, prefix: str):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        base = self.folder / f"{prefix}_{ts}"

        self._eeg_f  = open(base.with_suffix("").as_posix() + "_eeg.csv",  "w", newline="")
        self._ppg_f  = open(base.with_suffix("").as_posix() + "_ppg.csv",  "w", newline="")
        self._imu_f  = open(base.with_suffix("").as_posix() + "_imu.csv",  "w", newline="")
        self._met_f  = open(base.with_suffix("").as_posix() + "_metrics.csv", "w", newline="")

        self._eeg_w = csv.writer(self._eeg_f)
        self._ppg_w = csv.writer(self._ppg_f)
        self._imu_w = csv.writer(self._imu_f)
        self._met_w = csv.writer(self._met_f)

        self._eeg_w.writerow(["timestamp"] + EEG_CHANNELS)
        self._ppg_w.writerow(["timestamp"] + PPG_CHANNELS[:8])
        self._imu_w.writerow(["timestamp"] + IMU_CHANNELS)
        self._met_w.writerow(["timestamp", "channel",
                              "delta","theta","alpha","beta","gamma",
                              "focus_index","relaxation","calm_index","engagement","meditation",
                              "hr_bpm","sdnn_ms","rmssd_ms","pnn50","lf_hf"])
        self._base_str = str(base)
        print(f"[+] Recording to: {base}_*.csv")

    def write_eeg(self, ts: float, sample: List[float]):
        self._eeg_w.writerow([f"{ts:.6f}"] + [f"{v:.4f}" for v in sample])

    def write_ppg(self, ts: float, sample: List[float]):
        self._ppg_w.writerow([f"{ts:.6f}"] + [f"{v:.2f}" for v in sample])

    def write_imu(self, ts: float, sample: List[float]):
        self._imu_w.writerow([f"{ts:.6f}"] + [f"{v:.6f}" for v in sample])

    def write_metrics(self, ts: float, channel: str,
                      bands: Dict, nf: Dict, hrv: Dict):
        self._met_w.writerow([
            f"{ts:.6f}", channel,
            f"{bands.get('delta',0):.6f}",
            f"{bands.get('theta',0):.6f}",
            f"{bands.get('alpha',0):.6f}",
            f"{bands.get('beta',0):.6f}",
            f"{bands.get('gamma',0):.6f}",
            f"{nf.get('focus_index',0):.4f}",
            f"{nf.get('relaxation',0):.4f}",
            f"{nf.get('calm_index',0):.4f}",
            f"{nf.get('engagement',0):.4f}",
            f"{nf.get('meditation',0):.4f}",
            f"{hrv.get('hr_bpm',0):.2f}",
            f"{hrv.get('sdnn_ms',0):.2f}",
            f"{hrv.get('rmssd_ms',0):.2f}",
            f"{hrv.get('pnn50',0):.2f}",
            f"{hrv.get('lf_hf',0):.4f}",
        ])

    def flush(self):
        for f in (self._eeg_f, self._ppg_f, self._imu_f, self._met_f):
            f.flush()

    def close(self):
        for f in (self._eeg_f, self._ppg_f, self._imu_f, self._met_f):
            f.close()
        print(f"[+] Session saved to {self._base_str}_*.csv")


# ===========================================================================
# LIVE DISPLAY (Rich TUI)
# ===========================================================================

def _bar(value: float, max_val: float, width: int = 15) -> str:
    """Return a simple text bar for terminal display."""
    filled = int(width * min(value / max(max_val, 1e-9), 1.0))
    return "█" * filled + "░" * (width - filled)


class LiveDisplay:
    """Terminal UI showing per-channel band powers + HRV + neurofeedback."""

    def __init__(self, ppg_channel: str = "IR_inner"):
        self.ppg_channel  = ppg_channel
        self._band_data: Dict[str, Dict] = {ch: {} for ch in EEG_CHANNELS}
        self._nf_data:   Dict[str, Dict] = {ch: {} for ch in EEG_CHANNELS}
        self._hrv_data:  Dict            = {}
        self._lock = asyncio.Lock()

    async def update(self, channel: str, bands: Dict, nf: Dict, hrv: Optional[Dict]):
        async with self._lock:
            self._band_data[channel] = bands
            self._nf_data[channel]   = nf
            if hrv:
                self._hrv_data = hrv

    def _make_table(self) -> "Table":
        t = Table(title="🧠 Muse EEG", expand=True, border_style="cyan")
        t.add_column("Channel", style="bold white", width=8)
        for b in BANDS:
            t.add_column(b.capitalize(), justify="right", width=18)
        t.add_column("Focus", justify="right", width=8)
        t.add_column("Relax", justify="right", width=8)
        t.add_column("Calm", justify="right", width=8)

        # Compute per-band max for normalisation
        all_vals = {b: [] for b in BANDS}
        for ch in EEG_CHANNELS:
            bd = self._band_data.get(ch, {})
            for b in BANDS:
                if bd.get(b, 0) > 0:
                    all_vals[b].append(bd[b])
        maxes = {b: max(v) if v else 1.0 for b, v in all_vals.items()}

        for ch in EEG_CHANNELS:
            bd = self._band_data.get(ch, {})
            nf = self._nf_data.get(ch, {})
            cols = [ch]
            for b in BANDS:
                v = bd.get(b, 0.0)
                bar = _bar(v, maxes[b])
                cols.append(f"{bar} {v:6.1f}")
            cols.append(f"{nf.get('focus_index',0):.2f}")
            cols.append(f"{nf.get('relaxation',0):.2f}")
            cols.append(f"{nf.get('calm_index',0):.2f}")
            t.add_row(*cols)
        return t

    def _make_hrv_panel(self) -> "Panel":
        hrv = self._hrv_data
        hr  = hrv.get("hr_bpm", 0)
        lines = [
            f"❤  HR:      {hr:5.1f} bpm   {_bar(hr, 180, 20)}",
            f"   SDNN:    {hrv.get('sdnn_ms',0):6.1f} ms",
            f"   RMSSD:   {hrv.get('rmssd_ms',0):6.1f} ms",
            f"   pNN50:   {hrv.get('pnn50',0):5.1f} %",
            f"   LF/HF:   {hrv.get('lf_hf',0):5.2f}",
            f"   PPG ch:  {self.ppg_channel}",
        ]
        return Panel("\n".join(lines), title="HRV", border_style="green", width=40)

    def render(self):
        if not RICH_AVAILABLE:
            self._plain_render()
            return
        layout = Layout()
        layout.split_column(
            Layout(self._make_table(), name="bands", ratio=3),
            Layout(self._make_hrv_panel(), name="hrv", ratio=1),
        )
        return layout

    def _plain_render(self):
        """Fallback plain-text display when Rich is not installed."""
        os.system("clear" if os.name == "posix" else "cls")
        print("=" * 65)
        print("  Muse EEG Watch")
        print("=" * 65)
        hdr = f"{'Ch':<6}" + "".join(f"{b:>9}" for b in BANDS) + f"{'Focus':>7}"
        print(hdr)
        print("-" * 65)
        for ch in EEG_CHANNELS:
            bd = self._band_data.get(ch, {})
            nf = self._nf_data.get(ch, {})
            row = f"{ch:<6}"
            for b in BANDS:
                row += f"{bd.get(b,0):9.1f}"
            row += f"{nf.get('focus_index',0):7.2f}"
            print(row)
        print("-" * 65)
        hrv = self._hrv_data
        print(f"  HR={hrv.get('hr_bpm',0):.1f}bpm  "
              f"RMSSD={hrv.get('rmssd_ms',0):.1f}ms  "
              f"LF/HF={hrv.get('lf_hf',0):.2f}  "
              f"[{self.ppg_channel}]")
        print("=" * 65)


# ===========================================================================
# MAIN SESSION COORDINATOR
# ===========================================================================

class MuseSession:
    """Ties together BLE client, signal processing, recording, and display."""

    def __init__(self,
                 address: Optional[str]  = None,
                 demo: bool              = False,
                 device_type: str        = "athena",
                 ppg_channel: str        = "IR_inner",
                 save_folder: str        = "muse_data",
                 save_prefix: str        = "session",
                 duration_sec: Optional[float] = None,
                 record: bool            = True):

        self.ppg_channel  = ppg_channel
        self.duration_sec = duration_sec
        self.record       = record

        # Per-channel processors
        self.band_estimators = {ch: BandPowerEstimator() for ch in EEG_CHANNELS}
        self.hrv             = HRVMetrics()
        self.display         = LiveDisplay(ppg_channel)
        self.recorder        = DataRecorder(save_folder, save_prefix) if record else None
        self._metric_tick    = 0  # write metrics every N EEG packets

        # Source
        if demo:
            self.source = DemoSource(
                on_eeg=self._on_eeg,
                on_ppg=self._on_ppg,
                on_imu=self._on_imu,
            )
        else:
            if not address:
                raise ValueError("BLE address required (or use --demo)")
            self.source = MuseClient(
                address=address,
                device_type=device_type,
                on_eeg=self._on_eeg,
                on_ppg=self._on_ppg,
                on_imu=self._on_imu,
            )

    def _on_eeg(self, pkt: Dict):
        ts = pkt["ts"]
        channels = pkt["channels"]
        for sample in pkt["samples"]:
            for i, ch in enumerate(channels[:4]):  # limit to 4 standard
                if i < len(sample) and ch in self.band_estimators:
                    self.band_estimators[ch].push(sample[i])
                    if self.recorder:
                        # write one row per sample (all channels together)
                        pass  # done below per-burst
            # Write raw EEG row
            if self.recorder:
                row4 = [sample[i] if i < len(sample) else 0.0
                        for i in range(4)]
                self.recorder.write_eeg(ts, row4)

        # Compute and broadcast metrics every 64 samples (~0.25s)
        self._metric_tick += len(pkt["samples"])
        if self._metric_tick >= 64:
            self._metric_tick = 0
            self._emit_metrics(ts)

    def _emit_metrics(self, ts: float):
        hrv_metrics = self.hrv.get_metrics()
        for ch in EEG_CHANNELS:
            bands = self.band_estimators[ch].get_bands()
            nf    = NeurofeedbackMetrics.compute(bands)
            asyncio.get_event_loop().create_task(
                self.display.update(ch, bands, nf,
                                    hrv_metrics if ch == EEG_CHANNELS[0] else None)
            )
            if self.recorder:
                self.recorder.write_metrics(ts, ch, bands, nf, hrv_metrics)
        if self.recorder:
            self.recorder.flush()

    def _on_ppg(self, pkt: Dict):
        ts       = pkt["ts"]
        channels = pkt["channels"]
        for sample in pkt["samples"]:
            # Feed selected PPG channel to HRV
            if self.ppg_channel in channels:
                idx = channels.index(self.ppg_channel)
                if idx < len(sample):
                    self.hrv.push(sample[idx])
            if self.recorder:
                row = [sample[i] if i < len(sample) else 0.0
                       for i in range(min(len(channels), 8))]
                self.recorder.write_ppg(ts, row)

    def _on_imu(self, pkt: Dict):
        ts = pkt["ts"]
        for sample in pkt["samples"]:
            if self.recorder:
                self.recorder.write_imu(ts, sample)

    async def run(self):
        if RICH_AVAILABLE:
            with Live(refresh_per_second=4, screen=True) as live:
                async def refresh_loop():
                    while True:
                        live.update(self.display.render())
                        await asyncio.sleep(0.25)
                refresh_task = asyncio.create_task(refresh_loop())
                try:
                    await self.source.connect_and_stream(self.duration_sec)
                finally:
                    refresh_task.cancel()
        else:
            async def plain_refresh():
                while True:
                    self.display._plain_render()
                    await asyncio.sleep(1.0)
            refresh_task = asyncio.create_task(plain_refresh())
            try:
                await self.source.connect_and_stream(self.duration_sec)
            finally:
                refresh_task.cancel()

        if self.recorder:
            self.recorder.close()


# ===========================================================================
# BLE SCANNER
# ===========================================================================

async def scan_and_pick() -> Optional[str]:
    """Scan for nearby Muse devices and let user pick one."""
    if not BLEAK_AVAILABLE:
        print("[!] bleak not installed. Cannot scan.")
        return None
    print("[*] Scanning for Muse devices (5 s)...")
    devices = await BleakScanner.discover(timeout=5.0)
    muse_devs = [d for d in devices
                 if d.name and ("Muse" in d.name or "InteraXon" in d.name)]
    if not muse_devs:
        print("[!] No Muse devices found.")
        return None
    print("\nFound devices:")
    for i, d in enumerate(muse_devs):
        print(f"  [{i}] {d.name}  —  {d.address}")
        print(d)
    try:
        choice = int(input("\nPick device number: ").strip())
        print(muse_devs[choice].address)
        return muse_devs[choice].address
    except (ValueError, IndexError):
        return None


# ===========================================================================
# CLI
# ===========================================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Muse EEG for Termux / Android",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    p.add_argument("--address", "-a", metavar="MAC",
                   help="BLE MAC address of your Muse device")
    p.add_argument("--scan", "-s", action="store_true",
                   help="Scan for nearby Muse devices and pick interactively")
    p.add_argument("--demo", action="store_true",
                   help="Run with simulated data (no BLE needed)")
    p.add_argument("--device-type", choices=["athena", "muse2"],
                   default="athena",
                   help="Device variant (default: athena / Muse S)")
    p.add_argument("--ppg-channel", default="IR_inner",
                   choices=PPG_CHANNELS,
                   help="PPG channel to use for HRV (default: IR_inner)")
    p.add_argument("--folder", default="muse_data",
                   help="Output folder for recordings (default: muse_data)")
    p.add_argument("--prefix", default="session",
                   help="Filename prefix for recordings (default: session)")
    p.add_argument("--duration", type=float, default=None,
                   help="Session duration in seconds (default: run until Ctrl-C)")
    p.add_argument("--no-record", action="store_true",
                   help="Disable CSV recording (display only)")
    return p


async def main_async(args):
    address = args.address

    if args.scan and not args.demo:
        address = await scan_and_pick()
        if not address:
            sys.exit(1)

    session = MuseSession(
        address     = address,
        demo        = args.demo,
        device_type = args.device_type,
        ppg_channel = args.ppg_channel,
        save_folder = args.folder,
        save_prefix = args.prefix,
        duration_sec= args.duration,
        record      = not args.no_record,
    )
    try:
        await session.run()
    except KeyboardInterrupt:
        print("\n[*] Stopped by user.")
    except Exception as e:
        print(f"[!] Error: {e}")
        raise


def main():
    parser = build_parser()
    args   = parser.parse_args()

    if not args.demo and not args.address and not args.scan:
        print(__doc__)
        parser.print_help()
        sys.exit(0)

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()