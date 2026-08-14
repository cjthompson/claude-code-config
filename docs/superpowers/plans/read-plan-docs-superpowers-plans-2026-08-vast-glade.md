# Review: Staged TypeScript LSP Recovery Proxy vs. Plan

## Context

The repo has staged changes that implement the TypeScript LSP recovery proxy specified in
`docs/superpowers/plans/2026-08-12-typescript-lsp-recovery-proxy.md`. This review compares the staged
code to that plan to identify gaps, contradictions, and bugs before the work is committed.

Staged files in scope:
- `plugins/typescript-development/scripts/typescript-lsp.mjs` (new)
- `plugins/typescript-development/scripts/typescript-lsp.sh` (new, baseline resolver)
- `plugins/typescript-development/.lsp.json` (new)
- `tests/plugins/typescript-development/lsp.test.mjs` (new)
- `tests/plugins/typescript-development/fixtures/crashing-lsp.mjs` (new)
- `tests/plugins/typescript-development/structure.test.mjs` (modified)
- `README.md` and `CHANGELOG.md` (modified)

The plan's hard global constraints are all honored by the staged code:
- Proxy invokes `typescript-lsp.sh --check`; does not duplicate the resolver. ✓
- stdout contains only LSP `Content-Length` frames. ✓ (asserted in one test)
- Up to 5 child crashes with delays `[250, 500, 1000, 2000, 4000]` ms. ✓
- Queue cap `1_048_576` bytes / `10_000` ms. ✓
- Recovery core is `initialize`/`initialized`, `workspace/didChangeConfiguration`, workspace folder
  notifications, `textDocument/didOpen`/`didChange`/`didClose`, plus recorded server-request
  responses. ✓

---

## Findings

### F1 — Test/proxy behavior contradicts the plan on pending requests — **HIGH**

**Location:** `tests/plugins/typescript-development/lsp.test.mjs`, test
`"wrapper restores an unsaved document after the native server crashes"`.

The plan (Task 3, Step 3) is explicit:
> "Cancel/error outstanding client requests that belonged to the crashed child rather than retrying them."

The proxy implements that directive in `RecoveryProxy.handleExit` by calling
`failPendingClientRequests`, which writes a JSON-RPC `InternalError` to stdout for every
`pendingClientRequests` id and clears the map. That part of the implementation matches the plan.

The test, however, expects a *successful retry*. The test writes `textDocument/hover` with `id: 2`
to the proxy *before* the crash-inducing `didChange`, then waits for
`decodeFrames(stdout).find(m => m.id === 2)` to be `{ result: { contents: "recovered" } }`.

Trace:
1. Client → proxy: hover (id=2). Proxy records id=2 in `pendingClientRequests`, forwards to child.
2. Client → proxy: didChange. Proxy forwards; child (fixture launch 1) crashes.
3. Proxy `handleExit` → `failPendingClientRequests(...)` writes
   `{ id: 2, error: { code: -32603, ... } }` to stdout.
4. Test `find(...)` returns the error response (first match on `id === 2`).
5. Assertion `assert.deepEqual(response.result, { contents: "recovered" })` fails — there is no
   `result`.

There's a latent race too: if the fixture on launch 1 manages to send its
`{ contents: "recovered" }` response before the crash closes the pipe, `routeServer` would forward
it as well (only `pendingClientRequests.delete(message.id)` runs there). The test then races
between first match being error vs result depending on chunk ordering. It cannot reliably pass
either way.

**Resolution — pick one:**
- **A. Honor the plan.** Update the test to assert `response.error.code === -32603` (and that this
  response arrives before any successful retry from queued-traffic replay on launch 2).
- **B. Honor the test.** Remove `failPendingClientRequests` from `handleExit`; instead re-route
  pending client requests to the replacement after `snapshot.replay` and the queued flush. Update
  the plan to match.

Recommend A — it preserves the plan's contract and is a smaller change.

### F2 — Plan naming vs. implemented naming — **LOW**

| Plan name | Code name | Where |
|-----------|-----------|-------|
| `LspFrameReader` | `FrameReader` | `typescript-lsp.mjs` |
| `SessionSnapshot.observeClient(message)` | `SessionSnapshot.observe(message)` | `typescript-lsp.mjs` |
| `applyContentChanges(text, changes)` | `applyChanges(text, changes)` | `typescript-lsp.mjs` |
| `PendingClientQueue` (class, `10000`/`1048576` limits) | Inline `queued`/`queuedBytes`/`enqueue`/`startQueueTimer` on `RecoveryProxy` | `typescript-lsp.mjs` |

Constants (`MAX_QUEUE_BYTES = 1_048_576`, `MAX_QUEUE_MS = 10_000`, `STDERR_TAIL_BYTES = 4_096`,
`RECOVERY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000]`, `MAX_RECOVERIES = 5`) match exactly.

**Recommendation:** Decide whether the plan is normative. If yes, rename. If the plan is a sketch
and the code is authoritative, update the plan so the next reviewer doesn't flag this again.

### F3 — Test helper `spawnProxy(options)` missing — **LOW**

Plan Task 1, Step 3 calls for a `spawnProxy(options)` helper that drives the real Node wrapper over
stdio. The test file has `encodeFrame`, `decodeFrames`, `probeLsp`, `directTscChild`,
`waitForLspMessage`, and `assertFile` — but no `spawnProxy`. The recovery test inlines its own
spawn; the live-recovery test does the same.

**Recommendation:** Add `spawnProxy(options)` (returning `{ child, stdout, stderr, write, finish }`)
and have the recovery and live-recovery tests use it. Keep `probeLsp` only for the
symlink/foreign-cwd probe where it has distinct completion semantics.

### F4 — Fixture issues `client/registerCapability`, not the configuration request the plan implies — **LOW**

Plan Task 1, Step 1: fixture flags "make a deterministic fake LSP … issue a configuration request …".
The fixture in `crashing-lsp.mjs` issues `client/registerCapability`. The proxy supports both (same
allowlist), so the recovery path is exercised either way. Strictly, the fixture does not match the
plan's wording.

**Recommendation:** Either update the plan wording (the allowlist-driven approach is the right
design), or have the fixture exercise `workspace/configuration` too so both branches are covered.

### F5 — Missing test coverage for several plan requirements — **MEDIUM**

| Plan requirement | Staged coverage |
|------------------|-----------------|
| Retry delays scheduled in the five-step sequence | None — no test asserts 250/500/1000/2000/4000 |
| Sixth failure exits nonzero with bounded stderr summary | None — `MAX_RECOVERIES = 5` path not exercised |
| `didClose` removes the document | None |
| Malformed `Content-Length` → controlled failure without stdout contamination | None |
| Invalid change range → controlled failure without stdout contamination | None |
| `didOpen` followed by ranged `didChange` → one replayable full-text document | Partial (only via the recovery test) |
| stdout purity under all paths | Asserted once in the recovery test only |

**Recommendation:** Add at minimum: an exhaustion test that triggers 6 crashes and asserts
`process.exitCode === 1` plus a stderr summary containing `recovery 5/5`, and a malformed-frame
test that asserts a clean stdout and a nonzero exit.

### F6 — Dead code in `handleServerRequest` — **LOW**

```js
const cached = this.serverRequestResponses.get(requestKey);
if (cached) {
    writeFrame(this.child.stdin, { jsonrpc: "2.0", id: message.id, ...cached });
    return;
}
if (this.state === "recovering") {
    if (!cached) {                              // always true at this point
        this.fail(`replacement TypeScript LSP requested uncached ${message.method}`);
        return;
    }
}
```

The inner `if (!cached)` is unreachable as a falsy branch — the prior `if (cached) { ... return; }`
exits on any truthy cache. Harmless; the outer `if (state === "recovering")` already handles the
fail case correctly.

**Recommendation:** Drop the inner `if (!cached)`, or restructure into one branch.

### F7 — `npm test` script does not exist — **MEDIUM**

Plan Task 4, Step 5:
> "Run: `npm test && npm run typecheck`"

`package.json`:
```json
"scripts": {
    "install-packages": "...",
    "reinstall": "...",
    "install-package": "...",
    "typecheck": "tsc --noEmit -p packages/installer/tsconfig.json"
}
```

There is no `"test"` script. `npm test` will fail with `Missing script: test`.

**Recommendation:** Add `"test": "node --test tests/**/*.test.mjs"` (or whatever glob pattern the
repo's workspaces already use), or correct the plan's verification command to run the explicit
`node --test tests/plugins/typescript-development/lsp.test.mjs` and `structure.test.mjs`
invocations used in Tasks 1–3.

### F8 — `workspace/didChangeConfiguration` invalidates the server-request response cache — **INFO**

`RecoveryProxy.routeClient` calls `this.serverRequestResponses.clear()` whenever it routes a
`workspace/didChangeConfiguration`. Reasonable (server may want a different configuration), but
unintended consequence: if the client changes configuration mid-recovery, every cached
`workspace/configuration` becomes a no-cache miss, and the proxy will fail the replacement on any
such request that follows during recovery.

**Recommendation:** Document the intended behavior in the plan (or in a one-line comment in
`routeClient`).

### F9 — `.lsp.json` validation — **NONE — covered**

Already covered by `"plugin owns exactly one .lsp.json keyed by language"`,
`"lsp args resolve from the plugin root, never the subprocess cwd"`, and
`"Node recovery proxy delegates TypeScript discovery to the Bash resolver"`.

### F10 — Documentation & changelog — **NONE — covered**

`README.md` `### typescript-development` documents the control path, retry/backoff, queue bounds,
stderr-only diagnostics, post-exhaustion handoff, and `$TS_LSP_BIN`. `CHANGELOG.md` v0.0.67 has an
entry for the recovery proxy upgrade.

### F11 — Recovery-state branch in `handleServerRequest` — **INFO**

When in `"recovering"` state, every supported server request would in practice have a cached
response (reached recovery only after exercising the request). In the rare case the replacement asks
a question for which no prior response exists, the proxy fails — matches the plan's "fail closed"
rule. Correct behavior, but the reasoning is not in the doc.

**Recommendation:** One-line comment near `if (this.state === "recovering")` explaining the
fall-through-to-fail intent.

### F12 — `argv[1]` entry guard regression test — **NONE — covered**

The `"wrapper has no argv[1] entry guard"` test strips comments before regex-searching, so prose
about the bug does not satisfy or trip the check. Correct.

---

## Recommended Follow-up Tasks (priority order)

1. **Resolve F1** — pick A (honor plan) or B (honor test); update test and/or proxy so the
   assertion passes.
2. **Resolve F7** — add a `"test"` script to `package.json` or correct the plan's verification
   command.
3. **Add coverage for F5** — retry sequence, exhaustion, malformed-input, didClose, invalid range.
4. **Resolve F2 and F4** — reconcile plan/code naming and fixture request type.
5. **Add F3 (`spawnProxy`) helper** to deduplicate test setup.
6. **Trim F6 dead code** while editing.
7. **Verify locally** — `node --test tests/plugins/typescript-development/lsp.test.mjs` and
   `structure.test.mjs` should both pass; the live-recovery test self-skips if TypeScript 7 isn't
   installed (only skip expected).

## Critical Files to Modify (if executing fixes)

- `tests/plugins/typescript-development/lsp.test.mjs` — F1, F3, F5
- `plugins/typescript-development/scripts/typescript-lsp.mjs` — F2 (renames), F6, possibly F1 (option B)
- `package.json` — F7
- `docs/superpowers/plans/2026-08-12-typescript-lsp-recovery-proxy.md` — F2/F4 (if plan should match code)

## Verification

After fixes:

```
node --test tests/plugins/typescript-development/lsp.test.mjs
node --test tests/plugins/typescript-development/structure.test.mjs
npm run typecheck
```

The first must pass with no stdout protocol contamination. The live-recovery test self-skips if
TypeScript 7 isn't installed — that is the only expected skip.