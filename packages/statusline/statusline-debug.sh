#!/bin/bash
# Debug wrapper for statusline.sh — appends each render's session JSON to
# /tmp/statusline-debug.log, then delegates to statusline.sh so the real
# two-line powerline still renders. Used temporarily to inspect the session
# JSON Claude Code pipes in.
#
# Drop in by pointing ~/.claude/settings.json statusLine.command at this file
# instead of statusline.sh. To revert, point it back at statusline.sh.

set -o pipefail
umask 077 # all created files are owner-only (600)

LOG="${XDG_STATE_HOME:-$HOME/.local/state}/claude/statusline-debug.log"
mkdir -p "$(dirname "$LOG")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read stdin once into a variable, then fan out: to the log, and to the renderer.
input=$(cat)

# Append record: sentinel, ISO timestamp, pretty-printed session JSON, blank line.
# Pretty-print via node so multi-line JSON is human-scannable.
{
  printf '\n=== %s ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -n "$input" ]; then
    printf '%s' "$input" | node -e '
      let s = "";
      process.stdin.on("data", c => s += c);
      process.stdin.on("end", () => {
        try { console.log(JSON.stringify(JSON.parse(s), null, 2)); }
        catch { process.stdout.write(s); }
      });
    ' 2>/dev/null || printf '%s' "$input"
  else
    printf '(empty stdin)\n'
  fi
} >> "$LOG"

# Pass through to the real renderer with the captured stdin.
printf '%s' "$input" | bash "$SCRIPT_DIR/statusline.sh"
