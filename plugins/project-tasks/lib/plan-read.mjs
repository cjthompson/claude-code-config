/**
 * plan-read — the read-only `plan *` reporting commands.
 *
 * `plan tasks`, `plan status`, and `plan progress` answer questions about a
 * plan without ever writing to it. They live apart from `handlers.mjs` for two
 * reasons: that file is already long enough that adding nine more handlers
 * would bury the task commands, and separating the read commands from the
 * reconciliation commands lets the two be worked on without touching the same
 * file.
 *
 * The same contract as `handlers.mjs` applies — the parser validated flag
 * shape, a handler validates against state — and a handler returns its exit
 * code (or nothing, meaning 0) rather than calling `process.exit`.
 *
 * A plan is global and may own tasks in several repositories, so `--project`
 * on these commands identifies the plan's OWNER and never filters its children.
 * Every one of them prints a `project` column for exactly that reason.
 *
 * The three are deliberately different artifacts rather than three formats of
 * one query:
 *
 *   plan tasks     the rows, machine-shaped, one line per child task.
 *   plan status    the ANNOTATED PLAN — the stored body verbatim with per-step
 *                  progress woven in under the heading it belongs to.
 *   plan progress  a STANDALONE REPORT — header, table, prose summary; or, with
 *                  `--counts`, the one machine-readable line the accept-flow in
 *                  SKILL.md parses.
 *
 * `plan status` answers "what has happened to this document"; `plan progress`
 * answers "how far along is this work". Collapsing them into one command would
 * mean the annotated body could never be piped anywhere the table was wanted,
 * and vice versa.
 */

import { emit, esc, notesJson, planDrift, resolvePlanId, sqlJson, sqlRows } from './db.mjs';
import { slugify } from './normalize.mjs';

/**
 * The one place markdown is parsed. A heading line and nothing else — no list
 * items, no fenced-code awareness, no inline structure. `plan status` needs to
 * know where a step begins and nothing more, and a real parser here would be a
 * dependency taken on for a single regex's worth of work.
 */
const HEADING_RE = /^#{1,6}\s+(.*)$/;

/** @param {number} seq @returns {string} the `P###` display id */
function planLabel(seq) {
    return `P${String(seq).padStart(3, '0')}`;
}

/** @param {number} seq @returns {string} the `#NNN` display id */
function taskLabel(seq) {
    return `#${String(seq).padStart(3, '0')}`;
}

/**
 * Every child task of a plan, in the order the tasks were created.
 *
 * `ORDER BY t.id` rather than `seq`, and that is the whole reason this is a
 * helper: a plan's children may live in several projects, where `seq` is only
 * unique per project. Ordering by `seq` would interleave two repositories'
 * numbering into a sequence that looks meaningful and is not. Insertion order
 * is `create-tasks`'s order, which is the plan's own step order.
 *
 * `open_deps` counts each task's incomplete dependencies, resolved against
 * **its own** project — `depends_on` holds project-local `seq` values, so a
 * child in another repository must be joined on `d.project=t.project` and not
 * on the plan owner's project. `t.depends_on` is qualified deliberately: an
 * unqualified `depends_on` inside the subquery binds to `d`, which is the bug
 * documented on `taskDepsBlocked` in `handlers.mjs`.
 *
 * @param {number} planId
 * @returns {any[]}
 */
function childTasks(planId) {
    return sqlJson(
        `SELECT t.seq, t.project, t.title, t.status, t.plan_anchor, t.commit_sha, t.completed_at,
                COALESCE(t.completed_at, t.updated, t.created) AS when_ts,
                (SELECT COUNT(*) FROM json_each(COALESCE(t.depends_on,'[]')) j
                   JOIN tasks d ON d.project=t.project AND d.seq=j.value
                  WHERE d.status!='completed') AS open_deps
           FROM tasks t
          WHERE t.plan_id=${Number(planId)}
          ORDER BY t.id;`,
    );
}

/**
 * A plan's notes, newest first — the order `plan note list` already returns.
 *
 * @param {number} planId
 * @returns {Array<{id:number, ts:string, kind:string, note?:string, tasks?:Array<{project:string,seq:number}|number>, hash?:string}>}
 */
function planNotes(planId) {
    return JSON.parse(notesJson(planId, null));
}

/**
 * A note's task references, normalized to qualified project + sequence pairs.
 * Legacy integer refs are interpreted as children of the plan owner only; they
 * are never matched against another child project with the same sequence.
 *
 * @param {{tasks?:Array<{project:string,seq:number}|number>}} note
 * @param {string} planProject
 * @returns {Array<{project:string,seq:number}>}
 */
function noteRefs(note, planProject) {
    if (!Array.isArray(note.tasks)) return [];
    return note.tasks.map((ref) =>
        typeof ref === 'number'
            ? { project: planProject, seq: Number(ref) }
            : { project: String(ref.project), seq: Number(ref.seq) },
    );
}

/** @param {{project:string,seq:number}} ref @returns {string} */
function refKey(ref) {
    return JSON.stringify([ref.project, Number(ref.seq)]);
}

/** @param {{project:string,seq:number}} ref @returns {string} */
function taskRefLabel(ref) {
    return `${ref.project}#${String(ref.seq).padStart(3, '0')}`;
}

// ── plan tasks ────────────────────────────────────────────────

/**
 * A plan's child tasks as `#NNN|project|anchor|type|title|priority|status`.
 *
 * `project` is the second column and is not optional: a plan is global, so two
 * children can both be `#003` in different repositories. Callers filter on that
 * column — `--project` here names the plan's owner and never narrows the
 * children, which is why there is deliberately no per-repo filter flag.
 *
 * Unlike `task list`, cancelled rows are NOT hidden by default. The two callers
 * both need them: the reconciliation loop classifies every existing anchor, and
 * the post-cancel check in the spec's verification block reads this command to
 * confirm that completed children survived a cascade and the rest did not.
 * `--status` filters exactly, with no implicit second predicate.
 *
 * @param {any} action
 */
function planTasks(action) {
    const p = esc(action.global.project);
    const planId = resolvePlanId(p, Number(action.opts.seq));
    const status = action.opts.status;
    const where = status ? ` AND t.status='${esc(status)}'` : '';

    emit(
        sqlRows(
            `SELECT printf('#%03d',t.seq), t.project, COALESCE(t.plan_anchor,''),
                    t.type, t.title, t.priority, t.status
               FROM tasks t
              WHERE t.plan_id=${planId}${where}
              ORDER BY t.id;`,
        ),
        action.global.outputFile,
    );
    return 0;
}

// ── plan status ───────────────────────────────────────────────

/**
 * The blockquote line describing one task under its heading.
 *
 * `project` is present on every line for the same reason it is a column in
 * `plan tasks`: `#003` alone is ambiguous across a plan's repositories.
 *
 * @param {any} task
 * @returns {string}
 */
function statusLine(task) {
    const parts = [`**${taskLabel(task.seq)}**`, task.status, task.project];
    if (task.completed_at) parts.push(task.completed_at);
    if (task.commit_sha) parts.push(task.commit_sha);
    return `> ${parts.join(' · ')}`;
}

/**
 * A note rendered inside a heading's blockquote. Prose may contain newlines, so
 * every line is prefixed — an unprefixed continuation line would end the
 * blockquote and silently reflow the rest of the note into the plan body.
 *
 * @param {{ts:string, kind:string, note?:string}} note
 * @returns {string[]}
 */
function noteBlockquote(note) {
    const text = `_${note.ts}_ · ${note.kind}${note.note ? ` — ${note.note}` : ''}`;
    return text.split('\n').map((line) => `> ${line}`.trimEnd());
}

/**
 * A note rendered in the `## History` footer, as one list item. Newlines are
 * collapsed here rather than prefixed: a footer entry is a summary line, and a
 * multi-line list item reads as a nested block.
 *
 * @param {{ts:string, kind:string, note?:string, tasks?:Array<{project:string,seq:number}|number>}} note
 * @param {string} planProject
 * @returns {string}
 */
function noteHistoryLine(note, planProject) {
    const refs = noteRefs(note, planProject);
    const suffix = refs.length ? ` (${refs.map(taskRefLabel).join(', ')})` : '';
    const body = note.note ? ` — ${note.note.replace(/\s*\n\s*/g, ' ')}` : '';
    return `- _${note.ts}_ · ${note.kind}${suffix}${body}`;
}

/**
 * The stored plan body with per-step progress woven in.
 *
 * The body is reproduced VERBATIM. Annotation is purely additive: a blockquote
 * inserted after a heading whose slug matches a task anchor, carrying that
 * task's status and any note that references it. Nothing in the document is
 * rewritten, reordered, or dropped, so a reader comparing this against the plan
 * file sees the plan plus commentary rather than a rendering of it.
 * One canonical status payload applies to stdout, programmatic callers, and
 * `--output-file`; an empty body remains empty for every consumer.
 *
 * Matching is by `slugify(heading)` against `tasks.plan_anchor`, which is the
 * same function `--anchor` is normalized through at the CLI boundary — one code
 * path, so a heading and the anchor derived from it cannot disagree.
 *
 * When a task anchor matches no heading, a warning naming those anchors goes to
 * **stderr** while the body still goes to stdout. That split is the point: the
 * spec requires that a plan whose headings have all been renamed prints its
 * body and says so, never that it silently degrades into the `plan progress`
 * table. Warning on stdout would corrupt `--output-file`; suppressing it would
 * hide the drift that makes the annotation empty.
 *
 * Notes are attributed to the step they name. A note lands in the `## History`
 * footer when none of its task refs was rendered inline — including refs to
 * tasks that are not children of this plan at all — so no note can be dropped
 * by an attribution that finds nowhere to attach.
 *
 * `--limit` bounds the footer only (default 10, per the registry), with an
 * `(N earlier notes)` line accounting for the remainder. It deliberately does
 * not bound the inline notes: those are the evidence under the step a reader is
 * looking at, and truncating them would hide the most relevant entries in order
 * to shorten the least relevant part of the page.
 *
 * @param {any} action
 */
function planStatus(action) {
    const p = esc(action.global.project);
    const seq = Number(action.opts.seq);
    const planId = resolvePlanId(p, seq);

    const [plan] = sqlJson(`SELECT project, content FROM plans WHERE id=${planId};`);
    const tasks = childTasks(planId);
    const notes = planNotes(planId);

    /** @type {Map<string, any[]>} anchor → the tasks carrying it */
    const byAnchor = new Map();
    for (const task of tasks) {
        if (!task.plan_anchor) continue;
        const bucket = byAnchor.get(task.plan_anchor);
        if (bucket) bucket.push(task);
        else byAnchor.set(task.plan_anchor, [task]);
    }

    const body = plan?.content ?? '';
    const lines = body === '' ? [] : body.split('\n');

    // Pass 1 — which anchors the document actually mentions. Attribution needs
    // this before the body can be rendered, because a note is only inline if
    // the task it names is itself rendered somewhere.
    /** @type {Set<string>} */
    const matchedAnchors = new Set();
    for (const line of lines) {
        const heading = HEADING_RE.exec(line);
        if (!heading) continue;
        const slug = slugify(heading[1]);
        if (byAnchor.has(slug)) matchedAnchors.add(slug);
    }

    /** @type {Set<string>} qualified refs that will appear under some heading */
    const renderedRefs = new Set();
    for (const anchor of matchedAnchors) {
        for (const task of byAnchor.get(anchor) ?? []) {
            renderedRefs.add(refKey({ project: task.project, seq: Number(task.seq) }));
        }
    }

    /** @type {Map<string, any[]>} qualified task ref → notes naming it */
    const notesByRef = new Map();
    /** @type {any[]} */
    const history = [];
    for (const note of notes) {
        const attached = noteRefs(note, plan.project).filter((ref) => renderedRefs.has(refKey(ref)));
        if (attached.length === 0) {
            history.push(note);
            continue;
        }
        for (const ref of attached) {
            const key = refKey(ref);
            const bucket = notesByRef.get(key);
            if (bucket) bucket.push(note);
            else notesByRef.set(key, [note]);
        }
    }

    // Pass 2 — the body, verbatim, with the annotation appended after each
    // matching heading.
    /** @type {string[]} */
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        const heading = HEADING_RE.exec(lines[i]);
        if (!heading) continue;
        const stepTasks = byAnchor.get(slugify(heading[1]));
        if (!stepTasks) continue;

        const before = out.length;
        for (const task of stepTasks) {
            out.push(statusLine(task));
            // Deduplicated per task: one note may name several tasks under the
            // same heading, and repeating it once per ref reads as several
            // distinct events.
            const seen = new Set();
            const key = refKey({ project: task.project, seq: Number(task.seq) });
            for (const note of notesByRef.get(key) ?? []) {
                if (seen.has(note.id)) continue;
                seen.add(note.id);
                out.push(...noteBlockquote(note));
            }
        }
        // A blank line only where the document does not already provide one, so
        // the annotation never welds itself onto the prose that follows.
        const next = lines[i + 1];
        if (out.length > before && next !== undefined && next.trim() !== '') out.push('');
    }

    if (history.length > 0) {
        const limit = Number(action.opts.limit);
        const shown = history.slice(0, Math.max(limit, 0));
        // A body ending in a newline already contributed a trailing empty line;
        // adding a second one puts a gap in the page that the document did not.
        if (out.length > 0 && out[out.length - 1] !== '') out.push('');
        out.push('## History', '');
        for (const note of shown) out.push(noteHistoryLine(note, plan.project));
        const earlier = history.length - shown.length;
        if (earlier > 0) out.push('', `(${earlier} earlier note${earlier === 1 ? '' : 's'})`);
    }

    const unmatched = [...byAnchor.keys()].filter((anchor) => !matchedAnchors.has(anchor)).sort();
    if (unmatched.length > 0) {
        process.stderr.write(
            `WARNING: no heading in ${planLabel(seq)} matches ${unmatched.length} task ` +
                `anchor${unmatched.length === 1 ? '' : 's'}: ${unmatched.join(', ')}\n` +
                `         Those tasks are not annotated below; the body is printed as stored.\n`,
        );
    }

    emit(out.join('\n'), action.global.outputFile);
    return 0;
}

// ── plan progress ─────────────────────────────────────────────

/**
 * Child-task counts, in the order `--counts` prints them.
 *
 * `blocked` overlaps `pending` rather than partitioning alongside it — a task is
 * blocked *while* pending — so the four status counts sum to `total` and
 * `blocked` does not participate in that sum. The accept-flow in SKILL.md reads
 * it as "is there anything left that cannot start", not as a fifth status.
 *
 * @param {any[]} tasks
 * @returns {{total:number, pending:number, in_progress:number, completed:number, cancelled:number, blocked:number}}
 */
function tally(tasks) {
    const counts = {
        total: tasks.length,
        pending: 0,
        in_progress: 0,
        completed: 0,
        cancelled: 0,
        blocked: 0,
    };
    for (const task of tasks) {
        if (task.status in counts) counts[task.status] += 1;
        if (task.status === 'pending' && Number(task.open_deps) > 0) counts.blocked += 1;
    }
    return counts;
}

/**
 * Escape one markdown table cell. A pipe inside a title would otherwise split
 * the row into extra columns, and a newline would end the table entirely.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
}

/**
 * The one-paragraph summary — derived entirely from the counts, so the same
 * database always produces the same sentence. All four statuses are named even
 * at zero: a reader comparing two runs should see a number change rather than a
 * clause appear and disappear.
 *
 * @param {string} label
 * @param {ReturnType<typeof tally>} counts
 * @returns {string}
 */
function summarize(label, counts) {
    if (counts.total === 0) {
        return `${label} has no tasks yet, so there is no progress to report.`;
    }
    const open = counts.pending + counts.in_progress;
    const sentences = [
        `${label} has ${counts.total} task${counts.total === 1 ? '' : 's'}: ` +
            `${counts.completed} completed, ${counts.in_progress} in progress, ` +
            `${counts.pending} pending, ${counts.cancelled} cancelled.`,
        counts.blocked === 0
            ? 'No pending task is blocked by an incomplete dependency.'
            : `${counts.blocked} pending task${counts.blocked === 1 ? ' is' : 's are'} ` +
              'blocked by an incomplete dependency.',
        open === 0
            ? 'Every task is terminal.'
            : `${open} task${open === 1 ? '' : 's'} remain${open === 1 ? 's' : ''} open.`,
    ];
    return sentences.join(' ');
}

/**
 * A standalone progress report: header, task table, summary, latest note.
 *
 * Standalone is the distinction from `plan status`. Nothing here reproduces the
 * plan document, so this command answers "how far along is this" for a plan
 * whose body is empty, unmatched, or thousands of lines long, and it is safe to
 * paste under a `plan status` rendering without repeating it.
 *
 * `--counts` replaces the whole report with
 * `total|pending|in_progress|completed|cancelled|blocked`. That field order is a
 * contract: the accept-flow in SKILL.md reads positions 2, 3 and 6 to decide
 * whether to offer closing the plan, and reordering the line would not fail —
 * it would offer to close plans that still have open work.
 *
 * A plan with no tasks reports `0/0 complete` and says so in prose. There is
 * deliberately no percentage anywhere in this output: the only completion
 * figure the spec asks for is `done/total`, and a percentage is exactly the
 * field that turns an empty plan into a division by zero.
 *
 * @param {any} action
 */
function planProgress(action) {
    const p = esc(action.global.project);
    const seq = Number(action.opts.seq);
    const planId = resolvePlanId(p, seq);

    const tasks = childTasks(planId);
    const counts = tally(tasks);

    if (action.opts.counts) {
        emit(
            [
                counts.total,
                counts.pending,
                counts.in_progress,
                counts.completed,
                counts.cancelled,
                counts.blocked,
            ].join('|'),
            action.global.outputFile,
        );
        return 0;
    }

    const [plan] = sqlJson(
        `SELECT title, source, path, content_hash, pending_hash FROM plans WHERE id=${planId};`,
    );
    const label = planLabel(seq);
    const drift = planDrift({
        source: plan.source,
        path: plan.path ?? null,
        content_hash: plan.content_hash ?? null,
        pending_hash: plan.pending_hash ?? null,
    });

    const out = [
        `# ${label} · ${plan.title}`,
        '',
        `${plan.source} · drift ${drift} · ${counts.completed}/${counts.total} complete`,
        '',
    ];

    if (tasks.length === 0) {
        out.push('_No tasks are linked to this plan yet._');
    } else {
        out.push('| ID | Project | Step | Status | When | Commit |');
        out.push('| --- | --- | --- | --- | --- | --- |');
        for (const task of tasks) {
            // The step column falls back to the title for a task with no
            // anchor: a plan may own tasks that were never derived from a
            // heading, and an empty cell would report them as nameless rather
            // than as unanchored.
            const step = task.plan_anchor || task.title;
            out.push(
                `| ${taskLabel(task.seq)} | ${cell(task.project)} | ${cell(step)} | ` +
                    `${cell(task.status)} | ${cell(task.when_ts)} | ${cell(task.commit_sha)} |`,
            );
        }
    }

    out.push('', summarize(label, counts));

    const [latest] = planNotes(planId);
    out.push(
        '',
        latest
            ? `**Latest note** — _${latest.ts}_ · ${latest.kind}` +
                  `${latest.note ? ` — ${latest.note.replace(/\s*\n\s*/g, ' ')}` : ''}`
            : '_No notes yet._',
    );

    emit(out.join('\n'), action.global.outputFile);
    return 0;
}

/** @type {Record<string, (action:any) => number|void>} */
export const PLAN_READ_HANDLERS = {
    planTasks,
    planStatus,
    planProgress,
};
