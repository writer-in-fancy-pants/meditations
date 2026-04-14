#!/usr/bin/env python3
"""
bridge.py — WHOOP BLE → WebSocket bridge
Reads heart rate + RR intervals from the WHOOP BLE broadcast and
forwards JSON frames to connected WebSocket clients.

Requirements:  pip install bleak websockets
Usage:         python bridge.py [--host localhost] [--port 8765]

WHOOP setup: WHOOP app → Device Settings → HR Broadcast → ON

JSON frame sent to clients:
  { "bpm": 72, "rr_ms": [820, 815] }
"""

import argparse
import asyncio
import json
import logging
import struct
import threading

try:
    from bleak import BleakScanner, BleakClient
except ImportError:
    raise SystemExit("Install bleak:  pip install bleak")

try:
    import websockets
except ImportError:
    raise SystemExit("Install websockets:  pip install websockets")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("hrv-bridge")

HR_SERVICE     = "0000180d-0000-1000-8000-00805f9b34fb"
HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb"

clients      = set()
clients_lock = asyncio.Lock()
latest_frame = None
_loop        = None


def parse_hr_measurement(data: bytes):
    """
    Parse Bluetooth GATT Heart Rate Measurement (0x2A37).
    Returns (bpm, rr_intervals_ms).
    WHOOP sends RR in milliseconds directly (not Polar's 1/1024 s units).
    """
    flags   = data[0]
    hr_fmt  = flags & 0x01          # 0 = uint8, 1 = uint16
    rr_flag = bool(flags & 0x10)

    offset = 1
    if hr_fmt:
        bpm    = struct.unpack_from("<H", data, offset)[0]
        offset += 2
    else:
        bpm    = data[offset]
        offset += 1

    if flags & 0x08:   # energy expended
        offset += 2

    rr = []
    if rr_flag:
        while offset + 1 < len(data):
            raw    = struct.unpack_from("<H", data, offset)[0]
            offset += 2
            if 300 <= raw <= 2000:
                rr.append(raw)

    return bpm, rr


async def _broadcast(message: str):
    async with clients_lock:
        targets = list(clients)
    if targets:
        await asyncio.gather(*[c.send(message) for c in targets], return_exceptions=True)


def hr_callback(sender, data: bytearray):
    global latest_frame
    bpm, rr = parse_hr_measurement(bytes(data))
    import time
    frame = {"bpm": bpm, "rr_ms": rr, "ts": time.time()}
    latest_frame = frame
    if _loop:
        asyncio.run_coroutine_threadsafe(_broadcast(json.dumps(frame)), _loop)


async def ble_task():
    log.info("Scanning for WHOOP Heart Rate broadcast…")
    log.info("Make sure HR Broadcast is ON in the WHOOP app.")

    device = None
    while device is None:
        devices = await BleakScanner.discover(timeout=5.0, service_uuids=[HR_SERVICE])
        for d in devices:
            log.info(f"  Found: {d.name!r}  {d.address}")
            if d.name and "WHOOP" in d.name.upper():
                device = d
                break
        if device is None:
            log.warning("WHOOP not found — retrying in 5 s (is HR Broadcast ON?)")
            await asyncio.sleep(5)

    log.info(f"Connecting to {device.name} ({device.address})…")
    async with BleakClient(device.address) as client:
        log.info("Connected — subscribing to Heart Rate Measurement")
        await client.start_notify(HR_MEASUREMENT, hr_callback)
        log.info("Streaming HR data. Press Ctrl+C to stop.")
        while client.is_connected:
            await asyncio.sleep(1)
    log.warning("BLE disconnected.")


async def ws_handler(websocket):
    async with clients_lock:
        clients.add(websocket)
    log.info(f"WS client connected: {websocket.remote_address}  total={len(clients)}")
    try:
        if latest_frame:
            await websocket.send(json.dumps(latest_frame))
        await websocket.wait_closed()
    finally:
        async with clients_lock:
            clients.discard(websocket)
        log.info(f"WS client disconnected  total={len(clients)}")


async def main(host: str, port: int):
    global _loop
    _loop = asyncio.get_running_loop()

    asyncio.create_task(ble_task())

    log.info(f"WebSocket server on ws://{host}:{port}")
    async with websockets.serve(ws_handler, host, port):
        await asyncio.Future()   # run forever


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="WHOOP BLE → WebSocket bridge")
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()
    try:
        asyncio.run(main(args.host, args.port))
    except KeyboardInterrupt:
        log.info("Stopped.")
