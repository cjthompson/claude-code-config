# Command Watchdog Stats Store — Design

**Status:** Draft v6 for review. Supersedes v5 (commit `96849f1`) and the decision notes through `4899069`. Open items at the end are undecided.

## Goal

Record every command the watchdog supervises and what happened to it, so the user can see:

- Whether the watchdog kills processes, and how often.
- Which commands trigger kills, and which limit fired.
- Which limits in `watchdog-patterns.ini` should change, and in which direction.

Primary objective: reduce false positives (killed runs that would have finished).
Secondary objective: catch real hangs sooner where successful runs are fast and the configured limit is far above them.

## Settled decisions

- **Location.** `$COMMAND_WATCHDOG_HOME` names the directory when set. Otherwise the platform default below.
- **Opt-in collection.** Collection runs only while `stats.db` exists. Hooks never create the file or directory. `enable-stats` creates them.
- **Single writer.** `command-watchdog.py` monitors and kills, so it records every user command it supervises. The rtk rewrite lookup (`--rtk-decision`, run by `bash-watchdog.py`) writes no row: it is the hook's own call, not a user command.
- **Precedence: built-in < INI < environment.** Environment variables are the exception, used for per-run overrides (for example a retry after a kill). Only `WATCHDOG_IDLE`, `WATCHDOG_MAX_RUNTIME`, and `WATCHDOG_POLL_CAP` can be overridden per run. `WATCHDOG_NICE` is not supported.
- **Environment values** accept the same values as the INI: integers, `-1`, or `off`. `WATCHDOG_MAX_RUNTIME=0` keeps meaning off.
- **Per-run overrides.** The wrapper lifts leading `WATCHDOG_*=` assignments off the command and applies them to the watchdog.
- **The hook no longer injects `WATCHDOG_*` values.** The rewrite in `bash-watchdog.py` stops prefixing `WATCHDOG_IDLE`. The prior INI loader is removed.
- **Overridden runs are kept**, flagged `env_overrides = 1`. They do not create rule versions, and suggestions never read them.
- **rtk is an ordinary command when a user runs it.** `rtk hook …` records with primary process `rtk`. The hook's rewrite lookup is the exception: it is not recorded and ignores `[rule:…]` sections, so only `[command:rtk]`, `[global]`, and the built-in fallback apply. The plugin ships `[command:rtk] max_runtime: 15`.
- **Rule file is INI** (`watchdog-patterns.ini`). Sections: `[global]`, `[command:<prefix>]`, `[rule:<name>]`.
- **Kill reasons are one enum** with five values, named as in the code.
- **Outcomes (MVP):** `success`, `failed`, `killed`. `exit_code` is the code the caller received: 124 for a watchdog kill, 128+n for cancellation, 125 for launch failure, and the child's own code otherwise. One exception: a child killed by a signal from outside the watchdog stores its raw negative status (for example `-15`), while the caller receives `1`.
- **Command identity:** `primary_process`, `signature`, `command_line`, `loop_kind`, and `fired_check` (see below).
- **Versions live in the database.** The INI holds active values only. Backups from `suggest-timeouts --apply` are the readable history.
- **`idle_time` is replaced by `max_silence`.**
- **`acceptable_kill_percent`** defaults to `25`. Written to the INI only when different.
- **Suggestions always show all three options** for each numeric limit. A recommendation marker shows which option a trigger favors.
- **`nice`** is set per command in the INI (for example `[command:make]` with `nice: off`), never per run. Suggestions show its current value only. No options until a signal exists.
- **Enable/delete race:** hooks open `stats.db` with `mode=rw` and re-check at write time. `enable-stats` builds the file in a temp path and renames it.
- **Commands:** `stats`, `suggest-timeouts`, `reset-stats`, `delete-stats`, `enable-stats`.

## Location

| Platform | Default directory |
|---|---|
| macOS | `$HOME/Library/Application Support/command-watchdog` |
| Linux and other XDG systems | `${XDG_DATA_HOME:-$HOME/.local/share}/command-watchdog` |
| Windows | `%LOCALAPPDATA%\command-watchdog`, falling back to `%APPDATA%\command-watchdog` |

Files in the directory:

- `stats.db` — the live store. Its existence is the on/off switch for collection.
- `stats-backup-YYYYMMDD-HHMMSS.db` — backups from `reset-stats`.
- `watchdog-patterns.ini` — optional override of the plugin's `hooks/watchdog-patterns.ini`.
- `watchdog-patterns.ini.bak-YYYYMMDD-HHMMSS` — backups from `suggest-timeouts --apply`.

## Scope

### MVP

1. Kill-reason and outcome enums; raw `exit_code`; `fired_check`.
2. Opt-in gate; `enable-stats`, `delete-stats`, `reset-stats` (with backup).
3. Hook writes in `command-watchdog.py`: one transaction at exit covering `invocations`, counters, and the output tail.
4. Command identity: `primary_process`, `signature` (table-driven), `command_line`, `loop_kind`.
5. Removal of the `WATCHDOG_*` injection in `bash-watchdog.py` and of the `.txt` loader.
6. INI loader: read-only; `[global]`, `[command:<prefix>]`, `[rule:<name>]` with `regex`; `-1`/`off`; `nice: on|off`; `acceptable_kill_percent`.
7. Per-run override lifting in the wrapper; `env_overrides` flag.
8. Precedence: built-in < INI < environment.
9. Nice branch: `if nice_enabled:` lowers priority before exec; otherwise no change. Tests cover both.
10. Rule versions with change detection; overridden runs excluded from versions.
11. Counters per scope and version, including per-check kill counts and a separate `rule_override` scope.
12. Output tail: last 20 timestamped lines, killed runs only.
13. Pruning: detail rows older than 30 days, at most once per 24 h, never from an `rtk hook` run.
14. `stats` command.
15. `suggest-timeouts` for `idle`, `max_runtime`, `poll_cap`.
16. README and CHANGELOG updates for the new rule file and the environment behavior (see Open items).
17. Tests for all of the above.

### Add-ons (each becomes a project task when the plan is written; implemented after MVP)

1. Exit-code classification beyond `failed`: `cancelled` (signal) and `launch_failed`.
2. Config-driven signature table, value-flag table, and wrapper list (MVP ships them in code).
3. Codex and Cursor manifest parity for the commands.
4. Command-line redaction for secrets before storage.
5. Schema migrations beyond version 1.
6. Suggestions for new signature-table entries: signatures with many distinct third words.
7. Threshold and multiplier tuning from collected data.
8. Sub-agent proposals for formula changes.
9. A data-driven suggestion for `nice`, if a usable signal is found.
10. Regex-based argument matching beyond the MVP `[rule:…]` use.
11. Kill banner: the kill diagnostic prints `fired_check` and the exact retry prefix, e.g. `retry with WATCHDOG_IDLE=<2×current>`. Low priority; project task `#005`.
12. Skill instruction: `plugins/command-watchdog/skills/command-watchdog/SKILL.md` tells the model not to prefix `WATCHDOG_*` values except to retry a watchdog kill. Low priority; project task `#006`.

## Architecture

- **`stats_store.py`** — the only code that opens `stats.db`. Imported by `command-watchdog.py` and the CLI.
- **`plugins/command-watchdog/bin/command-watchdog-stats`** — stdlib-only CLI with subcommands `stats`, `suggest-timeouts`, `reset-stats`, `delete-stats`, `enable-stats`.
- **`plugins/command-watchdog/commands/`** — one Markdown file per command, each calling one subcommand.
- **`bash-watchdog.py`** — rewrites through rtk; lifts `WATCHDOG_*` assignments off the command; injects no values.
- **Gate** — checked at write time. No file means no writes, no pruning, no counters.
- **Best-effort** — exceptions from `stats_store` go to the debug log. Kill and exit logic never depends on a write.
- **Busy timeout** — 200 ms.
- **Stdlib only** — Python `sqlite3` and `configparser` with `interpolation=None`. Hooks run under `/usr/bin/python3` (3.9), so no `tomllib`, and no `X | None` annotations without `from __future__ import annotations`.

## Kill reasons, checks, and outcomes

```python
class KillReason(str, Enum):
    IDLE = "idle"                # untargeted: no output and no CPU progress for the idle limit
    POLL_IDLE = "poll-idle"      # targeted wait loop: no target progress for the idle limit
    TARGET_GONE = "target-gone"  # targeted wait loop: awaited process disappeared
    MAX_RUNTIME = "max-runtime"  # a wall-clock cap reached (see fired_check)
    ORPHANED = "orphaned"        # parent process changed

class FiredCheck(str, Enum):
    IDLE = "idle"                # idle or poll-idle kill
    MAX_RUNTIME = "max_runtime"  # max-runtime kill from the max_runtime setting
    POLL_CAP = "poll_cap"        # max-runtime kill from the poll_cap setting on an untargeted loop
    NONE = "none"                # target-gone, orphaned, or no kill

class Outcome(str, Enum):
    SUCCESS = "success"          # exit 0, not killed
    FAILED = "failed"            # nonzero exit, not killed, or watchdog-cancelled
    KILLED = "killed"            # watchdog killed the process group
```

`fired_check` is recorded by the code path that performs the kill, so suggestions never infer which limit fired. It replaces the earlier inference from `loop_kind`.

Outcome rules:

- `killed` comes only from the watchdog's own kill path, never from the exit code.
- A child that exits 125 or 130 on its own is `failed` with that `exit_code`.
- A watchdog cancellation (signal to the watchdog) is `failed` with `exit_code = 128 + n`, written in a `finally` block. The write blocks further signals until it completes, and a repeated signal during the write is ignored, so the write cannot re-enter.
- A launch failure (the watchdog cannot set priority or exec) is `failed` with `exit_code = 125`. Its timing columns are 0.

## Command identity

Each run gets:

- **`primary_process`** — the executable's basename after unwrapping. Before splitting, a leading `cd dir &&` is stripped, then splitting on `&&` and `;` takes the first segment. Unwrapping then strips leading `VAR=value` assignments, `env`, `timeout N`, `bundle exec`, `npx`, `uv run`, `poetry run`, `pnpm exec`, and `rtk` when another command follows it. `rtk hook …` is not unwrapped: its primary process is `rtk`. `bash -c '…'` and `sh -c '…'` unwrap their string. Tokenizing uses `shlex`, with a fallback to whitespace splitting if `shlex` fails. `bin/rspec` becomes `rspec`.
- **`signature`** — the words that identify the subcommand:
  1. Word 1 is the `primary_process`.
  2. Skip flags. A flag that takes a value consumes its value, using the value-flag table. `--opt=value` is one token.
  3. Word 2 is the first remaining positional word.
  4. If `word1 word2` is in the signature table, word 3 is added, again skipping flags.
  5. `--` ends the signature.
- **`command_line`** — the raw command, for display.
- **`loop_kind`** — `none`, `targeted`, or `untargeted`, from the watchdog's wait-loop detection.

**Signature table** (in code for the MVP). These pairs take one more positional word:

| Word 1 | Word 2 | Word 3 added |
|---|---|---|
| `npm` | `run` | yes |
| `pnpm` | `run` | yes |
| `bun` | `run` | yes |
| `yarn` | `run` | yes |
| `docker` | `compose` | yes |

**Value-taking flags** (in code for the MVP). The flag's value is skipped. The key is the signature-table prefix that matched, or word 1 alone:

| Key | Flags that take a value |
|---|---|
| `git` | `-C`, `-c`, `--git-dir`, `--work-tree` |
| `docker` | `-H`, `--context`, `-c` |
| `docker compose` | `-f`, `--file`, `-p`, `--project-name`, `--env-file` |
| `npm`, `pnpm`, `yarn` | `--prefix`, `-w`, `--workspace` |

An unlisted runner groups coarser (two words) until its entries are added. A wrong entry changes grouping only, never kill behavior.

Sections use the signature as their name. A signature containing `]` falls back to its `primary_process`.

## Schema

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,            -- schema_version, last_prune
  value TEXT NOT NULL
);

CREATE TABLE rule_versions (
  rule_key    TEXT NOT NULL,         -- 'global', 'command:<prefix>', 'rule:<name>'
  version     INTEGER NOT NULL,      -- 1, 2, 3 ... per rule_key
  config_json TEXT NOT NULL,         -- INI-derived effective values; environment excluded
  created_at  TEXT NOT NULL,
  PRIMARY KEY (rule_key, version)
);

CREATE TABLE invocations (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL,     -- ISO 8601, UTC
  ended_at        TEXT NOT NULL,
  command_line    TEXT NOT NULL,
  primary_process TEXT NOT NULL,
  signature       TEXT NOT NULL,
  loop_kind       TEXT NOT NULL CHECK (loop_kind IN ('none','targeted','untargeted')),
  rule_key        TEXT NOT NULL,     -- rule that supplied the limits
  rule_version    INTEGER NOT NULL,  -- 0 when env_overrides = 1
  env_overrides   INTEGER NOT NULL,  -- 0/1
  override_vars   TEXT NOT NULL DEFAULT '',
  rtk_proxied     INTEGER NOT NULL,  -- 0/1
  outcome         TEXT NOT NULL CHECK (outcome IN ('success','failed','killed')),
  kill_reason     TEXT CHECK (kill_reason IN ('idle','poll-idle','target-gone','max-runtime','orphaned')),
  fired_check     TEXT NOT NULL CHECK (fired_check IN ('idle','max_runtime','poll_cap','none')),
  exit_code       INTEGER,           -- raw returncode, 124 for a watchdog kill, or 128+n / 125 as defined above
  execution_time  REAL NOT NULL,     -- seconds, wall clock
  cpu_time        REAL NOT NULL,     -- seconds
  max_silence     REAL NOT NULL,     -- longest span with no output and no CPU progress
  no_output_time  REAL NOT NULL,     -- silence at exit
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
  line_no       INTEGER NOT NULL,    -- 1..20, oldest first
  ts            TEXT NOT NULL,
  line          TEXT NOT NULL,       -- truncated to 4096 characters
  PRIMARY KEY (invocation_id, line_no)
);

CREATE TABLE counters (
  scope         TEXT NOT NULL CHECK (scope IN ('global','primary_process','signature','rule','rule_override','kill_reason')),
  key           TEXT NOT NULL,       -- '' global; process; signature; rule_key; reason
  rule_version  INTEGER NOT NULL DEFAULT 0,   -- real version for scope 'rule'; 0 otherwise
  invocations   INTEGER NOT NULL DEFAULT 0,
  successful    INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  killed        INTEGER NOT NULL DEFAULT 0,
  rtk_proxies   INTEGER NOT NULL DEFAULT 0,
  -- kills by the check that fired (scope 'rule' only; others leave these at 0)
  killed_idle        INTEGER NOT NULL DEFAULT 0,   -- fired_check = idle
  killed_max_runtime INTEGER NOT NULL DEFAULT 0,   -- fired_check = max_runtime
  killed_poll_cap    INTEGER NOT NULL DEFAULT 0,   -- fired_check = poll_cap
  -- successes only; avg = sum / successful
  execution_sum   REAL NOT NULL DEFAULT 0,
  cpu_sum         REAL NOT NULL DEFAULT 0,
  max_silence_sum REAL NOT NULL DEFAULT 0,
  no_output_sum   REAL NOT NULL DEFAULT 0,
  -- successes only; running maxima, not rebuildable from sums after pruning
  execution_max   REAL NOT NULL DEFAULT 0,
  cpu_max         REAL NOT NULL DEFAULT 0,
  max_silence_max REAL NOT NULL DEFAULT 0,
  no_output_max   REAL NOT NULL DEFAULT 0,
  -- successes of untargeted loops only (basis for poll_cap)
  untargeted_successful    INTEGER NOT NULL DEFAULT 0,
  untargeted_execution_max REAL NOT NULL DEFAULT 0,
  last_succeeded_at TEXT,
  last_killed_at    TEXT,
  PRIMARY KEY (scope, key, rule_version)
);
```

Counter rules:

- `process` and `signature` scopes always use `rule_version = 0`.
- The `rule` scope uses the real `rule_version`. Suggestions read only this scope, and only the current version.
- `rule_override` counts runs with `env_overrides = 1`, keyed by `rule_key`. It is for reporting only.
- `kill_reason` scope rows are keyed by reason, with `rule_version = 0`, and count kills in their `killed` column. `stats` reads them for per-reason totals, so those totals survive pruning.

Counters survive pruning. Each run updates its applicable scopes in the same transaction as its `invocations` insert.

## Rule file

`watchdog-patterns.ini`. The plugin ships a default. The data-directory copy overrides it.

```ini
[global]
idle: 90
max_runtime: off
poll: 5
poll_cap: 1800
nice: on
acceptable_kill_percent: 25

[command:rtk]
max_runtime: 15

[command:git]
idle: 120

[command:git push]
idle: 600

[rule:shell-scripts]
regex: \.sh\b
idle: 300
```

Rules:

- **Keys:** `idle`, `max_runtime`, `poll`, `poll_cap`, `nice`, `acceptable_kill_percent`, and `regex` (in `[rule:…]` sections only).
- **Values:** integers, or `-1` / `off` to disable a numeric check. `idle` and `poll_cap` must be positive when set; `0` is rejected for them. `max_runtime: 0` is accepted as `off`. `poll` must be a positive integer. `nice` is `on` or `off`.
- **Merge:** the plugin file and the data-directory file are merged per section and per key before lookup. A data-directory value overrides the plugin value for that key only.
- **Lookup:**
  1. `[rule:<name>]` sections, in file order. The first whose `regex` matches the raw command text as written, before rtk rewriting, wins. An invalid regex is logged and its section is skipped.
  2. Otherwise the longest `[command:<prefix>]` whose prefix matches the signature.
  3. Otherwise `[global]`.
  Each key falls through independently to the next level.
- **Prefix matching** is word-bounded: `[command:git]` matches `git status` but not `gitk`.
- **Environment** overrides the merged result per key, for the run only, and only for `idle`, `max_runtime`, and `poll_cap`.
- **Parsing:** `configparser` with `interpolation=None`, so `%` is literal. Inline `;` comments are not stripped by default, so comments go on their own lines.
- **Invalid values** are logged, and that key falls through.
- **Disabled values:** the loader converts `-1` and `off` to `None` (or `0` for `max_runtime`) before values reach the kill logic, because the kill code tests `max_runtime` for truthiness. A test covers `-1`.

## Hook behavior

- **Precedence:** built-in default < merged INI < `WATCHDOG_IDLE`, `WATCHDOG_MAX_RUNTIME`, and `WATCHDOG_POLL_CAP` from the command's leading assignments (lifted by the wrapper) or the process environment. Other `WATCHDOG_*` names are not read, and are left in the command as written.
- **Wrapper channel:** `bash-watchdog.py` passes the original command, the rtk flag, and lifted values to `command-watchdog.py` as arguments (`--original`, `--rtk-proxied`, `--rtk-decision` for the rtk lookup, `--set idle=600`), not as environment variables, so they never count as process-level overrides. Lifting happens on the original command before rtk runs. A lifted value is accepted only if it matches `^(-1|off|\d+)$`.
- **Overrides:** a run with any lifted or process-level override sets `env_overrides = 1`, records `rule_version = 0`, and does not create a rule version. `stats` and `suggest-timeouts` name the variable behind each excluded run, so a stale launch-time variable is visible rather than silently emptying suggestions.
- **`nice`:** read from the merged INI only, per command. When on, the child is set to the platform's lowest priority before exec, with the existing refusal path. When off, there is no priority change and no 125 refusal, and the child keeps the watchdog's inherited priority. The README update says so. There is no environment override.
- **Run state:** a run-state object owned by `main` holds start time, CPU samples, `max_silence`, and the output tail. The cancellation and normal-exit writes read it, so `SystemExit` unwinding does not lose timings. The write sits in `finally`, after signals are blocked and before handlers are restored, so a second write cannot follow it.
- **`max_silence`:** longest span with no output and no CPU progress, on the same clock as the idle check. In targeted wait loops, target activity resets the clock instead, and CPU is sampled every `poll` seconds, so the value is accurate to within `poll` seconds.
- **Output tail:** the last 20 complete lines with timestamps, each truncated to 4096 characters, kept only for killed runs.
- **Rule versions:** when a non-overridden run's INI-derived values differ from its rule's latest `rule_versions` row, the hook inserts a version with `INSERT OR IGNORE` and re-reads it, so two hooks racing on the same change agree.
- **Pruning:** at most once per 24 h, gated on `meta.last_prune`, in the exit transaction. Never run from an `rtk hook` process.
- **Pragmas:** `enable-stats` sets WAL journal mode and `synchronous=NORMAL`. Every connection sets `PRAGMA foreign_keys=ON`.
- **Latency:** the INI is read before the child starts; it is one small file read. The stats write happens after the child exits, with a 200 ms busy timeout. An `rtk hook` run therefore adds its write time before its own process returns. That write never prunes, so the added time is bounded by the busy timeout.

## Suggestions

Suggestions are per rule section, one section at a time, using the current `rule_version` only and never overridden runs. `[command:rtk]` is skipped by default, because its data is capped at 15 s; `suggest-timeouts rtk` runs it on request. They are always shown for each numeric limit: `idle`, `max_runtime`, and `poll_cap`. Each display always lists all three options (tight, medium, long). A recommendation marker shows which option a trigger favors; no marker appears when no trigger holds.

`poll` is a sampling interval and gets none. `nice` shows its current value only. No stored metric shows whether lowest priority slows a process, so it gets no options until a signal exists (add-on 9).

Each check uses one statistic and one kill count:

| Check | Statistic (successes only) | Kills counted as `K` |
|---|---|---|
| `idle` | `max_silence_max` | `killed_idle` |
| `max_runtime` | `execution_max` | `killed_max_runtime` |
| `poll_cap` | `untargeted_execution_max` | `killed_poll_cap` |

For one check: `C` is the configured value, `N` the successes, `M` the statistic's maximum, `K` the kills for this check divided by all invocations of the rule version, and `R = M ÷ C`. Success rate is successes divided by all invocations of the rule version. A rule version with zero invocations shows "no runs yet", and no triggers apply.

- **Recommendation triggers** (mark one option as recommended):
  - Loosen: `K > acceptable_kill_percent` or `R ≥ 0.75`.
  - Tighten: success rate ≥ 50% and `C ≥ 3 × M`.
  - Both hold: loosen is recommended.
  - Neither: no marker.
- **Confidence:** `N ≥ 3` is normal. `N < 3` lists the options marked "low confidence". `N = 0` takes `M` as 0, so tight shows the floor, medium and long use the Loosen-column formulas on `C` when it is numeric, and every option is marked "no successful runs yet". With `C = off` and `N = 0`, every option shows the floor and is marked "no successful runs yet".

| Option | Loosen pressure | Otherwise | `C` is `off` |
|---|---|---|---|
| **tight** | `M × 1.25` | `M × 1.25` | `M × 1.25` |
| **medium** | `max(C, M) × 2` | `M × 1.5` | `M × 2` |
| **long** | `max(C, M) × 3` | `M × 3` | `M × 3` |

- **Floor:** every value is at least `max(5, 2 × poll)` seconds.
- **Rounding:** up to the next 30 s when at least 60 s; up to the next 5 s when below 60 s.
- **Tight can lower the limit.** Options are choices; the user picks.
- **Killed runs** contribute only to `K`. Their silence is censored at the limit, so they do not set a value.

All multipliers, thresholds, and rounding are starting values to tune from collected data.

## Commands

All run `command-watchdog-stats <subcommand>`.

### `stats`

Read-only. Opens `stats.db` with `mode=rw` and `query_only=ON`, runs only `SELECT`s, and never creates `stats.db` or its directory (SQLite may create empty `stats.db-wal` and `stats.db-shm` sidecars). A failed read-only open is reported, not raised.

When `stats.db` is absent: prints `stats disabled. Do you want to enable stats collection?` and nothing else.

When enabled, prints:

- Global totals per outcome, with the rtk proxy count, and the count of overridden runs, listed by variable name.
- For each measured statistic: average and max over successes.
- Kills by fired check and by reason, with count and share.
- Per rule section: rule version in use, current and previous side by side, kill rate, averages, maxima, `last_succeeded_at`, and `last_killed_at`.

### `suggest-timeouts`

Disabled: same prompt as `stats`; nothing computed.

Enabled: one rule section at a time. Shows that section's statistics and current values, then each check's three options with the recommendation marker and confidence. Then:

1. **Preview:** diff against that section in the data-directory INI.
2. **Apply on confirm:** `--apply` writes only after an explicit yes. The INI is written to a temp file and renamed into place. The current file is first copied to `watchdog-patterns.ini.bak-YYYYMMDD-HHMMSS`.

### `reset-stats`

Requires `--yes`. Copies `stats.db` to `stats-backup-YYYYMMDD-HHMMSS.db` with the SQLite online backup API, then clears `invocations`, `output_tail`, `counters`, and `rule_versions`, and resets `meta.last_prune`. The file stays, so collection stays on. Backups are never deleted.

### `delete-stats`

Requires `--all --yes`. Deletes `stats.db`, `stats.db-wal`, `stats.db-shm`, and every `stats-backup-*.db`. Leaves the INI and its backups. Collection turns off.

### `enable-stats`

Creates the schema in a temp file in the target directory, sets pragmas, writes `meta.schema_version`, and renames it to `stats.db`. Idempotent: an existing file is left alone. A corrupt file or an unknown `schema_version` is reported and not overwritten.

## Skill instruction

The model must not prefix commands with `WATCHDOG_*` values. A prefix is allowed only to retry a command the watchdog killed, with the limit raised, and the model states why in its reply.

The instruction lives in the plugin's skill file, `plugins/command-watchdog/skills/command-watchdog/SKILL.md`, the plugin's normal skill location. Writing it is add-on 12 (project task `#006`, low priority). Until then, the injection removal stops the source of the habit, but nothing instructs the model otherwise.

## Error handling

- Write failure, lock beyond 200 ms, or read-only filesystem: skip the write, log to the debug log, run unaffected.
- Unknown `schema_version`: writes disabled; the CLI reports the mismatch.
- Invalid INI value or regex: logged; that key or section falls through.
- INI write failure in `suggest-timeouts --apply`: the temp file is removed, the original is left unchanged, and the error is reported.
- Missing `stats.db`: disabled, not an error.

## Testing

Existing tests in `plugins/command-watchdog/tests/` are updated where they assert on the old `.txt` patterns file, the old `idle` reason name, the `WATCHDOG_IDLE` injection, or the old nice behavior. Each change is listed in the plan.

- **`stats_store.py`** on a temp directory: insert, sums, maxima, averages, pruning keeps counters and versions, output tail capped at 20 lines and 4096 characters.
- **Enums:** the emitted reasons equal `KillReason`; `FiredCheck` matches the kill path; the database `CHECK` constraints accept exactly these values; `outcome`, `kill_reason`, and `fired_check` agree.
- **Gate:** no `stats.db` means no file is created and no writes occur, including when `delete-stats` runs during a run.
- **`enable-stats`:** temp-then-rename; idempotent; a concurrent hook sees either no file or a complete one.
- **Rule versions:** a changed INI value creates a version; an unchanged value does not; an overridden run creates none; two racing hooks agree.
- **Overrides:** `WATCHDOG_IDLE=600 cmd` lifts the assignment and applies it; `env_overrides` is set; suggestions exclude the run.
- **Injection removed:** the rewrite no longer contains `WATCHDOG_IDLE=`.
- **Nice:** `nice: on` lowers priority; `nice: off` changes nothing and never returns 125. `WATCHDOG_NICE` is ignored, and a test asserts it. Rename and rewrite `test_environment_cannot_raise_task_priority` (`tests/test_nice.py`) to cover these states.
- **INI:** `-1` and `off` disable; `0` rejected for `idle` and `poll_cap`, accepted as off for `max_runtime`; `poll: off` rejected; `[rule:…]` regex order; invalid regex skipped; longest-prefix; word boundaries (`git` vs `gitk`); per-key fall-through; merge of plugin and data-directory files; `%` literal.
- **rtk (new tests):** `rtk hook claude < f` → primary `rtk`, signature `rtk hook`, limited by `[command:rtk]`; `rtk git status` → primary `git`; the wrapper no longer injects values. A process-level `WATCHDOG_MAX_RUNTIME=0` does not disable the rtk cap: the rtk call's environment has no `WATCHDOG_*` keys, and a built-in 15 s fallback applies if the INI lacks one.
- **Signature parsing:** `FOO=1 npm run build` → `npm run build`; `cd x && npm test` → `npm test`; `bash -c 'npm test'` → `npm test`; `git -C dir status` → `git status`; `npm run -s build -- --watch` → `npm run build`; `docker compose -f x.yml up` → `docker compose up`; `bin/rails test` → `rails test`; `--opt=value` is one token; a `]` falls back to the process.
- **Outcomes:** a child exiting 125 or 130 is `failed` with that code; a watchdog cancellation is `failed` with `128 + n`; a launch failure is `failed` with `125`; `killed` only from the kill path.
- **Suggestions:** one fixture per trigger and option; recommendation markers; all three options always shown; `N < 3` low confidence; `N = 0` message; `C = off`; floor applies to `M = 0`; rounding; `tight` below `C` under loosen pressure; overridden runs excluded; only the current version used.
- **Pruning:** the 24 h gate; never run from `rtk hook`.
- **`stats`:** read-only opens use `mode=rw` with `query_only=ON`; disabled prompt; never creates `stats.db` or its directory (SQLite may create empty `stats.db-wal` and `stats.db-shm` sidecars).
- **`reset-stats` and `delete-stats`:** backup contents; post-reset tables empty; delete removes WAL, SHM, and backups, and keeps the INI.
- **`suggest-timeouts`:** preview diff; apply writes after confirm; `.bak` created; temp-then-rename; failure leaves the original intact.
- **Output tail:** present for killed runs only; capped at 20 lines and 4096 characters.
- **Location:** `COMMAND_WATCHDOG_HOME` overrides the platform default; the default is used when unset.
- **Failure injection:** a broken database does not change exit status, kill decision, or command output.
- **CHECK constraint:** rows with `fired_check = 'idle'` or `'max_runtime'` and a NULL `kill_reason` are rejected. SQLite passes a CHECK that evaluates to NULL, so the clauses use `IS NOT NULL`.
- **Wrapper channel:** `--original`, `--rtk-proxied`, and `--set` arrive intact; lifted values not matching `^(-1|off|\d+)$` are rejected; a non-listed `WATCHDOG_*` assignment (for example `WATCHDOG_NICE=off`) is left in the command and not lifted.
- **Regex vs rtk:** `[rule:…]` matches the original command text when rtk has rewritten it.
- **Cancellation reentrancy:** a repeated signal during the cancellation write is ignored.
- **Variable names:** `stats` and `suggest-timeouts` name the variable behind each excluded run.
- **`-1` for `max_runtime`:** converted to `None` before the kill logic; the run is not killed at once.

## Documentation

The README (`README.md`, the `command-watchdog` section around lines 136 and 161) describes `hooks/watchdog-patterns.txt`, the nice and `WATCHDOG_NICE` behavior, and the `WATCHDOG_POLL_CAP` setting. Each is updated in the plan to match the INI format and the decided precedence. The CHANGELOG gets an entry when the change merges to `main`. The hook's module docstring on nice behavior (`command-watchdog.py:83-86`) and the denied-priority error text (`command-watchdog.py:778`) are updated to match the new nice rules.

## Open for review

- **`WATCHDOG_NICE`:** resolved. Removed for good; `nice` is INI-only, per command, with `nice: off` for rare exceptions.
- **Kill banner:** moved out of the MVP into add-on 11, low priority, tracked as project task `#005`. Until it ships, a killed command gets no retry guidance from the watchdog; only the skill instruction covers it.
- **Skill instruction location:** resolved. `plugins/command-watchdog/skills/command-watchdog/SKILL.md`, add-on 12.
- **Tuning values:** 25%, 75%, 3× gap, 50% success rate, 1.25 / 1.5 / 2 / 3 multipliers, floor, and rounding. All starting points.
- **Poll cap placement:** `poll_cap` is in `[global]` and per command. Confirm.

## Out of scope

- Automatic application of suggestions.
- Remote or shared stats across machines.
- Per-command-line rules. `command_line` is stored and displayed, not used for rules.
