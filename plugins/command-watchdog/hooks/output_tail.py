"""Bounded tail of a command's output: last 20 complete lines with UTC timestamps."""
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Deque, List, Tuple

LINE_LIMIT = 4096
TAIL_LIMIT = 20
# A character is at most 4 UTF-8 bytes; anything beyond this can never survive truncation.
_BYTE_LIMIT = LINE_LIMIT * 4


class OutputTail:
    def __init__(self):
        # The reader thread feeds while the main thread may flush or read; every method takes this lock.
        self._lock = threading.Lock()
        self._partial = b""
        self._lines: Deque[Tuple[str, str]] = deque(maxlen=TAIL_LIMIT)

    @staticmethod
    def _stamp(now: float) -> str:
        return datetime.fromtimestamp(now, tz=timezone.utc).isoformat(timespec="seconds")

    def _emit(self, raw: bytes, stamp: str) -> None:
        text = raw[:_BYTE_LIMIT].decode("utf-8", errors="replace")[:LINE_LIMIT]
        self._lines.append((stamp, text))

    def feed(self, chunk: bytes, now: float) -> None:
        with self._lock:
            parts = (self._partial + chunk).split(b"\n")
            stamp = self._stamp(now)
            # Keep the unfinished line bounded so a newline-free stream cannot grow memory.
            self._partial = parts.pop()[:_BYTE_LIMIT]
            # Only the last TAIL_LIMIT complete lines can survive; skip the rest.
            for part in parts[-TAIL_LIMIT:]:
                self._emit(part, stamp)

    def flush(self, now: float) -> None:
        with self._lock:
            if self._partial:
                self._emit(self._partial, self._stamp(now))
                self._partial = b""

    def lines(self) -> List[Tuple[str, str]]:
        with self._lock:
            return list(self._lines)
