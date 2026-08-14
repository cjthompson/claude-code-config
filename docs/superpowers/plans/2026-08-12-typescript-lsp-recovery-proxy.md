# TypeScript LSP Recovery Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TypeScript 7 LSP launcher recover a crashed native `tsc` without losing the current LSP session state, while retaining the Bash launcher as an unchanged comparison baseline.

**Architecture:** The Node launcher becomes a stdio JSON-RPC proxy. It asks the existing Bash resolver for the validated TypeScript 7 executable, forwards framed messages to one `tsc` child, and retains only replayable client state: initialization inputs, configuration, workspace notifications, and the current full text of open documents. On a crash it starts a replacement with bounded exponential backoff, initializes it internally, replays that snapshot, then releases a bounded FIFO of client traffic. Unsupported server-to-client behavior fails closed so Claude Code can recreate a fresh LSP session.

**Tech Stack:** Node.js ESM, `node:child_process`, `node:stream`, `node:test`, existing Bash 3.2 resolver.

**Spec:** Approved design conversation, 2026-08-12.

## Global Constraints

- Do not modify `plugins/typescript-development/scripts/typescript-lsp.sh`; it is the direct-exec baseline and the sole TypeScript 7 binary-discovery policy.
- The Node proxy must invoke that resolver as `typescript-lsp.sh --check` and never duplicate its PATH/Homebrew/version search.
- stdout contains only valid LSP `Content-Length` frames; all proxy diagnostics go to stderr.
- Recover at most five child crashes per wrapper process, with waits of 250 ms, 500 ms, 1 s, 2 s, and 4 s; after that exit nonzero for Claude Code's existing `maxRestarts: 3` handling.
- While recovering, buffer at most 10 seconds or 1 MiB of client-originated LSP frames in original order. On either limit, reply to queued requests with JSON-RPC `InternalError` and drop queued notifications, then terminate nonzero.
- The supported recovery core is `initialize`/`initialized`, `workspace/didChangeConfiguration`, workspace folder notifications, `textDocument/didOpen`, `textDocument/didChange`, and `textDocument/didClose`, plus recorded responses to known server requests. Unsupported server-originated requests or registrations cause a concise stderr reason and a nonzero exit.

---

### Task 1: Establish framed-protocol and fixture tests

**Files:**
- Create: `tests/plugins/typescript-development/fixtures/crashing-lsp.mjs`
- Modify: `tests/plugins/typescript-development/lsp.test.mjs`

**Interfaces:**
- Produces: fixture flags that make a deterministic fake LSP acknowledge initialize, record notifications, issue a configuration request, or exit at a selected protocol point.
- Produces: test helpers `encodeFrame(message)`, `decodeFrames(text)`, and `spawnProxy(options)` that drive the real Node wrapper over stdio.

- [ ] **Step 1: Write failing protocol tests**

Add tests that start the wrapper with `TS_LSP_BIN` pointing at the fake executable and assert that it forwards a framed initialize response unchanged, captures the current document text after an incremental `didChange`, and never writes diagnostics to stdout.

- [ ] **Step 2: Run the focused test file and verify the new assertions fail because the proxy behavior is absent**

Run: `node --test tests/plugins/typescript-development/lsp.test.mjs`

Expected: existing structural tests pass; new recovery assertions fail against the transparent one-child wrapper.

- [ ] **Step 3: Implement only fixture framing and test helpers**

The fixture must parse `Content-Length` framing, write protocol frames itself, and expose received messages through deterministic responses. Do not change production behavior in this task.

- [ ] **Step 4: Re-run the focused tests**

Run: `node --test tests/plugins/typescript-development/lsp.test.mjs`

Expected: helpers execute and the behavioral recovery assertions remain red.

### Task 2: Add a strict LSP JSON-RPC proxy and state snapshot

**Files:**
- Modify: `plugins/typescript-development/scripts/typescript-lsp.mjs`
- Modify: `tests/plugins/typescript-development/lsp.test.mjs`

**Interfaces:**
- Produces: `LspFrameReader`, accepting byte chunks and emitting complete JSON-RPC messages only after a valid `Content-Length` frame.
- Produces: `SessionSnapshot`, with `observeClient(message)`, `documents`, `initializeParams`, and latest state notifications.
- Produces: `applyContentChanges(text, changes)` for full and ranged LSP document changes, preserving client versions and rejecting impossible ranges.

- [ ] **Step 1: Write failing snapshot tests**

Add assertions that `didOpen` followed by a ranged `didChange` yields one replayable full-text document, `didClose` removes it, and malformed frames/invalid change ranges produce a controlled proxy failure rather than corrupting stdout.

- [ ] **Step 2: Verify those assertions fail**

Run: `node --test tests/plugins/typescript-development/lsp.test.mjs`

Expected: failures identify missing framing/state APIs.

- [ ] **Step 3: Implement the framing parser and narrow state model**

Keep parsing, document-range application, and snapshot mutation in focused local classes/functions in the Node launcher. Retain no request transcript, diagnostics cache, or closed-document content. Call `typescript-lsp.sh --check` with inherited environment to resolve the child binary.

- [ ] **Step 4: Verify the snapshot tests pass**

Run: `node --test tests/plugins/typescript-development/lsp.test.mjs`

Expected: all Task 1 and Task 2 assertions pass.

### Task 3: Implement crash recovery and fail-closed protocol handling

**Files:**
- Modify: `plugins/typescript-development/scripts/typescript-lsp.mjs`
- Modify: `tests/plugins/typescript-development/fixtures/crashing-lsp.mjs`
- Modify: `tests/plugins/typescript-development/lsp.test.mjs`

**Interfaces:**
- Produces: a recovery state machine `running -> recovering -> running | exhausted`.
- Produces: a bounded `PendingClientQueue` whose limits are `10_000` ms and `1_048_576` bytes.
- Produces: stderr records containing attempt number, delay, child exit/signal, and at most 4 KiB of child stderr.

- [ ] **Step 1: Write failing recovery tests**

Add fixture-driven tests for: crash after `didChange` then replacement receives internal initialize, latest configuration, and a full-text `didOpen`; client traffic during recovery drains in order; retry delays are scheduled in the configured five-step sequence; sixth failure exits nonzero with the bounded stderr summary.

- [ ] **Step 2: Verify recovery tests fail against the one-child launcher**

Run: `node --test tests/plugins/typescript-development/lsp.test.mjs`

Expected: failures show no replacement child and no replayed document state.

- [ ] **Step 3: Implement recovery sequencing**

On an unexpected child exit, stop normal forwarding, begin the configured retry schedule, start a replacement, perform its `initialize`/`initialized` exchange internally, replay the snapshot in dependency order, then flush the queued client frames. Client request IDs remain client-owned; internal initialization IDs are generated by the proxy and their responses never reach stdout. Cancel/error outstanding client requests that belonged to the crashed child rather than retrying them.

- [ ] **Step 4: Implement bounded diagnostics and fail-closed server operations**

Forward and track supported server-to-client requests. Cache valid responses needed by the recovery core. On an unsupported server request/registration, queued-byte/time overflow, unreplayable internal handshake, or retry exhaustion: write one concise stderr reason, fail affected pending client requests with `InternalError`, and exit nonzero.

- [ ] **Step 5: Verify recovery behavior**

Run: `node --test tests/plugins/typescript-development/lsp.test.mjs`

Expected: all recovery, queue, exhaustion, and stdout-purity assertions pass.

### Task 4: Wire, document, and validate both launchers

**Files:**
- Modify: `plugins/typescript-development/.lsp.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/plugins/typescript-development/lsp.test.mjs`

**Interfaces:**
- `.lsp.json` continues to launch `${CLAUDE_PLUGIN_ROOT}/scripts/typescript-lsp.mjs` with `maxRestarts: 3`.
- README documents the proxy's recovery boundary, retry policy, stderr diagnostics, the unchanged direct Bash comparison command, and `TS_LSP_BIN`.

- [ ] **Step 1: Write failing contract/documentation assertions**

Assert the Node launcher obtains its binary through the Bash resolver and that `.lsp.json` remains rooted at the Node proxy with `maxRestarts: 3`.

- [ ] **Step 2: Verify the contract assertion fails if the Node launcher has duplicated resolver logic**

Run: `node --test tests/plugins/typescript-development/lsp.test.mjs`

Expected: the new static/behavioral assertion fails until the resolver boundary is implemented.

- [ ] **Step 3: Update configuration and documentation**

Keep the Node proxy as default, retain the Bash executable unchanged, and describe `scripts/typescript-lsp.sh --check` as the direct comparison/control path. Add a dated changelog entry only if one is not already present for the current version work.

- [ ] **Step 4: Run targeted verification**

Run: `node --test tests/plugins/typescript-development/lsp.test.mjs && node --test tests/plugins/typescript-development/structure.test.mjs && npm run typecheck`

Expected: zero failures and no stdout protocol contamination.

- [ ] **Step 5: Run full repository verification before committing**

Run: `npm test && npm run typecheck`

Expected: zero test failures and a successful TypeScript check. Inspect the final diff, then commit only after applying the repository's required version, lockfile, changelog, and README post-commit metadata workflow.
