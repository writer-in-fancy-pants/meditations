# ── Frame recorder ────────────────────────────────────────────────────────────
#
# Usage:
#   recorder = FrameRecorder("session_2024.jsonl")
#   recorder.start()
#   # … bridge runs; call recorder.record(frame) wherever _broadcast is called …
#   recorder.stop()          # flushes and closes the file
#
# The recorder writes one JSON line per frame (newline-delimited JSON / .jsonl).
# Writing is done on a background thread via a queue so it never blocks the
# asyncio event loop or the BrainFlow polling threads.
#
# Integration — patch _broadcast to also feed the recorder:
#
#   async def _broadcast(message: str) -> None:
#       if _recorder is not None:
#           _recorder.record(message)          # message is already a JSON string
#       async with clients_lock:
#           targets = list(clients)
#       if targets:
#           await asyncio.gather(
#               *[c.send(message) for c in targets],
#               return_exceptions=True,
#           )

import json
import os
import queue
import threading
import time
from pathlib import Path
from typing import Union

import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recorder")

class FrameRecorder:
    """
    Thread-safe, non-blocking recorder for bridge output frames.

    All five frame types (eeg, ppg, fnirs, imu, battery) are captured
    exactly as broadcast to WebSocket clients — one JSON object per line
    in a newline-delimited JSON (.jsonl) file.

    Parameters
    ----------
    path : str | Path
        Destination file.  If the file already exists it is appended to,
        making it easy to resume a multi-run recording session.
    frame_types : set[str] | None
        Restrict recording to specific frame types, e.g. {"eeg", "ppg"}.
        None (default) records all frame types.
    flush_interval : float
        Seconds between forced disk flushes (default 5.0).  Lower values
        reduce data loss on crash at the cost of more I/O.
    max_queue : int
        Maximum number of pending frames in the write queue before the
        recorder starts dropping the oldest (default 2048).  Prevents
        unbounded memory growth if disk I/O falls behind the data rate.
    """

    _SENTINEL = object()   # signals the writer thread to exit

    def __init__(
        self,
        path: Union[str, Path],
        frame_types: set[str] | None = None,
        flush_interval: float = 5.0,
        max_queue: int = 2048,
    ) -> None:
        self._path           = Path(path)
        self._frame_types    = frame_types          # None = record all
        self._flush_interval = flush_interval
        self._max_queue      = max_queue
        self._queue: queue.Queue = queue.Queue(maxsize=max_queue)
        self._thread: threading.Thread | None = None
        self._running        = False
        self._frames_written = 0
        self._frames_dropped = 0
        self._started_at: float | None = None

    # ── Public API ────────────────────────────────────────────────

    def start(self) -> None:
        """Open the output file and start the background writer thread."""
        if self._running:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._running    = True
        self._started_at = time.time()
        self._thread = threading.Thread(
            target=self._writer_loop,
            daemon=True,
            name="FrameRecorder",
        )
        self._thread.start()
        log.info(
            "FrameRecorder started → %s  (types=%s)",
            self._path,
            self._frame_types or "all",
        )

    def stop(self, timeout: float = 10.0) -> None:
        """
        Signal the writer to flush and close, then wait up to `timeout`
        seconds for the queue to drain before returning.
        """
        if not self._running:
            return
        self._running = False
        self._queue.put(self._SENTINEL)
        if self._thread:
            self._thread.join(timeout=timeout)
        log.info(
            "FrameRecorder stopped — %d frames written, %d dropped → %s",
            self._frames_written,
            self._frames_dropped,
            self._path,
        )

    def record(self, frame: Union[str, dict]) -> None:
        """
        Enqueue a frame for writing.

        Accepts either a raw JSON string (as produced by _broadcast) or a
        plain dict.  Type filtering is applied here so the writer thread
        never has to parse frames it won't write.

        Silently drops the frame if the queue is full (non-blocking put).
        """
        if not self._running:
            return

        # Fast-path type filter before any serialisation
        if self._frame_types is not None:
            if isinstance(frame, str):
                # Avoid full parse: peek at the "type" field with a find
                if not any(f'"type": "{t}"' in frame or f'"type":"{t}"' in frame
                           for t in self._frame_types):
                    return
            elif isinstance(frame, dict):
                if frame.get("type") not in self._frame_types:
                    return

        # Serialise dicts; strings are already JSON
        line: str = frame if isinstance(frame, str) else json.dumps(frame)

        try:
            self._queue.put_nowait(line)
        except queue.Full:
            self._frames_dropped += 1
            # Evict oldest entry to make room for the new one
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(line)
            except queue.Empty:
                pass

    # ── Properties ────────────────────────────────────────────────

    @property
    def frames_written(self) -> int:
        return self._frames_written

    @property
    def frames_dropped(self) -> int:
        return self._frames_dropped

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def output_path(self) -> Path:
        return self._path

    # ── Background writer ─────────────────────────────────────────

    def _writer_loop(self) -> None:
        """
        Runs on the FrameRecorder background thread.
        Opens the file in append mode and drains the queue, flushing to
        disk every `_flush_interval` seconds.
        """
        last_flush = time.monotonic()

        try:
            with self._path.open("a", encoding="utf-8", buffering=1) as fh:
                while True:
                    # Block briefly so we don't spin when the queue is empty
                    try:
                        item = self._queue.get(timeout=self._flush_interval)
                    except queue.Empty:
                        fh.flush()
                        last_flush = time.monotonic()
                        continue

                    if item is self._SENTINEL:
                        # Drain any remaining items before exiting
                        while True:
                            try:
                                remaining = self._queue.get_nowait()
                                if remaining is not self._SENTINEL:
                                    fh.write(remaining + "\n")
                                    self._frames_written += 1
                            except queue.Empty:
                                break
                        fh.flush()
                        break

                    fh.write(item + "\n")
                    self._frames_written += 1

                    # Periodic flush
                    now = time.monotonic()
                    if now - last_flush >= self._flush_interval:
                        fh.flush()
                        last_flush = now

        except OSError as exc:
            log.error("FrameRecorder write error: %s", exc)
            self._running = False