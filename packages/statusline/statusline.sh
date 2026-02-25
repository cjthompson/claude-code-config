#!/bin/bash
# Claude Code statusline — two-line powerline with session, environment, and quota info
# Caches OAuth token until expiry, caches usage response for 5 minutes

set -o pipefail
umask 077 # all files created by this script are owner-only (600)

input=$(cat)

USAGE_CACHE="/tmp/claude-statusline-usage-cache"
TOKEN_CACHE="/tmp/claude-statusline-token-cache"
USAGE_MAX_AGE=300 # 5 minutes

# Check if a cache file exists and is younger than max_age seconds
is_fresh() {
  [ -f "$1" ] && {
    local now=$(date +%s)
    local mtime=$(stat -f %m "$1" 2>/dev/null)
    [ -n "$mtime" ] && [ $((now - mtime)) -lt "$2" ]
  }
}

# Get the cached OAuth token, or extract from Keychain if expired
get_token() {
  if [ -f "$TOKEN_CACHE" ]; then
    local expiry token now
    expiry=$(head -1 "$TOKEN_CACHE")
    token=$(tail -1 "$TOKEN_CACHE")
    now=$(date +%s)
    if [ -n "$expiry" ] && [ -n "$token" ] && [ "$now" -lt "$expiry" ] 2>/dev/null; then
      echo "$token"
      return 0
    fi
  fi

  local raw
  raw=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | xxd -r -p)
  [ -z "$raw" ] && return 1

  local token expires_ms expires_s
  token=$(echo "$raw" | grep -oE '"claudeAiOauth":\{"accessToken":"[^"]+"' | grep -oE 'sk-ant-oat[^"]+')
  expires_ms=$(echo "$raw" | grep -oE '"claudeAiOauth":\{"accessToken":"[^"]+","refreshToken":"[^"]+","expiresAt":([0-9]+)' | grep -oE 'expiresAt":[0-9]+' | grep -oE '[0-9]+')
  [ -z "$token" ] && return 1

  if [ -n "$expires_ms" ]; then
    expires_s=$((expires_ms / 1000))
  else
    expires_s=$(( $(date +%s) + 3600 ))
  fi

  printf '%s\n%s\n' "$expires_s" "$token" > "$TOKEN_CACHE"
  echo "$token"
}

# Fetch usage from API and update cache (only overwrites on valid response)
fetch_usage() {
  local token
  token=$(get_token) || return 1

  local response
  response=$(curl -s -4 --max-time 15 "https://api.anthropic.com/api/oauth/usage" \
    -H "Authorization: Bearer $token" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "User-Agent: claude-code/statusline")

  # Only update cache if we got a valid JSON response with expected data
  if echo "$response" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.exit(d && d.five_hour ? 0 : 1);
  " 2>/dev/null; then
    echo "$response" > "$USAGE_CACHE"
  fi
}

# Refresh usage cache if stale
if ! is_fresh "$USAGE_CACHE" $USAGE_MAX_AGE; then
  fetch_usage
fi

if [ ! -f "$USAGE_CACHE" ]; then
  echo "Usage: unavailable"
  exit 0
fi

# Gather environment info
CACHE_MTIME=$(stat -f %m "$USAGE_CACHE" 2>/dev/null || echo 0)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
TERM_WIDTH=$(tput cols 2>/dev/null || echo 120)

# Render statusline
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node --experimental-strip-types "$SCRIPT_DIR/statusline-render.ts" \
  "$USAGE_CACHE" "$CACHE_MTIME" "$TERM_WIDTH" "$input" "$GIT_BRANCH" \
  2>/dev/null || echo "Usage: parse error"
