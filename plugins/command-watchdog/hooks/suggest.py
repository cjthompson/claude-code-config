"""Suggestion math for numeric limits. Pure functions: no I/O."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass(frozen=True)
class CheckInput:
    name: str
    configured: Optional[int]
    successes: int
    maximum: float
    kills: int
    invocations: int
    poll: int
    acceptable_kill_percent: int


@dataclass(frozen=True)
class Option:
    name: str
    value: int
    recommended: bool
    confidence: str


@dataclass(frozen=True)
class CheckResult:
    name: str
    trigger: Optional[str]
    confidence: str
    options: Tuple[Option, ...]


def round_up(value: float) -> int:
    if value >= 60:
        return int(math.ceil(value / 30.0) * 30)
    return int(math.ceil(value / 5.0) * 5)


def _confidence(successes: int) -> str:
    if successes == 0:
        return "no successful runs yet"
    if successes < 3:
        return "low confidence"
    return "normal"


def suggest_check(inp: CheckInput) -> CheckResult:
    if inp.invocations == 0:
        return CheckResult(inp.name, None, "no runs yet", ())
    configured = inp.configured
    maximum = float(inp.maximum)
    kill_pct = 100.0 * inp.kills / inp.invocations
    success_pct = 100.0 * inp.successes / inp.invocations
    closeness = (maximum / configured) if configured else None
    loosen = kill_pct > inp.acceptable_kill_percent or (closeness is not None and closeness >= 0.75)
    tighten = success_pct >= 50 and configured is not None and configured >= 3 * maximum
    trigger = "loosen" if loosen else ("tighten" if tighten else None)

    floor = max(5, 2 * inp.poll)
    tight = 1.25 * maximum
    if inp.successes == 0 and configured is not None:
        medium, long = 2.0 * configured, 3.0 * configured
    elif loosen:
        base = max(configured or 0, maximum)
        medium, long = 2.0 * base, 3.0 * base
    elif configured is None:
        medium, long = 2.0 * maximum, 3.0 * maximum
    else:
        medium, long = 1.5 * maximum, 3.0 * maximum

    confidence = _confidence(inp.successes)
    raw = [("tight", tight), ("medium", medium), ("long", long)]
    options = tuple(
        Option(
            name=name,
            value=round_up(max(value, floor)),
            recommended=(trigger == "loosen" and name == "medium") or (trigger == "tighten" and name == "tight"),
            confidence=confidence,
        )
        for name, value in raw
    )
    return CheckResult(inp.name, trigger, confidence, options)
