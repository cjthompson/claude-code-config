# Claude Code Statusline

A two-line powerline-style statusline for Claude Code that displays session metrics, environment info, and Anthropic API quota usage — refreshed live inside the terminal.

Both lines are **width-aware** — segments are progressively dropped as the terminal narrows so lines never wrap.

```
 Opus 4.6 │ $2.10 │ $12.60/hr │ 45% ████░░░░ (90K/200K) │ ~1h1m left │ +100 -30 │ 10m ▶  improve-auth ▶  ~/d/my-project ▶
 5h 33% ████░░░░░░░░ 1h57m (2:00PM) │ 7d 16% ██░░░░░░░░░░ Fri 10:00AM │ (3m old) ▶
```

## Quick Start

The statusline is already active. It's configured in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  }
}
```

Claude Code pipes session JSON to the script via stdin on each render cycle. No manual invocation needed.

## Configuration

### Custom Model Context Window Sizes

Create `~/.claude/statusline-config.json` to override the context window size for specific models. This is useful when the context window size from Claude Code's session is inaccurate or you want to pin a different value.

```json
{
  "modelContextWindows": {
    "Claude Sonnet 4.6": 200000,
    "Claude Opus 4.8": 200000
  }
}
```

**Behavior:**
- Model names are matched **exactly** against `session.model.display_name` (the name shown in the statusline).
- When a model name matches, its configured window size is used instead of `context_window_size` from the session.
- When no config file exists or a model name doesn't match, the session value is used.
- The percentage displayed in the context window segment is calculated from actual token counts: `round((input_tokens + cache_creation_input_tokens + cache_read_input_tokens) / context_window_size * 100)`.

If the config file is absent or unparseable, the renderer silently falls back to the default behavior.

### Controlling Which Sections Appear

Add a `sections` array to `~/.claude/statusline-config.json` to choose which segments render and in what order. Only names in the array are shown — names absent from the list are suppressed.

When `sections` is absent from the config (or the file doesn't exist), all sections render in the default order.

```json
{
  "sections": [
    "model",
    "context_window",
    "usd_cost",
    "branch",
    "pwd",
    "line2"
  ]
}
```

Available section names:

| Name | Segment |
|---|---|
| `model` | Model name (e.g. `Opus 4.6`) |
| `usd_cost` | Total session cost (e.g. `$2.10`) |
| `burn_rate` | Cost per hour (e.g. `$12.60/hr`) |
| `context_window` | Context window usage (e.g. `45% ████░░░░ (90K/200K)`) |
| `time_to_full` | Estimated time until context window fills (e.g. `~1h1m left`) |
| `lines_changed` | Lines added/removed (e.g. `+100 -30`) |
| `duration` | Total session duration (e.g. `10m`) |
| `branch` | Git branch |
| `pwd` | Working directory |
| `line2` | The entire quota line (5h / 7d utilization) |

Unknown names are ignored, so adding future section names to the array won't break older versions.

### Disabling Account Usage (Line 2)

Set `CLAUDE_STATUSLINE_USAGE=0` to disable the account usage quota line. When disabled, no OAuth token retrieval or API calls are made — only Line 1 (session + environment) is rendered.

```bash
# In your shell profile (~/.bashrc, ~/.zshrc, config.fish, etc.)
export CLAUDE_STATUSLINE_USAGE=0
```

Enabled by default (`1`).

## Requirements

- **macOS** (uses `security` CLI for Keychain access and `stat -f %m` for file timestamps)
- **Node.js >= 22.7** (`--experimental-strip-types` with automatic ESM detection)
- **curl** (API calls to fetch quota)
- **git** (optional, for branch display)
- A terminal with **256-color support**

## Files

| File | Purpose |
|---|---|
| `statusline.sh` | Entry point — caching, token management, environment gathering |
| `statusline-render.mts` | Rendering engine — ANSI/powerline output, all display logic |
| `statusline-config.json` | Sample config — copied to `~/.claude/statusline-config.json` on install; users edit it for context-window overrides and section toggles |

Tests and dev tooling for this package live under `tests/packages/statusline/` at the repo root, not in this directory — kept out so they never ship as part of the installed package (see `manifest.json`'s `files` allowlist, which is a second, independent guard for the same goal). See **Running Tests** and **Manual Resize Testing** below.

## What It Shows

### Line 1 — Session + Environment

| Segment | Source | Example | Priority |
|---|---|---|---|
| Model name | `session.model.display_name` | `Opus 4.6` | protected — never dropped, never shrinks |
| Context window | `session.context_window` tokens or `~/.claude/statusline-config.json` override | `45% ████░░░░ (90K/200K)` | protected — shrinks instead of dropping (see below) |
| Git branch | `git rev-parse --abbrev-ref HEAD` | `improve-auth` | protected — shrinks instead of dropping (see below) |
| Working directory | `session.cwd` (parents shortened) | `~/d/my-project` | protected — never dropped; parent-dir abbreviation is unconditional, not width-driven |
| Session cost | `session.cost.total_cost_usd` | `$2.10` | 5 (first to drop) |
| Session duration | `session.cost.total_duration_ms` | `10m` | 6 |
| Lines changed | `session.cost.total_lines_{added,removed}` | `+100 -30` | 7 |
| Time to context limit | tokens remaining / token rate | `~1h1m left` | 9 |
| Burn rate | cost / duration (shown after 1 min) | `$12.60/hr` | 10 (last to drop) |

Segments are defined in display order, each with a `priority` number — higher means more important, kept longer. `fitSegments()` repeatedly removes the **lowest**-priority segment until the rendered line fits within `maxWidth`, stopping once only segments at or above `PROTECTED_PRIORITY` (100) remain. Model, context window, git branch, and working directory sit at that protected priority and are never removed by this loop — display order and priority are fully decoupled. If the protected four alone still don't fit a very narrow terminal, the line is left to wrap.

**Context window shrinking**: once every droppable segment is gone, if the line still doesn't fit, the context-window segment steps down through three tiers instead of disappearing: full (icon + % + bar + `(used/total)`) → drop the `(used/total)` suffix → drop the bar too, keeping only the icon and percentage.

**Branch shrinking**: also protected, also tiered — full name (up to 25 chars) → 18 chars → 12 chars, each with common prefixes (`chore/`, `feature/`, `feat/`, `fix/`, `bugfix/`, `hotfix/`, `release/`) stripped and long names trimmed with an ellipsis (e.g. `improve-playwrigh…`). Branch only starts shrinking once context has stepped through *all three* of its own tiers — context is denser information per column, so it gives up detail first.

**Path shortening**: All parent directories are collapsed to their first character. `~/dev/neat-core-js/.worktrees/sso` becomes `~/d/n/.w/sso`. The last segment is always preserved in full. Unlike branch, this abbreviation is unconditional — it happens at every width, not only when the line needs the room.

### Line 2 — API Quota

| Segment | Source | Example |
|---|---|---|
| 5-hour utilization | `data.five_hour.utilization` | `5h 33% ████░░░░░░░░` |
| 5-hour reset | `data.five_hour.resets_at` | `1h57m (2:00PM)` |
| 7-day utilization | `data.seven_day.utilization` | `7d 16% ██░░░░░░░░░░` |
| 7-day reset | `data.seven_day.resets_at` | `Fri 10:00AM` |
| Cache age | file mtime of usage cache | `(3m old)` |

Progress bars change color by utilization: green < 40%, yellow < 60%, orange < 80%, red >= 80%.

### Line 2 — Progressive Width Tiers

Line 2 uses pre-computed tiers from most to least detailed. The first tier that fits is used:

| Tier | Content |
|---|---|
| 0 (full) | `5h 33% ████░░░░ 1h57m (2:00PM) │ 7d 16% ██░░░░░░ Fri 10:00AM │ (3m old)` |
| 1 | Drop cache age |
| 2 | 5h reset: time only (`2:00PM`) |
| 3 | Drop 7d reset time |
| 4 | Drop 7d progress bar |
| 5 | Drop 5h progress bar |
| 6 | Drop 7d window entirely |
| 7 | Drop 5h reset time |
| 8 | Line 2 hidden entirely |

## Terminal Width Detection

Claude Code's statusline hook receives session JSON on stdin (piped), which means the subprocess has no TTY. Standard methods (`tput cols`, `$COLUMNS`) return incorrect values (80 or 0).

The script solves this by walking up the process tree (`$$ → parent → grandparent → ...`) to find an ancestor with a real TTY device, then queries `stty size` against that device:

```bash
_pid=$$
for _ in 1 2 3 4 5; do
  _tty=$(ps -o tty= -p "$_pid" 2>/dev/null | tr -d ' ')
  if [ -n "$_tty" ] && [ "$_tty" != "??" ]; then
    TERM_WIDTH=$(stty size <"/dev/$_tty" 2>/dev/null | awk '{print $2}')
    [ -n "$TERM_WIDTH" ] && break
  fi
  _pid=$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')
done
```

`maxWidth` is simply `termWidth` — Claude Code no longer renders anything in a right-aligned column next to the statusline, so no reserve is subtracted.

## Caching

Two cache files keep the statusline fast (typically <50ms render time):

| Cache | Path | TTL | Contents |
|---|---|---|---|
| Usage | `/tmp/claude-statusline-usage-cache` | 5 minutes | JSON response from `/api/oauth/usage` |
| Token | `/tmp/claude-statusline-token-cache` | Until OAuth expiry | Expiry timestamp + access token |

Both files are created with `umask 077` (owner-only, mode 600). The usage cache is only overwritten when the API returns a valid response containing `five_hour` data — stale-but-valid data is preferred over no data.

To force a refresh, delete the usage cache:

```bash
rm /tmp/claude-statusline-usage-cache
```

## Token Flow

1. Check `/tmp/claude-statusline-token-cache` for a non-expired token
2. If stale, extract the OAuth token from the macOS Keychain via `security find-generic-password`
3. Parse the `claudeAiOauth` credential for `accessToken` and `expiresAt`
4. Cache the token with its expiry for subsequent calls

## Running Tests

Test source lives in `tests/packages/statusline/`, not in this directory — see **Files** above for why.

```bash
node --experimental-strip-types --test tests/packages/statusline/statusline-render.test.mts
```

All pure functions in the renderer (`formatDuration`, `shortenPath`, `shortenBranch`, `fitSegments`, `buildContextTiers`, `buildBranchTiers`, `progressBar`, `quotaSeg`, etc.) are exported and unit-tested. A set of end-to-end tests verify the full rendering pipeline — including monotonicity (widening the terminal never drops a block) and shrink order (context tiers exhaust before branch starts shrinking) — by spawning the renderer as a subprocess with mock data.

## Manual Resize Testing

`tests/packages/statusline/statusline-resize-sweep.mts` renders the statusline at every width across a range with one fixed session payload, so you can eyeball exactly how segments drop and shrink as you tweak `fitSegments`/tiers. It's a dev tool, not an automated test — pair it with `statusline-render.test.mts` for regression coverage.

```bash
# Default: width 120 -> 20, current git branch, bundled fixture
node --experimental-strip-types tests/packages/statusline/statusline-resize-sweep.mts

# Compact transition view (only widths where line 1 actually changes)
node --experimental-strip-types tests/packages/statusline/statusline-resize-sweep.mts --summary

# Also save a plain (ANSI-stripped) copy for diffing against a previous run
node --experimental-strip-types tests/packages/statusline/statusline-resize-sweep.mts --summary --out /tmp/sweep.txt

# Custom range, branch, or payload
node --experimental-strip-types tests/packages/statusline/statusline-resize-sweep.mts --from 200 --to 10 --branch chore/some-branch --payload ./my-fixture.json
```

Edit `tests/packages/statusline/statusline-resize-sweep-fixture.json` to change the session data used (cost, token counts, rate limits, etc.) without touching the script.

## Architecture

```
Claude Code
    │ stdin (session JSON)
    ▼
statusline.sh
    ├── get_token()      → Keychain / token cache
    ├── fetch_usage()    → Anthropic API / usage cache
    ├── environment      → git branch, terminal width (via process tree TTY walk)
    │
    ▼ process.argv
statusline-render.mts
    ├── renderPowerline()  → groups segments by section, builds powerline string
    ├── fitSegments()      → drops lowest-priority segments until line fits
    ├── Line 1: segments with drop priorities → fitSegments(segs, maxWidth)
    │   Sections: green(22) ▶ blue(24) ▶ gray(237)
    └── Line 2: pre-computed tiers → first tier that fits maxWidth
```

The shell script handles I/O and caching (what bash is good at). The TypeScript renderer handles ANSI string construction and layout (where type safety and string manipulation matter). They communicate entirely through `process.argv` — no shell variable interpolation into JS source.
