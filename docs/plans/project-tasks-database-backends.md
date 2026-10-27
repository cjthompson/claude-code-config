# Project-tasks: database backends, claims, and handoffs

Updated: 2026-10-25. Status: planning. This document does not by itself authorize implementation.

## Scope and principles

Support per-project SQLite/PostgreSQL selection, shared-database claims, delegated claim access, durable handoffs, and atomic requirements updates.

Prefer consistent rules over command-specific exceptions. This is a trusted-agent task tracker, not a hardened security boundary. No CI ownership, remote sub-agent execution, background synchronization, or automatic claim expiry is assumed.

The decisions below reflect the discussion so far. Proposed interfaces and unresolved implementation choices are labeled accordingly. One-time SQLite-to-Postgres import remains deferred. Open questions, gaps, and edge cases are at the end.

The database-focused review has been incorporated into the schema and related contracts below. See the [review findings](project-tasks-database-schema-review.md) and [HTML schema overview](project-tasks-database-schema-review.html). Technical integrity requirements are part of the plan; policy choices and exact DDL still requiring review are identified explicitly. This update also records the runtime, driver, config-location, and timestamp decisions from the review discussion.

## Current implementation

- `bin/task-db` dispatches through `lib/cli.mjs` and `lib/registry.mjs`.
- `lib/db.mjs` launches fresh `sqlite3` processes. Existing multi-write transactions use real `BEGIN IMMEDIATE`; they are not no-ops.
- SQLite-specific SQL also exists in `handlers.mjs`, `plan-sync.mjs`, and `plan-read.mjs`.
- Tasks/plans have internal integer IDs and project-local sequence numbers. Requirements live in `reqs`; execution instructions and acceptance criteria are not separate fields.
- Existing plan commands already support inline/linked content and propose/apply/update/attach/detach. Reuse them, rather than inventing parallel source-update commands.
- Project discovery currently lives in initialization instructions. Shared helper initialization must discover config before selecting/opening the database.
- Claims/handoffs need new storage. Migrations must preserve IDs, sequence numbers, requirements, content, notes, and output contracts.

## Configuration

### Named connections

Store connections in `~/.config/project-tasks/project-tasks.json`:

```json
{
  "local": {
    "driver": "sqlite3",
    "path": "/absolute/path/to/tasks.db"
  },
  "docker": {
    "driver": "postgres",
    "url": "postgres://postgres:postgres@localhost:3306/project_tasks"
  },
  "lan": {
    "driver": "postgres",
    "host": "db.lan",
    "port": 5432,
    "database": "project_tasks",
    "user": "postgres",
    "password": "postgres"
  }
}
```

Use the existing per-project config to select a backend:

```json
{
  "projectName": "github.com/owner/repo",
  "backend": "lan"
}
```

Accept Postgres URLs or separate fields including a password. Both `postgres://` and `postgresql://` are valid. Port 3306 above is a possible Docker-published port, not the default PostgreSQL port; examples otherwise use 5432. Special URL credential characters require percent encoding. [PostgreSQL connection documentation](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-URIS)

### Config CLI

Planned commands:

```sh
task-db config get
task-db config get projectName
task-db config get backend
task-db config get backend NAME
task-db config set projectName VALUE
task-db config set backend NAME [JSON]
```

- With JSON, define/update the global connection and select it for this project. Without JSON, select an existing connection.
- Work without an available database or database client.
- Preserve other connections in the global file and the known project-config fields; unknown project-config fields are dropped on rewrite (item 2). Never automatically stage/commit config.
- Changing project name selects a name; it does not rename database records.
- Redact passwords/URL credentials in output/errors. New credential config files use owner-only permissions.
- Extend current argument parsing with command-local positional arguments; retain unrelated validation.

Approved (2026-10-24): mutually exclusive URL/separate fields; `passwordEnv` in v1; password-file support deferred until verified against the `pg` driver; validated atomic file replacements; global definition before project selection; report partial success if the second write fails, with no rollback of the global definition. Literal passwords inside the `config set backend NAME JSON` argument are allowed; they can appear in shell history and process listings.

### Discovery

Shared init resolves project config, project identity/backend, named connection, then repository/database. Every direct CLI call performs this discovery itself rather than relying on environment exported by a previous `db init` process; schema creation still requires `db init` (item 4). When discovery moves from `init.md` into the helper, do not port its host-based default for `PROJECT_TASKS_CONFIG_DIR`: the override applies only when the user sets it.

- Missing backend retains the default shared `tasks.db` and `PROJECT_TASKS_HOME`.
- Explicit invalid/unknown backend fails clearly, never silently falls back.
- Reuse the existing Git/non-Git search boundaries. At each searched directory, check `.agents/`, then `.claude/`, then `.codex/`, selecting the first existing project config. Approved (2026-10-24): `PROJECT_TASKS_CONFIG_DIR` is retained as a top override. When set, its directory is checked first at each searched level, before the fixed `.agents/`, `.claude/`, `.codex/` order. Discovery tests need an override case.
- Approved (2026-10-24): the backend comes only from the config discovered from the working directory. `--project` is a key inside that store, with no cross-check against the config's `projectName`.
- Switching backends selects independent stores; no migration/synchronization.

Use the first existing config, including backend-only configs; missing project name uses the existing fallback. Do not merge competing project configs; malformed selected JSON fails. Update the selected config. Create a new config only if no candidate config exists within discovery boundaries. Approved (2026-10-27): when `PROJECT_TASKS_CONFIG_DIR` is set, the new config is created in that directory (created if missing) with no location prompt, because setting the variable is an explicit choice of location. Otherwise use the first already-existing `.agents/`, `.claude/`, or `.codex/` directory in priority order at the chosen Git root/cwd. Do not create a host directory automatically. If none exists, `config set` requests a location choice: `.agents/`, `.claude/`, `.codex/`, or Stop; selecting a location authorizes creating that directory and its config. The CLI is AI-facing, so return a structured choice requirement for the agent to present, rather than blocking on terminal input. Reads/init never prompt or create a directory. This intentionally changes name-only discovery and needs documentation/tests.

## Repository abstraction

Create an abstract `Repository`, `SqliteRepository`, and `PostgresRepository`. Each owns operation-specific SQL for tasks/plans/notes/claims/handoffs/schema/IDs. Handlers contain domain orchestration, not backend-specific SQL.

Expose `withTransaction(db => ...)` or an equivalent transaction-scoped API. Reads authorizing/validating writes must share the transaction/connection: claims, revisions, affected tasks, membership, statuses, dependencies, and derived plan status.

- Both repositories use real transactions. SQLite retains write serialization/`BEGIN IMMEDIATE` where appropriate; no-op transactions would break current guarantees.
- PostgreSQL mutations serialize on one transaction advisory lock under `READ COMMITTED`, with one `pg.Client` per mutation; details in item 1.
- Preserve concurrent ID/sequence/note allocation, affected-row results, exact content, and public output types.
- Read local files client-side and transfer contents safely.
- Target Node >=24; use built-in `node:sqlite` and the pure-JavaScript `pg` client with an awaited repository interface. The current fresh-process-per-query mechanism cannot support interactive callbacks unchanged. Bind values rather than interpolate SQL; close each command connection in `finally`.

No CLI `startTransaction`/`commitTransaction`: separate processes cannot share a transaction without a persistent service. Each mutation command owns its whole transaction.

## Claims and authorization

A claim is a persistent write lock linked to one task/plan's internal ID, not sequence number. Only one active claim per target.

### Shared rules

- Claim before work or requirements changes.
- Implementation-changing writes require the target claim secret. Valid ownership suffices for requirements updates; no additional user approval.
- Metadata edits that do not affect implementation are allowed without ownership. The field classification is settled in item 6: title, priority, tags, and dependencies need no ownership; membership changes follow Creation and membership below.
- Task status/execution/completion writes require the task claim, except cancellation of an unclaimed mutable target. Cancellation checks existing claims atomically: caller-owned claims require valid secrets; another owner's claim blocks the ordinary operation. It never acquires temporary claims (item 12).
- Derived plan-status changes are implementation-neutral metadata and need no plan claim.
- A plan claim protects the plan itself; it is not needed to claim/execute its tasks.
- Changing task requirements needs its task claim; require a plan claim only if the plan changes too.
- Completed/cancelled tasks/plans are permanently read-only. No reopening, rewriting, or deleting; create new items referencing the originals. Standalone historical handoffs are still allowed.

### Creation and membership

- Creating a plan needs no existing claim and leaves it unclaimed.
- Creating a standalone task needs no task claim and leaves it unclaimed.
- Creating/attaching a task under an existing plan requires its plan claim.
- Detaching requires the source plan claim. Moving requires source and destination plan claims.
- Atomically verify that an association-changing task is writable and either unclaimed or authorized by its claim secret. No meaningless acquire/release inside that transaction.
- Finalized tasks/plans cannot have membership changed.

### Bulk claiming

Claiming a plan optionally claims all claimable tasks; default claims only the plan. Completed/cancelled tasks cannot be claimed. Any conflict fails the entire acquisition without new claims.

These are ordinary independent claims, not a persistent group. Later operations do not know whether bulk acquisition was used. Releasing/revoking one does not cascade; task claim operations are independent of plan claims.

## Secrets, delegation, and recovery

### Credential model

- Separate cryptographically random secret per claim; database stores only SHA-256 hash.
- `task-db` generates/saves the secret, returning claim ID rather than the secret.
- Protected writes load the local secret and verify its hash against the active claim in the transaction.
- Session IDs/agent/branch are attribution and lookup metadata, not authorization.
- Anyone holding a secret has equal authority, including release. Parent/sub-agent permissions are not distinguished.

`PROJECT_TASKS_SESSION_ID` selects the local session credential directory. Missing ID makes claim-related commands fail clearly. Do not invent an ID.

Approved storage (2026-10-24), one file per claim, superseding the earlier single `claims.json` per session:

```text
<state>/stores/<store_id>/sessions/<sha256(session-lookup-id)>/<claim-uuid>.json
<state>/stores/<store_id>/last_checked
```

Each file holds one claim's secret; local, owner-only, durable across resumption, outside commits/proposals/handoffs. The database maps a target to its active claim UUID, which names the file, so no lookup by file name or content is needed. Platform paths and overrides are in item 9.

Resolve target → active claim → local session entry → hash verification. A session ID alone cannot authorize writes. Keep secrets out of arguments and normal output.

This prevents casual spoofing, not deliberate theft by another agent with equivalent filesystem access. No hardened credential broker is required.

### Delegation and metadata

Explicitly copy only selected claims' secret files into a sub-agent's session directory. They share the claim, not separate locks; parents coordinate siblings via instructions. No verified-ancestry registration is required for authorization.

Assume sub-agents are local. Independent LAN agents acquire their own claims. Revocation invalidates all copies; new claims use fresh secrets.

Claim branch metadata is updatable after acquisition. Agents record the branch when they start work (host instructions say so; item 18), so any machine can find the work by branch name: fetch the branch and look for an existing worktree on it. No worktree path or hostname is recorded. The helper accepts an unknown branch and does not enforce this.

### Lifetime

- No automatic expiry.
- Release requires secret plus handoff, written atomically with release.
- Force revoke requires explicit confirmation and a handoff; no admin credential or old secret. Record reason/known state/unknowns.
- Lost secret recovery is force-revoke then reclaim, not secret retrieval.
- Returning `in_progress` to `pending` requires claim and stop-reason handoff but retains claim.
- Removal is explicit except finalization: completed/cancelled status releases its claim in the same transaction.
- Force cancellation confirmation authorizes revocation of affected task claims (item 12).

Revocation cannot stop filesystem work; later protected database writes reject stale secrets.

## Plan sources

### Default inline

Database content is authoritative. Inline plans can be created from text without a committed source file.

They may retain an original source path. That original file has no write/commit restrictions. Detect/refresh source changes only through existing explicit commands, never automatically on reads/execution. Refresh follows ordinary inline requirements-update rules: claim, prepared data, WHAT/WHY handoffs, atomic apply.

### Linked

- Commit file before creating linked plan record or tasks. Retain committed-and-clean checks for creation/attachment/propose/apply/update.
- Store paths relative to the owning working tree's Git root, never absolute machine/worktree paths; resolve against matching local checkouts and reject escapes.
- Apply only the reviewed source/staged revision, not implicitly newer content.
- A local commit hook protects changes affecting registered links, including edits/renames/deletions. Require the committing agent's plan claim secret.
- Reachable database plus missing authorization blocks commit. Unavailable database produces warning only.
- No CI enforcement requirement. Deterministically deriving affected task requirements from Git diffs is not a settled hook responsibility.
- Preserve readable snapshots without checkouts; map legacy absolute links only with verified repository information.

Changing plan requirements requires its claim and every affected task's claim. Plan ownership does not grant task ownership.

## Handoffs

### Content and history

Every handoff is a fresh, self-contained summary, optionally generated with the previous handoff as context. Retain earlier records for history; newest is default for resumption.

Start with a historical metadata snapshot: repo, branch, agent type (`codex`/`claude`), session ID, timestamp. Include PR number/link/state, project/JIRA ticket references, related IDs, and modified files where available.

Summarization focuses on initial prompt/recent prompts and relevant previous handoff context, work state, and next steps. Metadata should help locate/resume a full session where the host supports it, not promise cross-machine availability.

Requirements changes include WHAT and WHY. Plan handoff identifies cascading task requirement changes; each affected task also gets a fresh handoff.

Final task handoffs explain actual outcome: branch, PR created/not created, merged/not merged, abandoned/remaining work, uncertainties.

### Generation and storage

Agent generates handoffs before mutation commands; `task-db` validates/stores, not runs an LLM. A summarizing sub-agent is possible, pending transcript-access design.

Store handoffs linked to internal task/plan IDs with session ID/timestamp. Intended standalone interface: `task-db handoff <task-or-plan>`; exact target syntax is open.

| Action | Required handoff |
| --- | --- |
| Requirements change | Fresh WHAT/WHY handoff for changed plan and each changed task |
| Complete/cancel task | Final task handoff |
| Finalize plan | Final plan handoff from every task's final handoff |
| Return task to pending | Stop-reason handoff |
| Release/force-revoke claim | Work-state/reason handoff, including unknowns |

Same rules for ordinary/force operations. Empty plan finalization still needs a handoff; cancellation reason can suffice. An action handoff may cover its automatic claim release rather than duplicating the record.

Standalone handoffs need no claim and can annotate finalized items without modifying them.

Commit and push before release or completion are specified in item 18; unrelated dirty changes are left alone.

## Atomic proposal/apply workflow

One command reads prepared JSON and owns one transaction. Illustrative syntax, not final:

```sh
task-db plan apply --project PROJECT --seq 3 --proposal /path/to/proposal.json
```

Task requirements updates use the same prepared-payload approach. Extend existing commands, not a competing reconciliation system.

Payload contains the staged plan content's hash (`stagedHash`; item 3), affected task requirements, expected revisions/source identity, and fresh handoffs/metadata/WHAT/WHY. No secrets.

1. Read data and prepare changes/handoffs before mutation. Context loss during preparation leaves live requirements unchanged.
2. Apply loads credentials and begins transaction.
3. Check affected records, active claims/secrets, revisions, lifecycle, membership/dependencies inside transaction.
4. Write changes, handoffs, derived statuses, releases/revocations together.
5. Commit all or roll back all; no partial update for locked tasks or failed validation.

First valid transaction wins. Later conflicts fail without writes; reread/revise rather than silently retry/overwrite. Saved proposals can be resumed by an authorized session. Git/files/local credentials/database cannot all share one atomic transaction.

If needed tasks are claimed elsewhere, block entire update and ask: stop/retry; remove that task's changes; dangerously revoke; other.

Explain plan changes affecting in-progress/completed tasks. Options include stopping, revising plan, or creating new dependent tasks. Rewriting finalized tasks after revocation was superseded by permanent finality. In-progress changes need ownership, potentially obtained through explicit revocation.

## Lifecycle and plan status

No delete or reopen. New work references finalized originals.

Recalculate after every task status/membership change using one function. Finality is absorbing: return an already-finalized plan's recorded outcome unchanged. For mutable plans, use the table below; explicit empty-plan cancellation intent is an additional input to that same function:

| Task set | Plan status |
| --- | --- |
| No tasks, no explicit cancellation intent | `pending` |
| No tasks, explicit cancellation intent and required reason handoff | `cancelled` |
| Every task cancelled | `cancelled` |
| Every task finalized, at least one completed | `completed` |
| Otherwise, any task in progress | `in_progress` |
| Otherwise | `pending` |

Empty new plan stays pending; adding tasks requires plan claim. Returning last in-progress task to pending returns plan to pending without releasing claims.

Moves recalculate both plans; detach recalculates source. Resulting finalization has the same final-handoff/release requirements. Finalized plans cannot gain/lose tasks.

Before last active task ends, prepare its final handoff and plan final handoff from all task-final handoffs, including the proposed last one. Validate task set/revisions in transaction.

### Cancellation

Completed/already-cancelled tasks remain unchanged. If in-progress/completed tasks are involved, explain impact and ask: stop; cancel remaining pending tasks; force cancel active tasks.

- Cancel remaining affects pending tasks only; plan stays active while in-progress tasks remain.
- Force also cancels in-progress tasks and revokes their claims; confirmation rules are in item 12.
- Each cancelled task needs final handoff; resulting plan finalization needs final plan handoff. Same atomic rules.
- Shared status formula stays authoritative: completed tasks plus cancelled remainder produce a completed plan, not cancelled.

## Proposed implementation sequence

1. Resolve remaining config/session/proposal/lifecycle contracts.
2. Extract repository interfaces/shared rules while preserving SQLite behavior.
3. Add Postgres, additive schema migrations, config CLI/config-first init.
4. Add claims/secrets/delegation/authorization across all mutation paths.
5. Add handoffs/prepared payloads and atomic requirements/finalization/release.
6. Implement shared status/finality/membership/cancellation rules.
7. Default inline, adapt existing source refresh, add linked-file commit hook.
8. Update execution/init/delegation/recovery/handoff instructions (including the new `handoff` skill command) and verify both drivers.
9. Add the one-time whole-database SQLite-to-PostgreSQL import into an empty store (item 24). P001 tracks it as task `#021` (task numbers are per project, so it follows `#008`).

These steps are the work breakdown; item 24 groups them into five delivery stages.

Earlier backend-only effort estimates no longer cover expanded scope. Re-estimate once contracts are settled; no implementation starts merely because this document exists.

## Verification and delivery

- Run plugin `.mts` suites explicitly; root `npm test` is not a substitute.
- Cover config precedence/boundaries/backend-only files/fallback/errors/redaction/preservation/partial writes/offline commands.
- Shared repository tests: migration, exact content, notes/IDs, rollback, concurrency, connection failures, and explicit PostgreSQL timestamptz/SQLite UTC string parity, including mixed legacy timestamp ordering and precision.
- Schema integrity tests: wrong-target ending/predecessor references, NULL UUID identities, one-active-claim indexes, coherent ending fields, immutable audit rows, canonical-final evidence/outcome, exact final-summary child manifests, and database-assigned handoff ordering under clock skew.
- Replay tests: lost success response after claim release, receipt lookup before stale preconditions, canonical payload hashing, operation-ID reuse with different content, and missing local claim-secret persistence. Audit additive migration against legacy NULL revisions, partial anchor indexes, and identifier-migration sequence staging.
- Claim tests: bulk atomicity, missing session ID, lookup/delegation, stale tokens, force confirmation, persistence failures.
- Audit every old mutation path: notes/feedback/changelog/source/bulk/repair must not bypass shared rules.
- Test proposal conflicts and atomic requirements/handoffs/releases; final-plan summary races and recovery after context loss.
- Test shared status across membership/status transitions and mixed final states.
- Test inline text creation/explicit refresh/unrestricted source and linked clean commits/paths/hooks/offline warnings/renames/legacy conversion.
- Isolate tests from real config/database/session files; use disposable Postgres infrastructure.
- Update README/instructions/matching release metadata; deliver implementation through PR. Follow AGENTS.md verification if editing skills with `model:`. This planning update includes no commit/install.

## Decisions and recommendations for review

These sections correspond one-to-one to the 24 items below. All 24 items are decided; details still open within them are listed in each item and under Open questions at the end. Implementation-specific host capabilities still require verification. No code, database, installed agent files, Git hooks, or release metadata was changed to produce this planning update.

The common implementation model should be: parse/prepare outside the database transaction; enter one transaction; check current state and authorization; compute the complete change set and required handoffs; validate the prepared handoffs; write and commit. Every existing/new mutation calls this pipeline. A force option changes the authorized action, not finality or handoff requirements.

### 1. Repository transport

Decision: target Node >=24 and use Node's built-in `node:sqlite` for SQLite and the pure-JavaScript `pg` client for PostgreSQL. Make dispatch and repository orchestration async so both implement the same awaited interface, even though SQLite calls are synchronous internally. One command opens one connection and closes it in `finally`; no daemon or connection pool is necessary.

Limit SQLite usage to the prepared-statement/connection API supported by the minimum tested Node 24 release, and verify that release in distribution tests.

Use bound values rather than SQL string interpolation. Keep an entire Postgres transaction on the same `pg.Client`. [node-postgres transactions](https://node-postgres.com/features/transactions), [parameterized queries](https://node-postgres.com/features/queries)

For this low-volume tracker, initially serialize all cooperating PostgreSQL mutation transactions with one database-local transaction advisory lock, acquired before state reads, using `READ COMMITTED`. Do not establish an older repeatable-read snapshot before waiting for the lock. SQLite uses `BEGIN IMMEDIATE`. This avoids separate lock-ordering strategies for claims, sequence allocation, membership, and handoffs. Persistent task claims remain rows; they are not advisory locks held for the duration of agent work. Keep transaction lock/statement timeouts finite and never ask the user or summarize inside a transaction. Transaction advisory locks end with the transaction. Bootstrap and migrations take the same lock. Advisory locks coordinate only participating clients and do not replace constraints. [PostgreSQL locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html)

Tradeoff: unrelated projects serialize their short writes. That is acceptable initially; optimize only if actual contention warrants it.

Distribution is a gate: bundle the pure-JS Postgres dependency into a plugin-contained build artifact, keep `node:sqlite` external, and verify a plugin-only installation with no checkout-level `node_modules`. Lazy-load the selected driver so SQLite/config commands do not depend on loading PostgreSQL code. Do not assume plugin managers run npm installation.

### 2. Config contract

Decision: discovery and config-write behavior are specified under Discovery above. The connection-validation details below are approved (2026-10-24).

Keep the agreed global config path, literally `~/.config/project-tasks/project-tasks.json` on every OS (approved 2026-10-24); tests need an override variable for it. For SQLite, require a named connection's path to be absolute; default SQLite still honors `PROJECT_TASKS_HOME`. Do not reinterpret an explicit named connection using that variable.

Accept URL or separate host/port/database/user/password fields, reject mixed location definitions, and require an explicit database target rather than allowing an ambient user name to choose one. Accept `passwordEnv` as an alternative to literal password, error if the named variable is missing, and otherwise allow the driver's supported credential mechanism. Password-file support is deferred until its behavior is verified against the chosen driver, rather than assuming that all libpq options are implemented identically. Use explicit client config to avoid unrelated ambient connection variables redirecting the target. The driver supports programmatic fields and environment defaults. [node-postgres connection configuration](https://node-postgres.com/features/connecting)

Approved (2026-10-24): reject unknown connection-definition fields to catch typos. Unknown project-config fields are dropped when the tool rewrites the file; a write can therefore remove fields added by a newer version or another tool. Validate both intended writes before replacing either file; global definition first, project selection second. If selection fails, report that the global definition exists and selection is unchanged. Retrying selection is preferable to deleting a shared definition another project may already use.

### 3. CLI and proposal contract

Decision: retain an AI-facing, machine-readable CLI with versioned prepared payloads and atomic validation. Preserve current `task ... --project ... --seq ...` and `plan ... --project ... --seq ...` routing. Extend existing `plan apply` and `task update` with `--proposal FILE`, and relevant status/release/revoke commands with prepared payload input. All translate into the same mutation pipeline; do not add a generic SQL executor or a second plan-apply engine.

Proposed examples, not implemented syntax:

```sh
task-db plan apply --project PROJECT --seq 3 --proposal update.json
task-db task update --project PROJECT --seq 12 --proposal update.json
task-db task claim --project PROJECT --seq 12
task-db plan claim --project PROJECT --seq 3 --all-tasks
task-db claim delegate --claim-id CLAIM_UUID --to-session CHILD_SESSION
task-db claim release --claim-id CLAIM_UUID --proposal release.json
task-db claim revoke --claim-id CLAIM_UUID --confirm --proposal revoke.json
task-db handoff task:12 --project PROJECT --content-file handoff.json
task-db handoff plan:3 --project PROJECT --content-file handoff.json
```

Only the standalone handoff/config routes need the agreed positional extensions. A typed `task:`/`plan:` target avoids task/plan integer collisions. CLI sequences resolve inside the selected database/project to internal IDs; JSON stores typed internal IDs plus store identity.

Use a versioned JSON envelope: `schemaVersion`, `operationId`, `storeId`, `preconditions`, `changes`, `handoffs`. Restrict changes to supported domain operations, not arbitrary column names or SQL. Requirements arrays are replacements, not ambiguous incremental patches. Verify CLI target and payload target agree.

Example shape for a plan content update cascading to a task:

```json
{
  "schemaVersion": 1,
  "operationId": "uuid",
  "storeId": "database-uuid",
  "preconditions": [
    {"kind": "plan", "id": 9, "revision": 4, "claimId": "plan-claim-uuid"},
    {"kind": "task", "id": 42, "revision": 7, "claimId": "task-claim-uuid"}
  ],
  "changes": [
    {"kind": "plan", "id": 9, "stagedHash": "sha256-of-candidate-staged-by-plan-propose"},
    {"kind": "task", "id": 42, "requirements": ["Revised requirement"]}
  ],
  "handoffs": [
    {
      "target": {"kind": "plan", "id": 9},
      "summary": "Full current plan handoff",
      "what": "Updated plan and task 42 requirements",
      "why": "Reason for the change",
      "metadata": {}
    },
    {
      "target": {"kind": "task", "id": 42},
      "summary": "Full current task handoff",
      "what": "Changed requirement",
      "why": "Reason for the change",
      "metadata": {}
    }
  ]
}
```

UUID strings and empty metadata above are placeholders; production validation requires the agreed minimum fields. Secrets never appear in this file.

Approved (2026-10-24): a proposal never embeds plan text. A plan content change references the candidate already staged by `plan propose` through its hash (`stagedHash`); apply fails if the staged hash no longer matches. The existing stage, diff, and apply path remains the only way plan text changes.

Approved (2026-10-24): commands where retry matters but no payload file exists, such as claim acquisition and release, require a caller-supplied `--operation-id`. The helper never generates one, so a lost response can always be retried with the same ID.

Reuse existing source proposal/diff/hash logic. Require prepared WHAT/WHY/task handoffs at live apply, rather than allowing legacy direct requirements flags to bypass them. Existing requirements-on-creation remains valid: creation is not changing an existing item's requirements. The read-only preparation mode is defined in item 15.

### 4. Schema

Retain existing integer task/plan IDs, project sequences, JSON-text fields, and exact stored content. Additive SQLite upgrades must not rebuild tables, copy rows, or renumber IDs/sequences. New PostgreSQL tables use equivalent domain constraints without copying SQLite physical types. The database-focused review is incorporated here; exact DDL remains a review deliverable before implementation.

#### Store identity and revisions

Create a singleton store/schema metadata row: primary key `singleton_id` constrained to 1, unique non-NULL random `store_id`, and non-NULL migration version. Create it atomically; advance the version only with successfully committed DDL. Unknown newer schema versions fail rather than attempting downgrade. Bootstrap and migrations use the mutation serialization discipline. Approved (2026-10-24): only `db init` creates or migrates a store, matching current behavior; other commands check the schema version and fail with a clear "run `db init`" error when it is missing or outdated. "Direct CLI calls must not depend on a previous `db init` process" refers to config discovery, not schema creation.

Add nullable integer revisions to tasks/plans, with NULL defaults for additive SQLite columns. Interpret legacy NULL as zero; new records explicitly use zero; increments use `COALESCE(revision, 0) + 1`. Reject negative revisions. Increment each touched record/aggregate once per transaction, including affected plan context when a child's requirements/title/status/membership changes even if derived status stays unchanged. Keep the single-revision approach initially.

Keep project-local `(project, seq)` uniqueness. Allocate sequences under the write lock, preserving concurrent allocation and public numeric IDs. `MAX(seq)+1` is acceptable under this serialization; return generated internal IDs from the insert. If PostgreSQL uses bigint IDs, define safe-integer conversion explicitly rather than silently returning strings. Do not add positive-sequence constraints until auditing the existing identifier migration, which temporarily uses negative sequences.

#### Claims and ending evidence

Create `claims` with non-NULL UUID primary key, nullable task/plan foreign keys, secret hash, creator session/agent, optional branch, creation time, and nullable ending time/reason/handoff reference. Exactly one target is required with an explicit NULL-based CHECK; both target FKs use restricted deletion. SQLite UUID primary keys must explicitly be NOT NULL.

Use separate partial unique indexes for active task and plan claims:

```sql
CREATE UNIQUE INDEX claims_active_task
  ON claims(task_id) WHERE task_id IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX claims_active_plan
  ON claims(plan_id) WHERE plan_id IS NOT NULL AND ended_at IS NULL;
```

An index on `(task_id, plan_id)` alone does not enforce this with nullable target columns. Require either all ending fields to be NULL or all to be non-NULL. Validate controlled ending reasons, e.g. release/revoke/completed/cancelled. The ending handoff must belong to the claim's exact target; a UUID foreign key alone is insufficient. Validate hash format and store no raw secrets.

Claim target, hash, creation attribution/time are immutable. Optional execution-location metadata can change while active. Permit one transition to ended, then freeze the row. Keep ended claims and add indexes for target-specific history; active-only indexes do not cover that history. Do not impose cross-clock timestamp ordering constraints before defining the clock source.

#### Handoffs, ordering, and canonical finality

Create `handoffs` with non-NULL UUID identity, exactly one target FK, session/agent, generated timestamp, full nonblank summary, optional WHAT/WHY, validated immutable metadata JSON, reason list, and optional predecessor. Add database-recorded `recorded_at` and unique database-assigned integer `handoff_order`. Use the append order for latest/default resumption, not agent timestamps or random UUIDs. Index target/order separately for tasks and plans.

Preserve generated time as attribution. A supplied predecessor must belong to the same target, already exist, and match the latest accepted handoff when used as a preparation precondition. It is optional context, not a mandatory linked list.

Represent canonical-final and retrospective status explicitly; final flags are non-NULL, with SQLite boolean checks. Canonical endings also record a controlled final outcome, creating mutation operation ID, and target-revision evidence. Use separate partial unique indexes to permit at most one canonical final handoff per task/plan. Ordinary standalone handoffs remain annotations and cannot establish canonical authority.

Finalization must atomically insert canonical outcome evidence, end the active claim using that evidence, and set the final status. Validate outcome/status agreement and absence of an active claim afterward. Unique canonical indexes alone do not prove evidence exists. Required evidence applies to new transitions; legacy exceptions need an explicit migration baseline. Preserve handoffs as append-only, including their flags/provenance.

#### Final-plan source evidence

Add `final_handoff_sources` with composite primary key `(plan_handoff_id, task_handoff_id)`, restricted FKs, and reverse lookup index on task handoff. Rows are append-only. Validate that the left endpoint is a canonical final plan handoff and every right endpoint a canonical final task handoff for a child in that exact plan membership. Cross-project children are compared by internal ID.

Recheck exact child IDs, revisions, canonical handoff IDs, and aggregate plan revision under the transaction lock; ordinary FKs cannot detect an omitted child or changed membership. Persist the accepted membership/revision manifest as immutable structured metadata or a dedicated manifest table; choose its representation in DDL review. Empty final plans have no source rows but still require their own final handoff and explicit cancellation intent, approved in item 13.

#### Operation and publication receipts

Create append-only `mutation_receipts` keyed by non-NULL operation UUID, containing non-NULL payload hash, hash/canonicalization version, command/result schema version, committed time, and validated non-secret result. Commit receipts with domain changes. Bind the hash to operation kind, store, typed targets, proposal version, preconditions, changes, and handoffs. Define canonical logical JSON hashing while preserving meaningful array ordering. Keep receipts indefinitely initially.

Look up a committed receipt before applying stale revision/claim checks to a replay. Identical ID/hash returns the prior result; different payload with the same ID fails. This ordering is necessary after a successful finalization releases the original claim; replay authorization is settled in item 10. Acquisition additionally depends on durable local secret persistence; receipts cannot recover an unsaved secret.

Create append-only `changelog_publication_receipts` with task FK, operation reference, publication time, and structured destination/release metadata. Index task lookup. Combine legacy `in_changelog=1` with qualifying receipts when reading publication state. Multiple publication history records are retained; define a stable publication key and duplicate policy before adding a unique constraint.

#### Timestamps and backend representations

All PostgreSQL date/time columns use native `timestamptz`, including existing task/plan dates and new claim, handoff, receipt, and migration dates. SQLite new timestamps use fixed-format ISO 8601 UTC TEXT. Repository outputs use consistent UTC strings with millisecond precision; PostgreSQL columns use `timestamptz(3)` (approved). Normalize `pg` date values explicitly at the repository boundary.

Current SQLite dates are UTC `YYYY-MM-DD HH:mm` without a zone. Preserve those rows, recognize that known format explicitly as UTC, and normalize comparisons/output. Do not sort mixed legacy/new dates as raw text or parse legacy dates using implicit local time. Preserve the known minute precision without claiming original seconds are known. New PostgreSQL creation does not imply SQLite-to-PostgreSQL import.

#### Source identity, indexes, and validation

Persist repository identity, reviewed source commit (provenance only) and content-hash algorithm/version alongside linked source evidence; retain distinct reviewed staged-source identity. Decide exact columns in DDL review. A path/hash alone cannot distinguish repositories or identify the accepted content. Linked paths are nonblank and repository-relative; the source helper checks containment. Worktree location remains attribution, not portable identity.

Add `tasks(plan_id)` for complete membership lookup; the existing partial anchor index omits NULL-anchor children. New writes enforce that non-NULL anchors have a plan and are nonblank; audit historical violations before retrofitting constraints. Validate JSON shape/elements, not only JSON syntax. Enable and verify SQLite foreign keys on every connection before starting transactions.

Use database PK/FK/unique/local checks for identity and row shape, and the shared transactional domain validator for authorization, dependencies, required per-action handoffs, exact summary membership, and derived status. Narrow triggers enforce append-only history, same-target ending/predecessor links, and ended-claim immutability (approved); avoid mutually impossible immediate trigger ordering during finalization.

Audit disposable legacy data before adding constraints. Preserve finalized rows/statuses without inventing history. The recommended baseline marks legacy finalized targets explicitly; on-demand retrospective canonical endings must be labeled, identify known facts/unknowns, and use a separately defined evidence operation. Do not promote arbitrary standalone notes or run automatic LLM reconstruction at initialization.

#### Remaining schema decisions

- Approved: narrow database triggers plus shared domain validation for audit invariants.
- Approved: labeled retrospective legacy evidence created on demand, with a preserved migration baseline. Exact baseline representation remains for DDL review.
- Committed replay authorization: settled in item 10.
- Approved: millisecond precision (SQLite fixed-format UTC strings; PostgreSQL `timestamptz(3)`). Exact physical ID/UUID/JSON representations remain for DDL review.
- Publication identity/deduplication and whether a deliberate independent database clone must receive a new store ID (backups/restores of the same logical store retain it).
- Empty-plan cancellation intent is settled in item 13; encode it in the shared status calculator and validation contract.
- Full DDL review, including NULL/check/FK rules, immutable evidence/manifest representation, source identity, and migration ordering.

### 5. Revision scope

Decision: approved in review. Start with one integer revision per task/plan, rather than separate revisions for each field category. Every record mutation increments it; task changes affecting summary context, including requirements/title/status/membership, also invalidate affected plan context even if derived status stays the same. Increment once per touched record/aggregate per transaction.

This can reject a prepared requirements update after a harmless title change. That is conservative and easy to explain; reread/reprepare is preferable to field-level merge semantics initially.

Standalone handoffs do not increment the finalized target row. If generation relied on a previous handoff, include that exact ID in preconditions. Check latest-handoff identity by database-assigned append order before writing the new summary, and verify the predecessor belongs to the same target. Final plan summaries instead list canonical final task handoff IDs and exact task membership; later annotations do not rewrite the ending.

Record/source revision failures reject the complete transaction. Do not silently merge or retry semantic changes. Include `storeId` and expected claim ID so backend switching or revoke/reclaim cannot make an old proposal target the wrong store/claim.

### 6. Metadata boundary

Decision: approved in review. Use a documented field classification, not an LLM judgment inside `task-db`.

- Title, priority, tags: presentation/scheduling metadata; editable on mutable targets without secret.
- Requirements/content, explicit task status, completion fields, execution/commit outcome fields: protected changes.
- Membership/anchors/source links: structural changes, with the already-agreed task writability and plan-claim checks.
- Dependencies: scheduling metadata, as the user previously allowed; validate existence, same-project scope, self references, and cycles atomically without demanding ownership merely because a task is claimed.

Dependency edits must not change a running task's requirements, pause it, revoke its claim, or retroactively undo its start. Evaluate scheduling prerequisites when starting/restarting work. If someone needs to change the actual implementation, they must update requirements with a claim.

Accepted tradeoff: changing dependencies during execution affects future scheduling but not already-started work. Do not freeze dependencies during execution or interrupt running work as an implicit consequence of a metadata edit.

No metadata writes to finalized rows. Derived plan status uses the shared calculator; it is not an arbitrary status override API.

### 7. Existing writes and finality

Decision: approved in review. Audit registry entries before implementation and route every mutation through the same classifiers/validators. No handler gets a direct write path around them.

Feedback describing execution, commit SHA, completion time, and type changes affecting the task's meaning require ownership on mutable tasks. Plain commentary notes can remain metadata, but existing replace/delete protections on system notes must remain. Finalized row/note mutation is denied; use standalone handoffs for later commentary.

Move future changelog-publication bookkeeping to append-only receipts rather than toggling `in_changelog` on a completed task. Reads combine existing legacy flags with new receipts. This preserves history and removes a real conflict with permanent finality.

Source propose/discard/attach/detach changes plan state and requires its claim. If source mode/path changes without content changes, record provenance as an administrative handoff; if content changes, WHAT/WHY and cascading task handoffs apply.

Treat project-name config selection separately from renaming stored history. Do not make the current `db migrate` identifier-normalization command a quiet escape hatch around finality. Keep such data migrations out of ordinary workflows until explicitly designed and authorized.

Remove the existing forced plan-completion cascade: a plan cannot force unfinished tasks completed merely to satisfy plan status. Final task transitions require ordinary ownership/outcome handoffs; then status derives automatically.

### 8. Session integration

Decision: approved in review. Keep `PROJECT_TASKS_SESSION_ID` as the only tool credential lookup input; host adapters set it explicitly, and the tool does not guess when it is absent.

For Codex, use the actual current thread ID exposed to shell execution, not a persistent shell export copied from the parent. Current upstream source injects `CODEX_THREAD_ID`; verify the pinned supported host and child behavior in a contract test. [Codex shell-environment implementation](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/shell_environment.rs)

For Claude, a SessionStart adapter can read hook `session_id` and persist the project-tasks environment through the documented environment-file mechanism. Subagents also have distinct `agent_id`; retain root session ID plus agent ID for attribution and use a composite credential lookup identity if necessary. Do not assume SubagentStart can persist environment exactly like SessionStart. [Claude hook reference](https://code.claude.com/docs/en/hooks)

Require an explicit child startup handshake: obtain the actual child identity before work, delegate selected claim IDs, then let the child proceed. If the parent cannot discover it immediately, the child reports its ID and waits. Never share a global "current session" file or let a child silently use the parent's whole credential directory.

Approved (2026-10-24): optional `PROJECT_TASKS_AGENT_TYPE` (`codex`/`claude`) and `PROJECT_TASKS_AGENT_ID` supply attribution for claims and handoffs, stored as NULL when absent. They never authorize anything. Open, conditional on host verification: if a host cannot expose a child's actual identity before work starts, decide whether a parent-minted, delegation-scoped lookup ID is acceptable; until then the child-reports-and-waits fallback stands.

Capability differences belong in host adapters, not task/plan lifecycle rules. Unsupported hosts may still read/configure the tracker; protected writes fail clearly until the caller supplies a real session ID. Do not inspect installed session directories as part of initialization.

### 9. Secret files

Decision: approved in review. Namespace entries by persistent `store_id` and claim UUID, not connection name or integer target ID. Renaming a connection then does not break credentials; separate stores cannot collide.

Hash the session lookup string to derive the filesystem directory name; record the original identity inside each claim file, so no shared per-session file is needed. This handles composite session IDs and traversal/filename hazards without treating IDs as trusted paths.

Use XDG state on Linux, Application Support on macOS, and LocalAppData on Windows, with a dedicated `PROJECT_TASKS_STATE_HOME` override for tests/custom locations. Keep config and secret state separate.

Approved (2026-10-24): one file per claim, named by claim UUID and grouped by store then hashed session (layout under Credential model). Owner-only directory/file permissions where supported; create a temporary file in the same directory, write fully, atomically rename. Because each claim writes only its own file, no local file lock is needed; the earlier read/merge/write lock is removed.

When `PROJECT_TASKS_STATE_HOME` is unset but `PROJECT_TASKS_HOME` is set, secret state is derived under `PROJECT_TASKS_HOME`, so tests that set only the data home cannot write real secrets.

Delegation validates each source secret against the current active DB claim before copying that claim's file into the child session directory. A stale secret after revocation is harmless because every protected write rechecks the DB. Every claim ending (release, revoke, completed, cancelled) deletes that claim's files immediately after the ending commits: every copy under this machine's store directory, including delegated copies in other session directories. A failed delete is reported as a cleanup warning and never undoes the ending. No scans of other agents' home directories.

Copies on other machines cannot be reached at ending time. Example: machine B force-revokes a claim whose secret lives on machine A. The sweep below exists for those copies and for failed deletes; it is a backstop, not the primary cleanup.

Stale-secret sweep (approved 2026-10-24), backstop only:

- An active claim's file is always kept.
- An ended claim's file is deleted on the next sweep; its secret can never pass the hash check again, and replay does not need it.
- A file with no claim row is deleted once it is older than 7 days. The grace period covers acquisition, which saves the secret before the row commits. The claim row and its receipt commit together, so the database state alone resolves uncertain outcomes.
- The sweep runs from `db init` when the store's `last_checked` is more than 3 days old. It is best-effort with a short timeout and never fails init.
- Each run sweeps only the store `db init` just connected to (matched by `store_id`); other store directories are untouched until `db init` runs against them. A failed or partial query deletes nothing, and `last_checked` is updated only after a complete sweep of that store.
- Cloned databases (approved 2026-10-26): a clone keeps the original's `store_id`, so a machine using both would share one store directory and a sweep against the clone would delete the original's live files. A clone must therefore be given a new `store_id` with `db rekey` before use. `db rekey` rewrites only the metadata row of the clone. Claim rows copied into the clone have no secret files under the new store directory, so they must be force-revoked and reclaimed there. Nothing detects a clone that skipped `db rekey`; the documented requirement is the only guard.

### 10. Cross-resource failures and replay

Decision: approved in review. Generate claim UUID/secret, persist the local secret durably, then attempt database acquisition. If local persistence fails, acquire no database claim. An orphan local entry is preferable to an active claim with an unrecoverable secret.

If acquisition definitely rolls back, remove its unused entry best-effort. If the connection outcome is uncertain, retain it and inspect the operation receipt before trying again. The shared claim is authoritative; local entries never themselves imply ownership.

For all mutations requiring uncertain-outcome recovery, including standalone handoffs and claim endings, use `operationId` plus versioned canonical logical payload hash. Bind store/operation/target/proposal identity and meaningful content; preserve meaningful array order and do not regenerate timestamps during replay. A committed receipt returns the prior non-secret result for an identical replay, without requiring an active claim or new ownership authorization; new operations still require ordinary authorization. Same ID with a different payload errors. Check receipts before stale revision/current-claim validation for a replay, and store results in the same transaction as domain changes. Keep receipts indefinitely initially. This handles a lost success response after finalization already released the claim.

Only replays are idempotent: a stale proposal with a different operation ID is still a conflict, not an automatic retry. Keep prepared files until success is known; do not auto-delete them.

Secret-file cleanup after a claim ends is defined in item 9. No compensating force-revocation is necessary when it fails.

### 11. Bulk claim targets

Decision: approved in review. Discover the task set under the same write transaction/lock as acquisition. Include pending/in-progress tasks; exclude final tasks. Treat a claim already authorized by the current session's secret as satisfied; another claim, or a missing secret, is a conflict.

Acquire new claims for remaining targets atomically. On failure leave preexisting caller claims unchanged and add nothing. Return the complete target/claim list plus which were newly acquired. Persist all prospective secrets before DB commit as described in item 10.

Take a snapshot of membership at acquisition: later tasks are not automatically claimed. They require normal acquisition. "All tasks" is a command option, not a permanent relationship.

Plan-claim branch metadata applies to the plan only. Child claims can start without it and receive their actual execution metadata later; do not falsely mark every cross-repository child as using the same branch.

### 12. Cancellation authorization

Decision: cancellation is one atomic transaction and does not acquire/release temporary claims. An unclaimed mutable target can be cancelled directly. If it is already claimed, verify the caller's secret for that active claim. Any affected target claimed by another agent, or lacking a valid local secret, makes ordinary cancellation fail with no changes.

For plan-wide cancellation, check the plan and every task selected for cancellation under the same transaction/lock. Do not require pre-acquisition of claims on unclaimed targets merely to cancel them. Existing claims remain authoritative: plan ownership never overrides another task claim. Ending a caller-owned claim as part of cancellation is an ordinary finalization release, not a temporary acquire/release pair.

The "cancel remaining" option selects pending tasks, but does not waive existing-claim checks. Another owner's pending claim blocks the entire batch just like an in-progress claim. Completed/cancelled targets remain unchanged.

Approved: a separately confirmed force-cancellation/revocation route, never an implicit fallback from failed cancellation. It must guard the exact observed claim IDs/revisions, require per-target final handoffs, and never waive finality or authorize unrelated requirements changes. Approved confirmation (2026-10-24): a `--confirm` flag plus the observed claim IDs and revisions in the payload, sent only after the user answers an exact prompt, matching the existing `--confirm-*` pattern. Changed claims or revisions make the command fail.

Require one final handoff per cancelled task and a final plan handoff when the operation finalizes the plan. One handoff can cover cancellation and the automatic ending of its caller-owned claim. Validate lifecycle, existing claims, revisions, membership, and all handoffs before writing; commit everything or roll back everything.

### 13. Empty plans and cancellation outcomes

Decision: approved in review. Finality is absorbing. Once a plan has a final outcome, the calculator returns that outcome unchanged; it never returns a finalized plan to pending.

For a mutable plan, use the agreed task-derived formula, with explicit finalization intent as an input to that same function. A new empty plan has no such intent and stays pending. An explicitly cancelled empty plan has no active tasks and can finalize as cancelled with its reason handoff. Do not create a separate zero-task cancellation handler.

Common rule: finalization requires no active tasks, required handoff evidence, and either a nonempty finalized task set or an explicit cancellation request. Choose completed if any task completed; otherwise cancelled. This resolves the accepted empty-plan cancellation without treating every freshly created empty plan as cancelled.

Do not add an empty-plan force-complete shortcut. For a nonempty plan, all-completed/cancelled remains required. When cancellation leaves completed work, explain that the remaining work was cancelled and the derived plan outcome is completed; never pretend completed tasks were cancelled.

### 14. Impact prompts

Decision: approved in review. Show a concise impact report for plan proposals, but require a blocking user question only for something the agent cannot already authorize or apply consistently: another owner's claim, a force revocation/cancellation, or a proposed rewrite of finalized records.

Changing the caller's own in-progress task requirements may proceed with the required claims and WHAT/WHY, as agreed. Report the impact, but do not introduce another approval gate just because status is in-progress.

Never offer "revoke and rewrite" for completed/cancelled tasks. Report those requirements as historical constraints and revise the plan or add successor tasks referencing them. The affected original rows remain unchanged.

The CLI returns structured conflict/impact data; the agent presents choices. Avoid interactive terminal questions inside helper transactions, where an unattended process might hold a database lock while waiting.

### 15. Preparing derived finalization

Decision: approved (2026-10-24). Add a read-only preparation/dry-run mode (`--prepare`) to the existing mutation routes, not a new status engine. It evaluates the same proposed changes against a consistent snapshot and reports affected plans, expected revisions/membership, required handoff targets, and canonical final task handoff IDs.

The agent generates any missing task/plan summaries, then submits the complete payload. It may supply summaries proactively without a dry run; preparation is a convenience, not a separate stateful approval phase.

During apply, recompute the effect and verify the supplied summaries cover exactly the targets that will finalize. Missing evidence or changed membership returns a machine-readable conflict with no writes. This applies equally to completion, cancellation, detach, and move.

A final plan summary references every current child task's canonical finalization handoff, including final handoffs created by this same payload. References for new handoffs can use proposal-local keys resolved to generated IDs atomically.

No database lock is held while the agent summarizes or asks the user. No automatic plan summary is synthesized by SQL, and no "we will fill in the handoff later" status transition is permitted.

### 16. Legacy finalized data

Decision: approved. Preserve old records and recorded statuses on schema upgrade. Do not silently recalculate every old plan or manufacture old session history.

Use the same append-only handoff facility to add a retrospective final-outcome handoff when one is needed for a new plan summary. Label it retrospective, timestamp it when written, identify the summarizing session, and say which facts came from stored data versus which are unknown. It can become canonical ending evidence if none exists, without mutating the finalized task row, only through the separately defined retrospective evidence operation; ordinary standalone annotations cannot grant canonical authority. Preserve an explicit migration baseline identifying legacy exceptions. Who may run the retrospective evidence operation, and the baseline representation, remain for review.

Do this on demand before a mutation that requires the evidence, not by running an LLM over the whole store at initialization. Historical progress handoffs alone are not substitutes for ending evidence.

If legacy data contains a finalized plan with active children, report a consistency problem rather than reopening the plan or automatically rewriting its children. Leave that history intact and create a successor plan/tasks for ongoing work. Any one-time structural repair should be a separately reviewed migration, not an exception in everyday status logic.

Tradeoff: some existing data may need manual reconciliation before the full new lifecycle can be used. That is preferable to silently changing completed work.

### 17. Handoff generation and metadata

Decision: approved with additions (2026-10-27). Agents may write standalone status-update handoffs at natural stopping points (no claim needed), so a later session has fresher state than the last official handoff; nothing enforces this. A `handoff` skill command (invoked as `/project-tasks:handoff`) lets the user trigger a full handoff on demand: the agent writes the full summary from the template below for its current task or plan and stores it as a standalone handoff with `task-db handoff` (the command syntax is in the Generation and storage section). Every handoff records the agent kind (such as `claude` or `codex`, from `PROJECT_TASKS_AGENT_TYPE`) and the session ID (`PROJECT_TASKS_SESSION_ID`), so a reader knows which session wrote it and can locate that session's transcript even though the helper never opens it. If either value is unavailable (standalone handoffs need no claim, so no session ID is guaranteed) it is stored as explicitly unknown, never guessed or invented. Store structured metadata alongside a rendered heading and full summary. Generate both from the same payload so rendering cannot silently disagree with the structured fields.

Require target identity, current writer session/agent, summary, and generated timestamp. The database also assigns recorded time and monotonic handoff order; use that order for latest/resumption, leaving generated time as attribution. Prefer repo/project/branch/HEAD when applicable. Missing optional facts should be null or explicitly unknown, never guessed. Include the original session identity separately when reconstructing somebody else's work.

For requirements changes, require nonempty structured `what` and `why`; render WHAT/WHY sections from those fields. Validate presence, not whether an LLM considers the explanation persuasive. For finalization/release, require outcome/stopping-state text and relevant uncertainties.

The summarization template should include: initial prompt; recent prompts; previous handoff; current task/plan requirements; current repository facts; changes made; test results; unresolved issues; next steps; and why this handoff is being written. Final plan generation takes canonical ending evidence from every task.

Initially use context already available to the agent plus explicit user/host-provided transcript exports. Do not discover/read installed session logs by traversing agent home directories. Agent kind plus session ID is the baseline locator; store an optional host-provided session locator (such as a transcript path) as additional informational metadata, not a path that the helper automatically opens.

Keep PR merge state explicit and separate from task completion: a completed task may have a PR that is open, closed unmerged, or merged. Preserve that snapshot without automatic polling or rewriting historical handoffs.

### 18. Commit discipline and dirty trees

Decision: approved (2026-10-27).

- Host instructions tell the agent to commit its work whenever it reaches a point it considers complete, even if testing later requires more changes. Work-in-progress commits are fine because commits can be squashed or rewritten afterwards; there is little reason to leave work uncommitted.
- A claim means "I am working on this". An agent does not release a claim, complete a task, or finalize a plan until its work is committed to its branch and the branch is pushed (when the repository has a remote). Returning a task to pending retains the claim, so it needs no push. This is an agent instruction, not a check the helper can enforce, consistent with judgments staying with the agent.
- Record the branch on the claim when work starts, and in handoffs. Any machine finds the work by branch name (fetch the branch, look for an existing worktree on it). No worktree path or hostname is recorded. The final handoff records the branch and `HEAD` commit.
- Handoffs store no diffs, and there is no dirty-tree question. Unrelated uncommitted changes do not block release or completion; the agent leaves them alone.
- Work that was never pushed from a machine nobody can reach is not something this plugin recovers. The mitigation is frequent WIP commits and pushes, and tasks small enough to restart.

### 19. Git hook installation, discovery, and failures

Decision: approved (2026-10-27). Opt-in repository-local installation of a small hook that calls a read-only claim-check helper. Resolve the effective hooks directory rather than assuming `.git` is a directory. Respect existing `core.hooksPath`. If another hook/manager is present, provide an integration snippet or ask before installing a wrapper; never overwrite it automatically. Git permits configured hook paths and invokes commit hooks from the working-tree root. [Git hook documentation](https://git-scm.com/docs/githooks)

Check the actual staged tree and use NUL-delimited filenames. Treat renames as delete/add for protection matching, avoiding heuristic rename detection; inspect both affected path names. NUL output and disabling rename detection are documented Git options. [Git diff documentation](https://git-scm.com/docs/git-diff)

Query registered links for the current repo/backend on every protected commit check. No background watcher and no authoritative local link cache initially. If the DB lookup fails before links can be enumerated, give a generic "linked-plan protection could not be verified" warning and allow the commit. This is simpler than pretending a stale cache is complete.

Use a short connection timeout so commits do not hang. Database/client unavailability means warn-only as agreed. A successful query that finds a linked path without the correct secret blocks. Missing session ID blocks only when a reachable lookup establishes that the commit touches a protected link; unrelated ordinary commits should not require an agent session.

Malformed local config should produce a clear configuration error rather than masquerading as a conflicting claim. Approved (2026-10-27): the hook blocks the commit on locally invalid configuration, with a clear error; connection/authentication failures that prevent DB verification use the agreed warn-and-allow behavior. `git commit --no-verify` remains the user's bypass.

No prompt or automatic claim/revocation from the hook. The agent must acquire/delegate before committing.

### 20. Linked-source consistency and finality

Decision: approved (2026-10-27). Treat the committed file content as source evidence. Record repository identity, relative path, the commit, and the SHA-256 content hash in the proposal. The content hash is the verification: compare it before apply and on refresh, and treat a mismatch as drift. The commit hash is provenance only (it records where the text came from), is never a verification check, and may become unreachable after squashes or rebases without that meaning the text changed. No separate Git blob ID is stored. Verify committed/clean source before applying; store exactly the reviewed committed content, not an untracked temporary replacement.

The linked sequence is: hold required claims; prepare edits; commit the source change using the plan secret; apply the prepared database changes against that committed content. If database apply fails, keep the plan claim and report that Git advanced but database content did not. Retry from current state or revise; never automatically revert the Git commit.

Rename follows the same ordering: commit the old/new path changes while the old registered link is protected, then atomically update the link/content/handoffs to the new committed path. Detach can retain the stored snapshot and record provenance when a source is missing. Source deletion is never part of a SQL transaction.

Another commit or filesystem edit can race checks; Git and SQL are not jointly atomic. Pinning the accepted content hash means the database still identifies exactly what was applied. Later drift is handled through explicit existing commands, not automatic updates.

Decision (approved): strict finality. Finalized linked plans cannot be claimed, so their linked files cannot receive a valid write authorization. Those registered files are immutable historical plan files; successor work uses a new file path. A reachable hook blocks changes to the old finalized link. Do not silently stop protecting finalized links.

Inline default avoids this problem for most plans. Offline warn-only behavior remains a deliberate limit to protection.

### 21. Inline provenance and source deletion

Decision: approved with a change (2026-10-27). Keep today's import behavior: importing a plan copies it into the database, then deletes the source file after the existing byte-verification. This suits plans written in a worktree, where an imported plan needs no commit and cherry-pick to reach `main`. A `--no-delete-file` option on import keeps the source file instead. `plan detach` is unchanged: it keeps the file unless `--delete-file` is given. The origin path is still recorded as provenance.

Import deletion keeps the existing byte-verification and changed-source safeguards; a file that fails verification is never deleted. If deletion fails after DB commit, report success of embedding/detaching and failure of deletion separately; never pretend they were atomic.

Store in-repository provenance relative to Git root. Temporary content inputs are not automatically durable origins. If an origin is outside the repository, read it only when explicitly supplied and keep any absolute locator as machine-specific metadata, not a portable link.

Refreshing missing/moved origins reports a helpful error and lets the agent supply an explicit new file. It must not search arbitrary directories or silently import similarly named files.

No change to the current import default; document the new `--no-delete-file` option. After a default import there is no file to refresh from, so refresh uses the explicit-new-file path above.

### 22. Recovery after revocation

Decision: approved with changes (2026-10-27). Recovery stays procedural, not a daemon/lease system, and is not this plugin's job beyond the database.

- Force-revoke is an emergency escape hatch, not a normal workflow. The command prints a warning before the confirmation (item 12) and submits the revocation handoff and expected claim ID in the atomic force operation. The plugin does not inspect, stop, or contact the old worker. Revocation changes database authorization only and is never reported as the worker having stopped.
- A replacement agent acquires a new claim, reads the handoff history, finds the work by the recorded branch name (fetch it, check for an existing worktree on that branch), and decides whether to continue from it or restart. The plugin never resets branches, discards changes, removes worktrees, or closes PRs.
- Old workers recheck authorization before database updates and linked commits; rejection means stop and report, not reclaim. Ordinary task-file edits cannot be prevented by the database lock, so this is coordination rather than file exclusion.
- Work never pushed from an unreachable machine is lost to everyone else (item 18).

### 23. Dependencies and successor work

Decision: approved (2026-10-27). Preserve existing completion-based dependency satisfaction. A cancelled task does not mean its required output exists, so cancellation should not automatically unblock dependants.

Follow-up work on a completed task can depend on it normally. New work replacing a cancelled task should reference the cancelled item in the requirements/handoff/related IDs, but should not use that cancellation as a satisfied execution prerequisite. If other pending dependants must use the replacement, update their dependency lists under the same metadata/membership rules; never rewrite finalized dependants.

Validate dependencies inside the transaction: referenced tasks exist in the current project's sequence namespace, no self-reference/duplicates/cycles, and no silent conversion across backends. Preserve current sequence-based JSON representation initially; claims/handoffs still use internal IDs.

Validate start preconditions and set in-progress atomically. Do not acquire a claim as an implicit status change. Claim acquisition reserves the task; starting work is a separate authorized mutation that rechecks dependency state.

Cross-project execution dependencies would require a typed-ID design separate from current same-project sequence arrays. Do not silently add them during this backend refactor; cross-project plan membership already supported by current code is not the same feature.

### 24. Import, staged delivery, runtime, and effort

Decision: approved (2026-10-27), with one change: a one-time SQLite-to-PostgreSQL import is in scope. Implement additive in-place SQLite upgrades and new PostgreSQL schema creation. The import is an explicit command given the path of one SQLite file; it never discovers or reads installed agent directories. It imports the whole database into an empty, freshly initialized PostgreSQL store only (refused if the target has any projects), in one all-or-nothing transaction, preserving IDs and sequence numbers exactly so `#NNN` references stay valid. Finalized items arrive as labeled retrospective legacy items under item 16. Claims and secrets do not exist in SQLite and are not imported. Merging into a store that already has data is not supported. Backend switching otherwise remains selection only.

Deliver in reviewable stages while keeping incomplete shared-write workflows unavailable:

Approved (2026-10-27): the 8 steps under "Proposed implementation sequence" are the work breakdown and the task list; these stages are the PR groupings, each covering the steps shown.

1. Driver/packaging/session/hook proof-of-concept and interface decisions (step 1).
2. Repository extraction, config, and equivalent backend behavior (steps 2–3).
3. Claims/credentials and all mutation guards (step 4).
4. Handoffs/proposals/finality/derived status (steps 5–6).
5. Linked protection, host instructions, one-time import, and complete verification (steps 7–9).

Do not advertise PostgreSQL shared execution before the claim/handoff write path is complete. Intermediate PRs can build internals without publishing a partially enforced concurrency contract.

Target Node >=24 as agreed in item 1, testing the minimum supported Node 24 release plus the team's supported newer runtime. Pin the Postgres client/build dependency in lockfiles. For initial supported database versions, target a concrete PostgreSQL baseline such as 16 and test it plus the current supported server chosen for the LAN; supporting every historical server is unnecessary.

Add a disposable Docker Compose PostgreSQL test service bound to loopback on a nonconflicting configurable port. Do not touch the user's existing database or containers. Execute the canonical six plugin suites plus shared conformance/race/fault-injection suites, clean-plugin distribution tests, hook tests in temporary repos/worktrees, and root structure tests. No new CI requirement is implied.

The repository's existing canonical plugin command is:

```sh
node --experimental-strip-types --test \
  plugins/project-tasks/task-db.test.mts \
  plugins/project-tasks/task-db.integration.test.mts \
  plugins/project-tasks/task-db.plan-read.test.mts \
  plugins/project-tasks/task-db.plan-sync.test.mts \
  plugins/project-tasks/task-db.gfm.test.mts \
  plugins/project-tasks/task-db.format.test.mts
```

Update commands, execution/recovery references, README, and matching plugin manifests/catalog versions. Follow repository release/skill-verification requirements only when those files are actually changed. No implementation, dependency installation, commit, or configuration application is authorized by this recommendation write-up.

Rough planning range for the expanded scope: 20–32 focused engineering days, not a delivery promise:

| Work | Stage (steps) | Planning allowance |
| --- | --- | --- |
| Interface/driver/host integration spikes | 1 (1) | 2–3 days |
| Repositories/config/compatibility | 2 (2–3) | 4–6 days |
| Claims/secrets/guards | 3 (4) | 3–5 days |
| Handoffs/atomic updates/lifecycle | 4 (5–6) | 5–8 days |
| Hooks/docs/distribution/end-to-end verification | 5 (7–8) | 4–6 days |
| One-time SQLite-to-PostgreSQL import | 5 (9) | 2–4 days |

This is my estimate, not measured project performance. Packaging and child-session integration are the main uncertainties. If proof-of-concept reveals host limitations, revise scope/estimate before implementation rather than adding hidden workarounds.

### Cross-cutting checks before accepting these recommendations

- Every live mutation runs through one shared validator/transaction pipeline.
- Force actions do not waive finality or required handoffs.
- No claim ownership comes from session identity alone.
- No local secret/raw credential appears in proposals, handoffs, or normal output.
- Finalization evidence is stable even when later standalone handoffs are appended.
- No Git/filesystem/database atomicity is promised.
- Existing finalized history is preserved, not silently reconstructed or reopened.
- Requirements-impact judgments and summary generation stay with the agent; deterministic validation stays with the helper.
- All 24 items are decided; the decisions and the incorporated schema integrity requirements do not authorize implementation.

## Open questions, gaps, and edge cases

1. **Repository transport:** Node >=24 with node:sqlite/pg and serialized real transactions settled; verify bundling, bound parameters, async dispatch, READ COMMITTED lock ordering, timeouts, and deterministic output.
2. **Config contract:** settled. `.agents/.claude/.codex` priority with `PROJECT_TASKS_CONFIG_DIR` as a top override; backend from working-directory config only; literal `~/.config` global path; connection validation, `passwordEnv`, deferred password files, atomic writes, and partial-success reporting approved. Remaining: verify password-file behavior against `pg` before adding it.
3. **CLI/payload:** plan text referenced by staged hash and caller-supplied `--operation-id` approved. Remaining: exact commands, task/plan and sequence/internal-ID resolution, JSON validation/versioning, handoff minimum fields (item 17).
4. **Schema:** database-review integrity requirements incorporated in item 4; full DDL, legacy baseline representation, source manifests, publication keys, and independent-clone identity remain to settle. PostgreSQL timestamptz/SQLite UTC text, trigger/helper enforcement, and millisecond precision are approved.
5. **Revision scope:** settled; see item 5.
6. **Metadata boundary:** settled; see item 6.
7. **Legacy writes:** settled; see item 7.
8. **Session integration:** attribution variables approved. Remaining: verify stable Codex/Claude session IDs, env export, and child identity; delegation syntax; the conditional parent-minted lookup ID.
9. **Secret files:** settled. One file per claim, no lock, state-home fallback, immediate deletion on every claim ending, and the backstop sweep (7-day grace for rowless files, 3-day `last_checked` interval per store) approved.
10. **Cross-resource failure:** settled; see item 10.
11. **Bulk targets:** settled; see item 11.
12. **Cancellation authorization:** settled, including the confirmed force route; see item 12.
13. **Empty-plan finalization:** settled; see item 13.
14. **Impact prompts:** settled; see item 14.
15. **Derived-finalization preparation:** approved (`--prepare`). Remaining: tests proving prepare and apply agree.
16. **Legacy final items:** policy approved (item 16). Remaining: who may run the retrospective evidence operation, and the baseline representation.
17. **Summary integration:** settled; see item 17.
18. **Commit discipline and dirty trees:** settled; see item 18.
19. **Hook discovery/install:** settled; see item 19.
20. **Linked consistency:** settled; see item 20. Remaining: clone identity and path changes.
21. **Inline provenance/deletion:** settled; see item 21.
22. **Worker recovery:** settled; see item 22.
23. **Dependencies:** settled; see item 23.
24. **Import/delivery/estimate:** settled; see item 24. One-time whole-database import into an empty store is in scope.
