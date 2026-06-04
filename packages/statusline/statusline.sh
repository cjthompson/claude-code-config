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
node --experimental-strip-types "$SCRIPT_DIR/statusline-render.mts" \
  "$TERM_WIDTH" "$input" "$GIT_BRANCH" \
  2>/dev/null || echo "Usage: parse error"
