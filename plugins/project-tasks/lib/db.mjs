/**
 * db — the sqlite3 process layer for `task-db`.
 *
 * Every query runs through `sql()`, which spawns a fresh `sqlite3` process. That
 * matters more than it looks: connection-scoped state does not survive between
 * calls, so anything that must hold for a statement has to be prepended to the
 * script that carries it. Two things must:
 *
 *   PRAGMA foreign_keys=ON  — per-connection, defaults to OFF. Without it the
 *     `tasks.plan_id REFERENCES plans(id)` clause is a comment: an insert naming
 *     a nonexistent plan succeeds silently and the row is unreachable from its
 *     plan forever.
 *   busy_timeout=5000       — without it a concurrent writer fails instantly
 *     with SQLITE_BUSY rather than waiting out a short lock.
 *
 * The busy timeout is issued as the `.timeout` dot command rather than
 * `PRAGMA busy_timeout=5000;`. They call the same C function, but the PRAGMA
 * form is a query that RETURNS ITS VALUE, so it would print `5000` on the first
 * line of every command's stdout and corrupt every parse downstream. Verified.
 *
 * `-bail` is load-bearing, not defensive. Verified on sqlite3 3.51.0: without
 * it, a failing statement inside `BEGIN IMMEDIATE … COMMIT` is skipped, the
 * COMMIT still runs, and the transaction lands half-applied. With it, sqlite3
 * exits at the failure with the transaction still open, and closing the
 * connection rolls the whole batch back.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A user-facing failure raised below the parser.
 *
 * Shaped like `CliError` — `message` is already formatted for stderr and
 * `exitCode` travels with the error — so `bin/task-db` has one exit path for
 * both layers and never has to decide a code itself.
 */
export class DbError extends Error {
    /**
     * @param {string} message
     * @param {{ exitCode?: number }} [options]
     */
    constructor(message, options = {}) {
        super(message);
        this.name = 'DbError';
        this.exitCode = options.exitCode ?? 1;
    }
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Resolve the sqlite busy timeout. The environment override is a narrow test
 * seam; invalid values retain the production default.
 *
 * @returns {number}
 */
function resolveBusyTimeoutMs() {
    const raw = process.env.PROJECT_TASKS_BUSY_TIMEOUT_MS?.trim();
    if (raw !== undefined && /^\d+$/.test(raw)) {
        const timeout = Number(raw);
        if (Number.isSafeInteger(timeout)) return timeout;
    }
    return DEFAULT_BUSY_TIMEOUT_MS;
}

/**
 * @param {number} timeoutMs
 * @returns {string}
 */
function preamble(timeoutMs) {
    return `PRAGMA foreign_keys=ON;\n.timeout ${timeoutMs}\n`;
}

/**
 * @param {number} timeoutMs
 * @returns {string}
 */
function formatBusyTimeout(timeoutMs) {
    return timeoutMs >= 1000 && timeoutMs % 1000 === 0
        ? `${timeoutMs / 1000}s`
        : `${timeoutMs}ms`;
}

/** @type {Map<string,string>} home → resolved db path (mkdir already done) */
const homeCache = new Map();

/**
 * Resolve the database path from the environment.
 *
 * Read per call rather than frozen at import, so a test can point the module at
 * a temp home without re-importing it. Every real invocation is a fresh process
 * where the value cannot change anyway.
 *
 * @returns {string}
 */
export function dbPath() {
    const home =
        process.env.PROJECT_TASKS_HOME ??
        (process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'project-tasks') : null) ??
        join(process.env.HOME ?? '', '.claude');
    let path = homeCache.get(home);
    if (path === undefined) {
        mkdirSync(home, { recursive: true });
        path = join(home, 'tasks.db');
        homeCache.set(home, path);
    }
    return path;
}

/**
 * Run a SQL script through a fresh `sqlite3` process. Returns trimmed stdout.
 *
 * @param {string} query
 * @param {string[]} [flags] extra sqlite3 argv, e.g. `['-json']`
 * @returns {string}
 */
export function sql(query, flags = []) {
    const timeoutMs = resolveBusyTimeoutMs();
    try {
        return execFileSync('sqlite3', ['-bail', ...flags, dbPath()], {
            input: `${preamble(timeoutMs)}${query}\n`,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 64 * 1024 * 1024,
        }).trim();
    } catch (err) {
        throw new DbError(describeFailure(err, timeoutMs));
    }
}

/**
 * Turn a spawn failure into something a caller can act on.
 *
 * @param {any} err
 * @param {number} timeoutMs
 * @returns {string}
 */
function describeFailure(err, timeoutMs) {
    if (err?.code === 'ENOENT') {
        return "ERROR: 'sqlite3' was not found on PATH.\n       task-db shells out to the sqlite3 CLI; install it and retry.";
    }
    const detail = String(err?.stderr ?? '').trim() || String(err?.message ?? '').trim();
    if (/database is locked|SQLITE_BUSY/i.test(detail)) {
        return (
            `ERROR: the task database stayed locked for longer than ${formatBusyTimeout(timeoutMs)}.\n` +
            '       Another task-db process is mid-write. Nothing was changed; retry.'
        );
    }
    return `ERROR: database operation failed.\n       ${detail || 'sqlite3 exited nonzero.'}`;
}

/**
 * Run one or more statements as a single atomic batch.
 *
 * Used by every operation that touches more than one row, or that pairs a state
 * change with an auto-note. On any failure the batch rolls back whole — there is
 * no half-applied transition.
 *
 * @param {string|string[]} statements
 * @param {string[]} [flags]
 * @returns {string}
 */
export function transaction(statements, flags = []) {
    const body = (Array.isArray(statements) ? statements : [statements]).join('\n');
    try {
        return sql(`BEGIN IMMEDIATE;\n${body}\nCOMMIT;`, flags);
    } catch (err) {
        if (err instanceof DbError) {
            throw new DbError(
                `${err.message}\n       The transaction was rolled back; no partial change was applied.`,
                { exitCode: err.exitCode },
            );
        }
        throw err;
    }
}

/**
 * Run a query in `-json` mode and parse the result.
 *
 * @param {string} query
 * @returns {any[]}
 */
export function sqlJson(query) {
    const out = sql(query, ['-json']);
    return out ? JSON.parse(out) : [];
}

/**
 * Run a query in pipe-separated mode — the row shape every list command emits.
 *
 * @param {string} query
 * @returns {string}
 */
export function sqlRows(query) {
    return sql(query, ['-separator', '|']);
}

/**
 * Run a query and return stdout with exactly sqlite3's own row-terminating
 * newline removed — never `.trim()`, which also destroys a plan body's real
 * leading/trailing whitespace. sqlite3's `-list` mode appends exactly one
 * `\n` after a row's value regardless of what the value itself contains, so
 * stripping one trailing `\n` (not trimming) recovers the exact stored bytes.
 *
 * @param {string} query
 * @returns {string}
 */
export function sqlBody(query) {
    const timeoutMs = resolveBusyTimeoutMs();
    try {
        const out = execFileSync('sqlite3', ['-bail', dbPath()], {
            input: `${preamble(timeoutMs)}${query}\n`,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 64 * 1024 * 1024,
        });
        return out.endsWith('\n') ? out.slice(0, -1) : out;
    } catch (err) {
        throw new DbError(describeFailure(err, timeoutMs));
    }
}

/**
 * SQL-escape a scalar for use inside a single-quoted literal.
 *
 * Correct for short scalars (titles, statuses, timestamps). It is NOT the tool
 * for file bodies or note prose — those go through `readfileExpr` so no amount
 * of content can reshape the statement carrying it.
 *
 * @param {unknown} val
 * @returns {string}
 */
export function esc(val) {
    return String(val ?? '').replace(/'/g, "''");
}

/** Current timestamp in the `YYYY-MM-DD HH:MM` form the schema stores. */
export function now() {
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * @param {string} text
 * @returns {string} lowercase hex sha256
 */
export function sha256(text) {
    return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * A SQL expression yielding a file's contents as TEXT.
 *
 * `readfile()` returns a BLOB, and `json()` rejects a BLOB as malformed, so the
 * CAST is required rather than cosmetic.
 *
 * @param {string} path
 * @returns {string}
 */
export function readfileExpr(path) {
    return `CAST(readfile('${esc(path)}') AS TEXT)`;
}

/**
 * Read a file's contents as a JS string. Callers that need to persist those
 * bytes should use `sourceSnapshot()` below rather than re-reading this path
 * through SQLite: a file edit between the hash read and the SQL read would make
 * the recorded hash describe different bytes from the stored body.
 *
 * @param {string} path
 * @returns {string}
 */
export function readSourceFile(path) {
    try {
        return readFileSync(path, 'utf-8');
    } catch (err) {
        const detail = err?.code === 'ENOENT' ? 'no such file' : String(err?.message ?? err);
        throw new DbError(`ERROR: cannot read '${path}': ${detail}.`);
    }
}

/**
 * Report whether a plan has work outstanding against its applied content.
 *
 * `references/plans.md` defines a non-empty drift indicator as "a candidate is
 * staged OR the linked file no longer matches the applied hash". Both halves
 * matter, and they are independent: an INLINE plan has no file to drift against
 * but can still hold a staged candidate awaiting `plan apply`. Reporting only
 * the file half tells a reader an inline plan is `n/a` while a proposal sits
 * unapplied on it.
 *
 * `staged` takes precedence over `drifted` because it is the more actionable
 * state — the next step is `plan apply` or `plan discard` either way, and
 * `plan propose` re-reads the file, so a drifted file is subsumed by resolving
 * the staged candidate.
 *
 * `pending_hash` is REQUIRED to be present on the argument, and absent is not
 * the same as null. Both call sites previously built a partial object literal
 * rather than passing a row, so a missing column would read as `undefined` and
 * silently report "nothing staged" — the exact bug this function had. Missing
 * the key throws instead, which surfaces in tests rather than in a user's
 * output.
 *
 * @param {{ source: string, path: string|null, content_hash: string|null,
 *           pending_hash: string|null }} plan
 * @returns {'n/a'|'clean'|'drifted'|'missing'|'staged'}
 */
export function planDrift(plan) {
    if (!('pending_hash' in plan)) {
        throw new Error('planDrift requires a pending_hash field; select it or pass null explicitly.');
    }
    if (plan.pending_hash) return 'staged';
    if (plan.source !== 'linked') return 'n/a';
    if (!plan.path || !existsSync(plan.path)) return 'missing';
    let text;
    try {
        text = readFileSync(plan.path, 'utf-8');
    } catch {
        return 'missing';
    }
    return sha256(text) === plan.content_hash ? 'clean' : 'drifted';
}

/** @type {string|null} */
let scratchDir = null;

/**
 * Write `contents` to a private temp file and return its path. The caller is
 * responsible for removing it (see `noteInsertSql`'s `cleanup`).
 *
 * @param {string} contents
 * @param {string} [suffix]
 * @returns {string}
 */
export function tempFile(contents, suffix = '') {
    if (scratchDir === null) scratchDir = mkdtempSync(join(tmpdir(), 'task-db-'));
    const path = join(scratchDir, `${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`);
    writeFileSync(path, contents);
    return path;
}

/**
 * Capture source text once, then expose it to SQL through a private temp file.
 *
 * A plan's stored body and its SHA must refer to exactly the same bytes. Reading
 * a live source once for `sha256()` and again through SQLite's `readfile()`
 * leaves an edit window between the two reads; this helper closes it without
 * ever interpolating arbitrary document content into SQL.
 *
 * @param {string} path
 * @returns {{ text:string, hash:string, expression:string, cleanup:() => void }}
 */
export function sourceSnapshot(path) {
    const text = readSourceFile(path);
    const snapshotPath = tempFile(text, '.source');
    return {
        text,
        hash: sha256(text),
        expression: readfileExpr(snapshotPath),
        cleanup: () => rmSync(snapshotPath, { force: true }),
    };
}

/**
 * Build the statement that appends one note to a plan.
 *
 * The new note's id is `MAX(id)+1` **computed inside this same UPDATE**, as a
 * correlated subquery over the row being written. Reading the maximum into
 * JavaScript and writing it back would let two concurrent appends read the same
 * value and allocate the same id; here the read and the write are one statement
 * under one write lock. Verified that deleting id 2 leaves `1,3` with the next
 * allocation still 4, so a `list` → `delete` sequence cannot hit the wrong entry.
 *
 * Returned rather than executed so callers can compose it into a larger
 * `BEGIN IMMEDIATE` batch — a state change and its lifecycle note must commit
 * together or not at all.
 *
 * @param {number|string} planId  a literal plan id, or a trusted SQL
 *   expression yielding one (e.g. `'last_insert_rowid()'`), for a caller
 *   appending a note in the same batch as the INSERT that creates the plan.
 * @param {string} kind
 * @param {{ tasks?:Array<{project:string,seq:number}|number>, note?:string, hash?:string, ts?:string }} [fields]
 * @param {{ guard?:string }} [options] trusted SQL predicate additionally
 *   required for the target plan row; internal callers use this for a
 *   compare-and-swap transition.
 * @returns {{ sql:string, cleanup:() => void }}
 */
export function noteInsertSql(planId, kind, fields = {}, options = {}) {
    // `id` is seeded at 0 so json_set REPLACES it in place, keeping it first in
    // key order instead of appending it after the prose.
    /** @type {Record<string, unknown>} */
    const payload = { id: 0, ts: fields.ts ?? now(), kind };
    if (fields.tasks?.length) payload.tasks = fields.tasks;
    if (fields.note !== undefined) payload.note = fields.note;
    if (fields.hash) payload.hash = fields.hash;

    const path = tempFile(JSON.stringify(payload), '.json');
    const idExpr = typeof planId === 'number' ? Number(planId) : planId;
    const statement = `UPDATE plans
           SET notes = json_insert(
                   COALESCE(notes,'[]'),
                   '$[#]',
                   json_set(
                       json(${readfileExpr(path)}),
                       '$.id',
                       (SELECT COALESCE(MAX(CAST(json_extract(value,'$.id') AS INTEGER)),0)+1
                          FROM json_each(COALESCE(plans.notes,'[]')))
                   )
               ),
               updated='${esc(now())}'
         WHERE id=${idExpr}${options.guard ? ` AND (${options.guard})` : ''};`;

    return { sql: statement, cleanup: () => rmSync(path, { force: true }) };
}

/**
 * Append one note to a plan as a standalone atomic write.
 *
 * @param {number} planId
 * @param {string} kind
 * @param {{ tasks?:Array<{project:string,seq:number}|number>, note?:string, hash?:string, ts?:string }} [fields]
 */
export function addNote(planId, kind, fields = {}) {
    const { sql: statement, cleanup } = noteInsertSql(planId, kind, fields);
    try {
        transaction([statement]);
    } finally {
        cleanup();
    }
}

/**
 * A plan's global numeric id, resolved from its project + P### display
 * sequence. Every `plan note *` handler — and every other `plan *` command
 * still to land — is called with `--seq`, but a plan's mutable columns
 * (`notes`, `content`, …) live on the row identified by `id`. This is the one
 * lookup all of them share.
 *
 * @param {string} project already-escaped (via `esc()`) project name
 * @param {number} seq
 * @returns {number}
 */
export function resolvePlanId(project, seq) {
    const id = sql(`SELECT id FROM plans WHERE project='${project}' AND seq=${Number(seq)};`);
    if (id === '') {
        throw new DbError(`ERROR: no plan P${String(seq).padStart(3, '0')} for this project.`);
    }
    return Number(id);
}

/**
 * One note object from a plan's notes array, or null if no note with that id
 * exists on that plan.
 *
 * @param {number} planId
 * @param {number} noteId
 * @returns {{id:number, ts:string, kind:string, note?:string, tasks?:Array<{project:string,seq:number}|number>, hash?:string}|null}
 */
export function findNote(planId, noteId) {
    const raw = sql(
        `SELECT value FROM plans, json_each(COALESCE(plans.notes,'[]'))
          WHERE plans.id=${Number(planId)} AND CAST(json_extract(value,'$.id') AS INTEGER)=${Number(noteId)};`,
    );
    return raw === '' ? null : JSON.parse(raw);
}

/**
 * A plan's notes as a JSON array, most-recent-id first, optionally capped to
 * the last `limit` entries. Built entirely in SQL via `json_group_array` so
 * the text returned is ready for `emit()` verbatim.
 *
 * @param {number} planId
 * @param {number|null} limit
 * @returns {string}
 */
export function notesJson(planId, limit) {
    return sql(
        `SELECT COALESCE(json_group_array(json(value)), '[]') FROM (
             SELECT value FROM plans, json_each(COALESCE(plans.notes,'[]'))
              WHERE plans.id=${Number(planId)}
              ORDER BY CAST(json_extract(value,'$.id') AS INTEGER) DESC
              LIMIT ${limit === null || limit === undefined ? -1 : Number(limit)}
         );`,
    );
}

/**
 * Build the statement that replaces one note in a plan's notes array by id.
 * `existing` supplies the `id`/`ts`/`kind` to preserve verbatim; `fields`
 * supplies the new `note` and optional `tasks`. `edited` is stamped to now.
 * This is a full replace, not a merge — an omitted `fields.tasks` does not
 * carry the original note's tasks forward.
 *
 * The replacement object is written to a temp file and pulled back in via
 * `readfile()`, exactly like `noteInsertSql`, so note prose containing quotes
 * or newlines can never reshape the statement carrying it.
 *
 * @param {number} planId
 * @param {{id:number, ts:string, kind:string}} existing
 * @param {{note:string, tasks?:Array<{project:string,seq:number}|number>}} fields
 * @returns {{ sql:string, cleanup:() => void }}
 */
export function noteReplaceSql(planId, existing, fields) {
    /** @type {Record<string, unknown>} */
    const payload = { id: existing.id, ts: existing.ts, kind: existing.kind };
    if (fields.tasks?.length) payload.tasks = fields.tasks;
    payload.note = fields.note;
    payload.edited = now();

    const path = tempFile(JSON.stringify(payload), '.json');
    const statement = `UPDATE plans
           SET notes = (
                   SELECT json_group_array(
                            CASE WHEN CAST(json_extract(value,'$.id') AS INTEGER)=${Number(existing.id)}
                                 THEN json(${readfileExpr(path)})
                                 ELSE json(value)
                            END
                          )
                     FROM json_each(COALESCE(plans.notes,'[]'))
               ),
               updated='${esc(now())}'
         WHERE id=${Number(planId)};`;

    return { sql: statement, cleanup: () => rmSync(path, { force: true }) };
}

/**
 * Build the statement that removes one note from a plan's notes array by id.
 * Remaining notes keep their own ids, so the next `MAX(id)+1` allocation is
 * unaffected by the gap — deleting id 2 out of {1,2,3} leaves {1,3} and the
 * next id is 4.
 *
 * @param {number} planId
 * @param {number} noteId
 * @returns {string}
 */
export function noteDeleteSql(planId, noteId) {
    return `UPDATE plans
           SET notes = (
                   SELECT COALESCE(json_group_array(json(value)), '[]')
                     FROM json_each(COALESCE(plans.notes,'[]'))
                    WHERE CAST(json_extract(value,'$.id') AS INTEGER) != ${Number(noteId)}
               ),
               updated='${esc(now())}'
         WHERE id=${Number(planId)};`;
}

/**
 * The single stdout choke point.
 *
 * With `--output-file` the payload goes to the file (parent dirs created,
 * overwritten) and only a one-line confirmation reaches stdout. Exit codes are
 * untouched by redirection, so a handler's 0/2/3/4 signal survives it.
 *
 * @param {string} payload
 * @param {string|null} [outputFile]
 * @param {{ raw?: boolean }} [options] `raw` writes the bytes verbatim, for
 *   content round-trips where a helpfully-added newline would break `diff`.
 */
export function emit(payload, outputFile = null, options = {}) {
    const text = payload == null ? '' : String(payload);
    const body = options.raw || text === '' || text.endsWith('\n') ? text : `${text}\n`;

    if (outputFile) {
        mkdirSync(dirname(outputFile), { recursive: true });
        writeFileSync(outputFile, body);
        process.stdout.write(`${Buffer.byteLength(body)} bytes → ${outputFile}\n`);
        return;
    }
    if (body !== '') process.stdout.write(body);
}

/**
 * Column names of a table, as a Set. Used by the additive migration to decide
 * what is missing without ever rebuilding the table.
 *
 * @param {string} table
 * @returns {Set<string>}
 */
export function tableColumns(table) {
    return new Set(sqlJson(`PRAGMA table_info(${table});`).map((row) => row.name));
}
