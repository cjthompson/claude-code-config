# Fix "Usage: parse error" in statusline.sh

> Plan-file note: the harness designated `~/.claude/plans/…` for this file,
> but that write was denied (this repo's `CLAUDE.md` puts `~/.claude`
> off-limits, and the global rule prefers the repo `docs/` dir for plan/spec
> files — same precedent as `docs/plans/installer-reapply-review.md`).
> Written here instead.

## Context

Some Claude Code sessions show the statusline text `Usage: parse error`
instead of the normal powerline. That string is a hardcoded fallback in
`packages/statusline/statusline.sh:33`:

```bash
node --experimental-strip-types "$SCRIPT_DIR/statusline-render.mts" \
  "$TERM_WIDTH" "$input" "$GIT_BRANCH" \
  2>/dev/null || echo "Usage: parse error"
```

Any non-zero exit from the `node` renderer -- for any reason -- gets
collapsed into this one misleading string, and `2>/dev/null` throws away the
real error. Root cause investigation (systematic-debugging skill) required
finding what actually makes the renderer exit non-zero, since it clearly
doesn't happen on every session/machine.

**Root cause, confirmed by direct reproduction** (not guessed): in
`packages/statusline/statusline-render.mts`, `main()` normalizes
`session.rate_limits` like this (lines 401-413):

```ts
const rl = session.rate_limits;
const data: Record<string, any> = rl ? {
  five_hour: rl.five_hour ? {
    utilization: rl.five_hour.used_percentage,
    resets_at: new Date(rl.five_hour.resets_at * 1000).toISOString(),
  } : undefined,
  seven_day: rl.seven_day ? {
    utilization: rl.seven_day.used_percentage,
    resets_at: new Date(rl.seven_day.resets_at * 1000).toISOString(),
  } : undefined,
} : {};
```

When `session.rate_limits.five_hour` (or `.seven_day`) is present but its
`resets_at` field is missing/undefined -- e.g. a bucket that has usage but
hasn't started its reset window yet -- `resets_at * 1000` is `NaN`,
`new Date(NaN)` is an Invalid Date, and `.toISOString()` throws
`RangeError: Invalid time value`, uncaught. Confirmed by direct reproduction:

```
$ node --experimental-strip-types statusline-render.mts 80 \
    '{"model":{"display_name":"Sonnet"},"rate_limits":{"five_hour":{"used_percentage":10}}}' main
RangeError: Invalid time value
    at Date.toISOString (<anonymous>)
    at main (.../statusline-render.mts:407:58)
exit=1
```

A control run with both `resets_at` fields present exits 0 and renders
normally, isolating the trigger to that one field. Other candidate causes
were tested and ruled out: empty stdin, `{}`, missing `cost`/`context_window`,
and empty git branch all exit 0. (A genuinely malformed JSON string does also
reproduce the symptom via `JSON.parse`, but nothing indicates Claude Code
ever sends malformed JSON -- the `rate_limits` shape gap is the one
confirmed, reachable-in-practice cause, tied to the `rate_limits` feature
added in `7486d16`, 2026-06-04.)

`buildQuotaLine` (the consumer, lines 358-393) already handles a missing
`resets_at` gracefully -- `data.five_hour?.resets_at ? ... : ''` -- so the
crash is purely in the normalization step reaching for a field it assumed
would always be there.

Separately, `statusline.sh`'s blanket `2>/dev/null || echo "Usage: parse
error"` is a real defect independent of the trigger: it discards the real
stderr and always prints the same misdescriptive string, so any future
failure (regardless of cause) will again be undiagnosable from the statusline
alone. This is worth fixing on its own evidence.

Repo: `/Users/chris.thompson/dev/claude-code-config` (under `~/dev` -- no PR
required, no CI; still cut one branch per independently-shippable slice per
**PR Cadence**, from `origin/main`, and skip `gh pr create` unless asked).
Default branch confirmed via `git fetch` + `git symbolic-ref --short
refs/remotes/origin/HEAD` -> `origin/main`.

## Plan

Two independently-shippable slices, both cut from `origin/main`:

### Slice A -- `ct/statusline-ratelimit-crash-fix` (the actual bug fix)

In `packages/statusline/statusline-render.mts`, guard the `resets_at`
conversion so a bucket with usage but no reset timestamp degrades to
`resets_at: undefined` instead of throwing -- matching what `buildQuotaLine`
already expects:

```ts
five_hour: rl.five_hour ? {
  utilization: rl.five_hour.used_percentage,
  resets_at: rl.five_hour.resets_at
    ? new Date(rl.five_hour.resets_at * 1000).toISOString()
    : undefined,
} : undefined,
seven_day: rl.seven_day ? {
  utilization: rl.seven_day.used_percentage,
  resets_at: rl.seven_day.resets_at
    ? new Date(rl.seven_day.resets_at * 1000).toISOString()
    : undefined,
} : undefined,
```

Steps:
1. Apply the guard above to both `five_hour` and `seven_day`.
2. Re-run the reproduction commands from this plan's Context section
   (missing `resets_at` on `five_hour`, on `seven_day`, and the full-valid
   control) and confirm all three now exit 0 with a sane render.
3. Check for an existing test file: `packages/statusline/statusline-render.test.mts`
   is referenced elsewhere in the repo (`docs/plans/installer-reapply-review.md`)
   as this package's test convention (`node --experimental-strip-types --test`).
   Add a case there for "rate_limits bucket present without resets_at does not
   throw" if that file exists; otherwise note its absence rather than
   inventing a new test framework.
4. Per this repo's `CLAUDE.md` post-commit rule: bump `package.json` patch
   version, add a `CHANGELOG.md` entry dated today describing the crash and
   fix, and check whether `README.md` needs updating (unlikely -- this is an
   internal bugfix, not a behavior change to document).

### Slice B -- `ct/statusline-error-visibility` (independent hardening)

Make `statusline.sh`'s failure path diagnosable instead of a fixed
misleading string. Replace the blanket swallow with something that captures
the real stderr/exit code, e.g. redirect stderr to a small log file under
`${XDG_STATE_HOME:-$HOME/.local/state}/claude/` (matching the existing
pattern in `statusline-debug.sh`) while still printing a short, honest
statusline fallback (e.g. `statusline: render failed (see log)` instead of
the misleading `Usage: parse error`, which reads like a CLI-argument error
and isn't one). Keep the fallback itself cheap/robust -- it must never itself
throw or hang the statusline.

Steps:
1. Change the `|| echo "Usage: parse error"` line in `statusline.sh` to
   capture stderr and exit code, write them to a log file, and print a
   clearer, non-misleading fallback string.
2. Manually verify by forcing a failure (e.g. temporarily reintroduce the
   Slice A bug, or `chmod -x` the renderer) and confirming the log captures
   the real cause.
3. Version bump + CHANGELOG entry per this repo's `CLAUDE.md` post-commit
   rule.

These two slices touch disjoint files in practice (A: `statusline-render.mts`
+ its test; B: `statusline.sh`) and are reviewable/mergeable independently --
no dependency between them.

## Verification

- Slice A: the three reproduction commands in Context, run against the
  patched file, all exit 0 and print a rendered powerline (no stack trace).
- Slice B: force a renderer failure and confirm the statusline shows the new,
  honest fallback text and the log file contains the real exit code + stderr.
- After both: run the full statusline manually with a real Claude Code
  session (`bash ~/.claude/statusline.sh` piped a real session JSON, or just
  observe the next live session) to confirm no regression in the normal
  render path.

## Note on scope

Environment/PATH causes (Node version, mise/nvm shims, missing `node` on
PATH) were considered -- the sibling `packages/installer` docs
(`docs/plans/installer-reapply-review.md`) document a real mise-shim/`HOME`
fragility in this repo -- but were ruled out as *this* bug's trigger by
direct reproduction on this machine (empty input, `{}`, and missing optional
fields all succeed; only the `rate_limits.resets_at` gap reproduces the
crash). Not pursuing PATH-widening or Node-version-detection changes here
since there's no evidence tying them to this symptom; Slice B's improved
error logging is what would surface such a cause if it's ever actually in
play.
