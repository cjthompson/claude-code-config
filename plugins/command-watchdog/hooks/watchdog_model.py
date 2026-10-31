"""Shared enums. Values are stored verbatim in stats.db and match the watchdog's log text."""
from enum import Enum


class KillReason(str, Enum):
    IDLE = "idle"
    POLL_IDLE = "poll-idle"
    TARGET_GONE = "target-gone"
    MAX_RUNTIME = "max-runtime"
    ORPHANED = "orphaned"


class FiredCheck(str, Enum):
    IDLE = "idle"
    MAX_RUNTIME = "max_runtime"
    POLL_CAP = "poll_cap"
    NONE = "none"


class Outcome(str, Enum):
    SUCCESS = "success"
    FAILED = "failed"
    KILLED = "killed"


class LoopKind(str, Enum):
    NONE = "none"
    TARGETED = "targeted"
    UNTARGETED = "untargeted"
