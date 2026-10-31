# Command Watchdog Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every watchdog-supervised command in an opt-in SQLite store, add per-command INI limits with per-run overrides, and ship the `stats`, `suggest-timeouts`, `reset-stats`, `delete-stats`, and `enable-stats` commands.

**Architecture:** Stdlib-only Python modules beside the hooks. Pure modules hold the enums, command identity, INI resolution, output tail, and suggestion math. A single store module is the only code that opens `stats.db`. `command-watchdog.py` writes one transaction per run at exit. `bash-watchdog.py` lifts per-run overrides off the command and stops injecting `WATCHDOG_*` values. A CLI in `bin/` backs five plugin commands.

**Tech Stack:** Python 3.9 stdlib (`sqlite3`, `configparser`, `shlex`, `json`, `argparse`, `unittest`), run by `/usr/bin/python3`. SQLite in WAL mode.

**Spec:** `docs/superpowers/specs/2026-10-13-watchdog-stats-design.md` (commit `feee3b9`). Executors read both the spec and this plan.

## Global Constraints

- Python 3.9 stdlib only. No `tomllib`. Add `from __future__ import annotations` before any `X | None` annotation.
- Run tests with `/usr/bin/python3 -m unittest discover -s plugins/command-watchdog/tests -v`, from the worktree root.
- `configparser.ConfigParser(interpolation=None, strict=False)` everywhere. Keys are lowercased by `configparser`.
- Kill reasons, exactly: `idle`, `poll-idle`, `target-gone`, `max-runtime`, `orphaned`.
- Outcomes, exactly: `success`, `failed`, `killed`.
- Disable markers: `-1` or `off`. `max_runtime: 0` and `WATCHDOG_MAX_RUNTIME=0` mean off. `idle: 0` and `poll_cap: 0` are invalid. `poll` must be a positive integer; `off` and `-1` are invalid for `poll`.
- `nice` takes `on` or `off`, set per command in the INI only. `WATCHDOG_NICE` is not read.
- Precedence: built-in < merged INI < environment. Lifted command-prefix assignments count as environment.
- Only `WATCHDOG_IDLE`, `WATCHDOG_MAX_RUNTIME`, and `WATCHDOG_POLL_CAP` lift from a command prefix. Accepted lifted values match `^(-1|off|\d+)$`.
- Store directory: `$COMMAND_WATCHDOG_HOME` if set. Otherwise macOS `$HOME/Library/Application Support/command-watchdog`; Linux `${XDG_DATA_HOME:-$HOME/.local/share}/command-watchdog`; Windows `%LOCALAPPDATA%\command-watchdog`, falling back to `%APPDATA%\command-watchdog`.
- Store files: `stats.db`, `stats-backup-YYYYMMDD-HHMMSS.db`, `watchdog-patterns.ini`, `watchdog-patterns.ini.bak-YYYYMMDD-HHMMSS`.
- SQLite: busy timeout 200 ms; `journal_mode=WAL`; `synchronous=NORMAL`; `PRAGMA foreign_keys=ON` on every connection.
- Retention: detail rows 30 days; prune at most once per 24 h; counters never pruned; never prune from an `rtk hook` run.
- Output tail: last 20 complete lines with timestamps, killed runs only, each line truncated to 4096 characters.
- Suggestions: `N ≥ 3` normal. `tight = M × 1.25`. Loosen trigger: `K% > acceptable_kill_percent` or `R ≥ 0.75`. Tighten trigger: success rate ≥ 50% and `C ≥ 3 × M`. Floor `max(5, 2 × poll)`. Round up to 30 s at ≥ 60 s, else to 5 s.
- Built-in defaults: `idle 90`, `max_runtime off`, `poll 5`, `poll_cap 1800`, `nice on`, `acceptable_kill_percent 25`. Built-in command default: `rtk` → `max_runtime 15`.
- Stats are opt-in. Hooks never create `stats.db` or its directory.
- A stats failure never changes the exit status, the kill decision, or the command output.
- Do not edit `CHANGELOG.md` and do not bump plugin versions in this plan. CLAUDE.md requires those only after merge to `main`.

## Review Focus

1. A command that is only assignments (`WATCHDOG_IDLE=600`) leaves nothing to run. Expected: the wrapper passes it through unmodified and no stats row is written. Tests: Task 8.
2. The stats store is unwritable, locked, or corrupt while a command runs. Expected: the command runs and its exit status is unchanged. Tests: Task 7c.
3. A malformed INI (broken syntax, bad value, bad regex, a literal `%`) must not block Bash. Expected: the hook runs with the remaining valid values and built-in defaults. Tests: Task 3 and Task 8.
4. Signature parsing with unmatched quotes, `$(`, pipes, or a lone `--` must not raise. Expected: a string result every time. Tests: Task 2.
5. Two hooks create the same rule version at once. Expected: exactly one `rule_versions` row. Tests: Task 5.

## Plan Decisions (confirm before executing)

- **P1 `WATCHDOG_POLL`.** Still read from the process environment, because `tests/test_command_watchdog.py` and `tests/test_hook.py` set it. It counts as an environment override. It is not liftable from a command prefix. The spec's list of per-run keys is otherwise unchanged.
- **P2 Regex input.** `[rule:…]` regexes match the command after lifting assignments and before rtk rewriting. The wrapper passes this text as `--original`.
- **P3 Exit codes.** `exit_code` stores the raw `proc.returncode` for killed and failed runs. `supervise()` still returns `124` on a hang, as today.
- **P4 `max_silence`.** Includes the trailing gap from the last activity to exit.
- **P5 No command after overrides.** The wrapper passes the original command through unmodified and logs it. Nothing is wrapped and nothing is recorded.
- **P6 Recommended option.** A loosen trigger marks `medium`. A tighten trigger marks `tight`.
- **P7 Schema addition.** `invocations` gets an `override_vars TEXT NOT NULL DEFAULT ''` column so `stats` can name the variables behind excluded runs. Update the spec's schema block to match.
- **P8 Applying suggestions.** `suggest-timeouts SECTION --choose idle=medium,max_runtime=tight --apply` writes only the named choices. A missing `--choose` is a usage error.
- **P9 INI rewrite.** `--apply` rewrites the data-directory INI with `configparser`, which drops comments. The `.bak` copy keeps them.

## File Structure

Create:

- `plugins/command-watchdog/hooks/watchdog_model.py` — enums: `KillReason`, `FiredCheck`, `Outcome`, `LoopKind`.
- `plugins/command-watchdog/hooks/command_identity.py` — `lift_overrides`, `primary_process`, `signature`.
- `plugins/command-watchdog/hooks/watchdog_config.py` — INI load and merge, value parsing, `resolve`.
- `plugins/command-watchdog/hooks/watchdog-patterns.ini` — shipped rules (replaces `watchdog-patterns.txt`).
- `plugins/command-watchdog/hooks/output_tail.py` — line buffer for killed-run output.
- `plugins/command-watchdog/hooks/stats_store.py` — paths, enable, schema, record, counters, prune, reset, delete.
- `plugins/command-watchdog/hooks/suggest.py` — pure suggestion math.
- `plugins/command-watchdog/bin/command-watchdog-stats` — CLI.
- `plugins/command-watchdog/commands/stats.md`, `suggest-timeouts.md`, `reset-stats.md`, `delete-stats.md`, `enable-stats.md`.
- Tests: `tests/test_watchdog_model.py`, `tests/test_command_identity.py`, `tests/test_watchdog_config.py`, `tests/test_output_tail.py`, `tests/test_stats_store.py`, `tests/test_record_run.py`, `tests/test_prune_reset.py`, `tests/test_suggest.py`, `tests/test_limits.py`, `tests/test_recording.py`, `tests/test_cli.py`, `tests/test_commands.py`.

Modify:

- `plugins/command-watchdog/hooks/command-watchdog.py` — argument parsing, module path, limits applied per run, `None` for off, nice branch, `FiredCheck`, `max_silence`, output tail, recording.
- `plugins/command-watchdog/hooks/bash-watchdog.py` — remove injection and the `.txt` loader; lift overrides; strip `WATCHDOG_*` from the rtk call; new wrapper arguments.
- `plugins/command-watchdog/tests/test_nice.py`, `tests/test_hook.py` — see Tasks 7 and 8.
- `README.md` — command-watchdog section.

Delete:

- `plugins/command-watchdog/hooks/watchdog-patterns.txt` (Task 8).

Test files import hooks by inserting the hooks directory on `sys.path`. Every test file starts with:

```python
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
```

---

### Task 1: Shared enums

**Files:**
- Create: `plugins/command-watchdog/hooks/watchdog_model.py`
- Test: `plugins/command-watchdog/tests/test_watchdog_model.py`

**Interfaces:**
- Produces: `KillReason`, `FiredCheck`, `Outcome`, `LoopKind` (`str`-mixin `Enum`s). Callers use `.value` when writing to SQLite, logs, or diagnostics.

- [ ] **Step 1: Write the failing test**

```python
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from watchdog_model import KillReason, FiredCheck, Outcome, LoopKind


class ModelTests(unittest.TestCase):
    def test_kill_reasons_match_code_names(self):
        self.assertEqual({r.value for r in KillReason},
                         {"idle", "poll-idle", "target-gone", "max-runtime", "orphaned"})

    def test_fired_checks(self):
        self.assertEqual({f.value for f in FiredCheck}, {"idle", "max_runtime", "poll_cap", "none"})

    def test_outcomes(self):
        self.assertEqual({o.value for o in Outcome}, {"success", "failed", "killed"})

    def test_loop_kinds(self):
        self.assertEqual({k.value for k in LoopKind}, {"none", "targeted", "untargeted"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_watchdog_model.py -v`
Expected: FAIL with `ModelNotFoundError`-style `ModuleNotFoundError: No module named 'watchdog_model'`.

- [ ] **Step 3: Write the minimal implementation**

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_watchdog_model.py -v`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/watchdog_model.py plugins/command-watchdog/tests/test_watchdog_model.py
git commit -m "feat(command-watchdog): add shared kill-reason and outcome enums"
```

---

### Task 2: Command identity and override lifting

**Files:**
- Create: `plugins/command-watchdog/hooks/command_identity.py`
- Test: `plugins/command-watchdog/tests/test_command_identity.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `lift_overrides(cmd: str) -> Tuple[Dict[str, str], List[str], str]` — returns `(overrides, rejected, remaining)`. `overrides` maps `idle`, `max_runtime`, `poll_cap` to raw strings. `rejected` lists lifted assignments whose value failed `^(-1|off|\d+)$`. `remaining` is the command without the lifted assignments; it is `""` when nothing else remains.
  - `primary_process(cmd: str) -> str` — `""` for an empty command.
  - `signature(cmd: str) -> str` — `""` for an empty command.
  - `SIGNATURE_PAIRS: FrozenSet[str]`, `VALUE_FLAGS: Dict[str, FrozenSet[str]]`.

- [ ] **Step 1: Write the failing test**

```python
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from command_identity import lift_overrides, primary_process, signature


class LiftTests(unittest.TestCase):
    def test_lifts_listed_key(self):
        self.assertEqual(lift_overrides("WATCHDOG_IDLE=600 npm test"), ({"idle": "600"}, [], "npm test"))

    def test_assignment_only_leaves_nothing(self):
        self.assertEqual(lift_overrides("WATCHDOG_IDLE=600"), ({"idle": "600"}, [], ""))

    def test_rejects_bad_value(self):
        self.assertEqual(lift_overrides("WATCHDOG_IDLE=abc npm test"), ({}, ["WATCHDOG_IDLE=abc"], "npm test"))

    def test_keeps_unlisted_watchdog_name(self):
        self.assertEqual(lift_overrides("WATCHDOG_NICE=off npm test"), ({}, [], "WATCHDOG_NICE=off npm test"))

    def test_accepts_negative_one_and_keeps_other_assignments(self):
        self.assertEqual(lift_overrides("WATCHDOG_MAX_RUNTIME=-1 FOO=1 make"),
                         ({"max_runtime": "-1"}, [], "FOO=1 make"))


class PrimaryTests(unittest.TestCase):
    def test_cases(self):
        cases = {
            "FOO=1 npm run build": "npm",
            "cd x && npm test": "npm",
            "bash -c 'npm test'": "npm",
            "bin/rspec spec": "rspec",
            "rtk hook claude": "rtk",
            "rtk git status": "git",
            "bundle exec rspec": "rspec",
            "timeout 5 make": "make",
            "": "",
        }
        for cmd, expected in cases.items():
            with self.subTest(cmd=cmd):
                self.assertEqual(primary_process(cmd), expected)


class SignatureTests(unittest.TestCase):
    def test_cases(self):
        cases = {
            "npm run build -- --watch": "npm run build",
            "git -C dir status": "git status",
            "npm run -s build -- --watch": "npm run build",
            "docker compose -f x.yml up": "docker compose up",
            "bin/rails test": "rails test",
            "git --git-dir=.git log": "git log",
            "rtk hook claude": "rtk hook",
            "npm test": "npm test",
            "make": "make",
            "npm run": "npm run",
        }
        for cmd, expected in cases.items():
            with self.subTest(cmd=cmd):
                self.assertEqual(signature(cmd), expected)

    def test_never_raises_on_malformed_input(self):
        for cmd in ['echo "unterminated', "echo $(date)", "a | b", "--", '"', "'", "cd", "&&", "  "]:
            with self.subTest(cmd=cmd):
                self.assertIsInstance(signature(cmd), str)
                self.assertIsInstance(primary_process(cmd), str)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_command_identity.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'command_identity'`.

- [ ] **Step 3: Write the minimal implementation**

```python
"""Command identity: lift per-run WATCHDOG_* overrides, primary process, and signature."""
import os
import re
import shlex
from typing import Dict, FrozenSet, List, Tuple

LIFTABLE = {"WATCHDOG_IDLE": "idle", "WATCHDOG_MAX_RUNTIME": "max_runtime", "WATCHDOG_POLL_CAP": "poll_cap"}
VALUE_RE = re.compile(r"\A(-1|off|\d+)\Z")
ASSIGN_RE = re.compile(r"\A\s*([A-Za-z_][A-Za-z0-9_]*)=(\S*)")
TOKEN_ASSIGN_RE = re.compile(r"\A[A-Za-z_][A-Za-z0-9_]*=")
CD_RE = re.compile(r"\A\s*cd\s+(?:'[^']*'|\"[^\"]*\"|\S+)\s*(?:&&|;)\s*")

SIGNATURE_PAIRS: FrozenSet[str] = frozenset({"npm run", "pnpm run", "bun run", "yarn run", "docker compose"})
VALUE_FLAGS: Dict[str, FrozenSet[str]] = {
    "git": frozenset({"-C", "-c", "--git-dir", "--work-tree"}),
    "docker": frozenset({"-H", "--context", "-c"}),
    "docker compose": frozenset({"-f", "--file", "-p", "--project-name", "--env-file"}),
    "npm": frozenset({"--prefix", "-w", "--workspace"}),
    "pnpm": frozenset({"--prefix", "-w", "--workspace"}),
    "yarn": frozenset({"--prefix", "-w", "--workspace"}),
}
MAX_DEPTH = 5


def lift_overrides(cmd: str) -> Tuple[Dict[str, str], List[str], str]:
    overrides: Dict[str, str] = {}
    rejected: List[str] = []
    kept: List[str] = []
    rest = cmd
    while True:
        match = ASSIGN_RE.match(rest)
        if not match:
            break
        name, value = match.group(1), match.group(2)
        token = match.group(0).strip()
        rest = rest[match.end():].lstrip()
        if name in LIFTABLE:
            if VALUE_RE.match(value):
                overrides[LIFTABLE[name]] = value
            else:
                rejected.append(token)
        else:
            kept.append(token)
            # Keep scanning: a later listed assignment still lifts.
            continue
    remaining = " ".join(kept + ([rest] if rest else [])).strip()
    return overrides, rejected, remaining


def _first_segment(cmd: str) -> str:
    quote = None
    for index, char in enumerate(cmd):
        if quote:
            if char == quote:
                quote = None
        elif char in "'\"":
            quote = char
        elif char in ";|&":
            return cmd[:index]
    return cmd


def _tokens(segment: str) -> List[str]:
    try:
        return shlex.split(segment)
    except ValueError:
        return segment.split()


def _unwrap(cmd: str, depth: int = 0) -> List[str]:
    if depth > MAX_DEPTH:
        return []
    cmd = CD_RE.sub("", cmd, count=1)
    tokens = _tokens(_first_segment(cmd))
    while tokens:
        t0 = os.path.basename(tokens[0])
        if TOKEN_ASSIGN_RE.match(tokens[0]):
            tokens = tokens[1:]
        elif t0 == "env":
            tokens = tokens[1:]
        elif t0 == "timeout":
            tokens = tokens[1:]
            while tokens and tokens[0].startswith("-"):
                tokens = tokens[1:]
            tokens = tokens[1:]
        elif (t0, tokens[1:2]) in {("bundle", ["exec"]), ("pnpm", ["exec"]), ("uv", ["run"]), ("poetry", ["run"])}:
            tokens = tokens[2:]
        elif t0 == "npx":
            tokens = tokens[1:]
        elif t0 == "rtk" and len(tokens) > 1 and tokens[1] != "hook":
            tokens = tokens[1:]
        elif t0 in ("bash", "sh") and tokens[1:2] == ["-c"] and len(tokens) >= 3:
            return _unwrap(tokens[2], depth + 1)
        else:
            return tokens
    return tokens


def primary_process(cmd: str) -> str:
    tokens = _unwrap(cmd)
    return os.path.basename(tokens[0]) if tokens else ""


def _flags_for(words: List[str]) -> FrozenSet[str]:
    return VALUE_FLAGS.get(" ".join(words), frozenset())


def signature(cmd: str) -> str:
    tokens = _unwrap(cmd)
    if not tokens:
        return ""
    first = os.path.basename(tokens[0])
    rest = tokens[1:]
    index = 0

    def next_positional(words: List[str]):
        nonlocal index
        flags = _flags_for(words)
        while index < len(rest):
            token = rest[index]
            index += 1
            if token == "--":
                return None
            if token.startswith("--") and "=" in token:
                continue
            if token.startswith("-"):
                if token in flags:
                    index += 1
                continue
            return token
        return None

    second = next_positional([first])
    if second is None:
        return first
    words = [first, second]
    if " ".join(words) in SIGNATURE_PAIRS:
        third = next_positional(words)
        if third is not None:
            words.append(third)
    return " ".join(words)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_command_identity.py -v`
Expected: PASS. If `npm run -s build -- --watch` fails, check that `-s` is skipped as a flag and `build` is taken as word 3.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/command_identity.py plugins/command-watchdog/tests/test_command_identity.py
git commit -m "feat(command-watchdog): add override lifting and command identity"
```

---

### Task 3: INI rules and resolution

**Files:**
- Create: `plugins/command-watchdog/hooks/watchdog_config.py`
- Create: `plugins/command-watchdog/hooks/watchdog-patterns.ini`
- Test: `plugins/command-watchdog/tests/test_watchdog_config.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `parse_value(key: str, raw: str)` → `int | bool | None`; raises `ValueError` on invalid input. `None` means off.
  - `load_rules(paths: Sequence[str]) -> Tuple[Rules, List[str]]` — second item is warnings.
  - `resolve(rules: Rules, signature: str, cmd: str, overrides: Dict[str, str]) -> Resolution`.
  - `Limits` (frozen dataclass): `idle: Optional[int]`, `max_runtime: Optional[int]`, `poll: int`, `poll_cap: Optional[int]`, `nice: bool`, `acceptable_kill_percent: int`.
  - `Resolution` (frozen dataclass): `limits: Limits`, `rule_key: str`, `ini_values: Dict[str, object]`, `overridden: bool`, `override_vars: Tuple[str, ...]`, `warnings: Tuple[str, ...]`.
  - `BUILTIN_GLOBAL`, `BUILTIN_COMMANDS`, `ENV_NAMES` (maps `idle`, `max_runtime`, `poll`, `poll_cap` to `WATCHDOG_*` names).

- [ ] **Step 1: Write the failing test**

```python
import os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from watchdog_config import load_rules, parse_value, resolve


def write(directory, name, text):
    path = os.path.join(directory, name)
    with open(path, "w") as handle:
        handle.write(text)
    return path


class ParseValueTests(unittest.TestCase):
    def test_disable_markers(self):
        self.assertIsNone(parse_value("idle", "-1"))
        self.assertIsNone(parse_value("idle", "off"))
        self.assertIsNone(parse_value("max_runtime", "0"))
        self.assertIsNone(parse_value("max_runtime", "off"))

    def test_invalid_values(self):
        for key, raw in [("idle", "0"), ("poll_cap", "0"), ("poll", "off"), ("poll", "-1"),
                         ("nice", "maybe"), ("acceptable_kill_percent", "0"), ("idle", "x")]:
            with self.subTest(key=key, raw=raw):
                with self.assertRaises(ValueError):
                    parse_value(key, raw)

    def test_nice_values(self):
        self.assertTrue(parse_value("nice", "on"))
        self.assertFalse(parse_value("nice", "off"))


class LoadAndResolveTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def test_builtin_defaults(self):
        rules, warnings = load_rules([])
        result = resolve(rules, "npm test", "npm test", {})
        self.assertEqual((result.limits.idle, result.limits.max_runtime, result.limits.poll,
                          result.limits.poll_cap, result.limits.nice), (90, None, 5, 1800, True))
        self.assertEqual(warnings, [])

    def test_rtk_builtin_cap_survives_global_off(self):
        path = write(self.dir.name, "a.ini", "[global]\nmax_runtime: off\n")
        rules, _ = load_rules([path])
        self.assertEqual(resolve(rules, "rtk hook", "rtk hook claude", {}).limits.max_runtime, 15)

    def test_longest_prefix_wins_and_is_word_bounded(self):
        path = write(self.dir.name, "a.ini",
                     "[command:git]\nidle: 120\n[command:git push]\nidle: 600\n")
        rules, _ = load_rules([path])
        self.assertEqual(resolve(rules, "git push origin", "git push origin", {}).limits.idle, 600)
        self.assertEqual(resolve(rules, "git status", "git status", {}).limits.idle, 120)
        self.assertEqual(resolve(rules, "gitk", "gitk", {}).limits.idle, 90)

    def test_rule_regex_beats_command(self):
        path = write(self.dir.name, "a.ini",
                     "[rule:shell-scripts]\nregex: \\.sh\\b\nidle: 300\n[command:bash]\nidle: 120\n")
        rules, _ = load_rules([path])
        result = resolve(rules, "bash scripts/run.sh", "bash scripts/run.sh", {})
        self.assertEqual(result.limits.idle, 300)
        self.assertEqual(result.rule_key, "rule:shell-scripts")

    def test_invalid_regex_skips_section_with_warning(self):
        path = write(self.dir.name, "a.ini", "[rule:bad]\nregex: (\nidle: 300\n")
        rules, warnings = load_rules([path])
        self.assertTrue(any("bad" in w for w in warnings))
        self.assertEqual(resolve(rules, "x", "x", {}).limits.idle, 90)

    def test_data_directory_overrides_per_key_and_keeps_plugin_values(self):
        plugin = write(self.dir.name, "plugin.ini", "[command:make]\nidle: 300\nmax_runtime: 900\n")
        data = write(self.dir.name, "data.ini", "[command:make]\nidle: 120\n")
        rules, _ = load_rules([plugin, data])
        result = resolve(rules, "make", "make", {})
        self.assertEqual((result.limits.idle, result.limits.max_runtime), (120, 900))

    def test_malformed_file_is_a_warning_not_an_error(self):
        path = write(self.dir.name, "a.ini", "[global\nidle 90\n")
        rules, warnings = load_rules([path])
        self.assertTrue(warnings)
        self.assertEqual(resolve(rules, "x", "x", {}).limits.idle, 90)

    def test_literal_percent_in_regex(self):
        path = write(self.dir.name, "a.ini", "[rule:pct]\nregex: 100%\nidle: 30\n")
        rules, warnings = load_rules([path])
        self.assertEqual(warnings, [])
        self.assertEqual(resolve(rules, "x", "run 100%", {}).limits.idle, 30)

    def test_environment_overrides_ini_and_reports_variable(self):
        path = write(self.dir.name, "a.ini", "[command:make]\nidle: 300\n")
        rules, _ = load_rules([path])
        result = resolve(rules, "make", "make", {"idle": "600"})
        self.assertEqual(result.limits.idle, 600)
        self.assertTrue(result.overridden)
        self.assertEqual(result.override_vars, ("WATCHDOG_IDLE",))

    def test_negative_one_override_disables_max_runtime(self):
        rules, _ = load_rules([])
        self.assertIsNone(resolve(rules, "make", "make", {"max_runtime": "-1"}).limits.max_runtime)

    def test_invalid_environment_value_is_ignored_with_warning(self):
        rules, _ = load_rules([])
        result = resolve(rules, "make", "make", {"idle": "0"})
        self.assertEqual(result.limits.idle, 90)
        self.assertTrue(result.warnings)

    def test_ini_values_exclude_environment(self):
        rules, _ = load_rules([])
        result = resolve(rules, "make", "make", {"idle": "600"})
        self.assertEqual(result.ini_values["idle"], 90)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_watchdog_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'watchdog_config'`.

- [ ] **Step 3: Write the minimal implementation**

```python
"""Rule file: INI loading, per-key merge, value parsing, and limit resolution."""
from __future__ import annotations

import configparser
import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

BUILTIN_GLOBAL: Dict[str, object] = {
    "idle": 90, "max_runtime": None, "poll": 5, "poll_cap": 1800,
    "nice": True, "acceptable_kill_percent": 25,
}
BUILTIN_COMMANDS: Dict[str, Dict[str, object]] = {"rtk": {"max_runtime": 15}}
KEYS = ("idle", "max_runtime", "poll", "poll_cap", "nice", "acceptable_kill_percent")
ENV_NAMES = {"idle": "WATCHDOG_IDLE", "max_runtime": "WATCHDOG_MAX_RUNTIME",
             "poll": "WATCHDOG_POLL", "poll_cap": "WATCHDOG_POLL_CAP"}
ENV_KEYS = ("idle", "max_runtime", "poll_cap", "poll")


@dataclass(frozen=True)
class Limits:
    idle: Optional[int]
    max_runtime: Optional[int]
    poll: int
    poll_cap: Optional[int]
    nice: bool
    acceptable_kill_percent: int


@dataclass(frozen=True)
class Resolution:
    limits: Limits
    rule_key: str
    ini_values: Dict[str, object]
    overridden: bool
    override_vars: Tuple[str, ...]
    warnings: Tuple[str, ...]


@dataclass
class Rules:
    global_values: Dict[str, object] = field(default_factory=dict)
    commands: Dict[str, Dict[str, object]] = field(default_factory=dict)
    rules: List[Tuple[str, "re.Pattern[str]", Dict[str, object]]] = field(default_factory=list)


def parse_value(key: str, raw: str):
    value = raw.strip().lower()
    if key == "nice":
        if value in ("on", "off"):
            return value == "on"
        raise ValueError("nice must be on or off")
    if key == "acceptable_kill_percent":
        number = int(value)
        if not 1 <= number <= 100:
            raise ValueError("acceptable_kill_percent must be 1..100")
        return number
    if key == "poll":
        number = int(value)
        if number <= 0:
            raise ValueError("poll must be a positive integer")
        return number
    if value in ("-1", "off"):
        return None
    number = int(value)
    if key == "max_runtime" and number == 0:
        return None
    if number <= 0:
        raise ValueError("{} must be positive, or -1/off".format(key))
    return number


def _merge_section(target: Dict[str, object], section: configparser.SectionProxy, warnings: List[str], label: str):
    for key, raw in section.items():
        if key == "regex":
            continue
        if key not in KEYS:
            warnings.append("{}: unknown key {}".format(label, key))
            continue
        try:
            target[key] = parse_value(key, raw)
        except ValueError as error:
            warnings.append("{}: {}".format(label, error))


def load_rules(paths: Sequence[str]) -> Tuple[Rules, List[str]]:
    rules = Rules()
    warnings: List[str] = []
    rule_index: Dict[str, int] = {}
    for path in paths:
        if not os.path.isfile(path):
            continue
        parser = configparser.ConfigParser(interpolation=None, strict=False)
        try:
            parser.read(path, encoding="utf-8")
        except (configparser.Error, UnicodeDecodeError) as error:
            warnings.append("{}: {}".format(path, error))
            continue
        for name in parser.sections():
            section = parser[name]
            if name == "global":
                _merge_section(rules.global_values, section, warnings, "[global]")
            elif name.startswith("command:"):
                prefix = name[len("command:"):].strip()
                values = rules.commands.setdefault(prefix, {})
                _merge_section(values, section, warnings, name)
            elif name.startswith("rule:"):
                rule_name = name[len("rule:"):].strip()
                regex_text = section.get("regex", "")
                try:
                    pattern = re.compile(regex_text)
                except re.error as error:
                    warnings.append("{}: invalid regex ({}); section skipped".format(name, error))
                    continue
                if rule_name in rule_index:
                    index = rule_index[rule_name]
                    old_name, _, values = rules.rules[index]
                    rules.rules[index] = (old_name, pattern, values)
                else:
                    values: Dict[str, object] = {}
                    rule_index[rule_name] = len(rules.rules)
                    rules.rules.append((rule_name, pattern, values))
                _merge_section(values, section, warnings, name)
            else:
                warnings.append("{}: unknown section".format(name))
    return rules, warnings


def _longest_command(table: Dict[str, Dict[str, object]], signature: str) -> Optional[str]:
    best = None
    for prefix in table:
        if signature == prefix or signature.startswith(prefix + " "):
            if best is None or len(prefix) > len(best):
                best = prefix
    return best


def resolve(rules: Rules, signature: str, cmd: str, overrides: Dict[str, str]) -> Resolution:
    warnings: List[str] = []
    layers: List[Tuple[str, Dict[str, object]]] = []
    rule_key = "global"

    for name, pattern, values in rules.rules:
        if pattern.search(cmd):
            layers.append(("rule:" + name, values))
            rule_key = "rule:" + name
            break

    command = _longest_command(rules.commands, signature)
    if command is not None:
        layers.append(("command:" + command, rules.commands[command]))
        if rule_key == "global":
            rule_key = "command:" + command

    builtin = _longest_command(BUILTIN_COMMANDS, signature)
    if builtin is not None:
        layers.append(("builtin:" + builtin, BUILTIN_COMMANDS[builtin]))
        if rule_key == "global":
            rule_key = "command:" + builtin

    layers.append(("global", rules.global_values))

    ini: Dict[str, object] = {}
    for _label, layer in layers:
        for key, value in layer.items():
            ini.setdefault(key, value)
    for key, value in BUILTIN_GLOBAL.items():
        ini.setdefault(key, value)

    effective = dict(ini)
    applied: List[str] = []
    for key in ENV_KEYS:
        if key not in overrides:
            continue
        try:
            effective[key] = parse_value(key, overrides[key])
            applied.append(ENV_NAMES[key])
        except ValueError as error:
            warnings.append("{}: {}".format(ENV_NAMES[key], error))

    limits = Limits(
        idle=effective["idle"], max_runtime=effective["max_runtime"], poll=effective["poll"],
        poll_cap=effective["poll_cap"], nice=effective["nice"],
        acceptable_kill_percent=effective["acceptable_kill_percent"],
    )
    return Resolution(limits=limits, rule_key=rule_key, ini_values=ini, overridden=bool(applied),
                      override_vars=tuple(applied), warnings=tuple(warnings))
```

Create `plugins/command-watchdog/hooks/watchdog-patterns.ini` by migrating the two active rules from `watchdog-patterns.txt`:

```ini
# Per-command limits. Values are seconds; -1 or off disables a check.
# Lookup: [rule:*] regex (first match), then the longest [command:*] prefix, then [global].
# Environment variables override these per run: WATCHDOG_IDLE, WATCHDOG_MAX_RUNTIME, WATCHDOG_POLL_CAP.

[global]
idle: 90
max_runtime: off
poll: 5
poll_cap: 1800
nice: on
acceptable_kill_percent: 25

[command:rtk]
max_runtime: 15

[rule:rspec]
regex: \A(?:\./)?(?:bin/rspec|bundle\s+exec\s+rspec|rspec)\b
idle: 90

[rule:shell-scripts]
regex: \.sh\b
idle: 300
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_watchdog_config.py -v`
Expected: PASS. Then check the shipped file loads without warnings:

Run: `/usr/bin/python3 -c "import sys; sys.path.insert(0,'plugins/command-watchdog/hooks'); from watchdog_config import load_rules; r,w=load_rules(['plugins/command-watchdog/hooks/watchdog-patterns.ini']); print(w)"`
Expected: `[]`

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/watchdog_config.py plugins/command-watchdog/hooks/watchdog-patterns.ini plugins/command-watchdog/tests/test_watchdog_config.py
git commit -m "feat(command-watchdog): add INI rule loading and limit resolution"
```

---

### Task 4: Store paths, schema, enable, gate

**Files:**
- Create: `plugins/command-watchdog/hooks/stats_store.py`
- Test: `plugins/command-watchdog/tests/test_stats_store.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SCHEMA_VERSION = 1`
  - `class StoreError(Exception)`
  - `store_dir(env: Mapping[str, str] = os.environ, platform: str = sys.platform) -> str`
  - `db_path(env=..., platform=...) -> str`
  - `is_enabled(path: Optional[str] = None) -> bool`
  - `check_schema(path: str) -> str` — `'ok'`, `'unknown-version'`, or `'corrupt'`.
  - `enable(path: Optional[str] = None) -> str` — creates the store if absent; returns the path. Raises `StoreError` if an existing file is not `'ok'`.
  - `connect(path: str, readonly: bool = False) -> sqlite3.Connection` — raises `sqlite3.OperationalError` when the file is missing in rw mode; never creates files.

- [ ] **Step 1: Write the failing test**

```python
import os, sqlite3, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import stats_store as ss


class PathTests(unittest.TestCase):
    def test_env_override_wins(self):
        self.assertEqual(ss.store_dir({"COMMAND_WATCHDOG_HOME": "/x"}, "darwin"), "/x")

    def test_platform_defaults(self):
        self.assertEqual(ss.store_dir({"HOME": "/h"}, "darwin"), "/h/Library/Application Support/command-watchdog")
        self.assertEqual(ss.store_dir({"HOME": "/h"}, "linux"), "/h/.local/share/command-watchdog")
        self.assertEqual(ss.store_dir({"XDG_DATA_HOME": "/d"}, "linux"), "/d/command-watchdog")
        self.assertEqual(ss.store_dir({"LOCALAPPDATA": "C:\\L"}, "win32"), "C:\\L\\command-watchdog")


class EnableTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "nested", "stats.db")

    def test_gate_no_file_no_create(self):
        self.assertFalse(ss.is_enabled(self.path))
        with self.assertRaises(sqlite3.OperationalError):
            ss.connect(self.path)
        self.assertFalse(os.path.exists(self.path))
        self.assertFalse(os.path.exists(os.path.dirname(self.path)))

    def test_enable_creates_schema_wal_and_is_idempotent(self):
        ss.enable(self.path)
        self.assertTrue(ss.is_enabled(self.path))
        self.assertEqual(ss.check_schema(self.path), "ok")
        conn = ss.connect(self.path)
        try:
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({"meta", "rule_versions", "invocations", "output_tail", "counters"} <= tables)
            self.assertEqual(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "1")
        finally:
            conn.close()
        ss.enable(self.path)  # idempotent, no error

    def test_corrupt_and_unknown_version_are_reported_not_overwritten(self):
        with open(self.path, "wb") as handle:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            handle.write(b"not a database")
        self.assertEqual(ss.check_schema(self.path), "corrupt")
        with self.assertRaises(ss.StoreError):
            ss.enable(self.path)
        with open(self.path, "rb") as handle:
            self.assertEqual(handle.read(), b"not a database")

    def test_readonly_connection_cannot_write(self):
        ss.enable(self.path)
        conn = ss.connect(self.path, readonly=True)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("INSERT INTO meta(key, value) VALUES ('x', 'y')")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_stats_store.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'stats_store'`.

- [ ] **Step 3: Write the minimal implementation**

```python
"""The only module that opens stats.db. Opt-in: a missing file means collection is off."""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from typing import Mapping, Optional

SCHEMA_VERSION = 1
BUSY_TIMEOUT_MS = 200

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE rule_versions (
  rule_key TEXT NOT NULL, version INTEGER NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (rule_key, version)
);

CREATE TABLE invocations (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
  command_line TEXT NOT NULL, primary_process TEXT NOT NULL, signature TEXT NOT NULL,
  loop_kind TEXT NOT NULL CHECK (loop_kind IN ('none','targeted','untargeted')),
  rule_key TEXT NOT NULL, rule_version INTEGER NOT NULL,
  env_overrides INTEGER NOT NULL, override_vars TEXT NOT NULL DEFAULT '',
  rtk_proxied INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failed','killed')),
  kill_reason TEXT CHECK (kill_reason IN ('idle','poll-idle','target-gone','max-runtime','orphaned')),
  fired_check TEXT NOT NULL CHECK (fired_check IN ('idle','max_runtime','poll_cap','none')),
  exit_code INTEGER,
  execution_time REAL NOT NULL, cpu_time REAL NOT NULL, max_silence REAL NOT NULL, no_output_time REAL NOT NULL,
  CHECK ((outcome = 'killed') = (kill_reason IS NOT NULL)),
  CHECK (
    (fired_check = 'idle' AND kill_reason IS NOT NULL AND kill_reason IN ('idle','poll-idle'))
    OR (fired_check = 'max_runtime' AND kill_reason IS NOT NULL AND kill_reason = 'max-runtime')
    OR (fired_check = 'poll_cap' AND kill_reason IS NOT NULL AND kill_reason = 'max-runtime' AND loop_kind = 'untargeted')
    OR (fired_check = 'none' AND (kill_reason IS NULL OR kill_reason IN ('target-gone','orphaned')))
  )
);

CREATE TABLE output_tail (
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL, ts TEXT NOT NULL, line TEXT NOT NULL,
  PRIMARY KEY (invocation_id, line_no)
);

CREATE TABLE counters (
  scope TEXT NOT NULL CHECK (scope IN ('global','primary_process','signature','rule','rule_override','kill_reason')),
  key TEXT NOT NULL,
  rule_version INTEGER NOT NULL DEFAULT 0,
  invocations INTEGER NOT NULL DEFAULT 0,
  successful INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  killed INTEGER NOT NULL DEFAULT 0,
  rtk_proxies INTEGER NOT NULL DEFAULT 0,
  killed_idle INTEGER NOT NULL DEFAULT 0,
  killed_max_runtime INTEGER NOT NULL DEFAULT 0,
  killed_poll_cap INTEGER NOT NULL DEFAULT 0,
  execution_sum REAL NOT NULL DEFAULT 0, cpu_sum REAL NOT NULL DEFAULT 0,
  max_silence_sum REAL NOT NULL DEFAULT 0, no_output_sum REAL NOT NULL DEFAULT 0,
  execution_max REAL NOT NULL DEFAULT 0, cpu_max REAL NOT NULL DEFAULT 0,
  max_silence_max REAL NOT NULL DEFAULT 0, no_output_max REAL NOT NULL DEFAULT 0,
  untargeted_successful INTEGER NOT NULL DEFAULT 0,
  untargeted_execution_max REAL NOT NULL DEFAULT 0,
  last_succeeded_at TEXT, last_killed_at TEXT,
  PRIMARY KEY (scope, key, rule_version)
);
"""


class StoreError(Exception):
    pass


def store_dir(env: Mapping[str, str] = os.environ, platform: str = sys.platform) -> str:
    override = env.get("COMMAND_WATCHDOG_HOME")
    if override:
        return override
    if platform == "darwin":
        return os.path.join(env["HOME"], "Library", "Application Support", "command-watchdog")
    if platform.startswith("win"):
        base = env.get("LOCALAPPDATA") or env.get("APPDATA")
        return os.path.join(base, "command-watchdog")
    base = env.get("XDG_DATA_HOME") or os.path.join(env["HOME"], ".local", "share")
    return os.path.join(base, "command-watchdog")


def db_path(env: Mapping[str, str] = os.environ, platform: str = sys.platform) -> str:
    return os.path.join(store_dir(env, platform), "stats.db")


def is_enabled(path: Optional[str] = None) -> bool:
    return os.path.isfile(path or db_path())


def connect(path: str, readonly: bool = False) -> sqlite3.Connection:
    mode = "ro" if readonly else "rw"
    conn = sqlite3.connect("file:{}?mode={}".format(path, mode), uri=True,
                           timeout=BUSY_TIMEOUT_MS / 1000.0, isolation_level=None)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout={}".format(BUSY_TIMEOUT_MS))
    return conn


def check_schema(path: str) -> str:
    try:
        conn = connect(path, readonly=True)
        try:
            row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return "corrupt"
    if row is None:
        return "corrupt"
    return "ok" if row[0] == str(SCHEMA_VERSION) else "unknown-version"


def enable(path: Optional[str] = None) -> str:
    target = path or db_path()
    if os.path.exists(target):
        status = check_schema(target)
        if status != "ok":
            raise StoreError("existing {} is {}; not overwritten".format(target, status))
        return target
    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    os.close(handle)
    try:
        conn = sqlite3.connect(temp, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(SCHEMA)
            conn.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
            conn.execute("INSERT INTO meta(key, value) VALUES ('last_prune', '')")
        finally:
            conn.close()
        os.replace(temp, target)
    except BaseException:
        if os.path.exists(temp):
            os.unlink(temp)
        raise
    return target
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_stats_store.py -v`
Expected: PASS. If `test_gate_no_file_no_create` fails because the directory was created, `connect` must not call `makedirs`; it does not, so check that the test is not calling `enable` first.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/stats_store.py plugins/command-watchdog/tests/test_stats_store.py
git commit -m "feat(command-watchdog): add opt-in stats store with schema and enable gate"
```

---

### Task 5: Record a run and update counters

**Files:**
- Modify: `plugins/command-watchdog/hooks/stats_store.py` (append)
- Test: `plugins/command-watchdog/tests/test_record_run.py`

**Interfaces:**
- Consumes: `connect`, `SCHEMA`, `StoreError` from Task 4.
- Produces:
  - `@dataclass RunRecord` with fields: `started_at: str`, `ended_at: str`, `command_line: str`, `primary_process: str`, `signature: str`, `loop_kind: str`, `rule_key: str`, `ini_values: Dict[str, object]`, `env_overrides: bool`, `override_vars: Tuple[str, ...]`, `rtk_proxied: bool`, `outcome: str`, `kill_reason: Optional[str]`, `fired_check: str`, `exit_code: Optional[int]`, `execution_time: float`, `cpu_time: float`, `max_silence: float`, `no_output_time: float`, `output_tail: Tuple[Tuple[str, str], ...] = ()`.
  - `record_run(path: str, rec: RunRecord, now: Optional[str] = None) -> None` — one `BEGIN IMMEDIATE` transaction. Raises on failure; the caller catches.

- [ ] **Step 1: Write the failing test**

```python
import json, os, sqlite3, sys, tempfile, threading, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import stats_store as ss
from stats_store import RunRecord


def rec(outcome="success", kill=None, fired="none", env=False, cfg=None, loop="none", tail=(), rule="global",
        exec_time=2.0, signature="npm test", rtk=False):
    return RunRecord(
        started_at="2026-10-14T10:00:00+00:00", ended_at="2026-10-14T10:00:02+00:00",
        command_line="npm test", primary_process="npm", signature=signature, loop_kind=loop,
        rule_key=rule, ini_values=cfg or {"idle": 90}, env_overrides=env,
        override_vars=("WATCHDOG_IDLE",) if env else (), rtk_proxied=rtk,
        outcome=outcome, kill_reason=kill, fired_check=fired, exit_code=0 if outcome == "success" else 1,
        execution_time=exec_time, cpu_time=1.0, max_silence=0.5, no_output_time=0.2,
        output_tail=tuple(tail),
    )


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "stats.db")
        ss.enable(self.path)

    def one(self, sql, args=()):
        conn = ss.connect(self.path, readonly=True)
        try:
            return conn.execute(sql, args).fetchone()
        finally:
            conn.close()

    def test_counters_and_detail(self):
        ss.record_run(self.path, rec(exec_time=2.0))
        ss.record_run(self.path, rec(exec_time=5.0))
        ss.record_run(self.path, rec(outcome="killed", kill="idle", fired="idle", exec_time=9.0))
        g = self.one("SELECT invocations, successful, killed, execution_max, execution_sum FROM counters "
                     "WHERE scope='global' AND key=''")
        self.assertEqual(g, (3, 2, 1, 5.0, 7.0))
        r = self.one("SELECT killed_idle, rule_version FROM counters WHERE scope='rule' AND key='global'")
        self.assertEqual(r, (1, 1))
        k = self.one("SELECT killed FROM counters WHERE scope='kill_reason' AND key='idle'")
        self.assertEqual(k, (1,))

    def test_rule_version_changes_only_on_change(self):
        ss.record_run(self.path, rec(cfg={"idle": 90}))
        ss.record_run(self.path, rec(cfg={"idle": 90}))
        ss.record_run(self.path, rec(cfg={"idle": 120}))
        self.assertEqual(self.one("SELECT COUNT(*) FROM rule_versions WHERE rule_key='global'"), (2,))
        self.assertEqual(self.one("SELECT MAX(version) FROM rule_versions WHERE rule_key='global'"), (2,))

    def test_overridden_run_creates_no_version_and_uses_override_scope(self):
        ss.record_run(self.path, rec(env=True))
        self.assertEqual(self.one("SELECT COUNT(*) FROM rule_versions"), (0,))
        self.assertEqual(self.one("SELECT invocations FROM counters WHERE scope='rule_override' AND key='global'"), (1,))
        self.assertIsNone(self.one("SELECT 1 FROM counters WHERE scope='rule' AND key='global'"))
        self.assertEqual(self.one("SELECT override_vars FROM invocations"), ("WATCHDOG_IDLE",))

    def test_output_tail_only_for_killed_runs_and_capped(self):
        tail = [("2026-10-14T10:00:0{}+00:00".format(i % 10), "x" * 5000) for i in range(25)]
        ss.record_run(self.path, rec(outcome="success", tail=tail))
        ss.record_run(self.path, rec(outcome="killed", kill="idle", fired="idle", tail=tail))
        conn = ss.connect(self.path, readonly=True)
        try:
            rows = conn.execute("SELECT invocation_id, COUNT(*), MAX(LENGTH(line)) FROM output_tail "
                                "GROUP BY invocation_id").fetchall()
        finally:
            conn.close()
        self.assertEqual(rows, [(2, 20, 4096)])

    def test_failed_write_rolls_back_everything(self):
        original = ss._bump
        calls = {"n": 0}

        def boom(conn, scope, key, version, record):
            calls["n"] += 1
            if calls["n"] == 2:
                raise sqlite3.OperationalError("disk full")
            return original(conn, scope, key, version, record)

        ss._bump = boom
        try:
            with self.assertRaises(sqlite3.OperationalError):
                ss.record_run(self.path, rec())
        finally:
            ss._bump = original
        self.assertEqual(self.one("SELECT COUNT(*) FROM invocations"), (0,))
        self.assertEqual(self.one("SELECT COUNT(*) FROM counters"), (0,))

    def test_racing_writers_create_one_version(self):
        errors = []

        def worker():
            try:
                ss.record_run(self.path, rec(cfg={"idle": 77}))
            except Exception as error:  # pragma: no cover - reported below
                errors.append(error)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.one("SELECT COUNT(*) FROM rule_versions WHERE rule_key='global'"), (1,))

    def test_missing_store_is_not_created(self):
        other = os.path.join(self.dir.name, "absent", "stats.db")
        with self.assertRaises(sqlite3.OperationalError):
            ss.record_run(other, rec())
        self.assertFalse(os.path.exists(other))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_record_run.py -v`
Expected: FAIL with `AttributeError: module 'stats_store' has no attribute 'RunRecord'`.

- [ ] **Step 3: Write the minimal implementation**

Append to `plugins/command-watchdog/hooks/stats_store.py`:

```python
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Tuple

LINE_LIMIT = 4096
TAIL_LIMIT = 20


@dataclass
class RunRecord:
    started_at: str
    ended_at: str
    command_line: str
    primary_process: str
    signature: str
    loop_kind: str
    rule_key: str
    ini_values: Dict[str, object]
    env_overrides: bool
    override_vars: Tuple[str, ...]
    rtk_proxied: bool
    outcome: str
    kill_reason: Optional[str]
    fired_check: str
    exit_code: Optional[int]
    execution_time: float
    cpu_time: float
    max_silence: float
    no_output_time: float
    output_tail: Tuple[Tuple[str, str], ...] = ()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _rule_version(conn, rule_key: str, ini_values: Dict[str, object], now: str) -> int:
    config_json = json.dumps(ini_values, sort_keys=True)
    latest = conn.execute(
        "SELECT version, config_json FROM rule_versions WHERE rule_key=? ORDER BY version DESC LIMIT 1",
        (rule_key,)).fetchone()
    if latest is not None and latest[1] == config_json:
        return latest[0]
    conn.execute(
        "INSERT OR IGNORE INTO rule_versions(rule_key, version, config_json, created_at) "
        "VALUES (?, COALESCE((SELECT MAX(version) FROM rule_versions WHERE rule_key=?), 0) + 1, ?, ?)",
        (rule_key, rule_key, config_json, now))
    row = conn.execute(
        "SELECT version FROM rule_versions WHERE rule_key=? AND config_json=? ORDER BY version DESC LIMIT 1",
        (rule_key, config_json)).fetchone()
    return row[0]


def _bump(conn, scope: str, key: str, version: int, rec: RunRecord) -> None:
    ok = rec.outcome == "success"
    killed = rec.outcome == "killed"
    fired = rec.fired_check if killed else "none"
    success_values = {
        "execution": rec.execution_time if ok else 0.0,
        "cpu": rec.cpu_time if ok else 0.0,
        "max_silence": rec.max_silence if ok else 0.0,
        "no_output": rec.no_output_time if ok else 0.0,
    }
    untargeted = ok and rec.loop_kind == "untargeted"
    conn.execute(
        "INSERT INTO counters (scope, key, rule_version, invocations, successful, failed, killed, rtk_proxies, "
        "killed_idle, killed_max_runtime, killed_poll_cap, execution_sum, cpu_sum, max_silence_sum, no_output_sum, "
        "execution_max, cpu_max, max_silence_max, no_output_max, untargeted_successful, "
        "untargeted_execution_max, last_succeeded_at, last_killed_at) "
        "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(scope, key, rule_version) DO UPDATE SET "
        "invocations = invocations + 1, successful = successful + excluded.successful, "
        "failed = failed + excluded.failed, killed = killed + excluded.killed, "
        "rtk_proxies = rtk_proxies + excluded.rtk_proxies, "
        "killed_idle = killed_idle + excluded.killed_idle, "
        "killed_max_runtime = killed_max_runtime + excluded.killed_max_runtime, "
        "killed_poll_cap = killed_poll_cap + excluded.killed_poll_cap, "
        "execution_sum = execution_sum + excluded.execution_sum, cpu_sum = cpu_sum + excluded.cpu_sum, "
        "max_silence_sum = max_silence_sum + excluded.max_silence_sum, "
        "no_output_sum = no_output_sum + excluded.no_output_sum, "
        "execution_max = MAX(execution_max, excluded.execution_max), cpu_max = MAX(cpu_max, excluded.cpu_max), "
        "max_silence_max = MAX(max_silence_max, excluded.max_silence_max), "
        "no_output_max = MAX(no_output_max, excluded.no_output_max), "
        "untargeted_successful = untargeted_successful + excluded.untargeted_successful, "
        "untargeted_execution_max = MAX(untargeted_execution_max, excluded.untargeted_execution_max), "
        "last_succeeded_at = COALESCE(excluded.last_succeeded_at, last_succeeded_at), "
        "last_killed_at = COALESCE(excluded.last_killed_at, last_killed_at)",
        (scope, key, version,
         int(ok), int(rec.outcome == "failed"), int(killed), int(rec.rtk_proxied),
         int(fired == "idle"), int(fired == "max_runtime"), int(fired == "poll_cap"),
         success_values["execution"], success_values["cpu"], success_values["max_silence"], success_values["no_output"],
         success_values["execution"], success_values["cpu"], success_values["max_silence"], success_values["no_output"],
         int(untargeted), rec.execution_time if untargeted else 0.0,
         rec.ended_at if ok else None, rec.ended_at if killed else None))


def record_run(path: str, rec: RunRecord, now: Optional[str] = None) -> None:
    stamp = now or _now()
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            version = 0
            if not rec.env_overrides:
                version = _rule_version(conn, rec.rule_key, rec.ini_values, stamp)
            cursor = conn.execute(
                "INSERT INTO invocations (started_at, ended_at, command_line, primary_process, signature, loop_kind, "
                "rule_key, rule_version, env_overrides, override_vars, rtk_proxied, outcome, kill_reason, fired_check, "
                "exit_code, execution_time, cpu_time, max_silence, no_output_time) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (rec.started_at, rec.ended_at, rec.command_line, rec.primary_process, rec.signature, rec.loop_kind,
                 rec.rule_key, version, int(rec.env_overrides), ",".join(rec.override_vars), int(rec.rtk_proxied),
                 rec.outcome, rec.kill_reason, rec.fired_check, rec.exit_code, rec.execution_time, rec.cpu_time,
                 rec.max_silence, rec.no_output_time))
            if rec.outcome == "killed":
                for number, (ts, line) in enumerate(rec.output_tail[-TAIL_LIMIT:], start=1):
                    conn.execute("INSERT INTO output_tail(invocation_id, line_no, ts, line) VALUES (?,?,?,?)",
                                 (cursor.lastrowid, number, ts, line[:LINE_LIMIT]))
            _bump(conn, "global", "", 0, rec)
            _bump(conn, "primary_process", rec.primary_process, 0, rec)
            _bump(conn, "signature", rec.signature, 0, rec)
            if rec.env_overrides:
                _bump(conn, "rule_override", rec.rule_key, 0, rec)
            else:
                _bump(conn, "rule", rec.rule_key, version, rec)
            if rec.outcome == "killed":
                _bump(conn, "kill_reason", rec.kill_reason, 0, rec)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
```

Note: the `_bump` for scope `kill_reason` uses `key = rec.kill_reason`, so `_bump` is called with the reason as key. The call above passes `rec.kill_reason` as the key argument. The pruning call is added in Task 6.

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_record_run.py -v`
Expected: PASS. If `test_failed_write_rolls_back_everything` fails, check that `record_run` looks up `_bump` through the module global at call time (it does, because the call is `_bump(...)` inside the function).

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/stats_store.py plugins/command-watchdog/tests/test_record_run.py
git commit -m "feat(command-watchdog): record runs and counters in one transaction"
```

---

### Task 6: Prune, reset, and delete

**Files:**
- Modify: `plugins/command-watchdog/hooks/stats_store.py` (append and wire pruning into `record_run`)
- Test: `plugins/command-watchdog/tests/test_prune_reset.py`

**Interfaces:**
- Consumes: `record_run`, `connect` from Tasks 4–5.
- Produces:
  - `maybe_prune(conn, now: str) -> bool` — deletes invocations older than 30 days at most once per 24 h, gated on `meta.last_prune`.
  - `reset(path: str, now: Optional[str] = None) -> str` — backs up to `stats-backup-YYYYMMDD-HHMMSS.db` beside the store, then clears detail, counters, and versions. Returns the backup path.
  - `delete_all(path: str) -> List[str]` — removes `stats.db`, `-wal`, `-shm`, and every `stats-backup-*.db`. Returns the removed paths.

- [ ] **Step 1: Write the failing test**

```python
import glob, os, sqlite3, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import stats_store as ss
from stats_store import RunRecord


def rec(ended, signature="npm test", outcome="success"):
    return RunRecord(started_at=ended, ended_at=ended, command_line="npm test", primary_process="npm",
                     signature=signature, loop_kind="none", rule_key="global", ini_values={"idle": 90},
                     env_overrides=False, override_vars=(), rtk_proxied=False, outcome=outcome,
                     kill_reason=None, fired_check="none", exit_code=0, execution_time=1.0, cpu_time=0.5,
                     max_silence=0.2, no_output_time=0.1)


class PruneTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "stats.db")
        ss.enable(self.path)

    def count(self, sql):
        conn = ss.connect(self.path, readonly=True)
        try:
            return conn.execute(sql).fetchone()[0]
        finally:
            conn.close()

    def test_prune_removes_old_detail_keeps_counters_and_is_gated(self):
        ss.record_run(self.path, rec("2026-08-01T00:00:00+00:00"), now="2026-08-01T00:00:00+00:00")
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00"), now="2026-10-14T00:00:00+00:00")
        self.assertEqual(self.count("SELECT COUNT(*) FROM invocations"), 1)
        self.assertEqual(self.count("SELECT invocations FROM counters WHERE scope='global'"), 2)
        conn = ss.connect(self.path)
        try:
            self.assertFalse(ss.maybe_prune(conn, "2026-10-14T06:00:00+00:00"))
        finally:
            conn.close()

    def test_rtk_hook_never_prunes(self):
        ss.record_run(self.path, rec("2026-08-01T00:00:00+00:00"), now="2026-08-01T00:00:00+00:00")
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00", signature="rtk hook"),
                      now="2026-10-14T00:00:00+00:00")
        self.assertEqual(self.count("SELECT COUNT(*) FROM invocations WHERE signature='npm test'"), 1)

    def test_reset_backs_up_then_clears_and_keeps_file(self):
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00"))
        backup = ss.reset(self.path, now="2026-10-14T09:08:07+00:00")
        self.assertTrue(os.path.basename(backup).startswith("stats-backup-"))
        self.assertTrue(os.path.exists(self.path))
        self.assertEqual(self.count("SELECT COUNT(*) FROM invocations"), 0)
        self.assertEqual(self.count("SELECT COUNT(*) FROM counters"), 0)
        backup_conn = sqlite3.connect(backup)
        try:
            self.assertEqual(backup_conn.execute("SELECT COUNT(*) FROM invocations").fetchone()[0], 1)
        finally:
            backup_conn.close()

    def test_delete_all_removes_store_and_backups_but_not_ini(self):
        ini = os.path.join(self.dir.name, "watchdog-patterns.ini")
        with open(ini, "w") as handle:
            handle.write("[global]\n")
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00"))
        ss.reset(self.path, now="2026-10-14T09:08:07+00:00")
        removed = ss.delete_all(self.path)
        self.assertFalse(os.path.exists(self.path))
        self.assertEqual(glob.glob(os.path.join(self.dir.name, "stats-backup-*.db")), [])
        self.assertTrue(os.path.exists(ini))
        self.assertTrue(removed)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_prune_reset.py -v`
Expected: FAIL with `AttributeError: module 'stats_store' has no attribute 'maybe_prune'`.

- [ ] **Step 3: Write the minimal implementation**

Append to `plugins/command-watchdog/hooks/stats_store.py`:

```python
import glob
from datetime import timedelta
from typing import List

RETENTION_DAYS = 30
PRUNE_INTERVAL_HOURS = 24


def _meta_get(conn, key: str) -> Optional[str]:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def _meta_set(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def maybe_prune(conn, now: str) -> bool:
    current = datetime.fromisoformat(now)
    last = _meta_get(conn, "last_prune")
    if last:
        if current - datetime.fromisoformat(last) < timedelta(hours=PRUNE_INTERVAL_HOURS):
            return False
    cutoff = (current - timedelta(days=RETENTION_DAYS)).isoformat(timespec="seconds")
    conn.execute("DELETE FROM invocations WHERE ended_at < ?", (cutoff,))
    _meta_set(conn, "last_prune", now)
    return True


def reset(path: str, now: Optional[str] = None) -> str:
    stamp = datetime.fromisoformat(now or _now())
    backup = os.path.join(os.path.dirname(path), "stats-backup-" + stamp.strftime("%Y%m%d-%H%M%S") + ".db")
    source = connect(path, readonly=True)
    target = sqlite3.connect(backup)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        for table in ("output_tail", "invocations", "counters", "rule_versions"):
            conn.execute("DELETE FROM " + table)
        _meta_set(conn, "last_prune", "")
        conn.execute("COMMIT")
    finally:
        conn.close()
    return backup


def delete_all(path: str) -> List[str]:
    candidates = [path, path + "-wal", path + "-shm"]
    candidates += glob.glob(os.path.join(os.path.dirname(path), "stats-backup-*.db"))
    removed: List[str] = []
    for candidate in candidates:
        if os.path.exists(candidate):
            os.unlink(candidate)
            removed.append(candidate)
    return removed
```

Wire pruning into `record_run`. In `record_run`, after `_bump(conn, ...)` calls and before `conn.execute("COMMIT")`, add:

```python
            if not rec.signature.startswith("rtk hook"):
                maybe_prune(conn, stamp)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_prune_reset.py plugins/command-watchdog/tests/test_record_run.py plugins/command-watchdog/tests/test_stats_store.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/stats_store.py plugins/command-watchdog/tests/test_prune_reset.py
git commit -m "feat(command-watchdog): add gated pruning, reset with backup, and delete"
```

---

### Task 7a: Hook argument parsing, per-run limits, nice, and fired check

**Files:**
- Modify: `plugins/command-watchdog/hooks/command-watchdog.py`
- Modify: `plugins/command-watchdog/tests/test_nice.py`
- Test: `plugins/command-watchdog/tests/test_limits.py`

**Interfaces:**
- Consumes: `lift_overrides`, `primary_process`, `signature` (Task 2); `load_rules`, `resolve`, `Limits` (Task 3); `KillReason`, `FiredCheck`, `LoopKind` (Task 1); `stats_store.db_path`, `store_dir` (Task 4).
- Produces (module level in `command-watchdog.py`): `parse_args(argv) -> (dict, str)`, `apply_limits(limits: Limits) -> None`, `rule_paths() -> List[str]`, and a `RunState` class (fields used by Tasks 7b and 7c: `original`, `signature`, `primary`, `rule_key`, `ini_values`, `overridden`, `override_vars`, `rtk_proxied`, `loop_kind`, `fired`, `kill_reason`, `killed`, `cancelled`, `launch_failed`, `exit_code`, `max_silence`, `cpu_time`, `start`, `tail`, `recorded`).

- [ ] **Step 1: Write the failing test**

Create `plugins/command-watchdog/tests/test_limits.py`:

```python
import os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHDOG = os.path.join(HERE, "..", "hooks", "command-watchdog.py")
ENV = dict(os.environ, WATCHDOG_POLL="1")


def run_watchdog(args, env=None, timeout=30):
    return subprocess.run(["/usr/bin/python3", WATCHDOG] + args, capture_output=True, text=True,
                          env=env or ENV, timeout=timeout)


class LimitTests(unittest.TestCase):
    def test_set_idle_triggers_kill_then_off_does_not(self):
        killed = run_watchdog(["--set", "idle=2", "--", "sh", "-c", "sleep 30"])
        self.assertEqual(killed.returncode, 124)
        self.assertIn("HANG DETECTED (idle)", killed.stdout + killed.stderr)
        survived = run_watchdog(["--set", "idle=off", "--", "sh", "-c", "sleep 4; echo done"])
        self.assertEqual(survived.returncode, 0)
        self.assertIn("done", survived.stdout)

    def test_invalid_set_value_falls_through_to_default(self):
        result = run_watchdog(["--set", "idle=0", "--", "echo", "ok"])
        self.assertEqual(result.returncode, 0)
        self.assertIn("ok", result.stdout)

    def test_no_command_is_usage_error(self):
        self.assertEqual(run_watchdog(["--original", "x", "--"]).returncode, 2)

    def test_nice_off_keeps_inherited_priority(self):
        with tempfile.TemporaryDirectory() as home:
            with open(os.path.join(home, "watchdog-patterns.ini"), "w") as handle:
                handle.write("[command:python3]\nnice: off\n")
            env = dict(ENV, COMMAND_WATCHDOG_HOME=home)
            probe = "/usr/bin/python3 -c 'import os; print(os.getpriority(os.PRIO_PROCESS, 0))'"

            def setup():
                os.setpriority(os.PRIO_PROCESS, 0, 5)

            result = subprocess.run(["/usr/bin/python3", WATCHDOG, probe], capture_output=True, text=True,
                                    env=env, timeout=30, preexec_fn=setup)
            self.assertEqual(result.stdout.split(), ["5"])


if __name__ == "__main__":
    unittest.main()
```

Update `plugins/command-watchdog/tests/test_nice.py`: keep `test_environment_cannot_raise_task_priority` (it still holds, because `WATCHDOG_NICE` is ignored). Add this method to `NiceTests`:

```python
    def test_nice_off_in_ini_is_not_a_priority_refusal(self):
        import tempfile as _tf
        with _tf.TemporaryDirectory() as home:
            with open(os.path.join(home, "watchdog-patterns.ini"), "w") as handle:
                handle.write("[command:python3]\nnice: off\n")
            env = dict(os.environ, COMMAND_WATCHDOG_HOME=home)
            r = subprocess.run(["/usr/bin/python3", WATCHDOG, PROBE], capture_output=True, text=True,
                               env=env, timeout=30)
            self.assertEqual(r.returncode, 0)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_limits.py -v`
Expected: FAIL. `--set` is treated as part of the command, so `test_set_idle_triggers_kill_then_off_does_not` fails with the wrong return code.

- [ ] **Step 3: Write the minimal implementation**

In `plugins/command-watchdog/hooks/command-watchdog.py`:

1. Add after the existing imports (before the module constants at line 116):

```python
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from command_identity import lift_overrides, primary_process, signature  # noqa: E402
from watchdog_config import Limits, load_rules, resolve  # noqa: E402
from watchdog_model import FiredCheck, KillReason, LoopKind  # noqa: E402
import stats_store  # noqa: E402
```

2. Keep the environment-read constants at lines 116–119 as import-time defaults. Add directly below `NICE = ...`:

```python
NICE_ENABLED = True
```

3. Add these functions above `def main()`:

```python
def parse_args(argv):
    opts = {"original": None, "rtk_proxied": False, "set": []}
    args = list(argv)
    try:
        while args and args[0] in ("--original", "--rtk-proxied", "--set"):
            flag = args.pop(0)
            if flag == "--rtk-proxied":
                opts["rtk_proxied"] = True
            elif flag == "--original":
                opts["original"] = args.pop(0)
            else:
                opts["set"].append(args.pop(0))
    except IndexError:
        return None, ""
    if args and args[0] == "--":
        args.pop(0)
    return opts, " ".join(args).strip()


def rule_paths():
    plugin_rules = os.path.join(HERE, "watchdog-patterns.ini")
    data_rules = os.path.join(stats_store.store_dir(), "watchdog-patterns.ini")
    return [plugin_rules, data_rules]


def apply_limits(limits):
    global IDLE_LIMIT, MAX_RUNTIME, POLL, POLL_CAP, NICE_ENABLED, TARGET_GONE_GRACE
    IDLE_LIMIT = limits.idle
    MAX_RUNTIME = limits.max_runtime or 0
    POLL = limits.poll
    POLL_CAP = limits.poll_cap or 0
    NICE_ENABLED = limits.nice
    TARGET_GONE_GRACE = 3 * POLL


class RunState:
    def __init__(self, cmd, original, rtk_proxied):
        self.cmd = cmd
        self.original = original
        self.signature = signature(cmd)
        self.primary = primary_process(cmd)
        self.rtk_proxied = rtk_proxied
        self.start = time.time()
        self.rule_key = "global"
        self.ini_values = {}
        self.overridden = False
        self.override_vars = ()
        self.loop_kind = LoopKind.NONE
        self.fired = FiredCheck.NONE
        self.kill_reason = None
        self.killed = False
        self.cancelled = None
        self.launch_failed = False
        self.exit_code = None
        self.max_silence = 0.0
        self.cpu_time = 0.0
        self.tail = []
        self.recorded = False
```

4. In `main()`, replace the first lines (`cmd = " ".join(sys.argv[1:]).strip()` and the `if not cmd:` block) with:

```python
    opts, cmd = parse_args(sys.argv[1:])
    if opts is None or not cmd:
        print("command-watchdog: no command given", file=sys.stderr)
        return 2
    overrides = {}
    for item in opts["set"]:
        key, _, value = item.partition("=")
        if key:
            overrides[key] = value
    for env_name, key in (("WATCHDOG_IDLE", "idle"), ("WATCHDOG_MAX_RUNTIME", "max_runtime"),
                          ("WATCHDOG_POLL_CAP", "poll_cap"), ("WATCHDOG_POLL", "poll")):
        if env_name in os.environ and key not in overrides:
            overrides[key] = os.environ[env_name]
    rules, warnings = load_rules(rule_paths())
    original = opts["original"] if opts["original"] is not None else cmd
    resolution = resolve(rules, signature(cmd), original, overrides)
    apply_limits(resolution.limits)
    run = RunState(cmd, original, opts["rtk_proxied"])
    run.rule_key = resolution.rule_key
    run.ini_values = resolution.ini_values
    run.overridden = resolution.overridden
    run.override_vars = resolution.override_vars
    for warning in list(warnings) + list(resolution.warnings):
        debug_log({"stage": "config-warning", "message": warning})
```

Add a `run = RunState` reference only; recording is added in Task 7c. Remove the `cw.main` dependency on `command` naming inside the remainder of `main()`: keep using `cmd` as before.

5. In `child_setup()` (around line 609), guard the priority call:

```python
    if NICE_ENABLED:
        os.setpriority(os.PRIO_PROCESS, 0, NICE)
```

6. In `supervise()`, guard the idle comparison and set the fired check. Replace the block that computes `reason` (around lines 871–879) with:

```python
        detail = ""
        fired = FiredCheck.NONE
        if os.getppid() != PARENT_PID:
            reason = KillReason.ORPHANED
        elif max_runtime and (now - start_time) >= max_runtime:
            reason = KillReason.MAX_RUNTIME
            fired = FiredCheck.MAX_RUNTIME if MAX_RUNTIME else FiredCheck.POLL_CAP
            detail = str(max_runtime)
        elif target_gone:
            reason = KillReason.TARGET_GONE
            detail = tracker.describe() if tracker else ""
        elif IDLE_LIMIT is not None and idle >= IDLE_LIMIT:
            reason = KillReason.POLL_IDLE if targeted else KillReason.IDLE
            fired = FiredCheck.IDLE
            detail = tracker.describe() if targeted else ""
        else:
            continue
        CURRENT_RUN.fired = fired
        CURRENT_RUN.kill_reason = reason
```

`CURRENT_RUN` is a module-level reference set in `main()` right after `run = RunState(...)`: `global CURRENT_RUN; CURRENT_RUN = run`. Declare `CURRENT_RUN = None` near the constants.

Then change `dump_diagnostics(pgid, busiest, reason, detail, ...)` to `dump_diagnostics(pgid, busiest, reason.value, detail, ...)`. Change the `kill_group` call site unchanged. Change the `debug_log` in `dump_diagnostics` if it formats the enum (it receives a string now).

7. Also replace `IDLE_LIMIT` references in messages with the same value (they accept `None`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_limits.py plugins/command-watchdog/tests/test_nice.py -v`
Expected: PASS. Then run the existing suites to catch regressions:

Run: `/usr/bin/python3 -m unittest discover -s plugins/command-watchdog/tests -v`
Expected: PASS. If `test_hook.py` fails because `watchdog-patterns.txt` is missing, that is expected until Task 8; note the failing tests and continue.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/command-watchdog.py plugins/command-watchdog/tests/test_limits.py plugins/command-watchdog/tests/test_nice.py
git commit -m "feat(command-watchdog): per-run limits, nice on/off, and fired check"
```

---

### Task 7b: Max silence and output tail

**Files:**
- Create: `plugins/command-watchdog/hooks/output_tail.py`
- Modify: `plugins/command-watchdog/hooks/command-watchdog.py`
- Test: `plugins/command-watchdog/tests/test_output_tail.py`

**Interfaces:**
- Consumes: `RunState` from Task 7a.
- Produces: `class OutputTail` with `feed(chunk: bytes, now: float) -> None`, `flush(now: float) -> None`, `lines() -> List[Tuple[str, str]]`, where each entry is `(iso_timestamp_utc, line_text)`. Keeps the last 20 complete lines, each truncated to 4096 characters.

- [ ] **Step 1: Write the failing test**

```python
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from output_tail import OutputTail


class OutputTailTests(unittest.TestCase):
    def test_splits_lines_across_chunks(self):
        tail = OutputTail()
        tail.feed(b"ab", 0)
        tail.feed(b"c\nde", 1)
        tail.feed(b"f\n", 2)
        self.assertEqual([line for _, line in tail.lines()], ["abc", "def"])

    def test_keeps_last_twenty(self):
        tail = OutputTail()
        for i in range(25):
            tail.feed("line{}\n".format(i).encode(), i)
        lines = [line for _, line in tail.lines()]
        self.assertEqual(len(lines), 20)
        self.assertEqual(lines[0], "line5")
        self.assertEqual(lines[-1], "line24")

    def test_truncates_long_lines_and_flushes_partial(self):
        tail = OutputTail()
        tail.feed(b"x" * 5000, 0)
        tail.flush(1)
        lines = tail.lines()
        self.assertEqual(len(lines[0][1]), 4096)

    def test_invalid_bytes_do_not_raise(self):
        tail = OutputTail()
        tail.feed(b"\xff\xfe bad\n", 0)
        self.assertIn("bad", tail.lines()[0][1])

    def test_timestamps_are_utc_iso(self):
        tail = OutputTail()
        tail.feed(b"hi\n", 0)
        self.assertTrue(tail.lines()[0][0].startswith("1970-01-01T00:00:00"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_output_tail.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'output_tail'`.

- [ ] **Step 3: Write the minimal implementation**

Create `plugins/command-watchdog/hooks/output_tail.py`:

```python
"""Bounded tail of a command's output: last 20 complete lines with UTC timestamps."""
from collections import deque
from datetime import datetime, timezone
from typing import Deque, List, Tuple

LINE_LIMIT = 4096
TAIL_LIMIT = 20


class OutputTail:
    def __init__(self):
        self._partial = b""
        self._lines: Deque[Tuple[str, str]] = deque(maxlen=TAIL_LIMIT)

    @staticmethod
    def _stamp(now: float) -> str:
        return datetime.fromtimestamp(now, tz=timezone.utc).isoformat(timespec="seconds")

    def _emit(self, raw: bytes, now: float) -> None:
        text = raw.decode("utf-8", errors="replace")[:LINE_LIMIT]
        self._lines.append((self._stamp(now), text))

    def feed(self, chunk: bytes, now: float) -> None:
        data = self._partial + chunk
        parts = data.split(b"\n")
        self._partial = parts.pop()
        for part in parts:
            self._emit(part, now)

    def flush(self, now: float) -> None:
        if self._partial:
            self._emit(self._partial, now)
            self._partial = b""

    def lines(self) -> List[Tuple[str, str]]:
        return list(self._lines)
```

In `command-watchdog.py`:

1. Import: `from output_tail import OutputTail` next to the other local imports.
2. In `RunState.__init__`, replace `self.tail = []` with `self.tail = OutputTail()`.
3. In `supervise()`, replace every assignment `state["last_activity"] = now` (and `state["last_activity"] = time.time()`) with a call to a helper that tracks the longest gap. Define inside `supervise()` after `state = {...}`:

```python
    def touch(now):
        # Caller holds `lock`. Track the longest silent span before this event.
        gap = now - state["last_activity"]
        if gap > CURRENT_RUN.max_silence:
            CURRENT_RUN.max_silence = gap
        state["last_activity"] = now
```

Replace the three call sites:
- In `reader()`: `with lock: touch(time.time())`, and also feed the tail before it: `CURRENT_RUN.tail.feed(chunk, time.time())` placed right after `os.write(1, chunk)`.
- In the poll loop (CPU progress, previously line 858/864): `with lock: touch(now)`.
- Keep `state["last_activity"]` reads for the idle check unchanged.

4. Record CPU and trailing silence where the loop ends. Immediately after `reader_thread.join(2)` in `supervise()`, add:

```python
    with lock:
        now_final = time.time()
        trailing = now_final - state["last_activity"]
        if trailing > CURRENT_RUN.max_silence:
            CURRENT_RUN.max_silence = trailing
    CURRENT_RUN.tail.flush(time.time())
```

5. In the poll loop where the group CPU is sampled (the variable `cpu` updated near `last_cpu = cpu`), add `CURRENT_RUN.cpu_time = cpu` next to `last_cpu = cpu`. If the loop has no sample on a plain command (no poll), set `CURRENT_RUN.cpu_time` from `group_cpu(pgid)[0]` once after `reader_thread.join(2)` with a `try/except Exception: pass` guard.

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_output_tail.py plugins/command-watchdog/tests/test_limits.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/output_tail.py plugins/command-watchdog/hooks/command-watchdog.py plugins/command-watchdog/tests/test_output_tail.py
git commit -m "feat(command-watchdog): track max silence and killed-run output tail"
```

---

### Task 7c: Record outcomes in the hook

**Files:**
- Modify: `plugins/command-watchdog/hooks/command-watchdog.py`
- Test: `plugins/command-watchdog/tests/test_recording.py`

**Interfaces:**
- Consumes: `RunState` (Task 7a), `OutputTail` (Task 7b), `stats_store.record_run`, `RunRecord`, `is_enabled`, `db_path` (Tasks 4–5).
- Produces: `classify(run: RunState) -> Tuple[str, Optional[int]]` returning `(outcome, exit_code)`; `record_run_safely(run: RunState) -> None`.

- [ ] **Step 1: Write the failing test**

```python
import os, signal, subprocess, sys, tempfile, time, unittest
from unittest.mock import patch
import io, contextlib, shlex

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHDOG = os.path.join(HERE, "..", "hooks", "command-watchdog.py")
sys.path.insert(0, os.path.join(HERE, "..", "hooks"))
import stats_store as ss


def run_watchdog(home, args, timeout=30):
    env = dict(os.environ, COMMAND_WATCHDOG_HOME=home, WATCHDOG_POLL="1")
    return subprocess.run(["/usr/bin/python3", WATCHDOG] + args, capture_output=True, text=True,
                          env=env, timeout=timeout)


def rows(home, sql):
    conn = ss.connect(os.path.join(home, "stats.db"), readonly=True)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name
        ss.enable(os.path.join(self.home, "stats.db"))

    def test_success_is_recorded(self):
        result = run_watchdog(self.home, ["--original", "echo hi", "--", "echo", "hi"])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(rows(self.home, "SELECT outcome, exit_code, primary_process FROM invocations"),
                         [("success", 0, "echo")])

    def test_idle_kill_is_recorded_with_tail(self):
        result = run_watchdog(self.home, ["--set", "idle=2", "--", "sh", "-c", "echo before; sleep 30"])
        self.assertEqual(result.returncode, 124)
        self.assertEqual(rows(self.home, "SELECT outcome, kill_reason, fired_check FROM invocations"),
                         [("killed", "idle", "idle")])
        self.assertGreaterEqual(len(rows(self.home, "SELECT * FROM output_tail")), 1)

    def test_failed_exit_is_recorded(self):
        run_watchdog(self.home, ["--", "sh", "-c", "exit 3"])
        self.assertEqual(rows(self.home, "SELECT outcome, exit_code FROM invocations"), [("failed", 3)])

    def test_unwritable_store_does_not_change_exit_status(self):
        blocked = os.path.join(self.home, "not-a-dir")
        with open(blocked, "w") as handle:
            handle.write("x")
        result = run_watchdog(blocked, ["--", "sh", "-c", "exit 7"])
        self.assertEqual(result.returncode, 7)

    def test_disabled_collection_creates_nothing(self):
        other = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(other, ignore_errors=True))
        result = run_watchdog(other, ["--", "echo", "ok"])
        self.assertEqual(result.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(other, "stats.db")))

    def test_launch_failure_is_recorded_as_125(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("cw", WATCHDOG)
        cw = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cw)
        marker = os.path.join(self.home, "ran")
        with patch.dict(os.environ, {"COMMAND_WATCHDOG_HOME": self.home}), \
                patch.object(sys, "argv", [WATCHDOG, "touch " + shlex.quote(marker)]), \
                patch.object(cw.os, "setpriority", side_effect=PermissionError("denied")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cw.main(), 125)
        self.assertFalse(os.path.exists(marker))
        self.assertEqual(rows(self.home, "SELECT outcome, exit_code FROM invocations"), [("failed", 125)])

    def test_cancellation_is_recorded_once_as_failed(self):
        proc = subprocess.Popen(["/usr/bin/python3", WATCHDOG, "--", "sh", "-c", "sleep 30"],
                                env=dict(os.environ, COMMAND_WATCHDOG_HOME=self.home, WATCHDOG_POLL="1"),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)
        proc.send_signal(signal.SIGTERM)
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=30)
        result = rows(self.home, "SELECT outcome, exit_code FROM invocations")
        self.assertEqual(result, [("failed", 128 + signal.SIGTERM)])

    def test_rtk_call_is_recorded_as_rtk(self):
        run_watchdog(self.home, ["--", "rtk", "hook", "claude"])
        self.assertEqual(rows(self.home, "SELECT primary_process, signature FROM invocations"),
                         [("rtk", "rtk hook")])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_recording.py -v`
Expected: FAIL, because no rows are written yet.

- [ ] **Step 3: Write the minimal implementation**

In `plugins/command-watchdog/hooks/command-watchdog.py`:

1. Add these functions above `main()`:

```python
def classify(run):
    if run.launch_failed:
        return "failed", 125
    if run.cancelled is not None:
        return "failed", 128 + run.cancelled
    if run.kill_reason is not None:
        return "killed", run.exit_code
    if run.exit_code == 0:
        return "success", 0
    return "failed", run.exit_code


def record_run_safely(run):
    if run.recorded:
        return
    run.recorded = True
    try:
        path = stats_store.db_path()
        if not stats_store.is_enabled(path):
            return
        outcome, exit_code = classify(run)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        started = datetime.fromtimestamp(run.start, tz=timezone.utc).isoformat(timespec="seconds")
        record = stats_store.RunRecord(
            started_at=started, ended_at=now, command_line=run.cmd,
            primary_process=run.primary, signature=run.signature,
            loop_kind=run.loop_kind.value, rule_key=run.rule_key, ini_values=run.ini_values,
            env_overrides=run.overridden, override_vars=run.override_vars, rtk_proxied=run.rtk_proxied,
            outcome=outcome,
            kill_reason=run.kill_reason.value if run.kill_reason is not None and outcome == "killed" else None,
            fired_check=run.fired.value if outcome == "killed" else "none",
            exit_code=exit_code,
            execution_time=max(0.0, time.time() - run.start), cpu_time=run.cpu_time,
            max_silence=run.max_silence, no_output_time=0.0,
            output_tail=tuple(run.tail.lines()) if outcome == "killed" else (),
        )
        stats_store.record_run(path, record, now=now)
    except Exception as error:
        debug_log({"stage": "stats-write-failed", "error": repr(error)})
```

Add `from datetime import datetime, timezone` to the imports if not present.

2. In `main()`, store the run globally and record in the existing `finally`. Immediately after `run = RunState(...)` and the config lines from Task 7a, add `global CURRENT_RUN; CURRENT_RUN = run`.

3. In the `except BaseException:` branch of the main `try`, set `run.cancelled = cancelled` just before the `raise` (`cancelled` is the existing local).

4. In the launch `except (OSError, subprocess.SubprocessError)` branch, set `run.launch_failed = True` before `return 125`.

5. Replace `return supervise(cmd, proc, proc.pid, r_fd)` with:

```python
        result = supervise(cmd, proc, proc.pid, r_fd)
        run.exit_code = proc.returncode
        run.killed = result == 124 and run.kill_reason is not None
        return result
```

Also add to `supervise()`: `CURRENT_RUN.exit_code` is set in `main()`, so no change is needed there.

6. In the `finally` block of `main()`, insert `record_run_safely(run)` directly after the first line `signal.pthread_sigmask(signal.SIG_BLOCK, cancel_signals)`, so the write happens with signals blocked and before handlers are restored. Use the variable name `run` (it is defined before the `try`; move `run = RunState(...)` above the `try` if it is not). Do not change the finally's remaining cleanup.

7. Set `run.loop_kind` in `supervise()` right after `tracker` is created:

```python
    CURRENT_RUN.loop_kind = (LoopKind.TARGETED if targeted
                             else LoopKind.UNTARGETED if tracker is not None else LoopKind.NONE)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_recording.py -v`
Expected: PASS. If `test_cancellation_is_recorded_once_as_failed` reports two rows, the second signal is not being ignored; check that `cancel()` blocks the signals before the `finally` write (the handler already calls `signal.pthread_sigmask(signal.SIG_BLOCK, cancel_signals)` and sets `SIG_IGN`).

Then run the full suite: `/usr/bin/python3 -m unittest discover -s plugins/command-watchdog/tests -v`. Expected: `test_hook.py` may still fail on the `.txt` file until Task 8.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/command-watchdog.py plugins/command-watchdog/tests/test_recording.py
git commit -m "feat(command-watchdog): record each supervised run at exit"
```

---

### Task 8: Wrapper changes and rule-file migration

**Files:**
- Modify: `plugins/command-watchdog/hooks/bash-watchdog.py`
- Delete: `plugins/command-watchdog/hooks/watchdog-patterns.txt`
- Modify: `plugins/command-watchdog/tests/test_hook.py`

**Interfaces:**
- Consumes: `lift_overrides` (Task 2).
- Produces: the rewritten command format `/usr/bin/python3 <WATCHDOG> --original <text> [--rtk-proxied] [--set key=value ...] -- <final_command>`.

- [ ] **Step 1: Write the failing test**

Add to `plugins/command-watchdog/tests/test_hook.py` (inside `HookTests`; `self.rewrite(command)` already exists):

```python
    def test_wrapper_does_not_inject_watchdog_idle(self):
        out = self.rewrite("npm test")
        self.assertNotIn("WATCHDOG_IDLE=", out)

    def test_lifted_override_becomes_set_argument(self):
        out = self.rewrite("WATCHDOG_IDLE=600 npm test")
        self.assertIn("--set", out)
        self.assertIn("idle=600", out)
        self.assertNotIn("WATCHDOG_IDLE=600", out)

    def test_assignment_only_passes_through_unmodified(self):
        out = self.rewrite("WATCHDOG_IDLE=600")
        self.assertNotIn("command-watchdog.py", out)

    def test_rule_file_is_ini_and_txt_is_gone(self):
        self.assertFalse((PLUGIN / "hooks/watchdog-patterns.txt").exists())
        self.assertTrue((PLUGIN / "hooks/watchdog-patterns.ini").exists())
```

Change the existing test that writes `hooks/watchdog-patterns.txt` (line 145 in the current file, `(self.root / "hooks/watchdog-patterns.txt").write_text(".* 2\n")`) to write an INI file instead:

```python
        (self.root / "hooks/watchdog-patterns.ini").write_text("[rule:all]\nregex: .\nidle: 2\n")
```

Also remove `WATCHDOG_IDLE="90"` and `WATCHDOG_MAX_RUNTIME="0"` from `setUp`'s env so the INI applies in these tests. Keep `WATCHDOG_POLL="1"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_hook.py -v`
Expected: FAIL. `test_wrapper_does_not_inject_watchdog_idle` finds `WATCHDOG_IDLE=` in the rewrite.

- [ ] **Step 3: Write the minimal implementation**

In `plugins/command-watchdog/hooks/bash-watchdog.py`:

1. Replace the constants and loader block. Remove `DEFAULT_IDLE`, `PATTERNS_FILE`, the whole `load_patterns()` function, and the `strip_env_prefix()` function. Add at the top with the other imports:

```python
sys.path.insert(0, HERE)
from command_identity import lift_overrides  # noqa: E402
```

Update the module docstring (lines around 10–17 and 29) so it no longer mentions `watchdog-patterns.txt` or per-command idle injection. State that per-command limits live in `watchdog-patterns.ini`.

2. In `resolve_via_rtk(raw, cmd)`, the env for the rtk call becomes:

```python
        env = {k: v for k, v in os.environ.items() if not k.startswith("WATCHDOG_")}
```

Delete the two lines that set `WATCHDOG_MAX_RUNTIME` and `WATCHDOG_IDLE`. Add the built-in fallback is already in `watchdog_config` (`rtk` → `max_runtime 15`), so no argument is needed.

Also change the function so it receives the already-lifted command: the caller passes `remaining` as `cmd`, and the rtk JSON is rebuilt with `tool_input.command` set to `remaining`:

```python
        payload = json.loads(raw)
        payload.setdefault("tool_input", {})["command"] = cmd
        raw = json.dumps(payload)
```

Place this before the `tempfile` write in `resolve_via_rtk`.

3. Replace the tail of the script (from `final_cmd, passthrough = resolve_via_rtk(raw, cmd)` to the end) with:

```python
lifted, rejected, remaining = lift_overrides(cmd)
for item in rejected:
    debug_log({"stage": "override-rejected", "assignment": item})
if not remaining:
    debug_log({"stage": "no-command-after-overrides", "original_command": cmd})
    sys.exit(0)  # P5: pass the original text through unmodified

final_cmd, passthrough = resolve_via_rtk(raw, remaining)
if passthrough is not None:
    print(json.dumps(passthrough))
    sys.exit(0)

args = [WATCHDOG, "--original", remaining]
if final_cmd != remaining:
    args.append("--rtk-proxied")
for key, value in lifted.items():
    args += ["--set", "{}={}".format(key, value)]
args += ["--", final_cmd]
wrapped = " ".join(["/usr/bin/python3"] + [shlex.quote(part) for part in args])
debug_log({
    "stage": "watchdog-wrap", "tool_name": tool_name, "original_command": cmd,
    "final_command": final_cmd, "lifted": lifted,
})
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "permissionDecisionReason": "command watchdog wrap",
        "updatedInput": {"command": wrapped},
    }
}))
sys.exit(0)
```

4. Delete `plugins/command-watchdog/hooks/watchdog-patterns.txt`:

```bash
git rm plugins/command-watchdog/hooks/watchdog-patterns.txt
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_hook.py -v`
Expected: PASS. Then the whole suite:

Run: `/usr/bin/python3 -m unittest discover -s plugins/command-watchdog/tests -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/bash-watchdog.py plugins/command-watchdog/tests/test_hook.py
git commit -m "feat(command-watchdog): lift per-run overrides and stop injecting WATCHDOG_IDLE"
```

---

### Task 9: Suggestion math

**Files:**
- Create: `plugins/command-watchdog/hooks/suggest.py`
- Test: `plugins/command-watchdog/tests/test_suggest.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `round_up(value: float) -> int`
  - `@dataclass(frozen=True) CheckInput`: `name: str`, `configured: Optional[int]`, `successes: int`, `maximum: float`, `kills: int`, `invocations: int`, `poll: int`, `acceptable_kill_percent: int`.
  - `@dataclass(frozen=True) Option`: `name: str`, `value: int`, `recommended: bool`, `confidence: str`.
  - `@dataclass(frozen=True) CheckResult`: `name: str`, `trigger: Optional[str]`, `confidence: str`, `options: Tuple[Option, ...]`.
  - `suggest_check(inp: CheckInput) -> CheckResult`.

- [ ] **Step 1: Write the failing test**

```python
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
from suggest import CheckInput, round_up, suggest_check


def inp(**kw):
    base = dict(name="idle", configured=300, successes=10, maximum=30.0, kills=0, invocations=12,
                poll=5, acceptable_kill_percent=25)
    base.update(kw)
    return CheckInput(**base)


def values(result):
    return {o.name: o.value for o in result.options}


class RoundingTests(unittest.TestCase):
    def test_round_up(self):
        self.assertEqual(round_up(0), 0)
        self.assertEqual(round_up(1), 5)
        self.assertEqual(round_up(31), 35)
        self.assertEqual(round_up(30), 30)
        self.assertEqual(round_up(61), 90)


class SuggestTests(unittest.TestCase):
    def test_tighten_example(self):
        result = suggest_check(inp())
        self.assertEqual(result.trigger, "tighten")
        self.assertEqual(values(result), {"tight": 40, "medium": 45, "long": 90})
        self.assertTrue([o for o in result.options if o.name == "tight"][0].recommended)

    def test_loosen_when_kill_rate_high(self):
        result = suggest_check(inp(maximum=280.0, kills=3, invocations=10))
        self.assertEqual(result.trigger, "loosen")
        self.assertEqual(values(result)["medium"], 600)
        self.assertEqual(values(result)["long"], 900)
        self.assertTrue([o for o in result.options if o.name == "medium"][0].recommended)

    def test_loosen_when_successes_close_to_limit(self):
        self.assertEqual(suggest_check(inp(maximum=240.0, kills=0)).trigger, "loosen")

    def test_no_successes_with_numeric_limit_uses_limit(self):
        result = suggest_check(inp(successes=0, maximum=0.0, kills=5, invocations=5, configured=600))
        self.assertEqual(values(result)["medium"], 1200)
        self.assertEqual(values(result)["long"], 1800)
        self.assertEqual(result.confidence, "no successful runs yet")

    def test_off_with_no_successes_is_floor(self):
        result = suggest_check(inp(configured=None, successes=0, maximum=0.0, invocations=0))
        self.assertEqual(result.confidence, "no runs yet")
        self.assertEqual(result.options, ())

    def test_zero_maximum_yields_floor_not_zero(self):
        result = suggest_check(inp(maximum=0.0, successes=4, invocations=4, poll=1))
        self.assertGreaterEqual(values(result)["tight"], 5)

    def test_low_confidence_below_three_successes(self):
        self.assertEqual(suggest_check(inp(successes=2, invocations=2)).confidence, "low confidence")

    def test_acceptable_percent_threshold(self):
        self.assertIsNone(suggest_check(inp(kills=2, invocations=10, acceptable_kill_percent=40)).trigger)
        self.assertEqual(suggest_check(inp(kills=2, invocations=10, acceptable_kill_percent=25)).trigger, "loosen")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_suggest.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'suggest'`.

- [ ] **Step 3: Write the minimal implementation**

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_suggest.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/hooks/suggest.py plugins/command-watchdog/tests/test_suggest.py
git commit -m "feat(command-watchdog): add pure suggestion math for numeric limits"
```

---

### Task 10: CLI

**Files:**
- Create: `plugins/command-watchdog/bin/command-watchdog-stats`
- Test: `plugins/command-watchdog/tests/test_cli.py`

**Interfaces:**
- Consumes: `stats_store` (Tasks 4–6), `suggest.suggest_check` and `CheckInput` (Task 9), `watchdog_config.load_rules` (Task 3).
- Produces: subcommands `stats`, `suggest-timeouts [SECTION] [--choose key=option,...] [--apply]`, `reset-stats --yes`, `delete-stats --all --yes`, `enable-stats`. Exit codes: `0` success, `1` store error, `2` usage error.

- [ ] **Step 1: Write the failing test**

```python
import configparser, glob, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "bin", "command-watchdog-stats")
sys.path.insert(0, os.path.join(HERE, "..", "hooks"))
import stats_store as ss
from stats_store import RunRecord


def cli(home, *args):
    env = dict(os.environ, COMMAND_WATCHDOG_HOME=home)
    return subprocess.run(["/usr/bin/python3", CLI] + list(args), capture_output=True, text=True, env=env)


def seed(home, n_ok=5, kills=0):
    path = os.path.join(home, "stats.db")
    ss.enable(path)
    base = dict(started_at="2026-10-14T10:00:00+00:00", ended_at="2026-10-14T10:00:02+00:00",
                command_line="make", primary_process="make", signature="make", loop_kind="none",
                rule_key="command:make", ini_values={"idle": 300}, env_overrides=False,
                override_vars=(), rtk_proxied=False, exit_code=0, execution_time=2.0, cpu_time=1.0,
                max_silence=30.0, no_output_time=0.5)
    for _ in range(n_ok):
        ss.record_run(path, RunRecord(outcome="success", kill_reason=None, fired_check="none", **base))
    for _ in range(kills):
        ss.record_run(path, RunRecord(outcome="killed", kill_reason="idle", fired_check="idle",
                                      **dict(base, exit_code=None)))


class CliTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name

    def test_stats_disabled_prompts_and_creates_nothing(self):
        result = cli(self.home, "stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("stats disabled. Do you want to enable stats collection?", result.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.home, "stats.db")))

    def test_enable_is_idempotent(self):
        self.assertEqual(cli(self.home, "enable-stats").returncode, 0)
        self.assertEqual(cli(self.home, "enable-stats").returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.home, "stats.db")))

    def test_stats_prints_totals(self):
        seed(self.home, n_ok=3)
        result = cli(self.home, "stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("invocations: 3", result.stdout)

    def test_suggest_without_section_lists_sections(self):
        seed(self.home)
        result = cli(self.home, "suggest-timeouts")
        self.assertIn("command:make", result.stdout)

    def test_suggest_section_prints_three_options_per_check(self):
        seed(self.home)
        result = cli(self.home, "suggest-timeouts", "command:make")
        self.assertEqual(result.returncode, 0)
        for word in ("tight", "medium", "long"):
            self.assertIn(word, result.stdout)

    def test_apply_requires_choose(self):
        seed(self.home)
        self.assertEqual(cli(self.home, "suggest-timeouts", "command:make", "--apply").returncode, 2)

    def test_apply_writes_chosen_value_and_backup(self):
        seed(self.home)
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 0)
        ini = os.path.join(self.home, "watchdog-patterns.ini")
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(ini)
        self.assertTrue(parser.has_option("command:make", "idle"))
        self.assertEqual(glob.glob(os.path.join(self.home, "watchdog-patterns.ini.bak-*")), [])

    def test_reset_refuses_without_yes(self):
        seed(self.home)
        self.assertEqual(cli(self.home, "reset-stats").returncode, 2)

    def test_reset_with_yes_backs_up_and_clears(self):
        seed(self.home, n_ok=2)
        self.assertEqual(cli(self.home, "reset-stats", "--yes").returncode, 0)
        self.assertEqual(len(glob.glob(os.path.join(self.home, "stats-backup-*.db"))), 1)
        self.assertIn("invocations: 0", cli(self.home, "stats").stdout)

    def test_delete_requires_all_and_yes(self):
        seed(self.home)
        self.assertEqual(cli(self.home, "delete-stats", "--yes").returncode, 2)
        self.assertEqual(cli(self.home, "delete-stats", "--all", "--yes").returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.home, "stats.db")))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_cli.py -v`
Expected: FAIL, because the CLI does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `plugins/command-watchdog/bin/command-watchdog-stats`, make it executable (`chmod +x`), and give it this content:

```python
#!/usr/bin/env python3
"""command-watchdog-stats: read stats, suggest limits, and manage the opt-in store."""
import argparse
import configparser
import datetime
import glob
import os
import shutil
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(HERE, "..", "hooks")
sys.path.insert(0, HOOKS)
import stats_store as ss  # noqa: E402
from suggest import CheckInput, suggest_check  # noqa: E402

PROMPT = "stats disabled. Do you want to enable stats collection?"
CHECKS = {
    "idle": ("max_silence_max", "killed_idle", "idle"),
    "max_runtime": ("execution_max", "killed_max_runtime", "max_runtime"),
    "poll_cap": ("untargeted_execution_max", "killed_poll_cap", "poll_cap"),
}


def data_ini():
    return os.path.join(ss.store_dir(), "watchdog-patterns.ini")


def cmd_stats(path):
    if not ss.is_enabled(path):
        print(PROMPT)
        return 0
    conn = ss.connect(path, readonly=True)
    try:
        g = conn.execute("SELECT invocations, successful, failed, killed, rtk_proxies FROM counters "
                         "WHERE scope='global' AND key=''").fetchone() or (0, 0, 0, 0, 0)
        print("invocations: {}".format(g[0]))
        print("successful: {}".format(g[1]))
        print("failed: {}".format(g[2]))
        print("killed: {}".format(g[3]))
        print("rtk proxies: {}".format(g[4]))
        print("overridden runs: {}".format(conn.execute(
            "SELECT COALESCE(SUM(invocations), 0) FROM counters WHERE scope='rule_override'").fetchone()[0]))
        for row in conn.execute("SELECT key, killed FROM counters WHERE scope='kill_reason' ORDER BY killed DESC"):
            print("kill reason {}: {}".format(row[0], row[1]))
        for row in conn.execute("SELECT key, invocations, killed FROM counters WHERE scope='primary_process' "
                                "ORDER BY killed DESC, invocations DESC LIMIT 10"):
            print("process {}: {} runs, {} killed".format(row[0], row[1], row[2]))
    finally:
        conn.close()
    return 0


def _rule_counters(conn, section):
    row = conn.execute("SELECT MAX(version) FROM rule_versions WHERE rule_key=?", (section,)).fetchone()
    if not row or row[0] is None:
        return None, None
    version = row[0]
    counters = conn.execute("SELECT * FROM counters WHERE scope='rule' AND key=? AND rule_version=?",
                            (section, version))
    names = [d[0] for d in counters.description]
    values = counters.fetchone()
    return version, (dict(zip(names, values)) if values else None)


def cmd_suggest(path, section, choose, apply_changes):
    if not ss.is_enabled(path):
        print(PROMPT)
        return 0
    conn = ss.connect(path, readonly=True)
    try:
        if section is None:
            for row in conn.execute("SELECT DISTINCT key FROM counters WHERE scope='rule' ORDER BY key"):
                print(row[0])
            print("pass one of these to suggest-timeouts SECTION")
            return 0
        version, data = _rule_counters(conn, section)
    finally:
        conn.close()
    if data is None:
        print("no data for {}".format(section))
        return 0
    chosen = {}
    if choose:
        for pair in choose.split(","):
            key, _, option = pair.partition("=")
            chosen[key.strip()] = option.strip()
    applied = {}
    for check, (stat, kill_col, _) in CHECKS.items():
        result = suggest_check(CheckInput(
            name=check, configured=None, successes=data["successful"], maximum=data[stat] or 0.0,
            kills=data[kill_col], invocations=data["invocations"], poll=5, acceptable_kill_percent=25))
        print("{} (trigger: {})".format(check, result.trigger or "none"))
        for option in result.options:
            marker = " <- recommended" if option.recommended else ""
            print("  {}: {}{} [{}]".format(option.name, option.value, marker, option.confidence))
        if check in chosen:
            applied[check] = dict((o.name, o.value) for o in result.options)[chosen[check]]
    if apply_changes:
        if not chosen:
            print("--apply requires --choose check=option", file=sys.stderr)
            return 2
        _write_section(section, applied)
    return 0


def _write_section(section, applied):
    ini = data_ini()
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    if os.path.isfile(ini):
        shutil.copy(ini, ini + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
        parser.read(ini, encoding="utf-8")
    if not parser.has_section(section):
        parser.add_section(section)
    for key, value in applied.items():
        parser.set(section, key, str(value))
    temp = ini + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        parser.write(handle)
    os.replace(temp, ini)


def cmd_reset(path, yes):
    if not yes:
        print("reset-stats needs --yes", file=sys.stderr)
        return 2
    if not ss.is_enabled(path):
        print("nothing to reset")
        return 0
    backup = ss.reset(path)
    print("backup: {}".format(backup))
    return 0


def cmd_delete(path, all_flag, yes):
    if not (all_flag and yes):
        print("delete-stats needs --all --yes", file=sys.stderr)
        return 2
    removed = ss.delete_all(path)
    print("removed {} file(s)".format(len(removed)))
    return 0


def cmd_enable(path):
    try:
        ss.enable(path)
    except ss.StoreError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("stats collection enabled at {}".format(path))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(prog="command-watchdog-stats")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("stats")
    suggest = sub.add_parser("suggest-timeouts")
    suggest.add_argument("section", nargs="?")
    suggest.add_argument("--choose")
    suggest.add_argument("--apply", action="store_true")
    reset = sub.add_parser("reset-stats")
    reset.add_argument("--yes", action="store_true")
    delete = sub.add_parser("delete-stats")
    delete.add_argument("--all", action="store_true")
    delete.add_argument("--yes", action="store_true")
    sub.add_parser("enable-stats")
    args = parser.parse_args(argv)
    path = ss.db_path()
    if args.command == "stats":
        return cmd_stats(path)
    if args.command == "suggest-timeouts":
        return cmd_suggest(path, args.section, args.choose, args.apply)
    if args.command == "reset-stats":
        return cmd_reset(path, args.yes)
    if args.command == "delete-stats":
        return cmd_delete(path, args.all, args.yes)
    return cmd_enable(path)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

The first apply creates the data-directory INI, so no backup exists yet (asserted above). Add a second test that applies twice and expects one backup:

```python
    def test_second_apply_keeps_backup(self):
        seed(self.home)
        cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=long", "--apply")
        self.assertEqual(len(glob.glob(os.path.join(self.home, "watchdog-patterns.ini.bak-*"))), 1)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_cli.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/bin/command-watchdog-stats plugins/command-watchdog/tests/test_cli.py
git commit -m "feat(command-watchdog): add command-watchdog-stats CLI"
```

---

### Task 11: Plugin command files

**Files:**
- Create: `plugins/command-watchdog/commands/stats.md`, `suggest-timeouts.md`, `reset-stats.md`, `delete-stats.md`, `enable-stats.md`
- Test: `plugins/command-watchdog/tests/test_commands.py`

**Interfaces:**
- Consumes: the CLI from Task 10 at `${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats`.
- Produces: five plugin commands. Each file has YAML frontmatter with a `description:` line.

- [ ] **Step 1: Write the failing test**

```python
import os, unittest

COMMANDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "commands")
EXPECT = {
    "stats.md": ["stats"],
    "suggest-timeouts.md": ["suggest-timeouts", "--apply"],
    "reset-stats.md": ["reset-stats", "--yes"],
    "delete-stats.md": ["delete-stats", "--all", "--yes"],
    "enable-stats.md": ["enable-stats"],
}


class CommandFileTests(unittest.TestCase):
    def test_files_exist_with_frontmatter_and_subcommand(self):
        for name, words in EXPECT.items():
            with self.subTest(name=name):
                text = open(os.path.join(COMMANDS, name), encoding="utf-8").read()
                self.assertTrue(text.startswith("---\ndescription: "))
                for word in words:
                    self.assertIn(word, text)
                self.assertIn("CLAUDE_PLUGIN_ROOT", text)

    def test_destructive_commands_require_confirmation(self):
        for name in ("reset-stats.md", "delete-stats.md", "suggest-timeouts.md"):
            with self.subTest(name=name):
                text = open(os.path.join(COMMANDS, name), encoding="utf-8").read()
                self.assertIn("AskUserQuestion", text)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_commands.py -v`
Expected: FAIL with `FileNotFoundError` for `commands/stats.md`.

- [ ] **Step 3: Write the minimal implementation**

Create `plugins/command-watchdog/commands/stats.md`:

```markdown
---
description: Show command-watchdog kill and success statistics, or offer to enable collection
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" stats` with Bash and show its output as printed.

If the output is `stats disabled. Do you want to enable stats collection?`, ask the user that question with AskUserQuestion. Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" enable-stats` only if the answer is yes.
```

Create `plugins/command-watchdog/commands/enable-stats.md`:

```markdown
---
description: Turn on command-watchdog stats collection
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" enable-stats` with Bash and report its output. Collection starts on the next supervised command.
```

Create `plugins/command-watchdog/commands/suggest-timeouts.md`:

```markdown
---
description: Suggest per-command watchdog limits from collected stats, then apply a chosen one
---

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" suggest-timeouts` with Bash to list rule sections. If the output is the disabled prompt, stop and ask the user whether to enable collection.
2. Ask which section to review with AskUserQuestion, using the listed sections as options.
3. Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" suggest-timeouts SECTION` and show its output as printed. It lists tight, medium, and long for idle, max_runtime, and poll_cap.
4. Ask the user which option to choose for each check with AskUserQuestion. Leave out any check the user does not want to change.
5. Preview by re-running with `--choose`, without `--apply`, and show the result.
6. Run with `--apply` only after the user explicitly confirms the preview. Pass the same `--choose` value, for example `--choose idle=tight,max_runtime=long --apply`.
```

Create `plugins/command-watchdog/commands/reset-stats.md`:

```markdown
---
description: Back up command-watchdog stats, then clear them
---

Before running anything, ask the user to confirm with AskUserQuestion. Explain that the current stats are copied to a timestamped backup and then cleared, and that collection stays on.

Only if the user confirms, run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" reset-stats --yes` with Bash and report the backup path.
```

Create `plugins/command-watchdog/commands/delete-stats.md`:

```markdown
---
description: Delete all command-watchdog stats and backups; turns collection off
---

Before running anything, ask the user to confirm with AskUserQuestion. Explain that this deletes the stats database and every backup, that collection turns off, and that the rule file is kept.

Only if the user confirms, run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" delete-stats --all --yes` with Bash and report the removed count.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/usr/bin/python3 -m unittest plugins/command-watchdog/tests/test_commands.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/command-watchdog/commands plugins/command-watchdog/tests/test_commands.py
git commit -m "feat(command-watchdog): add stats plugin commands"
```

---

### Task 12: README

**Files:**
- Modify: `README.md` (the command-watchdog section, around lines 136–161)

**Interfaces:**
- Consumes: final behavior from Tasks 3, 7, 8, and 10.
- Produces: user-facing documentation only.

- [ ] **Step 1: Find the lines to change**

Run: `rg -n "watchdog-patterns.txt|WATCHDOG_NICE|WATCHDOG_IDLE|POLL_CAP|nice" README.md`
Expected: the lines at about 136 and 161 from the design review.

- [ ] **Step 2: Make the edits**

Replace the sentence in the command-watchdog paragraph that reads `(default 90s; `hooks/watchdog-patterns.txt` sets per-command overrides, e.g. `rspec` and `.sh` scripts)` with: `(default 90s; `hooks/watchdog-patterns.ini` sets per-command and per-rule limits, for example `rspec` and `.sh` scripts)`.

Replace `` `WATCHDOG_NICE` is ignored, including for RTK rewrite decisions. `` with: ``Priority is set per command in `watchdog-patterns.ini` (`nice: off` skips the priority change for an exception); `WATCHDOG_NICE` is not read. With `nice: off` the child keeps the watchdog's inherited priority. ``

Replace `` `WATCHDOG_POLL_CAP` `` in the wait-loop paragraph with ``the `poll_cap` limit (environment `WATCHDOG_POLL_CAP`, default 1800s)``.

Add a new subsection after the command-watchdog paragraph, titled `#### Stats (opt-in)`, with this text:

> Stats are off until enabled. Run `/command-watchdog:enable-stats`, or `/command-watchdog:stats` and answer yes to its prompt. Once enabled, every supervised command is recorded in `stats.db` in the platform data directory (or `$COMMAND_WATCHDOG_HOME`). `/command-watchdog:stats` shows totals and kills by reason. `/command-watchdog:suggest-timeouts` proposes tight, medium, and long values per section and applies the one you choose. `/command-watchdog:reset-stats` backs up and clears the stats; `/command-watchdog:delete-stats` removes the database and all backups.

Add a sentence explaining per-run overrides: `A command can override idle, max_runtime, and poll_cap for one run with a leading assignment such as WATCHDOG_IDLE=600 (accepted values: integer, -1, or off). Other WATCHDOG_* names are not read.`

- [ ] **Step 3: Verify**

Run: `rg -n "watchdog-patterns.txt|WATCHDOG_NICE is ignored" README.md`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(command-watchdog): document INI rules, nice, overrides, and stats"
```

---

### Task 13: Full verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run the full unit suite with the required interpreter**

Run: `/usr/bin/python3 -m unittest discover -s plugins/command-watchdog/tests -v`
Expected: all tests PASS.

- [ ] **Step 2: Confirm the wrapper never injects `WATCHDOG_*`**

Run:
```bash
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"npm test"},"hook_event_name":"PreToolUse"}' \
  | PATH=/usr/bin:/bin /usr/bin/python3 plugins/command-watchdog/hooks/bash-watchdog.py
```
Expected: JSON whose `updatedInput.command` contains `--original` and does not contain `WATCHDOG_IDLE=`.

- [ ] **Step 3: Smoke-test the opt-in flow end to end**

```bash
export COMMAND_WATCHDOG_HOME=$(mktemp -d)
plugins/command-watchdog/bin/command-watchdog-stats stats            # expect the disabled prompt
plugins/command-watchdog/bin/command-watchdog-stats enable-stats      # expect "enabled"
/usr/bin/python3 plugins/command-watchdog/hooks/command-watchdog.py -- echo hi
plugins/command-watchdog/bin/command-watchdog-stats stats            # expect invocations: 1
unset COMMAND_WATCHDOG_HOME
```
Expected: the three outputs above.

- [ ] **Step 4: Check the spec test list against what was built**

Run: `rg -n "^- \*\*" docs/superpowers/specs/2026-10-13-watchdog-stats-design.md | tail -40`
Confirm each item in the spec's Testing section maps to a test in this plan. Record any gap in the final report; do not silently skip.

- [ ] **Step 5: Final state**

Run: `git status --short && git log --oneline -15`
Expected: clean tree on `watchdog-stats-design`. Do not merge, bump versions, or edit `CHANGELOG.md` here.

---

## Self-Review Notes

- Spec coverage: every MVP item in the spec maps to a task. Add-ons 1–12 are tracked as project tasks #005–#016 and are not planned here.
- Types: `Limits`, `Resolution`, `RunRecord`, `CheckInput`, `Option`, and `CheckResult` are defined once and used with the same field names in later tasks. `KillReason`, `FiredCheck`, `Outcome`, and `LoopKind` are used by `.value` when written.
- Known gaps to resolve during execution: the `max_silence` poll-mode accuracy note in the spec; and the `cpu_time` source when no poll loop runs (Task 7b step 5 covers it with a guarded `group_cpu` call).
