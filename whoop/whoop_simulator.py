#!/usr/bin/env python3
"""
whoop_simulator.py  —  WHOOP 4.0/5.0 physiological data simulator
Generates realistic HR + RR interval data and broadcasts it over WebSocket
in the same JSON format as bridge.py:  { "bpm": int, "rr_ms": [int, ...] }

WHOOP 4.0 specs modelled:
  • PPG sampled at 52 Hz internally; RR intervals derived from peak detection
  • RR intervals broadcast in milliseconds over BLE GATT 0x2A37
  • 1 BLE packet per second (~1–2 RR intervals per packet at rest)
  • RR resolution: ~1 ms (WHOOP sends raw ms, not Polar's 1/1024 s units)
  • Motion artefact: WHOOP suppresses RR intervals entirely on movement
  • Wrist placement: ±5–8 bpm noise vs biceps ±2–4 bpm
  • RMSSD at rest: 25–65 ms (individual variation; default 40 ms)

Usage:
    python whoop_simulator.py                      # resting session, wrist
    python whoop_simulator.py --scenario training  # workout ramp
    python whoop_simulator.py --scenario meditation
    python whoop_simulator.py --scenario sleep
    python whoop_simulator.py --scenario recovery
    python whoop_simulator.py --placement biceps   # lower noise
    python whoop_simulator.py --rmssd 55           # high HRV individual
    python whoop_simulator.py --hr-base 68 --port 9000
    python whoop_simulator.py --list-scenarios

Install:  pip install websockets
"""

import argparse
import asyncio
import json
import logging
import math
import random
import time

try:
    import websockets
except ImportError:
    raise SystemExit("Install websockets:  pip install websockets")

# ── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("whoop-sim")

# ── Scenario library ────────────────────────────────────────────────────────

SCENARIOS = {
    "resting": {
        "description": "Seated rest — baseline HRV session",
        "phases": [
            # (duration_s, target_hr, target_rmssd, label)
            (30,  65, 35, "settling"),
            (270, 62, 45, "deep rest"),
        ],
    },
    "meditation": {
        "description": "Slow resonant-frequency breathing (5.5 breaths/min)",
        "phases": [
            (60,  64, 38, "pre-meditation settle"),
            (120, 62, 55, "resonant breathing onset"),
            (300, 60, 72, "deep coherence"),   # HRV rises during slow breathing
            (60,  63, 48, "return"),
        ],
    },
    "training": {
        "description": "Moderate workout: warm-up → intervals → cool-down",
        "phases": [
            (120, 68,  38, "warm-up"),
            (60,  95,  18, "ramp"),
            (120, 145, 8,  "zone 4 intervals"),   # HRV suppressed at high HR
            (60,  155, 6,  "peak effort"),
            (180, 110, 12, "recovery jog"),
            (120, 80,  22, "cool-down"),
            (120, 68,  32, "post-workout rest"),
        ],
    },
    "recovery": {
        "description": "Morning HRV recovery measurement",
        "phases": [
            (30,  58, 42, "waking"),
            (90,  56, 55, "still waking"),
            (180, 54, 62, "resting measurement"),
        ],
    },
    "sleep": {
        "description": "Sleep cycle approximation (light → deep → REM × 2)",
        "phases": [
            (300, 58, 50, "light sleep N1/N2"),
            (600, 52, 68, "deep sleep N3"),         # highest HRV
            (400, 56, 44, "REM — variable HR"),
            (300, 50, 72, "deep sleep N3 (cycle 2)"),
            (500, 58, 48, "REM cycle 2"),
            (200, 60, 38, "light / wake"),
        ],
    },
}

# ── Placement noise profiles ────────────────────────────────────────────────

PLACEMENT_NOISE = {
    "wrist":   {"hr_noise_bpm": 1.8,  "rr_noise_ms": 4.0},
    "biceps":  {"hr_noise_bpm": 0.8,  "rr_noise_ms": 2.0},
    "apparel": {"hr_noise_bpm": 0.6,  "rr_noise_ms": 1.5},
}

# ── Physiological model ─────────────────────────────────────────────────────

class WhoopPhysioModel:
    """
    Generates beat-to-beat RR intervals that reproduce the spectral structure
    of real HRV (LF ~0.1 Hz + HF ~0.25 Hz) while following a HR/RMSSD
    trajectory defined by scenario phases.

    The model is driven at the true instantaneous beat rate, meaning packet
    timing matches real WHOOP behaviour: packets arrive once per second,
    carrying 1–2 RR values depending on current HR.
    """

    def __init__(self, hr_base: float, rmssd_base: float, placement: str):
        self.hr_base      = hr_base        # bpm
        self.rmssd_base   = rmssd_base     # ms
        self.placement    = placement

        # Current physiological targets (updated by phase transitions)
        self.target_hr    = hr_base
        self.target_rmssd = rmssd_base

        # Smoothed current values (first-order lag towards target)
        self.current_hr    = hr_base
        self.current_rmssd = rmssd_base

        # HRV oscillator state — two sinusoidal components:
        #   LF (~0.1 Hz, baroreflex / sympatho-vagal)
        #   HF (~0.25 Hz, RSA — respiratory sinus arrhythmia)
        self._lf_phase  = random.uniform(0, 2 * math.pi)
        self._hf_phase  = random.uniform(0, 2 * math.pi)
        self._lf_freq   = 0.10                # Hz
        self._hf_freq   = 0.25                # Hz

        # Phase transition management
        self._phases           = []
        self._phase_idx        = 0
        self._phase_elapsed    = 0.0
        self._phase_start_hr   = hr_base
        self._phase_start_rmssd= rmssd_base

        # Time accumulator for packet generation
        self._beat_accumulator = 0.0    # seconds of un-packeted beats
        self._rr_queue         = []     # generated RR intervals to be sent

        noise = PLACEMENT_NOISE.get(placement, PLACEMENT_NOISE["wrist"])
        self._hr_noise   = noise["hr_noise_bpm"]
        self._rr_noise   = noise["rr_noise_ms"]

        # Ectopic beat probability (WHOOP detects ~90% of true ectopics)
        self._ectopic_prob = 0.003      # ~0.3% of beats

    def load_phases(self, phases: list):
        self._phases         = phases
        self._phase_idx      = 0
        self._phase_elapsed  = 0.0
        if phases:
            _, thr, trmssd, _ = phases[0]
            self.target_hr     = thr
            self.target_rmssd  = trmssd
            self._phase_start_hr    = self.current_hr
            self._phase_start_rmssd = self.current_rmssd

    def _advance_phase(self, dt: float):
        """Update phase index based on elapsed time, smoothly interpolate targets."""
        if not self._phases:
            return
        self._phase_elapsed += dt
        dur, *_ = self._phases[self._phase_idx]
        if self._phase_elapsed >= dur:
            self._phase_elapsed = 0.0
            if self._phase_idx < len(self._phases) - 1:
                self._phase_idx        += 1
                _, thr, trmssd, label   = self._phases[self._phase_idx]
                self._phase_start_hr    = self.current_hr
                self._phase_start_rmssd = self.current_rmssd
                self.target_hr          = thr
                self.target_rmssd       = trmssd
                log.info(f"  Phase → {label!r}  target HR={thr}  target RMSSD={trmssd}")

    def _smooth(self, current, target, tau_s, dt):
        """Exponential approach with time constant tau_s."""
        alpha = 1 - math.exp(-dt / tau_s)
        return current + alpha * (target - current)

    def next_rr_ms(self, dt: float) -> float:
        """
        Generate the next physiologically plausible RR interval (ms).
        dt: wall-clock time since last call (s), used to advance oscillators.
        """
        # Advance phase
        self._advance_phase(dt)

        # Smooth current HR/RMSSD towards targets
        # HR adapts faster than RMSSD (sympathetic faster than parasympathetic)
        self.current_hr    = self._smooth(self.current_hr,    self.target_hr,    10.0, dt)
        self.current_rmssd = self._smooth(self.current_rmssd, self.target_rmssd, 25.0, dt)

        # Advance oscillators
        self._lf_phase += 2 * math.pi * self._lf_freq * dt
        self._hf_phase += 2 * math.pi * self._hf_freq * dt

        # Mean RR from current HR
        mean_rr = 60000.0 / max(self.current_hr, 30)

        # RMSSD → std dev of beat-to-beat differences → per-beat std (approx factor √2)
        per_beat_std = self.current_rmssd / math.sqrt(2)

        # LF amplitude scales with RMSSD (low-frequency power ∝ HRV)
        lf_amp  = per_beat_std * 0.6
        hf_amp  = per_beat_std * 0.9

        # Oscillatory component
        oscillation = (
            lf_amp * math.sin(self._lf_phase) +
            hf_amp * math.sin(self._hf_phase)
        )

        # Gaussian noise (instrument + PPG shot noise)
        noise = random.gauss(0, self._rr_noise)

        rr = mean_rr + oscillation + noise

        # Ectopic beat simulation (premature ventricular contraction)
        if random.random() < self._ectopic_prob:
            # Short beat followed by compensatory pause
            coupling  = random.uniform(0.60, 0.80)
            ectopic   = rr * coupling
            compensate= rr * (2.0 - coupling)
            # Return ectopic; store compensatory beat for next call
            self._rr_queue.insert(0, compensate)
            rr = ectopic

        # Clamp to physiologically valid range
        rr = max(300.0, min(2000.0, rr))
        return round(rr)

    def generate_packet(self, wall_time: float):
        """
        Return (bpm, rr_list) for one ~1 s BLE packet.
        Mirrors WHOOP's actual behaviour:
          - 1–2 RR intervals per packet at rest (HR 55–80)
          - 0–1 RR intervals at high HR (HR > 140) — timing may miss a beat
          - Packet rate: ~1 Hz
        """
        dt = 1.0   # packet interval seconds

        # Generate RR intervals that fill ~dt seconds
        collected = []
        time_budget = dt * 1000  # ms
        used = 0.0
        while used < time_budget and len(collected) < 4:
            # Pull from queue first (compensatory beats)
            if self._rr_queue:
                rr = self._rr_queue.pop(0)
            else:
                rr = self.next_rr_ms(dt / max(1, len(collected) + 1))
            collected.append(int(rr))
            used += rr

        # WHOOP suppresses RR if internal motion detected (not modelled here,
        # but can be triggered externally via --motion flag in future)
        # Derive BPM from collected RR intervals
        if collected:
            mean_rr = sum(collected) / len(collected)
            bpm = int(round(60000.0 / mean_rr))
        else:
            bpm = int(round(self.current_hr))

        # Add optical sensor HR noise (PPG quality variation)
        bpm = int(round(bpm + random.gauss(0, self._hr_noise)))
        bpm = max(30, min(220, bpm))

        return bpm, collected


# ── WebSocket server ────────────────────────────────────────────────────────

clients      = set()
clients_lock = asyncio.Lock()
latest_frame: dict | None = None


async def broadcast(message: str):
    async with clients_lock:
        targets = list(clients)
    if targets:
        results = await asyncio.gather(
            *[c.send(message) for c in targets],
            return_exceptions=True,
        )
        for r in results:
            if isinstance(r, Exception):
                log.debug(f"Broadcast error: {r}")


async def ws_handler(websocket):
    async with clients_lock:
        clients.add(websocket)
    log.info(f"Client connected:    {websocket.remote_address}  ({len(clients)} total)")
    try:
        if latest_frame:
            await websocket.send(json.dumps(latest_frame))
        await websocket.wait_closed()
    finally:
        async with clients_lock:
            clients.discard(websocket)
        log.info(f"Client disconnected: {websocket.remote_address}  ({len(clients)} total)")


# ── Simulation loop ─────────────────────────────────────────────────────────

async def simulation_loop(model: WhoopPhysioModel, total_duration: float | None):
    """Generate and broadcast one BLE packet per second."""
    global latest_frame
    start     = time.monotonic()
    tick      = 0
    log.info("Simulation running  (Ctrl+C to stop)")
    log.info(f"  HR base={model.hr_base:.0f} bpm  RMSSD base={model.rmssd_base:.0f} ms  placement={model.placement}")

    while True:
        t0   = time.monotonic()
        wall = t0 - start

        if total_duration and wall >= total_duration:
            log.info("Simulation duration reached — stopping.")
            break

        bpm, rr_list = model.generate_packet(1.0)   # dt = 1 s per packet

        frame = {
            "bpm":   bpm,
            "rr_ms": rr_list,
            "ts":    time.time(),
            "sim":   True,
            "tick":  tick,
        }
        latest_frame = frame

        await broadcast(json.dumps(frame))

        # Periodic console log (every 10 s)
        if tick % 10 == 0:
            rmssd_live = None
            if len(rr_list) >= 2:
                diffs = [abs(rr_list[i]-rr_list[i-1]) for i in range(1, len(rr_list))]
                rmssd_live = math.sqrt(sum(d**2 for d in diffs) / len(diffs))
            rmssd_str = f"{rmssd_live:.1f}" if rmssd_live else "n/a"
            log.info(
                f"  t={wall:5.0f}s  HR={bpm:3d} bpm  "
                f"RR={rr_list}  "
                f"current_HR={model.current_hr:.1f}  "
                f"current_RMSSD={model.current_rmssd:.1f} ms"
            )

        tick += 1

        # Sleep to maintain ~1 Hz packet rate
        elapsed = time.monotonic() - t0
        sleep_for = max(0, 1.0 - elapsed)
        await asyncio.sleep(sleep_for)


# ── Main ────────────────────────────────────────────────────────────────────

async def main(args):
    # Build scenario phases
    scenario_key = args.scenario
    scenario     = SCENARIOS[scenario_key]
    log.info(f"Scenario: {scenario_key!r} — {scenario['description']}")
    phases = scenario["phases"]

    total_dur = sum(p[0] for p in phases) if not args.loop else None
    if args.loop:
        log.info("Loop mode: scenario will repeat indefinitely")
    else:
        total_str = f"{total_dur}s ({total_dur/60:.1f} min)"
        log.info(f"Total duration: {total_str}")

    # Build model
    model = WhoopPhysioModel(
        hr_base     = args.hr_base,
        rmssd_base  = args.rmssd,
        placement   = args.placement,
    )
    model.load_phases(phases)

    # WebSocket server + simulation tasks
    host, port = args.host, args.port
    log.info(f"WebSocket on ws://{host}:{port}  (bridge-compatible output)")
    log.info(f"  Open hrv-neurofeedback/index.html → Bridge → ws://{host}:{port}")

    async with websockets.serve(ws_handler, host, port):
        if args.loop:
            while True:
                model.load_phases(phases)
                await simulation_loop(model, total_duration=None if args.loop else total_dur)
                if not args.loop:
                    break
        else:
            await simulation_loop(model, total_duration=total_dur)

    log.info("Simulator stopped.")


def parse_args():
    p = argparse.ArgumentParser(
        description="WHOOP physiological data simulator → WebSocket",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="\n".join(
            f"  {k:12s}  {v['description']}"
            for k, v in SCENARIOS.items()
        ),
    )
    p.add_argument(
        "--scenario", choices=list(SCENARIOS), default="resting",
        help="Physiological scenario to simulate (default: resting)",
    )
    p.add_argument(
        "--placement", choices=list(PLACEMENT_NOISE), default="wrist",
        help="Sensor placement — affects noise level (default: wrist)",
    )
    p.add_argument(
        "--hr-base", type=float, default=65.0, metavar="BPM",
        help="Baseline resting heart rate in bpm (default: 65)",
    )
    p.add_argument(
        "--rmssd", type=float, default=40.0, metavar="MS",
        help="Baseline RMSSD in ms — individual HRV level (default: 40)",
    )
    p.add_argument(
        "--host", default="localhost",
        help="WebSocket bind host (default: localhost)",
    )
    p.add_argument(
        "--port", type=int, default=8765,
        help="WebSocket port (default: 8765, matches bridge.py)",
    )
    p.add_argument(
        "--loop", action="store_true",
        help="Loop the scenario indefinitely instead of stopping after one run",
    )
    p.add_argument(
        "--list-scenarios", action="store_true",
        help="Print all scenarios and exit",
    )
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()

    if args.list_scenarios:
        print("\nAvailable scenarios:\n")
        for name, sc in SCENARIOS.items():
            total = sum(p[0] for p in sc["phases"])
            print(f"  {name:<14}  {sc['description']}")
            print(f"  {'':14}  Duration: {total}s ({total/60:.1f} min)")
            for dur, hr, rmssd, label in sc["phases"]:
                print(f"  {'':14}    [{dur:4d}s]  HR≈{hr:3d}  RMSSD≈{rmssd:2d}  {label}")
            print()
        raise SystemExit(0)

    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        log.info("Interrupted — simulator stopped.")
