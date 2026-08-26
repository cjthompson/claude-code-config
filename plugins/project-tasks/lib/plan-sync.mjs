/**
 * plan-sync — the `plan *` commands that change a plan's document or its link.
 *
 * `plan propose`, `plan apply`, `plan discard`, `plan attach`, `plan detach`,
 * and `plan update`. Together these are the reconciliation loop: a new body (or
 * a re-read of a linked file) is STAGED into `pending_content`/`pending_hash`,
 * the caller reviews the diff, and only then does `plan apply` promote it.
 *
 * The staging step is not ceremony. Diffing and committing in one command
 * leaves a window between the review and the write in which the source file can
 * change, so the caller approves one document and commits a different one.
 * Staging closes it: `plan apply` promotes the reviewed bytes, and verifies the
 * hash it promotes is the hash that was reviewed.
 *
 * The same contract as `handlers.mjs` applies — the parser validated flag
 * shape, a handler validates against state — and a handler returns its exit
 * code (or nothing, meaning 0) rather than calling `process.exit`.
 *
 * Two invariants hold across every function here:
 *
 *   1. **A body is read from disk exactly once per command.** The bytes that
 *      get hashed are the same JavaScript string that gets written to the
 *      staging column (via a temp file and `readfile()`), so `pending_hash` can
 *      never describe anything other than `pending_content`. Re-reading the
 *      path for the SQL literal would reopen the very window staging exists to
 *      close. This is also why nothing here calls `planDrift()`: that helper
 *      classifies a plan for the READ side and does its own read of the file,
 *      while these commands need the bytes themselves — so they classify from
 *      the single read they already hold. What they owe `planDrift` is the
 *      staging columns being truthful, since `pending_hash` is what makes it
 *      report `staged`.
 *   2. **`pending_hash IS NULL` is the one test for "nothing staged."** An
 *      empty candidate stages as `pending_content=''`, which is not NULL, so a
 *      content test would call a legitimately staged empty document unstaged.
 */

import { existsSync, rmSync, unlinkSync } from 'node:fs';

import {
    DbError, emit, esc, noteInsertSql, now, readfileExpr, readSourceFile,
    sha256, sqlBody, sqlJson, tempFile, transaction,
} from './db.mjs';
import { slugify } from './normalize.mjs';

// ── shared helpers ────────────────────────────────────────────

/**
 * The `P###` a user typed, for error prose.
 *
 * @param {number} seq
 * @returns {string}
 */
function displaySeq(seq) {
    return `P${String(seq).padStart(3, '0')}`;
}

/**
 * A plan's metadata row, by project + display sequence.
 *
 * Deliberately excludes `content` and `pending_content`: both are documents
 * that must come back byte-exact, and `sqlJson` is fine for that but the JSON
 * round-trip is wasted work on bodies these handlers only sometimes need.
 * `planText` fetches them individually through `sqlBody`.
 *
 * The not-found message is `resolvePlanId`'s verbatim, so a caller cannot tell
 * which lookup path reported it.
 *
 * @param {string} project already-escaped project name
 * @param {number} seq
 * @returns {{id:number, seq:number, title:string, source:string, path:string|null,
 *            origin_path:string|null, content_hash:string|null, synced_at:string|null,
 *            pending_hash:string|null, pending_at:string|null, status:string}}
 */
function loadPlan(project, seq) {
    const rows = sqlJson(
        `SELECT id, seq, title, source, path, origin_path, content_hash, synced_at,
                pending_hash, pending_at, status
           FROM plans WHERE project='${project}' AND seq=${Number(seq)};`,
    );
    if (rows.length === 0) {
        throw new DbError(`ERROR: no plan ${displaySeq(seq)} for this project.`);
    }
    return rows[0];
}

/**
 * One of a plan's document columns as exact bytes.
 *
 * `sqlBody`, never `sql`: the latter trims all leading and trailing whitespace,
 * which silently eats a document's real trailing newline and would make an
 * unchanged file look changed on the next propose.
 *
 * @param {number} planId
 * @param {'content'|'pending_content'} column
 * @returns {string}
 */
function planText(planId, column) {
    return sqlBody(`SELECT COALESCE(${column},'') FROM plans WHERE id=${Number(planId)};`);
}

/**
 * Promote one already-verified staged document with a compare-and-swap guard.
 *
 * `planApply()` has to hash the candidate in JavaScript, but another writer can
 * replace that candidate before its SQLite transaction begins. Both the note
 * and the promotion therefore require the exact hash *and* bytes that were
 * verified. If either differs, both UPDATEs are no-ops and the new candidate
 * remains staged for its own review.
 *
 * @param {number} planId
 * @param {string} expectedHash
 * @param {string} expectedText
 * @param {string} ts
 */
export function applyVerifiedStaging(planId, expectedHash, expectedText, ts) {
    const expectedPath = tempFile(expectedText, '.md');
    const guard =
        `pending_hash='${esc(expectedHash)}' AND ` +
        `pending_content=${readfileExpr(expectedPath)}`;
    const note = noteInsertSql(
        planId,
        'applied',
        { note: 'Applied the staged content.', hash: expectedHash, ts },
        { guard },
    );
    try {
        const changed = transaction([
            note.sql,
            `UPDATE plans
                SET content=pending_content,
                    content_hash=pending_hash,
                    synced_at='${esc(ts)}',
                    pending_content=NULL, pending_hash=NULL, pending_at=NULL,
                    updated='${esc(ts)}'
              WHERE id=${Number(planId)} AND (${guard});`,
            'SELECT changes();',
        ]);
        if (changed !== '1') {
            throw new DbError(
                'ERROR: the staged content changed before it could be applied.\n' +
                    "       Nothing was applied. Run 'plan propose' to review the replacement, or\n" +
                    "       'plan discard' to drop it.",
            );
        }
    } finally {
        note.cleanup();
        rmSync(expectedPath, { force: true });
    }
}

/**
 * Remove a source only if it still has the exact bytes inspected earlier in
 * `planDetach`. The database transition may wait behind another writer, so the
 * old inspection is not sufficient evidence that this pathname is still safe
 * to delete when the wait ends.
 *
 * @param {string} path
 * @param {string} checkedText
 */
export function unlinkVerifiedSource(path, checkedText) {
    const current = readSourceFile(path);
    if (current !== checkedText) {
        throw new DbError(
            `ERROR: refusing to delete ${path}: it changed after it was checked.\n` +
                '       The plan was detached, but the newer source remains on disk.',
        );
    }
    unlinkSync(path);
}

/**
 * The UPDATE that stages a candidate body.
 *
 * The body reaches SQL through a temp file and `readfile()` rather than
 * `esc()` — a plan document is arbitrary text, and no amount of it may be able
 * to reshape the statement carrying it. Returned rather than executed so it can
 * be composed into a larger batch (attach stages and relinks in one commit).
 *
 * @param {number} planId
 * @param {string} text
 * @param {string} hash sha256 of `text`
 * @param {string} ts
 * @returns {{ sql:string, cleanup:() => void }}
 */
function stageSql(planId, text, hash, ts) {
    const path = tempFile(text, '.md');
    const statement = `UPDATE plans
           SET pending_content=${readfileExpr(path)},
               pending_hash='${esc(hash)}',
               pending_at='${esc(ts)}',
               updated='${esc(ts)}'
         WHERE id=${Number(planId)};`;
    return { sql: statement, cleanup: () => rmSync(path, { force: true }) };
}

/**
 * The UPDATE that clears the three staging columns.
 *
 * @param {number} planId
 * @param {string} ts
 * @returns {string}
 */
function clearStageSql(planId, ts) {
    return `UPDATE plans
           SET pending_content=NULL, pending_hash=NULL, pending_at=NULL,
               updated='${esc(ts)}'
         WHERE id=${Number(planId)};`;
}

/**
 * A plan's child tasks, optionally restricted to a set of statuses.
 *
 * Ordered by project then seq because a plan is global: two children can both
 * be `#003`, and the only thing that disambiguates them is the project column,
 * which every message built from these rows prints.
 *
 * @param {number} planId
 * @param {string[]|null} statuses
 * @returns {Array<{seq:number, project:string, title:string, status:string}>}
 */
function childTasks(planId, statuses = null) {
    const filter = statuses ? `AND status IN (${statuses.map((s) => `'${esc(s)}'`).join(',')})` : '';
    return sqlJson(
        `SELECT seq, project, title, status FROM tasks
          WHERE plan_id=${Number(planId)} ${filter}
          ORDER BY project, seq;`,
    );
}

/**
 * `  #003  someproject  Add JWT middleware` — one child task per line, for the
 * confirmation reports.
 *
 * @param {Array<{seq:number, project:string, title:string}>} rows
 * @returns {string}
 */
function taskLines(rows) {
    return rows
        .map((row) => `         #${String(row.seq).padStart(3, '0')}  ${row.project}  ${row.title}`)
        .join('\n');
}

/**
 * @param {Array<{seq:number,project:string}>} rows
 * @returns {Array<{project:string,seq:number}>}
 */
function taskRefs(rows) {
    return rows.map((row) => ({ project: row.project, seq: Number(row.seq) }));
}

// ── the duplicate-anchor guard ────────────────────────────────

/**
 * Markdown headings in a document. The only place these commands look at
 * markdown at all, and deliberately one regex rather than a parser.
 *
 * @param {string} text
 * @returns {string[]} heading text, in document order
 */
function headings(text) {
    /** @type {string[]} */
    const found = [];
    for (const line of text.split('\n')) {
        const match = /^#{1,6}\s+(.*)$/.exec(line);
        if (match) found.push(match[1].trim());
    }
    return found;
}

/**
 * Refuse to stage a candidate in which two headings collapse to one slug that
 * an existing task already claims as its anchor.
 *
 * Anchors are the join key between plan steps and task rows, and the index
 * enforcing that join is `UNIQUE(plan_id, plan_anchor)`. A body with two
 * headings slugifying to a claimed anchor has no correct reconciliation: the
 * task belongs to one of the two steps and nothing in the document says which.
 * Guessing, or annotating both, would silently attribute work to the wrong
 * step — so this refuses before anything is written, and names the collision
 * so the caller can rename a heading.
 *
 * Only duplicates that MATCH an existing anchor are rejected. Two duplicate
 * headings nobody has a task for are the author's business.
 *
 * @param {number} planId
 * @param {string} label
 * @param {string} candidate
 */
function rejectDuplicateAnchors(planId, label, candidate) {
    /** @type {Map<string,string[]>} slug → heading texts that produced it */
    const bySlug = new Map();
    for (const heading of headings(candidate)) {
        const slug = slugify(heading);
        if (slug === '') continue;
        if (!bySlug.has(slug)) bySlug.set(slug, []);
        bySlug.get(slug).push(heading);
    }

    const duplicated = [...bySlug.entries()].filter(([, texts]) => texts.length > 1);
    if (duplicated.length === 0) return;

    const anchored = sqlJson(
        `SELECT seq, project, plan_anchor FROM tasks
          WHERE plan_id=${Number(planId)} AND plan_anchor IS NOT NULL;`,
    );
    /** @type {Map<string, Array<{seq:number, project:string}>>} */
    const byAnchor = new Map();
    for (const row of anchored) {
        if (!byAnchor.has(row.plan_anchor)) byAnchor.set(row.plan_anchor, []);
        byAnchor.get(row.plan_anchor).push(row);
    }

    const collisions = duplicated.filter(([slug]) => byAnchor.has(slug));
    if (collisions.length === 0) return;

    const detail = collisions
        .map(([slug, texts]) => {
            const owners = byAnchor
                .get(slug)
                .map((row) => `#${String(row.seq).padStart(3, '0')} (${row.project})`)
                .join(', ');
            const headingList = texts.map((text) => `'${text}'`).join(', ');
            return `         ${slug} ← ${headingList}  — claimed by ${owners}`;
        })
        .join('\n');

    throw new DbError(
        `ERROR: the proposed body for ${label} gives two headings the same anchor.\n` +
            `${detail}\n` +
            '       Nothing was staged. Rename one of the headings so each step has its own\n' +
            '       anchor, then run \'plan propose\' again.',
    );
}

// ── unified diff ──────────────────────────────────────────────

// A marker appended to a side's last line when that side is NOT newline
// terminated, so a document that differs only by its trailing newline still
// diffs as a change rather than producing an empty patch for a real edit. It is
// stripped again when hunks are rendered, which emits the standard git notation
// in its place, so it never reaches a caller.
//
// Written as an escape rather than a literal, and a private-use character
// rather than a control byte. A raw NUL here made this file binary to `grep`,
// and git's own binary heuristic only scans the first 8000 bytes — so it read
// the file as text purely by accident of where this constant sits. Moving the
// constant earlier would have silently turned a 1000-line source file into an
// unreviewable blob in history.
//
// U+E000 is in the Private Use Area: never assigned, never typed by accident,
// and valid UTF-8. It keeps the "cannot appear in a plan document" property
// without any of the tooling damage.
const NO_EOL = '\uE000no-newline-at-eof';

const DIFF_CONTEXT = 3;

// Myers keeps one endpoint array per edit-distance step. That is cheap for the
// common case (a few edits in a long document terminates at a small `d`) and
// quadratic for the pathological one (two unrelated documents). The cap bounds
// the trace at ~8MB and falls back to a whole-file replacement hunk, which is a
// correct patch — just not a minimal one.
const MAX_TRACE_CELLS = 2_000_000;

/**
 * Split a document into comparable lines. The trailing-newline state is folded
 * into the last line rather than tracked alongside it, so the diff sees it.
 *
 * @param {string} text
 * @returns {string[]}
 */
function diffLines(text) {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    else lines[lines.length - 1] += NO_EOL;
    return lines;
}

/**
 * Myers' greedy diff, returning an edit script of `{ t, s }` entries where `t`
 * is ' ', '-' or '+'. Returns null when the trace would exceed the cap.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{t:string, s:string}>|null}
 */
function myers(a, b) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const width = 2 * max + 3;
    const offset = max + 1;
    let v = new Int32Array(width);
    /** @type {Int32Array[]} */
    const trace = [];

    for (let d = 0; d <= max; d++) {
        if ((trace.length + 1) * width > MAX_TRACE_CELLS) return null;
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) x = v[k + 1 + offset];
            else x = v[k - 1 + offset] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[k + offset] = x;
            if (x >= n && y >= m) return backtrack(trace, a, b, offset);
        }
    }
    /* c8 ignore next */
    return null;
}

/**
 * Walk the saved traces backwards into an edit script.
 *
 * @param {Int32Array[]} trace
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} offset
 * @returns {Array<{t:string, s:string}>}
 */
function backtrack(trace, a, b, offset) {
    /** @type {Array<{t:string, s:string}>} */
    const script = [];
    let x = a.length;
    let y = b.length;

    for (let d = trace.length - 1; d >= 0; d--) {
        const v = trace[d];
        const k = x - y;
        const prevK = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
        const prevX = d === 0 ? 0 : v[prevK + offset];
        const prevY = d === 0 ? 0 : prevX - prevK;

        while (x > prevX && y > prevY) {
            script.push({ t: ' ', s: a[x - 1] });
            x--;
            y--;
        }
        if (d > 0) {
            if (x > prevX) {
                script.push({ t: '-', s: a[x - 1] });
                x--;
            } else {
                script.push({ t: '+', s: b[y - 1] });
                y--;
            }
        }
    }
    return script.reverse();
}

/**
 * Render an edit script as a unified diff with `DIFF_CONTEXT` lines of context.
 * Returns '' when the script holds no changes.
 *
 * @param {Array<{t:string, s:string}>} script
 * @param {string} aLabel
 * @param {string} bLabel
 * @returns {string}
 */
function renderUnified(script, aLabel, bLabel) {
    const changed = [];
    script.forEach((entry, i) => {
        if (entry.t !== ' ') changed.push(i);
    });
    if (changed.length === 0) return '';

    // Line numbers for each entry, precomputed: the a-index and b-index of the
    // line an entry consumes (a '+' consumes no a-line, and vice versa).
    let ai = 0;
    let bi = 0;
    const at = script.map((entry) => {
        const here = { a: ai, b: bi };
        if (entry.t !== '+') ai++;
        if (entry.t !== '-') bi++;
        return here;
    });

    // Two changes closer than 2×context share a hunk; further apart, the
    // context blocks would not touch and a second hunk is shorter.
    /** @type {Array<[number, number]>} */
    const groups = [];
    let start = changed[0];
    let end = changed[0];
    for (const index of changed.slice(1)) {
        if (index - end <= DIFF_CONTEXT * 2) end = index;
        else {
            groups.push([start, end]);
            start = index;
            end = index;
        }
    }
    groups.push([start, end]);

    const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
    for (const [first, last] of groups) {
        const from = Math.max(0, first - DIFF_CONTEXT);
        const to = Math.min(script.length - 1, last + DIFF_CONTEXT);

        let aCount = 0;
        let bCount = 0;
        for (let i = from; i <= to; i++) {
            if (script[i].t !== '+') aCount++;
            if (script[i].t !== '-') bCount++;
        }
        // A zero-length side is addressed by the line it would follow, which is
        // exactly the un-incremented index; otherwise the hunk starts at the
        // next line, 1-based.
        const aStart = aCount === 0 ? at[from].a : at[from].a + 1;
        const bStart = bCount === 0 ? at[from].b : at[from].b + 1;
        out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);

        for (let i = from; i <= to; i++) {
            const { t, s } = script[i];
            if (s.endsWith(NO_EOL)) {
                out.push(`${t}${s.slice(0, -NO_EOL.length)}`);
                out.push('\\ No newline at end of file');
            } else {
                out.push(`${t}${s}`);
            }
        }
    }
    return out.join('\n');
}

/**
 * A unified diff between two documents.
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {string} aLabel
 * @param {string} bLabel
 * @returns {string}
 */
export function unifiedDiff(oldText, newText, aLabel, bLabel) {
    const a = diffLines(oldText);
    const b = diffLines(newText);
    const script =
        myers(a, b) ?? [...a.map((s) => ({ t: '-', s })), ...b.map((s) => ({ t: '+', s }))];
    return renderUnified(script, aLabel, bLabel);
}

// ── plan propose ──────────────────────────────────────────────

/**
 * Read the candidate body, reporting an unreadable source as exit 4.
 *
 * 4 is `propose`'s declared code for "the source could not be read", as
 * distinct from 3 ("a diff is staged and awaiting review") and 1 (any other
 * error). `readSourceFile` raises exit 1, so the code is restated here rather
 * than in the helper — every other caller of that helper does mean 1.
 *
 * @param {string} path
 * @param {string} label
 * @returns {string}
 */
function readCandidate(path, label) {
    try {
        return readSourceFile(path);
    } catch (err) {
        const detail = err instanceof DbError ? err.message : `ERROR: cannot read '${path}'.`;
        throw new DbError(
            `${detail}\n       ${label} has nothing to propose from. Restore the file, or use\n` +
                "       'plan attach' to point the plan at a different one.",
            { exitCode: 4 },
        );
    }
}

/**
 * Stage a content change and print the diff for review.
 *
 * Exit codes are the contract a caller scripts against:
 *   0 — the candidate is byte-identical to the applied content. Staging is
 *       cleared (there is nothing to apply) and the caller stops.
 *   3 — the candidate differs. It is staged, and the unified diff is the
 *       payload. NOT an error: it is "a diff is waiting for review".
 *   4 — the source could not be read.
 *   1 — anything else, including both source-type guards.
 *
 * Re-proposing over an existing staged candidate REPLACES it. `propose` is the
 * command whose whole job is "stage the current state of the source", and a
 * refusal would leave the caller unable to re-stage after an edit without first
 * discarding. Replacement is safe precisely because the diff and the staged
 * bytes are written together: whatever is staged is what the caller was just
 * shown. (`attach` is the opposite case and does refuse — it stages a body the
 * caller never asked to see, so it must not silently displace one they did.)
 *
 * @param {any} action
 * @returns {number}
 */
function planPropose(action) {
    const o = action.opts;
    const project = esc(action.global.project);
    const seq = Number(o.seq);
    const plan = loadPlan(project, seq);
    const label = displaySeq(seq);

    // The two nonsense combinations. The second matters most: for a linked plan
    // the FILE is the source of truth, so pushing a body through the database
    // behind its back would leave stored content contradicting the file it
    // claims to track, and the drift indicator firing forever.
    if (plan.source === 'inline' && o.contentFile === undefined) {
        throw new DbError(
            `ERROR: ${label} is inline — no source file to re-read.\n` +
                "       Pass --content-file, or use 'plan attach' to link one.",
        );
    }
    if (plan.source === 'linked' && o.contentFile !== undefined) {
        throw new DbError(
            `ERROR: ${label} is linked to ${plan.path}.\n` +
                "       Edit that file and run 'plan propose', or use\n" +
                "       'plan attach' to point at a different file.",
        );
    }

    const sourcePath = plan.source === 'linked' ? plan.path : o.contentFile;
    if (!sourcePath) {
        throw new DbError(
            `ERROR: ${label} is linked but records no path.\n` +
                "       Use 'plan attach --path' to give it one.",
        );
    }

    const candidate = readCandidate(sourcePath, label);
    rejectDuplicateAnchors(plan.id, label, candidate);

    // Compared against the stored BYTES, not against `content_hash`. A plan
    // created with no body has a NULL hash but an empty document, and hashing
    // the empty string would make "no change" look like a change forever.
    const applied = planText(plan.id, 'content');
    const ts = now();

    if (candidate === applied) {
        if (plan.pending_hash !== null) transaction([clearStageSql(plan.id, ts)]);
        emit(`${label} is unchanged; nothing staged.`, action.global.outputFile);
        return 0;
    }

    if (plan.pending_hash !== null) {
        process.stderr.write(
            `warning: ${label} already had a candidate staged (${plan.pending_hash.slice(0, 12)}); ` +
                'it was replaced by this one.\n',
        );
    }

    const { sql: statement, cleanup } = stageSql(plan.id, candidate, sha256(candidate), ts);
    try {
        transaction([statement]);
    } finally {
        cleanup();
    }

    emit(unifiedDiff(applied, candidate, `a/${label}`, `b/${label}`), action.global.outputFile);
    return 3;
}

// ── plan apply ────────────────────────────────────────────────

/**
 * Promote the staged bytes into the applied content.
 *
 * The hash check is the reason the staging columns exist. `propose` wrote
 * `pending_content` and `pending_hash` in one statement, so re-hashing the
 * content and finding a different hash means the row was edited by something
 * other than `propose` — and applying it would commit a document nobody
 * reviewed. It refuses and leaves the staging in place: the caller can inspect
 * it, and `plan propose` or `plan discard` are both still available.
 *
 * The promotion is one UPDATE because SQL evaluates every right-hand side
 * against the pre-update row: `content=pending_content, pending_content=NULL`
 * reads the old value and clears it in the same statement, so there is no
 * intermediate state in which the content has moved but the staging has not.
 * It batches with the `applied` note so the note and the promotion commit
 * together or not at all.
 *
 * @param {any} action
 * @returns {number}
 */
function planApply(action) {
    const project = esc(action.global.project);
    const seq = Number(action.opts.seq);
    const plan = loadPlan(project, seq);
    const label = displaySeq(seq);

    if (plan.pending_hash === null) {
        throw new DbError(
            `ERROR: ${label} has nothing staged to apply.\n` +
                "       Run 'plan propose' first; it stages a candidate and prints the diff to review.",
        );
    }

    const staged = planText(plan.id, 'pending_content');
    const actual = sha256(staged);
    if (actual !== plan.pending_hash) {
        throw new DbError(
            `ERROR: ${label}'s staged content does not match the hash recorded when it was staged.\n` +
                `       staged as: ${plan.pending_hash}\n` +
                `       now hashes: ${actual}\n` +
                '       The staged bytes changed after they were reviewed, so applying them would\n' +
                "       commit a document nobody approved. Nothing was applied. Run 'plan propose'\n" +
                "       again to re-stage and review, or 'plan discard' to drop the candidate.",
        );
    }

    const ts = now();
    applyVerifiedStaging(plan.id, plan.pending_hash, staged, ts);

    emit(
        `${label} applied ${plan.pending_hash.slice(0, 12)} (${Buffer.byteLength(staged)} bytes).`,
        action.global.outputFile,
    );
    return 0;
}

// ── plan discard ──────────────────────────────────────────────

/**
 * Drop the staged candidate, leaving the applied content untouched.
 *
 * Idempotent: discarding a plan with nothing staged succeeds. The spec gives
 * `discard` no failure mode, and the caller reaches it on the refusal branch of
 * a review — where "there was nothing to drop" is the desired end state, not an
 * error. It writes no note: the note kinds are a closed set and none of them
 * describes a discard, and forging `status` for it would put a false entry in
 * the audit trail the `--force` guard exists to protect.
 *
 * @param {any} action
 * @returns {number}
 */
function planDiscard(action) {
    const project = esc(action.global.project);
    const seq = Number(action.opts.seq);
    const plan = loadPlan(project, seq);
    const label = displaySeq(seq);

    if (plan.pending_hash === null) {
        emit(`${label} had nothing staged.`, action.global.outputFile);
        return 0;
    }

    transaction([clearStageSql(plan.id, now())]);
    emit(
        `${label} discarded the staged candidate (${plan.pending_hash.slice(0, 12)}).`,
        action.global.outputFile,
    );
    return 0;
}

// ── plan attach ───────────────────────────────────────────────

/**
 * Point a plan at a file: set `path`, flip `source` to `linked`, and stage that
 * file's content for review.
 *
 * This is also how a linked plan's path is CHANGED — there is no separate
 * "relink" command, and re-attaching is the symmetric partner of `detach`.
 *
 * It refuses while a DIFFERENT candidate is staged. Attach stages a body the
 * caller has not seen yet; overwriting a candidate they are in the middle of
 * reviewing would discard a review silently. Attaching a file that happens to
 * hash to the staged candidate is not a conflict and proceeds.
 *
 * @param {any} action
 * @returns {number}
 */
function planAttach(action) {
    const project = esc(action.global.project);
    const seq = Number(action.opts.seq);
    const path = action.opts.path;
    const plan = loadPlan(project, seq);
    const label = displaySeq(seq);

    const candidate = readSourceFile(path);
    const candidateHash = sha256(candidate);

    if (plan.pending_hash !== null && plan.pending_hash !== candidateHash) {
        throw new DbError(
            `ERROR: ${label} already has a different candidate staged (${plan.pending_hash.slice(0, 12)}).\n` +
                "       Run 'plan apply' to accept it or 'plan discard' to drop it, then attach.",
        );
    }

    const applied = planText(plan.id, 'content');
    const ts = now();
    /** @type {string[]} */
    const statements = [];
    /** @type {Array<() => void>} */
    const cleanups = [];

    if (candidate === applied) {
        // The file already holds the applied content, so there is nothing to
        // review and `synced_at` is honestly now. Any staged candidate must
        // have hashed the same to get past the guard above, so clearing it
        // drops a no-op rather than a pending decision.
        statements.push(
            `UPDATE plans
                SET path='${esc(path)}', source='linked', synced_at='${esc(ts)}',
                    pending_content=NULL, pending_hash=NULL, pending_at=NULL,
                    updated='${esc(ts)}'
              WHERE id=${Number(plan.id)};`,
        );
    } else {
        statements.push(
            `UPDATE plans
                SET path='${esc(path)}', source='linked', updated='${esc(ts)}'
              WHERE id=${Number(plan.id)};`,
        );
        const staged = stageSql(plan.id, candidate, candidateHash, ts);
        statements.push(staged.sql);
        cleanups.push(staged.cleanup);
    }

    try {
        transaction(statements);
    } finally {
        for (const cleanup of cleanups) cleanup();
    }

    emit(
        candidate === applied
            ? `${label} is linked to ${path}; it already matches the applied content.`
            : `${label} is linked to ${path}; its content is staged for review ` +
                  `(${candidateHash.slice(0, 12)}). Run 'plan propose' to see the diff.`,
        action.global.outputFile,
    );
    return 0;
}

// ── plan detach ───────────────────────────────────────────────

/**
 * Return a plan to `inline`, keeping its body and recording where it came from.
 *
 * Three live-file states, and they are not the same operation:
 *
 *   matches the applied content — the stored body already IS the file, so the
 *     link is dropped with nothing to reconcile and `--delete-file` may unlink.
 *   differs — the file holds edits nobody has reconciled into tasks. Those
 *     bytes are preserved as a staged candidate, `--confirm-source-change` is
 *     required, and `--delete-file` is refused outright: deleting the file
 *     would destroy the only copy of an unreviewed change.
 *   gone — there is nothing to lose. The detach proceeds on the stored body
 *     with a warning, because refusing would strand the plan linked to a path
 *     that no longer exists.
 *
 * `source` and `path` always move together: `inline` with a path set, or
 * `linked` without one, are both states the rest of the surface cannot read.
 *
 * @param {any} action
 * @returns {number}
 */
function planDetach(action) {
    const o = action.opts;
    const project = esc(action.global.project);
    const seq = Number(o.seq);
    const plan = loadPlan(project, seq);
    const label = displaySeq(seq);

    if (plan.source !== 'linked') {
        throw new DbError(
            `ERROR: ${label} is already inline — there is no linked file to detach.`,
        );
    }
    const path = plan.path;
    if (!path) {
        throw new DbError(
            `ERROR: ${label} is linked but records no path, so there is nothing to detach.`,
        );
    }

    const live = existsSync(path) ? readSourceFile(path) : null;
    const applied = planText(plan.id, 'content');
    const changed = live !== null && live !== applied;

    // Ordered so a caller who passed both flags is told the blocking problem
    // rather than the one they already answered for.
    if (changed && o.deleteFile) {
        throw new DbError(
            `ERROR: refusing to delete ${path}: it holds plan changes that are not reconciled.\n` +
                '       Detach with --confirm-source-change, run the reconciliation loop\n' +
                "       ('plan propose' then 'plan apply', or 'plan discard'), then delete the file.",
        );
    }
    if (changed && !o.confirmSourceChange) {
        throw new DbError(
            `ERROR: ${path} differs from the content applied to ${label}.\n` +
                '       Detaching retains those bytes as a pending change, leaves the file on\n' +
                '       disk, and requires reconciliation before it can be deleted.\n' +
                '       Re-run with --confirm-source-change once the user has agreed.',
        );
    }

    const liveHash = live === null ? null : sha256(live);
    if (changed && plan.pending_hash !== null && plan.pending_hash !== liveHash) {
        throw new DbError(
            `ERROR: ${label} already has a different candidate staged (${plan.pending_hash.slice(0, 12)}).\n` +
                "       Run 'plan apply' to accept it or 'plan discard' to drop it, then detach.",
        );
    }

    const ts = now();
    /** @type {string[]} */
    const statements = [
        `UPDATE plans
            SET source='inline', path=NULL, origin_path='${esc(path)}', updated='${esc(ts)}'
          WHERE id=${Number(plan.id)};`,
    ];
    /** @type {Array<() => void>} */
    const cleanups = [];
    if (changed) {
        const staged = stageSql(plan.id, live, liveHash, ts);
        statements.push(staged.sql);
        cleanups.push(staged.cleanup);
    }

    try {
        transaction(statements);
    } finally {
        for (const cleanup of cleanups) cleanup();
    }

    // Unlink AFTER the commit, never before. Before deleting, re-read the file
    // so a save that landed while SQLite was busy cannot erase unreconciled
    // work. A deletion failure therefore leaves the row inline and the source
    // in place for the caller to resolve manually.
    if (o.deleteFile && live !== null) {
        try {
            unlinkVerifiedSource(path, live);
        } catch (err) {
            // A revalidation failure is already an actionable data-safety
            // refusal: do not wrap it in the generic "remove by hand" advice,
            // which would invite deletion of the newer source bytes it saved.
            if (err instanceof DbError) throw err;
            throw new DbError(
                `ERROR: ${label} was detached, but ${path} could not be deleted: ${String(err?.message ?? err)}.\n` +
                    '       The plan is inline and holds its content; remove the file by hand.',
            );
        }
    }

    if (live === null) {
        process.stderr.write(
            `warning: ${path} no longer exists; ${label} was detached with the content it had already applied.\n`,
        );
    }

    const detail = changed
        ? ` The live file's bytes are staged for review (${liveHash.slice(0, 12)}).`
        : o.deleteFile && live !== null
          ? ` ${path} was deleted.`
          : '';
    emit(`${label} is now inline; origin recorded as ${path}.${detail}`, action.global.outputFile);
    return 0;
}

// ── plan update ───────────────────────────────────────────────

/**
 * Cancelling a plan: build the confirmation report, or the cascade.
 *
 * Child tasks are CANCELLED, never deleted and never orphaned — `tasks.plan_id`
 * is `ON DELETE RESTRICT` precisely so that a plan with children cannot be
 * made to disappear out from under them, and the cascade preserves `plan_id` so
 * the plan's history stays legible after the fact.
 *
 * `completed` children are skipped: work that is finished stays finished, and
 * rewriting it would make the changelog lie. Already-`cancelled` children are
 * skipped too — the outcome is identical and not touching them keeps their
 * `updated` timestamp meaningful.
 *
 * `--confirm-cancel` is required even when the plan has no children at all. Its
 * job is to prove a human was asked, and making it conditional on state would
 * mean the skill has to predict whether the helper will demand it.
 *
 * @param {any} plan
 * @param {string} label
 * @param {boolean} confirmed
 * @param {string} ts
 * @returns {{ statements:string[], note:string, tasks:Array<{project:string,seq:number}> }}
 */
function cancelPlan(plan, label, confirmed, ts) {
    const doomed = childTasks(plan.id, ['pending', 'in_progress']);
    const completed = childTasks(plan.id, ['completed']);
    const inProgress = doomed.filter((row) => row.status === 'in_progress');

    if (!confirmed) {
        const parts = [`ERROR: cancelling ${label} needs confirmation.`];
        parts.push(
            `       ${doomed.length} child task(s) are not completed and would be cancelled` +
                (doomed.length ? ':' : '.'),
        );
        if (doomed.length) parts.push(taskLines(doomed));
        if (inProgress.length) {
            parts.push(`       ${inProgress.length} of those are in progress:`);
            parts.push(taskLines(inProgress));
        }
        parts.push(
            `       ${completed.length} child task(s) are already completed and would be left untouched` +
                (completed.length ? ':' : '.'),
        );
        if (completed.length) parts.push(taskLines(completed));
        parts.push('       Re-run with --confirm-cancel once the user has agreed.');
        throw new DbError(parts.join('\n'));
    }

    return {
        statements: [
            `UPDATE tasks SET status='cancelled', updated='${esc(ts)}'
              WHERE plan_id=${Number(plan.id)} AND status NOT IN ('completed','cancelled');`,
        ],
        note:
            `Status ${plan.status} → cancelled. Cancelled ${doomed.length} child task(s); ` +
            `${completed.length} completed child task(s) left untouched.`,
        tasks: taskRefs(doomed),
    };
}

/**
 * Completing a plan: refuse while children are open, or force them closed.
 *
 * Unlike `--confirm-cancel`, `--force-complete` is only required when there is
 * something to force. A plan whose children are all terminal closes directly —
 * that is the ordinary end of a plan, and demanding a confirmation for it would
 * train the caller to pass the flag reflexively.
 *
 * @param {any} plan
 * @param {string} label
 * @param {boolean} forced
 * @param {string} ts
 * @returns {{ statements:string[], note:string, tasks:Array<{project:string,seq:number}> }}
 */
function completePlan(plan, label, forced, ts) {
    const open = childTasks(plan.id, ['pending', 'in_progress']);

    if (open.length > 0 && !forced) {
        throw new DbError(
            `ERROR: ${label} has ${open.length} child task(s) that are not finished:\n` +
                `${taskLines(open)}\n` +
                '       Re-run with --force-complete to mark them completed, once the user has\n' +
                '       agreed, or finish them first.',
        );
    }

    if (open.length === 0) {
        return {
            statements: [],
            note: `Status ${plan.status} → completed. Every child task was already terminal.`,
            tasks: [],
        };
    }

    return {
        statements: [
            // COALESCE, so force-completing never rewrites when a task was
            // actually finished — the same rule `task update` applies.
            `UPDATE tasks SET status='completed', completed_at=COALESCE(completed_at,'${esc(ts)}'),
                    updated='${esc(ts)}'
              WHERE plan_id=${Number(plan.id)} AND status IN ('pending','in_progress');`,
        ],
        note: `Status ${plan.status} → completed. Force-completed ${open.length} child task(s).`,
        tasks: taskRefs(open),
    };
}

/**
 * Change a plan's own metadata: title, status, tags.
 *
 * This is NOT the document-sync path. A plan's body moves only through
 * `propose`/`apply`, and nothing here reads or writes `content`.
 *
 * A status change always records one `status` lifecycle note naming the
 * transition and any cascade, so `plan status` can narrate how the plan reached
 * its current state rather than only reporting where it landed. The plan row,
 * the child cascade and the note are one batch — a cascade that committed
 * without its note would be a state change with no record of why.
 *
 * @param {any} action
 * @returns {number}
 */
function planUpdate(action) {
    const o = action.opts;
    const project = esc(action.global.project);
    const seq = Number(o.seq);
    const plan = loadPlan(project, seq);
    const label = displaySeq(seq);
    const ts = now();

    /** @type {string[]} */
    const sets = [];
    if (o.title !== undefined) sets.push(`title='${esc(o.title)}'`);
    if (o.tags !== undefined) sets.push(`tags='${esc(JSON.stringify(o.tags))}'`);

    /** @type {string[]} */
    let cascade = [];
    /** @type {{note:string, tasks:Array<{project:string,seq:number}>}|null} */
    let lifecycle = null;

    if (o.status !== undefined) {
        // The parser has already tied --confirm-cancel to `--status cancelled`
        // and --force-complete to `--status completed`, so neither is re-checked
        // against the wrong status here.
        if (o.status === 'cancelled') {
            const result = cancelPlan(plan, label, Boolean(o.confirmCancel), ts);
            cascade = result.statements;
            lifecycle = { note: result.note, tasks: result.tasks };
        } else if (o.status === 'completed') {
            const result = completePlan(plan, label, Boolean(o.forceComplete), ts);
            cascade = result.statements;
            lifecycle = { note: result.note, tasks: result.tasks };
        } else {
            lifecycle = { note: `Status ${plan.status} → ${o.status}.`, tasks: [] };
        }
        sets.push(`status='${esc(o.status)}'`);
    }

    sets.push(`updated='${esc(ts)}'`);

    /** @type {string[]} */
    const statements = [
        `UPDATE plans SET ${sets.join(',')} WHERE id=${Number(plan.id)};`,
        ...cascade,
    ];
    /** @type {Array<() => void>} */
    const cleanups = [];
    if (lifecycle !== null) {
        const note = noteInsertSql(plan.id, 'status', {
            note: lifecycle.note,
            tasks: lifecycle.tasks,
            ts,
        });
        statements.push(note.sql);
        cleanups.push(note.cleanup);
    }

    try {
        transaction(statements);
    } finally {
        for (const cleanup of cleanups) cleanup();
    }

    emit(lifecycle === null ? `${label} updated.` : `${label}: ${lifecycle.note}`, action.global.outputFile);
    return 0;
}

/** @type {Record<string, (action:any) => number|void>} */
export const PLAN_SYNC_HANDLERS = {
    planPropose,
    planApply,
    planDiscard,
    planAttach,
    planDetach,
    planUpdate,
};
