#!/usr/bin/env python3
"""
preprocess_eeg.py — EEG chaos & band-power metric pre-calculator
================================================================
Reads a muselsl raw CSV (columns: timestamps, TP9, AF7, AF8, TP10)
and writes a *_metrics.csv that can be loaded directly by the EEG
dashboard, skipping all in-browser computation.

Computed metrics (one row per 1-second step, 4-second window):
  Standard  : focus, relaxation, meditation, stress, asymmetry,
              engagement, delta, theta, alpha, beta, gamma
  Chaos     : lle (Largest Lyapunov Exponent),
              corr_dim (Grassberger–Procaccia D₂),
              higuchi_fd (Higuchi fractal dimension),
              katz_fd (Katz fractal dimension),
              chaos_index (5-factor geometric mean)

Usage:
    pip install numpy scipy pandas tqdm
    python preprocess_eeg.py session.csv
    python preprocess_eeg.py session.csv -o session_metrics.csv
    python preprocess_eeg.py session.csv --win 4 --step 1 --fs 256
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.signal import welch
from scipy.spatial.distance import cdist

warnings.filterwarnings('ignore', category=RuntimeWarning)

# ── Default constants (overridden by CLI) ────────────────────────────────────

FS        : int   = 256    # sample rate (Hz)
WIN_SEC   : float = 4.0    # analysis window length (s)
STEP_SEC  : float = 1.0    # window step (s)
PSD_NPERSEG: int  = 512    # Welch FFT segment length
PSD_NOVERLAP: int = 256

BANDS = {
    'delta': (0.5,  4.0),
    'theta': (4.0,  8.0),
    'alpha': (8.0, 13.0),
    'beta' : (13.0, 30.0),
    'gamma': (30.0, 44.0),
}

CHANNELS = ['tp9', 'af7', 'af8', 'tp10']

# Output column order (matches METRICS dict in app.js)
OUTPUT_COLS = [
    't_sec',
    'focus', 'relaxation', 'meditation', 'stress', 'asymmetry', 'engagement',
    'delta', 'theta', 'alpha', 'beta', 'gamma',
    'lle', 'corr_dim', 'higuchi_fd', 'katz_fd', 'chaos_index',
]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Spectral / band-power helpers
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def band_powers(sig: np.ndarray) -> dict[str, float]:
    """Welch PSD → mean power in each canonical EEG band (µV²/Hz)."""
    freqs, psd = welch(sig, fs=FS, nperseg=PSD_NPERSEG,
                       noverlap=PSD_NOVERLAP, window='hann', scaling='density')
    return {
        name: float(psd[(freqs >= lo) & (freqs <= hi)].mean())
        for name, (lo, hi) in BANDS.items()
    }


def spectral_entropy(sig: np.ndarray) -> float:
    """Normalised Shannon spectral entropy ∈ [0, 1]."""
    _, psd = welch(sig, fs=FS, nperseg=PSD_NPERSEG,
                   noverlap=PSD_NOVERLAP, window='hann', scaling='density')
    total = psd.sum()
    if total == 0:
        return 0.0
    p = psd / total
    H = -np.sum(p * np.log2(np.maximum(p, 1e-12)))
    return float(H / np.log2(len(psd)))  # normalise to [0, 1]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Phase-space embedding
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def embed(x: np.ndarray, m: int = 3, tau: int = 3) -> np.ndarray:
    """
    Time-delay embedding → (N-(m-1)*tau, m) matrix.
    Each row is one point in the m-dimensional phase space.
    """
    N_pts = len(x) - (m - 1) * tau
    if N_pts < 1:
        return np.empty((0, m))
    row_starts = np.arange(N_pts)          # shape (N_pts,)
    delays     = np.arange(m) * tau        # shape (m,)
    return x[row_starts[:, None] + delays[None, :]]   # (N_pts, m)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Largest Lyapunov Exponent  (Rosenstein et al. 1993)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def largest_lyapunov_exponent(
    sig        : np.ndarray,
    m          : int = 3,
    tau        : int = 3,
    theiler_w  : int = 20,
    evolve_steps: int = 20,
    max_pts    : int = 300,
) -> float:
    """
    Estimates the LLE in bits/sample via the mean-divergence slope.

    Positive  → chaotic / complex dynamics
    Near zero → ordered / periodic brain state
    Negative  → (rare) very strongly damped signal

    The full N² NN search is vectorised with cdist and capped at max_pts
    query points to keep per-frame runtime under ~30 ms on modern hardware.
    """
    pts = embed(sig, m, tau)
    N   = len(pts)
    if N < evolve_steps + 2:
        return 0.0

    # Subsample query points
    step   = max(1, N // max_pts)
    q_idx  = np.arange(0, N, step)
    q_pts  = pts[q_idx]                # (Q, m)

    # Vectorised pairwise distance: (Q, N)
    D = cdist(q_pts, pts, metric='euclidean')

    div_sum   = np.zeros(evolve_steps)
    div_count = np.zeros(evolve_steps, dtype=np.int64)

    for local_i, global_i in enumerate(q_idx):
        row = D[local_i].copy()

        # Theiler window: exclude temporal neighbours to avoid autocorrelation
        lo = max(0,  global_i - theiler_w)
        hi = min(N,  global_i + theiler_w + 1)
        row[lo:hi]    = np.inf
        row[global_i] = np.inf

        nn      = int(np.argmin(row))
        nn_dist = row[nn]
        if np.isinf(nn_dist) or nn_dist == 0.0:
            continue

        # Track log-divergence over evolve_steps
        for k in range(1, evolve_steps + 1):
            qi2 = global_i + k
            ri2 = nn + k
            if qi2 >= N or ri2 >= N:
                break
            dk = float(np.linalg.norm(pts[qi2] - pts[ri2]))
            if dk > 0.0:
                div_sum[k - 1]   += np.log(dk / nn_dist)
                div_count[k - 1] += 1

    valid = div_count > 0
    if valid.sum() < 3:
        return 0.0

    steps = (np.where(valid)[0] + 1).astype(float)
    means = div_sum[valid] / div_count[valid]
    # LLE = slope of linear fit to mean log-divergence vs step index
    return float(np.polyfit(steps, means, 1)[0])


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Correlation Dimension  (Grassberger & Procaccia 1983)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def correlation_dimension(
    sig    : np.ndarray,
    m      : int = 3,
    tau    : int = 3,
    n_r    : int = 20,
    max_pts: int = 200,
) -> float:
    """
    Estimates the Grassberger–Procaccia D₂ from the slope of
    log C(r) vs log r in the scaling region.

    Typical scalp-EEG range: 1–5.
    Higher D₂ → more independent degrees of freedom → richer dynamics.
    """
    pts = embed(sig, m, tau)
    if len(pts) < 10:
        return 0.0

    # Subsample to bound O(N²) cost
    step = max(1, len(pts) // max_pts)
    sub  = pts[::step]                    # (M, m)

    # Upper-triangle pairwise distances
    D     = cdist(sub, sub, metric='euclidean')
    triu  = np.triu_indices_from(D, k=1)
    dists = np.sort(D[triu])              # ascending

    if len(dists) == 0:
        return 0.0

    r_min = np.percentile(dists,  2)
    r_max = np.percentile(dists, 90)
    if r_max <= r_min or r_min <= 0.0:
        return 0.0

    # Build correlation integral C(r) at log-spaced radii
    log_r = np.linspace(np.log(r_min), np.log(r_max), n_r)
    total  = len(dists)
    log_C  = []

    for lr in log_r:
        r   = np.exp(lr)
        cnt = int(np.searchsorted(dists, r, side='right'))
        C   = cnt / total
        if C > 0:
            log_C.append((lr, np.log(C)))

    if len(log_C) < 4:
        return 0.0

    # Linear regression on the middle 50 % (scaling region)
    trim = len(log_C) // 4
    reg  = log_C[trim : len(log_C) - trim]
    if len(reg) < 2:
        return 0.0

    xs, ys = zip(*reg)
    return float(max(0.0, np.polyfit(xs, ys, 1)[0]))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Higuchi Fractal Dimension  (Higuchi 1988)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def higuchi_fd(x: np.ndarray, kmax: int = 8) -> float:
    """
    Higuchi fractal dimension: slope of log L(k) vs log(1/k).

    For each interval length k and each starting offset m in [1..k],
    compute the normalised mean absolute difference L_m(k), then
    regress log(mean_m L_m(k)) against log(1/k).

    Typical scalp-EEG HFD range: 1.0 – 2.5
      ~1.0 → nearly flat (very slow / delta-dominated)
      ~2.0 → typical awake cortex
      ~2.5 → highly irregular / high-frequency
    """
    N = len(x)
    log_pairs: list[tuple[float, float]] = []

    for k in range(1, kmax + 1):
        Lk = 0.0
        for m in range(1, k + 1):
            n_intervals = (N - m) // k
            if n_intervals < 1:
                continue
            # Indices: m-1, m-1+k, m-1+2k, … (length n_intervals+1)
            idx  = (m - 1) + np.arange(n_intervals + 1) * k
            Lmk  = np.sum(np.abs(np.diff(x[idx])))
            Lmk *= (N - 1) / (k * k * n_intervals)
            Lk  += Lmk
        if Lk > 0:
            log_pairs.append((float(np.log(1.0 / k)), float(np.log(Lk / k))))

    if len(log_pairs) < 2:
        return 0.0

    xs, ys = zip(*log_pairs)
    return float(np.polyfit(xs, ys, 1)[0])


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Katz Fractal Dimension  (Katz 1988)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def katz_fd(x: np.ndarray) -> float:
    """
    Katz fractal dimension: KFD = log10(n) / (log10(n) + log10(L / d))

      d = total waveform path length  (sum of |x[i+1] − x[i]|)
      L = maximum distance from the first point
      n = number of steps (len(x) − 1)

    Fast O(N) computation, no embedding needed.
    Typical range: 0 – 2; awake cortex ~1.3–1.7.
    """
    n = len(x) - 1
    if n < 2:
        return 0.0
    d = float(np.sum(np.abs(np.diff(x.astype(np.float64)))))
    L = float(np.max(np.abs(x - x[0])))
    if d == 0.0 or L == 0.0:
        return 0.0
    return float(np.log10(n) / (np.log10(n) + np.log10(L / d)))


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Per-channel chaos bundle
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def channel_chaos(sig: np.ndarray) -> dict[str, float]:
    """Compute all four nonlinear metrics + spectral entropy for one channel."""
    return {
        'lle'        : largest_lyapunov_exponent(sig),
        'corr_dim'   : correlation_dimension(sig),
        'higuchi_fd' : higuchi_fd(sig),
        'katz_fd'    : katz_fd(sig),
        'spec_ent'   : spectral_entropy(sig),
    }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Composite chaos index (5-factor geometric mean)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Physiologically grounded normalisation ranges (scalp EEG, 256 Hz)
_CHAOS_RANGES = {
    'lle'       : (0.0, 0.50),   # bits/sample; positive → chaotic
    'corr_dim'  : (0.0, 5.00),   # D₂ ~ 1–5 for scalp EEG
    'higuchi_fd': (0.0, 3.00),   # HFD ~ 1.0–2.5
    'katz_fd'   : (0.0, 2.00),   # KFD ~ 0–2
    'spec_ent'  : (0.0, 1.00),   # already normalised
}


def composite_chaos_index(chaos_list: list[dict[str, float]]) -> float:
    """
    5-factor geometric mean of normalised chaos metrics averaged across channels.

    Each factor is clipped to its physiological range then divided by its max
    to land in [0, 1], so the product stays in [0, 1] and the fifth root
    expands it back to a readable scale.

    A score near 1.0 indicates highly complex, information-rich EEG dynamics;
    near 0.0 indicates pathologically flat or periodic signals.
    """
    factors: list[float] = []
    for key, (lo, hi) in _CHAOS_RANGES.items():
        mean_val = float(np.mean([d[key] for d in chaos_list]))
        normalised = np.clip((mean_val - lo) / (hi - lo), 0.0, 1.0)
        factors.append(float(normalised))

    product = float(np.prod(factors))
    return float(product ** (1.0 / len(factors))) if product > 0.0 else 0.0


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Standard neurofeedback metrics  (mirror app.js computeMetric formulas)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def standard_metrics(bp: dict[str, dict[str, float]]) -> dict[str, float]:
    """
    Compute all band-power ratio metrics exactly matching app.js computeMetric().
    `bp` must have keys tp9, af7, af8, tp10, each with delta/theta/alpha/beta/gamma.
    """
    eps = 1e-12

    def ch(channel: str, band: str) -> float:
        return bp[channel][band]

    def ch_avg(band: str) -> float:
        return float(np.mean([ch(c, band) for c in CHANNELS]))

    def front(band: str) -> float:
        return (ch('af7', band) + ch('af8', band)) / 2.0

    def temp(band: str) -> float:
        return (ch('tp9', band) + ch('tp10', band)) / 2.0

    af7a, af8a = ch('af7', 'alpha'), ch('af8', 'alpha')

    return {
        'focus'      : front('beta')  / (front('alpha') + front('theta') + eps),
        'relaxation' : temp('alpha'),
        'meditation' : ch_avg('theta') / (ch_avg('alpha') + eps),
        'stress'     : (front('beta') + front('gamma')) /
                       (front('alpha') + front('theta') + eps),
        'asymmetry'  : float(np.log(max(af8a, 1e-12)) - np.log(max(af7a, 1e-12))),
        'engagement' : ch_avg('beta') / (ch_avg('alpha') + ch_avg('theta') + eps),
        **{band: ch_avg(band) for band in BANDS},
    }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CSV loading with flexible column detection
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_COLUMN_ALIASES: dict[str, list[str]] = {
    'ts'  : ['timestamps', 'timestamp', 'time', 'unix_time'],
    'tp9' : ['tp9',  'eeg_1', 'eeg1'],
    'af7' : ['af7',  'eeg_2', 'eeg2'],
    'af8' : ['af8',  'eeg_3', 'eeg3'],
    'tp10': ['tp10', 'eeg_4', 'eeg4'],
}


def load_raw_csv(path: str | Path) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """
    Load muselsl raw CSV.
    Returns (raw_dict, timestamps) where raw_dict has keys tp9/af7/af8/tp10.
    Raises SystemExit on unrecoverable errors.
    """
    df  = pd.read_csv(path)
    col = {c.strip().lower().replace(' ', '_').replace('-', '_'): c for c in df.columns}

    def find(target: str) -> str | None:
        for alias in _COLUMN_ALIASES[target]:
            if alias in col:
                return col[alias]
        return None

    col_map: dict[str, str] = {}
    for target in ('tp9', 'af7', 'af8', 'tp10'):
        c = find(target)
        if c is None:
            sys.exit(f'Error: column "{target}" not found. '
                     f'Available columns: {list(df.columns)}')
        col_map[target] = c

    for ch in CHANNELS:
        df[col_map[ch]] = pd.to_numeric(df[col_map[ch]], errors='coerce')

    ts_col = find('ts')
    if ts_col:
        df['_ts'] = pd.to_numeric(df[ts_col], errors='coerce')
    else:
        df['_ts'] = np.arange(len(df)) / FS

    df.dropna(subset=[col_map[ch] for ch in CHANNELS] + ['_ts'], inplace=True)
    df.reset_index(drop=True, inplace=True)

    raw = {ch: df[col_map[ch]].to_numpy(dtype=np.float64) for ch in CHANNELS}
    ts  = df['_ts'].to_numpy(dtype=np.float64)
    return raw, ts


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Main pipeline
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def process(
    raw: dict[str, np.ndarray],
    ts : np.ndarray,
    verbose: bool = True,
) -> pd.DataFrame:
    """
    Sliding-window pipeline: computes all metrics and returns a DataFrame.
    One row per window step.
    """
    win_samp  = int(round(FS * WIN_SEC))
    step_samp = int(round(FS * STEP_SEC))
    n_total   = len(raw['tp9'])
    n_frames  = max(0, (n_total - win_samp) // step_samp + 1)
    t0        = ts[0]

    if n_frames < 1:
        sys.exit(f'Signal too short ({n_total} samples = {n_total/FS:.1f} s); '
                 f'need at least {win_samp} samples ({WIN_SEC} s).')

    if verbose:
        dur_min = (ts[-1] - ts[0]) / 60
        print(f'  Samples : {n_total}  ({dur_min:.2f} min @ {FS} Hz)')
        print(f'  Frames  : {n_frames}  '
              f'(window {WIN_SEC}s, step {STEP_SEC}s)')

    # ── Progress iterator ────────────────────────────────────────────────────
    try:
        from tqdm import tqdm
        frame_iter = tqdm(range(n_frames), unit='frame',
                          desc='  Computing', ncols=72)
    except ImportError:
        def frame_iter(iterable):           # type: ignore[misc]
            n = n_frames
            for i in iterable:
                if verbose and i % max(1, n // 20) == 0:
                    pct = 100 * i / n
                    print(f'\r  {pct:5.1f}%  [{i}/{n}]', end='', flush=True)
                yield i
            if verbose:
                print()
        frame_iter = frame_iter(range(n_frames))   # type: ignore[assignment]

    rows: list[dict] = []

    for f in frame_iter:
        start = f * step_samp
        end   = start + win_samp
        mid   = start + win_samp // 2

        win = {ch: raw[ch][start:end] for ch in CHANNELS}

        # ── Spectral (band powers) ────────────────────────────────────────
        bp = {ch: band_powers(win[ch]) for ch in CHANNELS}
        std = standard_metrics(bp)

        # ── Nonlinear chaos metrics ───────────────────────────────────────
        chaos_ch = [channel_chaos(win[ch]) for ch in CHANNELS]

        lle_mean  = float(np.mean([d['lle']         for d in chaos_ch]))
        d2_mean   = float(np.mean([d['corr_dim']    for d in chaos_ch]))
        hfd_mean  = float(np.mean([d['higuchi_fd']  for d in chaos_ch]))
        kfd_mean  = float(np.mean([d['katz_fd']     for d in chaos_ch]))
        ci        = composite_chaos_index(chaos_ch)

        row: dict = {
            't_sec'      : float(ts[mid] - t0),
            **std,
            'lle'        : lle_mean,
            'corr_dim'   : d2_mean,
            'higuchi_fd' : hfd_mean,
            'katz_fd'    : kfd_mean,
            'chaos_index': ci,
        }
        rows.append(row)

    df = pd.DataFrame(rows, columns=OUTPUT_COLS)
    return df


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CLI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def main() -> None:
    global FS, WIN_SEC, STEP_SEC
    ap = argparse.ArgumentParser(
        description='Pre-calculate EEG metrics from a muselsl raw CSV.',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument('input',
                    help='muselsl raw CSV (timestamps, TP9, AF7, AF8, TP10)')
    ap.add_argument('-o', '--output', default=None,
                    help='Output CSV path (default: <input>_metrics.csv)')
    ap.add_argument('--fs',   type=int,   default=FS,       metavar='HZ',
                    help='Sample rate')
    ap.add_argument('--win',  type=float, default=WIN_SEC,  metavar='SEC',
                    help='Analysis window length')
    ap.add_argument('--step', type=float, default=STEP_SEC, metavar='SEC',
                    help='Window step size')
    ap.add_argument('--kmax', type=int,   default=8,        metavar='K',
                    help='Higuchi kmax parameter')
    ap.add_argument('--quiet', action='store_true',
                    help='Suppress progress output')
    args = ap.parse_args()

    # Apply CLI overrides to module-level constants
    FS       = args.fs
    WIN_SEC  = args.win
    STEP_SEC = args.step

    out_path = args.output or str(Path(args.input).with_suffix('')) + '_metrics.csv'

    if not args.quiet:
        print('\n╔══════════════════════════════════════════╗')
        print('║   EEG Chaos & Band Metric Pre-Calculator ║')
        print('╚══════════════════════════════════════════╝')
        print(f'  Input  : {args.input}')
        print(f'  Output : {out_path}')
        print(f'  Params : fs={FS} Hz, window={WIN_SEC}s, step={STEP_SEC}s, '
              f'kmax={args.kmax}\n')

    raw, ts = load_raw_csv(args.input)
    df      = process(raw, ts, verbose=not args.quiet)
    df.to_csv(out_path, index=False, float_format='%.8g')

    if not args.quiet:
        print(f'\n✓  {len(df)} frames written → {out_path}')
        print(f'   Columns: {", ".join(df.columns.tolist())}\n')


if __name__ == '__main__':
    main()
