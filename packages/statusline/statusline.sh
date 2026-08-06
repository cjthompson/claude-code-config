#!/bin/bash
# Claude Code statusline — two-line powerline with session, environment, and quota info
# Rate-limit data (5h/7d) comes in via stdin session JSON (rate_limits field).

set -o pipefail

input=$(cat)

# Walk up the process tree to find a parent with a real TTY, then query its size.
# Needed because Claude Code's hook subprocess has no TTY of its own.
TERM_WIDTH=""
_pid=$$
for _ in 1 2 3 4 5; do
  _tty=$(ps -o tty= -p "$_pid" 2>/dev/null | tr -d ' ')
  if [ -n "$_tty" ] && [ "$_tty" != "??" ] && [ "$_tty" != "?" ]; then
    # Linux ps returns "pts/0", macOS returns "s000"
    _dev="/dev/$_tty"
    [ ! -e "$_dev" ] && _dev="/dev/tty$_tty"
    TERM_WIDTH=$(stty size <"$_dev" 2>/dev/null | awk '{print $2}')
    [ -n "$TERM_WIDTH" ] && break
  fi
  _pid=$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')
  [ -z "$_pid" ] || [ "$_pid" = "1" ] && break
done
TERM_WIDTH="${TERM_WIDTH:-80}"

GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

# Render statusline
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Bare `node` resolves via mise using the *calling session's* cwd, so a
# project that pins an older node (e.g. node=20, which lacks
# --experimental-strip-types) breaks the statusline for any session rooted
# there. Pin an explicit major version, bypassing that cwd-based lookup —
# `mise x node@<major>` reuses whatever patch of that major is already
# installed and only hits the network if none is, so this stays offline as
# long as node@24 has ever been installed on this machine.
if command -v mise >/dev/null 2>&1; then
  NODE_CMD=(mise x node@24 -- node)
else
  NODE_CMD=(node)
fi

# Keep the renderer's stdout/stderr separate so a successful render's
# on-purpose-discarded warnings (e.g. a bad statusline-config.json) never
# leak into the statusline text. Only a failure gets logged.
umask 077 # error log may briefly hold path/argv details; owner-only
STDOUT_FILE=$(mktemp) || exit 0
STDERR_FILE=$(mktemp) || exit 0
trap 'rm -f "$STDOUT_FILE" "$STDERR_FILE"' EXIT

"${NODE_CMD[@]}" --experimental-strip-types "$SCRIPT_DIR/statusline-render.mts" \
  "$TERM_WIDTH" "$input" "$GIT_BRANCH" \
  >"$STDOUT_FILE" 2>"$STDERR_FILE"
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  cat "$STDOUT_FILE"
else
  LOG="${XDG_STATE_HOME:-$HOME/.local/state}/claude/statusline-error.log"
  mkdir -p "$(dirname "$LOG")"
  {
    printf '=== %s (exit %s) ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STATUS"
    cat "$STDERR_FILE"
  } >>"$LOG"
  if grep -q -- '--experimental-strip-types' "$STDERR_FILE" 2>/dev/null; then
    FOUND_VER=$("${NODE_CMD[@]}" --version 2>/dev/null || echo "unknown")
    echo "statusline: needs Node >=22.7 for --experimental-strip-types (resolved node: $FOUND_VER) — see $LOG"
  else
    echo "statusline: render failed (exit $STATUS) — see $LOG"
  fi
fi
