#!/usr/bin/env bash
# typescript-lsp.sh — locate an installed TypeScript 7 `tsc` and launch it in LSP mode.
#
# `tsc --lsp --stdio` is the native LSP entry point in TypeScript 7 (the Go-based
# rewrite). `npx` does not reliably forward the `--lsp` flag to the resolved binary,
# so this script performs the discovery itself and then execs the resolved path
# with the LSP flags directly.
#
# Search order (a candidate is accepted only when it reports TypeScript 7):
#   1. $TS_LSP_BIN
#   2. ./node_modules/.bin/tsc — relative to cwd, so the edited project's own
#      TypeScript wins over a global install
#   3. $PATH
#   4. Common Homebrew install paths (macOS Apple Silicon, macOS Intel, Linuxbrew)
#
# Usage:
#   typescript-lsp.sh                     exec `tsc --lsp --stdio` (drop-in LSP command)
#   typescript-lsp.sh --check | --print   print the resolved binary, then exit
#
# Exit codes: 0 on success, 1 when no TypeScript 7 binary is found.
#
# Written to the bash 3.2 subset — no associative arrays, no mapfile, and regex
# operands must be unquoted variables rather than literals. The `env` shebang
# means the interpreter is whichever bash comes first on PATH, which on macOS is
# 3.2 from /bin but often 5.x from Homebrew, so the script has to run correctly
# under both. That subset is forward-compatible: `${arr[@]:-}` and the unquoted
# =~ operand behave identically on 5.x.

set -uo pipefail

HOMEBREW_CANDIDATES=(
  /opt/homebrew/lib/node_modules/typescript/bin/tsc
  /usr/local/lib/node_modules/typescript/bin/tsc
  /home/linuxbrew/.linuxbrew/lib/node_modules/typescript/bin/tsc
)

# Emit every candidate path in priority order, one per line.
candidate_paths() {
  if [ -n "${TS_LSP_BIN:-}" ]; then
    printf '%s\n' "$TS_LSP_BIN"
  fi

  printf '%s\n' "$PWD/node_modules/.bin/tsc"

  local _dir
  local _path_dirs
  local _old_ifs="$IFS"
  IFS=':'
  # Unquoted on purpose: word-splitting on ':' is how PATH is parsed.
  # shellcheck disable=SC2206
  _path_dirs=(${PATH:-})
  IFS="$_old_ifs"
  # The :- guard is required under `set -u`: in bash 3.2, expanding an empty
  # array as ${arr[@]} is an unbound-variable error. On an empty array this
  # yields a single empty string, which the -n test below discards.
  for _dir in "${_path_dirs[@]:-}"; do
    # An empty PATH entry means "cwd"; skip it rather than probing ./tsc.
    if [ -n "$_dir" ]; then
      printf '%s\n' "${_dir%/}/tsc"
    fi
  done

  printf '%s\n' "${HOMEBREW_CANDIDATES[@]}"
}

# Succeed only when $1 is an executable file reporting TypeScript major version 7.
is_typescript_7() {
  local _binary="$1"
  local _output
  local _re='^Version[[:space:]]+7\.'

  [ -f "$_binary" ] && [ -x "$_binary" ] || return 1

  # </dev/null so a candidate that unexpectedly reads stdin cannot consume the
  # LSP client's framed requests or hang the probe.
  _output=$("$_binary" --version 2>/dev/null </dev/null) || return 1

  [[ $_output =~ $_re ]]
}

# Print the first candidate that is TypeScript 7; return 1 if none qualify.
resolve_tsc() {
  local _candidate
  local _seen=""

  while IFS= read -r _candidate; do
    [ -n "$_candidate" ] || continue

    # Cheap dedupe: PATH routinely repeats directories, and each miss costs a
    # process spawn. bash 3.2 has no associative arrays, so track seen paths in
    # a '|'-delimited string. Two caveats, both benign here:
    #   - Lookup is a substring scan, so this is O(n^2) overall. PATH is bounded
    #     at a few dozen entries, so the constant beats spawning duplicate probes.
    #   - A path containing a literal '|' could in principle collide. POSIX only
    #     forbids '/' and NUL in filenames, so it is legal but not observed in
    #     practice; the cost of a collision is one skipped candidate, and the
    #     search simply continues.
    # The pattern is quoted, which suppresses glob interpretation of the
    # candidate — so paths containing *, ? or [ ] match literally.
    case "$_seen" in
      *"|$_candidate|"*) continue ;;
    esac
    _seen="$_seen|$_candidate|"

    if is_typescript_7 "$_candidate"; then
      printf '%s\n' "$_candidate"
      return 0
    fi
  done < <(candidate_paths)

  return 1
}

die_not_found() {
  # printf is a shell builtin; `cat` here would be an external binary and would
  # itself fail with "command not found" whenever PATH is broken — which is one
  # of the very situations that lands us in this function.
  printf '%s\n' \
    "typescript-lsp: could not locate a TypeScript 7 binary." \
    "Searched (continuing past anything that wasn't version 7):" \
    "  - \$TS_LSP_BIN (${TS_LSP_BIN:-unset})" \
    "  - ./node_modules/.bin/tsc" \
    "  - \$PATH" \
    "  - /opt/homebrew/lib/node_modules/typescript/bin/tsc" \
    "  - /usr/local/lib/node_modules/typescript/bin/tsc" \
    "  - /home/linuxbrew/.linuxbrew/lib/node_modules/typescript/bin/tsc" \
    "Install TypeScript 7 globally (e.g. \`npm i -g typescript@7\`) and try again." >&2
  exit 1
}

main() {
  local _mode="serve"

  case "${1:-}" in
    --check|--print) _mode="check" ;;
    "") ;;
    *)
      printf 'typescript-lsp: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac

  local _binary
  _binary=$(resolve_tsc) || die_not_found

  if [ "$_mode" = "check" ]; then
    printf '%s\n' "$_binary"
    exit 0
  fi

  # exec replaces this shell, so stdio is inherited and signals reach the server
  # directly — no wrapper process left in the middle to forward them.
  exec "$_binary" --lsp --stdio
}

main "$@"
