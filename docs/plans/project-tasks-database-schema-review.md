# Project-tasks database schema: focused review

Reviewed: 2026-10-11. Status: review recommendations, **not approved schema changes**. No database, implementation, dependencies, or installed configuration was changed.

Reviewed sources: [backend plan](project-tasks-database-backends.md), [HTML schema draft](project-tasks-database-schema-review.html), and the existing `plugins/project-tasks/lib/schema.mjs`, `db.mjs`, `handlers.mjs`, and `plan-sync.mjs`.

The table structure is a reasonable starting point. The important gaps are the guarantees between tables: ending a claim with evidence for the correct target, establishing a complete finalization record, ordering handoffs independently of agent clocks, and validating final plan summaries against exact task membership. These should be settled before generating DDL.

Accepted constraints carried into this review: Node >=24; `node:sqlite` and `pg`; real mutation transactions; PostgreSQL **all date/time columns use `timestamptz`**, including existing fields; SQLite stores new timestamps as ISO 8601 UTC text; repository outputs use consistent strings. PostgreSQL mutation serialization with a transaction advisory lock is the proposed concurrency approach discussed so far. Other choices below remain recommendations.

## Findings requiring resolution before implementation

### 1. An ending-handoff foreign key does not prove that the handoff belongs to the claim's target

The draft `claims.ending_handoff_id -> handoffs.id` proves that some handoff exists. It allows a claim on task 42 to end using a handoff for task 7 or a plan. The same problem exists for `handoffs.predecessor_id`: an unrelated target's summary can become the predecessor.

**Recommendation:** retain the two nullable target FKs and enforce exactly one with `CHECK ((task_id IS NOT NULL) <> (plan_id IS NOT NULL))`. Give both target FKs `ON DELETE RESTRICT`. Add same-target validation for ending and predecessor references, inside the mutation transaction, plus database triggers if database enforcement is chosen. Alternatively, use separate composite FK pairs with supporting unique keys for the task and plan cases; design their NULL behavior explicitly. A normal FK to the UUID alone is insufficient. Composite foreign keys can skip validation when a referencing component is NULL, so a superficially correct composite design needs careful testing. [SQLite foreign-key documentation](https://www.sqlite.org/foreignkeys.html)

Use these indexes, separately for tasks and plans:

```sql
CREATE UNIQUE INDEX claims_active_task
  ON claims(task_id) WHERE task_id IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX claims_active_plan
  ON claims(plan_id) WHERE plan_id IS NOT NULL AND ended_at IS NULL;
```

A unique index on `(task_id, plan_id)` would not enforce active uniqueness with the default NULL behavior. PostgreSQL documents NULL treatment and partial unique indexes. [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

Claim lifetime columns must be coherent: either all of `ended_at`, `ending_reason`, `ending_handoff_id` are NULL, or all are non-NULL. Use explicit `IS NULL`/`IS NOT NULL` checks. Recommended controlled ending reasons: release, revoke, completed, cancelled. Make target, secret hash, creation attribution, and creation time immutable; permit optional branch/worktree updates only while active; allow one transition to ended, then freeze the row. Do not require `ended_at >= created_at` until clock authority is defined: client/server clock skew can make that check reject legitimate endings.

**Failure case:** a release command stores a valid handoff UUID for another task. Ordinary FKs and a non-NULL ending time accept the release, but there is no trustworthy state summary for the released task.

### 2. Canonical-final uniqueness does not ensure finalization evidence exists

At most one canonical final handoff is necessary but insufficient. Nothing in the draft requires a task with final status to have one, associates it with the final outcome, or prevents standalone no-claim handoffs from claiming canonical authority.

**Recommendation:** canonical-final handoffs may be inserted only by the authorized finalization operation, or a separately approved retrospective historical-evidence operation. Standalone handoffs always remain annotations. Record a typed final outcome (`completed` or `cancelled`) on canonical handoffs and the creating mutation operation ID. Enforce one canonical handoff per target with two partial unique indexes. Flags are non-NULL; SQLite flags have `CHECK (... IN (0,1))`.

For new finalizations, one transaction inserts the canonical handoff and references, ends any active claim with that evidence, and updates final status. Validate that final outcome equals target status and no active claim remains. If triggers enforce this, order these writes deliberately; requiring final status before inserting evidence while requiring evidence before final status creates an impossible cycle. Legacy finalized rows need an explicit exception/baseline, discussed below.

Use append-only enforcement for handoffs and their final-source rows. A foreign key with delete restriction alone does not prevent summary text, final flags, or provenance from being edited.

**Failure case:** the task reaches completed status, but a handler omits its final handoff. Later plan finalization cannot truthfully assemble the required task outcome history.

### 3. The final-plan source join needs stronger semantics and a primary key

The draft join has two handoff UUID columns but no explicit primary key, no endpoint type check, and no guarantee that references cover the exact child set. Two references to one task do not substitute for evidence from two tasks.

**Recommendation:** give `final_handoff_sources` primary key `(plan_handoff_id, task_handoff_id)`, with both FKs restricted on deletion. Validate that the left endpoint is a canonical final **plan** handoff and the right endpoint a canonical final **task** handoff. Validate that each right-hand task belonged to that plan at finalization and that the reference set equals the full child set exactly. Cross-project children already exist; compare internal IDs, not project-local sequences or the plan's project name.

The plan operation's preconditions must include its expected aggregate revision and the exact set of child task IDs, revisions, and canonical handoff IDs. Recheck under the mutation lock. Store the accepted finalization membership/revision manifest as immutable evidence, either in structured handoff metadata with a versioned shape or a dedicated manifest table. Live membership is frozen after finalization, but a manifest makes historical evidence explicit.

For an empty finalized plan the join has zero rows, but the plan still needs its own final handoff. The policy authorizing empty cancellation remains a lifecycle question; the schema must not interpret zero evidence rows as missing evidence by itself.

**Failure case:** while a summary is being prepared, a task moves into the plan. Every referenced UUID remains valid, but the summary omits that task. A membership precondition catches this; ordinary FKs do not.

### 4. Agent-generated timestamps cannot define the latest handoff

The draft has `generated_at` and a UUID but lacks an authoritative append order. Two machines can have skewed clocks; prepared summaries can be submitted out of generation order. Sorting by generated time, or breaking ties with random UUIDs, can select an older summary as latest.

**Recommendation:** add a database-assigned monotonic `handoff_order` (unique integer) and a database-recorded `recorded_at`. Keep `generated_at` as agent attribution. Use `handoff_order` for newest/default resumption and predecessor validation. With serialized writes, allocation inside the transaction is straightforward; do not expose it as a replacement for UUID identity. Index `(task_id, handoff_order)` and `(plan_id, handoff_order)` over their non-NULL target cases.

The predecessor remains optional context, not a mandatory linked list. If a proposal used a predecessor, require it to equal the latest accepted handoff at apply time and belong to the same target. Insert a successor only after its predecessor exists; with immutable rows this also prevents predecessor cycles. Later standalone annotations must never replace canonical final evidence.

**Failure case:** a remote agent's clock is ten minutes ahead. An outdated handoff submitted yesterday can keep appearing above today's newly accepted summary if generated times are used as truth.

### 5. SQLite legacy timestamp strings conflict with the new representation

The current `db.mjs` `now()` uses `new Date().toISOString().slice(0,16).replace('T',' ')`: UTC values stored as `YYYY-MM-DD HH:mm`, without seconds or zone. The HTML currently says existing timestamps retain their representation on both backends; that contradicts the accepted PostgreSQL decision.

**Recommendation:** PostgreSQL date/time columns use `timestamptz`, including task `created`, `updated`, `completed_at`; plan `created`, `updated`, `synced_at`, `pending_at`; claim `created_at`, `ended_at`; handoff `generated_at`, proposed `recorded_at`; mutation receipt `committed_at`; publication receipt `published_at`; and any new migration timestamp. Historical timestamps embedded inside JSON remain JSON content, rather than independent typed columns.

New SQLite values use a fixed UTC format such as `YYYY-MM-DDTHH:mm:ss.SSSZ`. Preserve existing SQLite rows under the additive migration policy. Recognize the known old format explicitly as UTC, normalize output, and normalize comparisons before sorting/filtering mixed old/new values. Do not feed unzoned legacy values to implicit local-time parsing. Raw text sort is wrong within a date when the old strings use a space and new strings use `T`. Retain legacy minute precision honestly; do not invent original seconds.

PostgreSQL stores timezone-aware instants and displays them in the session timezone; it does not retain the original timezone name. Configure UTC presentation and require offsets on inputs. Decide whether to limit precision to milliseconds, e.g. `timestamptz(3)`, matching Node strings, or preserve microseconds with a custom string parser. [PostgreSQL date/time documentation](https://www.postgresql.org/docs/current/datatype-datetime.html)

`pg` parses `timestamptz` into JavaScript `Date` by default, with millisecond precision. Normalize explicitly to the repository's string contract rather than leaking Date objects or depending on JSON serialization to repair outputs. [node-postgres type parsing](https://node-postgres.com/features/types)

**Failure case:** SQLite orders legacy `2026-10-11 23:59` before new `2026-10-11T00:01:00.000Z` when ascending by raw text, reversing their actual order.

### 6. Mutation receipts need a complete replay contract

Operation UUID, payload hash, saved result, and commit time are suitable. Missing details can still permit duplicate mutations or make successful operations appear failed on retry.

**Recommendation:** store `operation_id` as primary key, non-NULL hash with an explicit hashing/canonicalization version, command/result schema version, committed timestamp, and a validated non-secret result. Bind the hash to operation kind, typed targets, store ID, proposal version, preconditions, changes, and handoffs. Define whether insignificant JSON formatting/key ordering counts as the same payload; recommend canonical logical JSON, without regenerating attribution/timestamps on retry. Preserve array ordering where meaningful.

Within the selected store and transaction, look up a receipt before interpreting stale revisions or old claims as a new operation. Same ID/hash returns the prior result; different hash fails. New changes and receipt insert commit together. Define whether replay after release/revocation requires current authority; applying normal current-claim checks first defeats recovery of already-completed operations. Never include secrets in receipts.

All mutations requiring uncertain-outcome recovery, including standalone handoffs and claim endings, should have operation IDs. Acquisition additionally needs a durable pre-generated local secret or another explicit recovery protocol: a database receipt cannot recover a random secret that was never safely saved locally. Keep receipt retention indefinite initially so old operation IDs cannot silently become reusable.

**Failure case:** a completion commits and ends the claim, but the response is lost. A retry that checks the now-inactive claim before its receipt reports failure even though the operation already succeeded.

## Additional schema recommendations

| Area | Specific recommendation | Reason |
| --- | --- | --- |
| Store identity | Singleton row with `singleton_id = 1` enforced by PK/CHECK, non-NULL unique random `store_id`, non-NULL migration version; create once atomically | The draft has no singleton key; multiple identity rows make proposal targeting ambiguous |
| Store copying | Preserve identity for backup/restore of the same logical store; explicitly re-identify deliberate independent clones before writes | A copied SQLite file otherwise accepts proposals intended for its sibling; table design alone cannot identify an independent copy |
| Revisions | Nullable additive SQLite column; interpret NULL as zero; new rows explicitly zero; update with `COALESCE(revision,0)+1`; reject negative values | `NULL+1` remains NULL and silently breaks conflict detection |
| Revision coverage | Increment once per transaction per changed task/plan; increment plan aggregate revision on child changes affecting summary context even if derived status is unchanged | A title/requirements change to a child can stale a prepared plan summary without changing plan status |
| Claims | UUID PK; non-NULL valid SHA-256 hash, session/agent, creation time; target/lifetime checks; never retarget or reuse ended claim IDs | Prevents ambiguous ownership and history reuse |
| Handoffs | UUID PK; non-NULL target, session/agent, generated/recorded times, nonblank summary; JSON object metadata, JSON array reasons; non-NULL final/retrospective flags | Defaults must not allow missing evidence to look valid |
| Final handoffs | Controlled final outcome, mutation operation reference, target-revision evidence; immutable canonical flag | Connects outcome and provenance to the mutation that actually finalized the record |
| Requirements handoffs | Validate nonblank WHAT and WHY when used for requirements changes, and required per-target evidence in the operation | Optional columns alone cannot enforce action-specific evidence |
| Final-source join | Composite PK and immutable rows; reverse index on `task_handoff_id` | Prevents duplicate edges; supports history lookup |
| Membership queries | Index `tasks(plan_id)` | Existing `(plan_id,plan_anchor)` index is partial and omits NULL-anchor children |
| Claim history | Target/time or target/order indexes separate from active-only unique indexes | Active indexes omit ended history |
| Canonical lookup | Partial unique indexes on non-NULL task/plan targets where canonical-final is true | Provides efficient stable ending lookup |
| Publication | Append-only receipts, indexed task FK, operation reference, explicit destination/release identity where deduplication is needed | Generic JSON metadata does not define when repeat publication is duplicate |
| Legacy changelog | Read published state as legacy `in_changelog=1` OR qualifying publication receipt exists | Replacing the flag in reads without this union loses prior publication history |
| JSON | Keep existing TEXT arrays initially; validate shape/elements at repository boundary; new table JSON columns should reject malformed JSON | Valid JSON alone does not mean a dependency array contains valid task sequences |
| Source identity | Add explicit `repo_identity`, `source_commit`, `source_blob`, and hash algorithm/version where source evidence is persisted; preserve reviewed staging identity separately | Current path/hash columns cannot distinguish same path in another repository or reproduce the accepted Git blob |
| Paths | Linked path must be nonblank and repository-relative; validate path containment in source helper; distinguish portable repository identity from machine-specific worktree attribution | A relative path without repository identity is ambiguous across projects/checkouts |

For publication receipts, decide whether one task can be published to several destinations/releases. Recommend retaining multiple historical receipts, with an optional explicit uniqueness rule on `(task_id, publication_key)` when a stable destination/release key exists. “Task has any receipt” is adequate for current boolean compatibility but may be too coarse for future destination-specific queries.

Keep task/plan internal integer IDs and `(project,seq)` unique keys. Allocate project sequences inside the write lock/transaction and return inserted IDs with `RETURNING`. Global serialization makes `MAX(seq)+1` acceptable initially; retain uniqueness as the backstop. Sequence gaps are harmless. If PostgreSQL identity IDs are `bigint`, define how they cross the JavaScript boundary; preserve the current numeric output contract only within safe integer bounds. Do not silently switch public IDs to strings. SQLite UUID primary keys should explicitly include `NOT NULL`: ordinary SQLite tables can allow NULL in non-integer primary-key columns for historical compatibility. [SQLite CREATE TABLE documentation](https://www.sqlite.org/lang_createtable.html)

Do not add `CHECK(seq>0)` to existing write flows without auditing them: current project migration temporarily parks task sequences as negative values inside its transaction. That migration also rewrites identifiers on finalized rows and already requires separate policy approval. The schema change should not accidentally approve or break it.

The current `(plan_id,plan_anchor)` index permits a non-NULL anchor with NULL plan ID. For new writes require `plan_anchor IS NULL OR plan_id IS NOT NULL`, reject empty anchors, and preserve cross-project membership. Audit legacy violations before adding any new enforcement to existing tables.

## Transactions and constraint enforcement

If PostgreSQL serialization is adopted, take one fixed application advisory transaction lock before authorization/state reads, then use `READ COMMITTED`. A command that waited behind another writer must read the state committed by that writer after lock acquisition. Avoid establishing a repeatable-read snapshot before waiting on the advisory lock. Each command uses one `pg.Client`, and migrations/bootstrap use the same lock discipline. Set finite lock/statement timeouts and perform LLM preparation/file interaction outside transactions. Transaction-level advisory locks release on transaction end. [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html), [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

An advisory lock coordinates only participating clients. Unique indexes, FKs, and local checks remain necessary. SQLite enables and verifies `PRAGMA foreign_keys=ON` on every connection before transactions and uses `BEGIN IMMEDIATE` for mutations. SQLite foreign-key enforcement is connection-specific. [SQLite foreign-key documentation](https://www.sqlite.org/foreignkeys.html)

**Recommended enforcement split:** database PK/FK/unique/local checks for identity and row shape; narrow triggers for append-only history, same-target ending/predecessor links, and ended-claim immutability; one shared transactional domain validator for authorization, dependency cycles, exact final-summary membership, action-specific handoffs, and derived plan status. PostgreSQL CHECK constraints cannot safely express rules against changing rows in other tables. [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

Trigger scope is a policy choice. A trusted-agent model does not require defending against a database administrator disabling constraints, but ordinary handler mistakes should not be able to edit audit evidence unnoticed. If triggers are declined, explicitly document those invariants as helper-enforced and exercise every legacy mutation path against the shared pipeline.

## Additive migration and legacy history

Keep the current no-table-rebuild, no-renumber, no-row-copy SQLite policy. Add revision/source columns with NULL defaults and create the new tables/indexes. Wrap each supported migration and version advancement together in a transaction; unknown newer schema versions fail rather than attempting downgrade. Concurrent initialization must use the same mutation serialization strategy. A version number must represent completed DDL, not attempted DDL.

Audit an exported/disposable copy for malformed JSON, dangling plan IDs, orphaned anchors, timestamp variants, and lifecycle inconsistencies before deciding any constraint retrofits. New constraints on old tables can fail on historical data; do not silently normalize or drop rows to satisfy them. Strong local checks can be installed on new tables without rewriting old ones.

Existing finalized tasks have no canonical ending handoffs. Migration must not fabricate agent testimony, completion times, secrets, or receipts. Preserve their fields and mark a stable legacy baseline, using an explicit nullable legacy-history marker or a separate baseline table keyed by target. When a new plan finalization requires those task endings, require an explicitly marked retrospective canonical evidence operation and keep uncertain details explicit. Merely appending a standalone note is insufficient to establish canonical authority. If an alternative legacy-summary policy is preferred, approve it before implementation.

Existing finalized plans retain historical status even if it differs from the new derivation; do not reopen or recalculate them during migration. A mutable legacy plan whose children are all final may need prepared handoffs before reconciliation. Migration should report this condition without inventing an outcome.

A one-time whole-database SQLite-to-PostgreSQL import into an empty store is in scope (backends plan item 24). New PostgreSQL tables should have native `timestamptz` columns from creation; this does not require rewriting existing SQLite rows or implementing an import. A future explicit import must preserve IDs/sequence values, interpret known legacy timestamps as UTC, and advance identity allocators above imported maxima.

## Decisions

1. **Approved (2026-10-27):** database-assigned handoff order and recorded time, separate from generated time (backends plan item 17).
2. **Approved:** narrow triggers plus domain validation for audit immutability and same-target evidence.
3. **Approved:** explicit, labeled retrospective evidence with a preserved migration baseline, created on demand. Statuses are never recalculated.
4. **Settled in backends plan item 10:** an identical committed replay returns its saved non-secret result without requiring an active claim.
5. **Approved:** milliseconds. UTC strings in SQLite and `timestamptz(3)` in PostgreSQL, with explicit legacy parsing.
6. **Partly settled:** a cloned store must run `db rekey` to get a new `store_id` (backends plan item 9). Still open: publication identity/deduplication.
7. **Settled in backends plan item 13:** explicitly cancelled empty plans finalize as cancelled with a reason handoff. New empty plans stay pending.

The original table layout can stay. The next schema draft should add the ordering/provenance fields, spell out NULL and lifecycle constraints, show all native PostgreSQL timestamps, and distinguish database-enforced rules from transactional domain validation. That would make the schema precise enough for a full DDL review without authorizing implementation.
