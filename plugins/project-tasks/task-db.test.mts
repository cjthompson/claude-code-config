/*  Run the tests:
 *    node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts
 *
 *  Additional top-level `describe` blocks (parser, registry coverage, skill
 *  call-site lint) are appended below the `normalize` block — keep each group
 *  self-contained so slices can land independently.
 */
import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { normalizeProject, slugify } from './lib/normalize.mjs';

// ── lib/normalize.mjs ─────────────────────────────────────────

/** Varied raw headings used for the slugify property assertions. */
const IDEMPOTENCY_TABLE: string[] = [
  'Step 1: Do the thing',
  '### Step 2 — Ship it!!! ',
  'a   ---  __ b',
  'Plan: (phase 3) / re-work "the" API',
  'v1.2.3-rc.4',
  'Café déjà vu',
  'Ship it 🚀 now',
  '!!!',
  '',
  '   ',
  'already-a-slug',
  '-leading-and-trailing-',
  'UPPER_SNAKE_CASE',
  'tabs\tand\nnewlines',
  '日本語 heading',
  '100% done?',
];

describe('normalize', () => {
  // These cases guard the verbatim move of normalizeProject out of
  // bin/task-db. Existing database rows are keyed on this exact output, so a
  // "cleanup" of the function must fail here rather than silently fragment
  // users' task lists.
  describe('normalizeProject', () => {
    const CANONICAL = 'github.com/o/r';

    const equivalent: Array<[string, string]> = [
      ['SSH with .git', 'git@github.com:o/r.git'],
      ['HTTPS with trailing slash', 'https://github.com/o/r/'],
      ['bare host path', 'github.com/o/r'],
      ['SSH without .git', 'git@github.com:o/r'],
    ];

    for (const [label, raw] of equivalent) {
      it(`collapses ${label} to ${CANONICAL}`, () => {
        strictEqual(normalizeProject(raw), CANONICAL);
      });
    }

    it('collapses every equivalent form to a single key', () => {
      const keys = new Set(equivalent.map(([, raw]) => normalizeProject(raw)));
      strictEqual(keys.size, 1);
      strictEqual([...keys][0], CANONICAL);
    });

    it('strips the http:// scheme as well as https://', () => {
      strictEqual(normalizeProject('http://github.com/o/r'), CANONICAL);
    });

    it('strips both .git and a trailing slash from an HTTPS url', () => {
      strictEqual(normalizeProject('https://github.com/o/r.git'), CANONICAL);
    });

    it('handles a non-github host in SSH form', () => {
      strictEqual(
        normalizeProject('git@gitlab.example.com:team/sub/repo.git'),
        'gitlab.example.com/team/sub/repo',
      );
    });

    it('trims surrounding whitespace', () => {
      strictEqual(normalizeProject('  git@github.com:o/r.git  '), CANONICAL);
    });

    it('leaves a plain local project name untouched', () => {
      strictEqual(normalizeProject('testproj'), 'testproj');
    });

    it('returns an empty string for empty input', () => {
      strictEqual(normalizeProject(''), '');
    });

    it('returns an empty string for whitespace-only input', () => {
      strictEqual(normalizeProject('   '), '');
    });

    it('returns an empty string for null', () => {
      strictEqual(normalizeProject(null), '');
    });

    it('returns an empty string for undefined', () => {
      strictEqual(normalizeProject(undefined), '');
    });

    it('is idempotent', () => {
      for (const [, raw] of equivalent) {
        strictEqual(normalizeProject(normalizeProject(raw)), normalizeProject(raw));
      }
    });
  });

  describe('slugify', () => {
    it('slugifies a plan heading', () => {
      strictEqual(slugify('Step 1: Do the thing'), 'step-1-do-the-thing');
    });

    it('lowercases mixed case', () => {
      strictEqual(slugify('MiXeD CaSe Heading'), 'mixed-case-heading');
    });

    it('trims leading and trailing punctuation', () => {
      strictEqual(slugify('### Step 2 — Ship it!!! '), 'step-2-ship-it');
    });

    it('collapses runs of separators into a single dash', () => {
      strictEqual(slugify('a   ---  __ b'), 'a-b');
    });

    it('collapses a heading full of mixed punctuation', () => {
      strictEqual(slugify('Plan: (phase 3) / re-work "the" API'), 'plan-phase-3-re-work-the-api');
    });

    it('keeps digits and drops the rest of a version string', () => {
      strictEqual(slugify('v1.2.3-rc.4'), 'v1-2-3-rc-4');
    });

    it('replaces unicode letters, since only [a-z0-9] survive', () => {
      strictEqual(slugify('Café déjà vu'), 'caf-d-j-vu');
    });

    it('replaces emoji', () => {
      strictEqual(slugify('Ship it 🚀 now'), 'ship-it-now');
    });

    it('returns an empty string for all-punctuation input', () => {
      strictEqual(slugify('!!!'), '');
      strictEqual(slugify('--- ___ ***'), '');
    });

    it('returns an empty string for empty and nullish input', () => {
      strictEqual(slugify(''), '');
      strictEqual(slugify(null), '');
      strictEqual(slugify(undefined), '');
    });

    it('produces only [a-z0-9-] with no leading, trailing, or repeated dash', () => {
      for (const raw of IDEMPOTENCY_TABLE) {
        const s = slugify(raw);
        ok(/^[a-z0-9-]*$/.test(s), `unexpected characters in slug: ${JSON.stringify(s)}`);
        ok(!/^-|-$|--/.test(s), `malformed dashes in slug: ${JSON.stringify(s)}`);
      }
    });

    // Anchors are the join key between plan-document headings and task rows.
    // A non-idempotent slug silently duplicates tasks on a second pass, so
    // idempotency is asserted as a property over a varied table rather than
    // as a single example.
    describe('idempotency', () => {
      for (const raw of IDEMPOTENCY_TABLE) {
        it(`slugify(slugify(x)) === slugify(x) for ${JSON.stringify(raw)}`, () => {
          const once = slugify(raw);
          strictEqual(slugify(once), once);
        });
      }
    });
  });
});

// ── lib/cli.mjs — parseArgv ───────────────────────────────────
//
// Four groups, per docs/plans/task-db-cli-parsing.md:
//   A. doc-derived fixtures  — external, guards registry-vs-parent-plan drift
//   B. skill call-site lint  — external, guards the hard-cutover call sites
//   C. coverage assertions   — external, guards spec'd-but-never-exercised
//   D. parser logic cases    — self-referential, guards coercion / cross-flag
//
// Group C runs LAST on purpose: it reads a ledger that Groups A and D populate
// as their `it` bodies execute. node:test runs declarations in order, so the
// ledger is complete by the time C reads it. Do not reorder these blocks.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deepStrictEqual, match, notStrictEqual } from 'node:assert/strict';
import { parseArgv, CliError } from './lib/cli.mjs';
import { COMMANDS, GROUPS, RENAMES, ENUMS } from './lib/registry.mjs';

const PLUGIN_DIR = import.meta.dirname;
const REPO_ROOT = resolve(PLUGIN_DIR, '../..');
const PARENT_PLAN = join(REPO_ROOT, 'docs/plans/project-tasks-plan-type.md');
const SKILL_DIR = join(PLUGIN_DIR, 'skills/project-tasks');

// ── shared markdown/shell extraction helpers ──────────────────
//
// Fixtures are stored as pre-split arrays because `process.argv` arrives
// already tokenized. These helpers exist only to lift argv arrays out of
// markdown; a quote-splitter applied to the assertions themselves would be
// testing the shell rather than the parser.

/** Tokenize one command string on whitespace, respecting quotes. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let quoted = false;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      quoted = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur !== '' || quoted) out.push(cur);
      cur = '';
      quoted = false;
      continue;
    }
    cur += c;
  }
  if (cur !== '' || quoted) out.push(cur);
  return out;
}

/** Split a shell line into pipeline/list segments plus its trailing comment. */
function shellSplit(line: string): { segments: string[]; comment: string } {
  const segments: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let comment = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      cur += c;
      quote = c;
      continue;
    }
    if (c === '#') {
      comment = line.slice(i);
      break;
    }
    if (c === ';') {
      segments.push(cur);
      cur = '';
      continue;
    }
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '|') {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return { segments: segments.map((s) => s.trim()).filter(Boolean), comment };
}

/** Logical lines of every fenced bash block, joining `\` continuations. */
function bashLines(markdown: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  let pending = '';
  for (const raw of markdown.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      inBlock = !inBlock && /^```(bash|sh|shell)\b/.test(trimmed);
      pending = '';
      continue;
    }
    if (!inBlock) continue;
    if (trimmed.endsWith('\\')) {
      pending += `${trimmed.slice(0, -1)} `;
      continue;
    }
    out.push((pending + trimmed).trim());
    pending = '';
  }
  return out;
}

// ── coverage ledger (read by Group C) ─────────────────────────

const EXERCISED_COMMANDS = new Set<string>();
const EXERCISED_FLAGS = new Set<string>();
const ACCEPTED_ENUM_VALUES = new Set<string>();
const THROWN_EXIT_CODES = new Set<number>();

function recordCoverage(command: string, argv: string[]): void {
  EXERCISED_COMMANDS.add(command);
  const spec = (COMMANDS as any)[command];
  if (!spec) return;
  for (const tok of argv) {
    if (!tok.startsWith('--')) continue;
    const name = tok.split('=')[0];
    if (spec.opts[name]) EXERCISED_FLAGS.add(`${command} ${name}`);
  }
}

/** Parse, assert purity, and feed the coverage ledger. */
function parseOk(argv: string[]): any {
  const snapshot = JSON.stringify(argv);
  const action = parseArgv(argv);
  strictEqual(JSON.stringify(argv), snapshot, 'parseArgv must not mutate its input array');
  if (action && action.kind === 'run') recordCoverage(action.command, argv);
  return action;
}

/** Assert a CliError carrying exitCode 1, and hand it back for message checks. */
function parseFail(argv: string[]): any {
  let err: any = null;
  try {
    parseArgv(argv);
  } catch (e) {
    err = e;
  }
  ok(err !== null, `expected parseArgv(${JSON.stringify(argv)}) to throw, but it returned`);
  ok(err instanceof CliError, `expected a CliError, got ${err?.constructor?.name}: ${err?.message}`);
  strictEqual(err.exitCode, 1, `CliError.exitCode must be 1, got ${err.exitCode}`);
  THROWN_EXIT_CODES.add(err.exitCode);
  return err;
}

/** Which ENUMS set an option's `values` array is, by reference. */
function enumNameFor(values: string[]): string | null {
  for (const [name, arr] of Object.entries(ENUMS)) {
    if (arr === values) return name;
  }
  return null;
}

// ── Group A — doc-derived fixtures ────────────────────────────
//
// Every `$T …` line in the Verification section of the parent plan is
// extracted at run time rather than hand-transcribed, so editing that block
// without updating the registry fails this suite.

type DocFixture = { argv: string[]; source: string; comment: string; marked: boolean };

function extractDocFixtures(): DocFixture[] {
  const md = readFileSync(PARENT_PLAN, 'utf8');
  const out: DocFixture[] = [];
  for (const line of bashLines(md)) {
    if (!line.startsWith('$T ')) continue;
    const { segments, comment } = shellSplit(line);
    for (const seg of segments) {
      const toks = tokenize(seg);
      if (toks[0] !== '$T') continue; // `$T` → [] : the driver token is dropped
      out.push({
        argv: toks.slice(1),
        source: seg,
        comment,
        marked: /must FAIL/i.test(comment) || /(→|->)\s*ERROR/.test(comment),
      });
    }
  }
  return out;
}

const DOC_FIXTURES = extractDocFixtures();

// Doc lines marked as failing that fail at RUNTIME, not at parse time. The
// parent plan's `# must FAIL` / `→ ERROR` markers describe end-to-end
// behavior; the cli-parsing plan carves these out explicitly as handler
// concerns. Asserting they parse CLEAN is what stops the follow-up plan from
// mistaking them for parser work.
const RUNTIME_GUARDS: Array<{ why: string; match: (a: string[]) => boolean }> = [
  {
    why: 'plan propose source-type guard depends on the stored plan `source`',
    match: (a) => a[0] === 'plan' && a[1] === 'propose',
  },
  {
    why: '--plan-id 999 is an FK violation, which depends on the DB',
    match: (a) => a.includes('--plan-id') && a[a.indexOf('--plan-id') + 1] === '999',
  },
  {
    why: 'plan note delete lifecycle guard depends on the stored note `kind`',
    match: (a) => a[0] === 'plan' && a[1] === 'note' && a[2] === 'delete' && !a.includes('--force'),
  },
];

function runtimeGuardFor(argv: string[]): { why: string } | null {
  return RUNTIME_GUARDS.find((g) => g.match(argv)) ?? null;
}

/** The single doc fixture matching a predicate; fails loudly on 0 or >1. */
function docFixture(label: string, pred: (a: string[]) => boolean): string[] {
  const hits = DOC_FIXTURES.filter((f) => pred(f.argv));
  strictEqual(hits.length, 1, `expected exactly one doc fixture for ${label}, found ${hits.length}`);
  return hits[0].argv;
}

describe('cli — Group A: doc-derived fixtures', () => {
  it('extracted a plausible number of $T lines from the parent plan', () => {
    // Guards the extractor itself: a regex slip yielding zero fixtures would
    // make every case below vacuously pass.
    ok(
      DOC_FIXTURES.length >= 25,
      `expected >=25 $T invocations in ${PARENT_PLAN}, got ${DOC_FIXTURES.length}`,
    );
  });

  for (const fx of DOC_FIXTURES) {
    const guard = runtimeGuardFor(fx.argv);
    if (fx.marked && !guard) {
      it(`rejects (doc marks it a failure): ${fx.source}`, () => {
        parseFail(fx.argv);
      });
    } else if (fx.marked && guard) {
      it(`parses clean despite the doc's failure marker — ${guard.why}: ${fx.source}`, () => {
        strictEqual(parseOk(fx.argv).kind, 'run');
      });
    } else {
      it(`parses: ${fx.source}`, () => {
        strictEqual(parseOk(fx.argv).kind, 'run');
      });
    }
  }

  it('every runtime-guard carve-out still matches a doc line marked as failing', () => {
    // Without this, deleting a `# must FAIL` marker upstream would leave a dead
    // carve-out that silently weakens the group.
    for (const g of RUNTIME_GUARDS) {
      ok(
        DOC_FIXTURES.some((f) => f.marked && g.match(f.argv)),
        `runtime guard is stale, no marked doc line matches: ${g.why}`,
      );
    }
  });

  it('db init needs no --project and carries no opts', () => {
    const action = parseOk(docFixture('db init', (a) => a[0] === 'db' && a[1] === 'init'));
    strictEqual(action.command, 'db init');
    deepStrictEqual(action.opts, {});
    strictEqual(action.global.project, null);
  });

  it('plan create --path sets path and leaves contentFile absent', () => {
    const action = parseOk(
      docFixture('linked plan create', (a) => a[0] === 'plan' && a[1] === 'create' && a.includes('--path')),
    );
    strictEqual(action.opts.path, '/tmp/p.md');
    ok(!('contentFile' in action.opts), 'contentFile must be absent when --path was used');
  });

  it('plan create --content-file with --origin sets both without an xor violation', () => {
    const action = parseOk(
      docFixture('imported plan create', (a) => a[0] === 'plan' && a[1] === 'create' && a.includes('--origin')),
    );
    strictEqual(action.opts.contentFile, '/tmp/q.md');
    strictEqual(action.opts.origin, '/tmp/q.md');
    ok(!('path' in action.opts));
  });

  it('plan get --content-only --output-file keeps outputFile out of opts', () => {
    const action = parseOk(
      docFixture('plan get round-trip', (a) => a[0] === 'plan' && a[1] === 'get' && a.includes('--output-file')),
    );
    strictEqual(action.opts.seq, 2);
    strictEqual(typeof action.opts.seq, 'number');
    strictEqual(action.opts.contentOnly, true);
    strictEqual(action.global.outputFile, '/tmp/restored.md');
    ok(!('outputFile' in action.opts), '--output-file is global, it must not leak into opts');
  });

  it('task add --anchor slugifies the raw heading at the parse boundary', () => {
    const action = parseOk(
      docFixture('raw heading anchor', (a) => a[a.indexOf('--anchor') + 1] === 'Step 1: Do the thing'),
    );
    strictEqual(action.opts.anchor, 'step-1-do-the-thing');
  });

  it('an already-slugified --anchor parses identically to the raw heading', () => {
    const raw = parseOk(
      docFixture('raw heading anchor', (a) => a[a.indexOf('--anchor') + 1] === 'Step 1: Do the thing'),
    );
    const slugged = parseOk(
      docFixture('pre-slugged anchor', (a) => a[a.indexOf('--anchor') + 1] === 'step-1-do-the-thing'),
    );
    deepStrictEqual(slugged, raw, 'slugify must be idempotent across the parse boundary');
  });

  it('task update --status in_progress accepts the enum', () => {
    const action = parseOk(
      docFixture('auto-advance', (a) => a[0] === 'task' && a[1] === 'update' && a.includes('in_progress')),
    );
    strictEqual(action.opts.status, 'in_progress');
  });

  it('plan propose --output-file does not disturb opts', () => {
    const action = parseOk(
      docFixture('propose with diff out', (a) => a[0] === 'plan' && a[1] === 'propose' && a.includes('--output-file')),
    );
    strictEqual(action.global.outputFile, '/tmp/d.patch');
    deepStrictEqual(Object.keys(action.opts).sort(), ['seq']);
  });

  it('plan note add applies the kind default and pluralizes --task', () => {
    const action = parseOk(
      docFixture('note add', (a) => a[0] === 'plan' && a[1] === 'note' && a[2] === 'add'),
    );
    deepStrictEqual(action.opts.tasks, [
      { project: 'github.com/acme/backend', seq: 1 },
      { project: 'github.com/acme/frontend', seq: 1 },
    ]);
    strictEqual(action.opts.kind, 'manual');
    strictEqual(action.opts.note, 'rescoped after review');
  });

  it('plan note delete reports --force as false when absent and true when present', () => {
    const bare = parseOk(
      docFixture(
        'note delete bare',
        (a) => a[0] === 'plan' && a[1] === 'note' && a[2] === 'delete' && !a.includes('--force'),
      ),
    );
    const forced = parseOk(
      docFixture(
        'note delete forced',
        (a) => a[0] === 'plan' && a[1] === 'note' && a[2] === 'delete' && a.includes('--force'),
      ),
    );
    strictEqual(bare.opts.force, false);
    strictEqual(forced.opts.force, true);
  });

  it('plan status applies the limit default of 10', () => {
    const action = parseOk(docFixture('plan status', (a) => a[0] === 'plan' && a[1] === 'status'));
    strictEqual(action.opts.limit, 10);
  });

  it('plan progress reports --counts as false when absent and true when present', () => {
    const hits = DOC_FIXTURES.filter((f) => f.argv[0] === 'plan' && f.argv[1] === 'progress');
    strictEqual(hits.length, 2, 'expected both plan progress lines in the parent plan');
    strictEqual(parseOk(hits.find((f) => !f.argv.includes('--counts'))!.argv).opts.counts, false);
    strictEqual(parseOk(hits.find((f) => f.argv.includes('--counts'))!.argv).opts.counts, true);
  });

  it('a timestamp with an embedded space survives as one token, alongside a sha', () => {
    const action = parseOk(docFixture('completion', (a) => a.includes('--completed-at')));
    strictEqual(action.opts.completedAt, '2026-08-09 12:00');
    strictEqual(action.opts.commitSha, 'deadbeef');
    strictEqual(action.opts.status, 'completed');
  });

  it('plan update --status cancelled satisfies atLeastOne on its own', () => {
    const action = parseOk(
      docFixture(
        'cancel without confirmation',
        (a) => a[0] === 'plan' && a[1] === 'update' && !a.includes('--confirm-cancel'),
      ),
    );
    strictEqual(action.opts.status, 'cancelled');
  });

  it('the legacy `insert` line throws naming its replacement', () => {
    match(parseFail(docFixture('legacy insert', (a) => a[0] === 'insert')).message, /task add/);
  });

  it('task changelog list --new-only parses to newOnly', () => {
    const action = parseOk(
      docFixture('changelog list', (a) => a[0] === 'task' && a[1] === 'changelog' && a[2] === 'list'),
    );
    strictEqual(action.opts.newOnly, true);
  });

  it('plan tasks / list / apply / attach / detach and task list all route', () => {
    // `plan discard` is deliberately absent: the cli-parsing plan's Group A
    // table lists it here, but the parent plan specifies `plan discard` in its
    // command table (§1, §3) without ever invoking it in the Verification
    // block. There is no `$T plan discard` line to derive a fixture from, so
    // its coverage comes from a hand-written fixture in Group D instead.
    const wanted = [
      ['plan', 'tasks'],
      ['plan', 'list'],
      ['plan', 'apply'],
      ['plan', 'attach'],
      ['plan', 'detach'],
      ['task', 'list'],
    ];
    for (const [a, b] of wanted) {
      const hit = DOC_FIXTURES.find((f) => f.argv[0] === a && f.argv[1] === b);
      ok(hit, `parent plan has no verification line for '${a} ${b}'`);
      const action = parseOk(hit!.argv);
      strictEqual(action.command, `${a} ${b}`);
      deepStrictEqual(action.route, [a, b]);
    }
  });
});

// ── Group B — skill call-site lint ────────────────────────────
//
// The highest-value test in this suite. The parent plan's central risk is that
// every $TASK_DB call site in a `model: haiku` SKILL.md must land on a renamed
// command, with no aliases to catch a miss. This converts that manual review
// into a gate.
//
// Rewriting those files is Wave 3, so while legacy names remain the
// enforcement skips with a visible reason. The skip is DERIVED from the file
// contents, never hardcoded, and the biconditional below makes it impossible
// for the skip to survive once the legacy names are gone.

const SKILL_FILES = ['SKILL.md', 'references/plans.md'];
const LEGACY_NAMES = Object.keys(RENAMES);

/**
 * Named placeholders the skill docs may use in place of a bare `N`.
 *
 * The docs describe five distinct numeric ID spaces — task seq (`#NNN`), plan
 * seq (`P###`), the global plan id `--plan-id` takes, note ids, and plain
 * counts — and warn against mixing them. Writing every one of them as `N` in
 * the examples undercuts that warning at exactly the moment a reader is copying
 * a number: an Opus review reproduced a task silently rebound to the wrong plan
 * and an unrelated plan silently marked completed, both at exit 0, from example
 * lines where two spaces shared the letter `N`.
 *
 * Substituting here rather than banning `{…}` keeps the lint's guarantee — that
 * every documented invocation really parses — while letting the prose name the
 * space it means. An unrecognized `{…}` is a hard error rather than a
 * pass-through, so a typo surfaces as a failing lint instead of silently
 * becoming a literal the parser happens to reject for an unrelated reason.
 */
const NAMED_PLACEHOLDERS: Record<string, string> = {
  '{task_seq}': '1',
  '{plan_seq}': '1',
  '{plan_id}': '1',
  '{note_id}': '1',
  '{count}': '1',
  '{plan_project}': 'testproj',
  '{type}': 'task',
  '{priority}': 'medium',
};

type CallSite = { argv: string[]; file: string; source: string };

function extractCallSites(): { sites: CallSite[]; missing: string[] } {
  const sites: CallSite[] = [];
  const missing: string[] = [];
  for (const rel of SKILL_FILES) {
    const abs = join(SKILL_DIR, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    for (const line of bashLines(readFileSync(abs, 'utf8'))) {
      if (!line.includes('$TASK_DB')) continue;
      for (const seg of shellSplit(line).segments) {
        const toks = tokenize(seg);
        if (toks[0] !== '$TASK_DB') continue;
        // Placeholder substitution: the docs write `"..."`, `$PROJECT`, `N`, and
        // the named `{…}` forms above.
        const argv = toks.slice(1).map((tok, i, all) => {
          if (tok === 'N') return '1';
          if (tok.startsWith('{') && tok.endsWith('}')) {
            const value = NAMED_PLACEHOLDERS[tok];
            if (value === undefined) {
              throw new Error(
                `${rel}: unknown placeholder ${tok} in \`${seg}\`. ` +
                  `Add it to NAMED_PLACEHOLDERS with the value space it stands for, ` +
                  `or use one of: ${Object.keys(NAMED_PLACEHOLDERS).join(', ')}.`,
              );
            }
            return value;
          }
          if (tok === '...' || tok === '$PROJECT') {
            return all[i - 1] === '--project' ? 'testproj' : 'placeholder';
          }
          return tok;
        });
        sites.push({ argv, file: rel, source: seg });
      }
    }
  }
  return { sites, missing };
}

const { sites: CALL_SITES, missing: MISSING_SKILL_FILES } = extractCallSites();
const LEGACY_CALL_SITES = CALL_SITES.filter((s) => LEGACY_NAMES.includes(s.argv[0]));

// Derived, never hardcoded. Non-null ⇒ the lint below is not representative yet.
const LINT_SKIP_REASON: string | null =
  LEGACY_CALL_SITES.length > 0
    ? `Wave 3 has not rewritten the skill yet: ${LEGACY_CALL_SITES.length} of ${CALL_SITES.length} ` +
      'call sites still use pre-cutover names (' +
      `${[...new Set(LEGACY_CALL_SITES.map((s) => s.argv[0]))].sort().join(', ')})` +
      (MISSING_SKILL_FILES.length ? `; missing file(s): ${MISSING_SKILL_FILES.join(', ')}` : '')
    : null;

describe('cli — Group B: skill call-site lint', () => {
  it('found $TASK_DB call sites to lint at all', () => {
    // Without this, an extractor bug after the Wave 3 rewrite would make the
    // whole group pass vacuously — the exact failure mode the lint exists for.
    ok(CALL_SITES.length > 0, `no $TASK_DB invocations extracted from ${SKILL_DIR}`);
  });

  // The transition guard, asserted as a biconditional so the skip can neither
  // linger once the legacy names are gone nor be switched off while they remain.
  it('the skip is engaged if and only if legacy call sites remain', () => {
    strictEqual(
      LINT_SKIP_REASON === null,
      LEGACY_CALL_SITES.length === 0,
      LINT_SKIP_REASON === null
        ? 'lint is enforcing but legacy call sites are still present'
        : 'lint is skipping but zero legacy call sites remain — it must now enforce',
    );
  });

  it(
    'every referenced skill file exists',
    LINT_SKIP_REASON === null ? {} : { skip: LINT_SKIP_REASON },
    () => {
      // Enforced only after the cutover, so Wave 3 cannot rewrite the call
      // sites and quietly leave references/plans.md uncreated.
      deepStrictEqual(MISSING_SKILL_FILES, []);
    },
  );

  for (const site of CALL_SITES) {
    it(
      `${site.file}: ${site.source}`,
      LINT_SKIP_REASON === null ? {} : { skip: LINT_SKIP_REASON },
      () => {
        // Deliberately not parseOk(): call sites lint the skill, they do not
        // count as coverage. A call site must never satisfy Group C on its own.
        const action = parseArgv(site.argv);
        ok(
          action.kind === 'run' || action.kind === 'help',
          `call site produced neither a run nor a help action: ${site.source}`,
        );
      },
    );
  }
});

// ── Group D — parser logic cases ──────────────────────────────

describe('cli — Group D: routing and the hard cutover', () => {
  for (const [legacy, replacement] of Object.entries(RENAMES) as any) {
    it(`'${legacy}' throws naming '${replacement.join(' ')}'`, () => {
      const err = parseFail([legacy, '--project', 'p']);
      match(err.message, new RegExp(replacement.join(' ')));
      match(err.message, /renamed/i);
    });
  }

  it("suggests 'plan apply' for 'plan aply'", () => {
    const err = parseFail(['plan', 'aply', '--project', 'p', '--seq', '1']);
    match(err.message, /unknown command/i);
    match(err.message, /plan apply/);
  });

  it("lists the group's leaves for 'task deps chek'", () => {
    const err = parseFail(['task', 'deps', 'chek', '--project', 'p', '--seq', '1']);
    match(err.message, /task deps check/);
    for (const leaf of (GROUPS as any)['task deps']) match(err.message, new RegExp(leaf));
  });

  it('a wholly unknown command throws', () => {
    match(parseFail(['badcmd']).message, /unknown command/i);
  });

  it('a group with no leaf returns help rather than throwing', () => {
    for (const group of Object.keys(GROUPS)) {
      const action = parseOk(group.split(' '));
      strictEqual(action.kind, 'help', `'${group}' should return help`);
      strictEqual(action.command, group);
    }
  });

  it('a bare invocation returns top-level help', () => {
    const action = parseOk([]);
    strictEqual(action.kind, 'help');
    strictEqual(action.command, null);
    ok(typeof action.usage === 'string' && action.usage.length > 0);
  });

  it('--help short-circuits at every depth', () => {
    for (const argv of [
      ['--help'],
      ['-h'],
      ['task', '--help'],
      ['task', 'deps', '--help'],
      ['task', 'add', '--help'],
      ['plan', 'note', 'add', '-h'],
      ['task', 'add', '--project', 'p', '--help'],
    ]) {
      strictEqual(parseOk(argv).kind, 'help', `expected help for ${JSON.stringify(argv)}`);
    }
  });

  it('a leftover word after a matched command is an unexpected argument', () => {
    const err = parseFail(['task', 'get', 'extra', '--project', 'p', '--seq', '1']);
    match(err.message, /unexpected argument/i);
    match(err.message, /extra/);
  });

  it('a stray positional after flag parsing has begun is an unexpected argument', () => {
    const err = parseFail(['task', 'get', '--project', 'p', '--seq', '1', 'extra']);
    match(err.message, /unexpected argument/i);
    match(err.message, /extra/);
  });
});

describe('cli — Group D: flags, values and coercion', () => {
  it("suggests '--project' for '--projekt'", () => {
    const err = parseFail(['task', 'add', '--projekt', 'foo', '--title', 'x', '--type', 'fix']);
    match(err.message, /unknown option '--projekt'/);
    match(err.message, /--project/);
    match(err.message, /task add/);
  });

  it('a missing required flag throws naming the flag', () => {
    const err = parseFail(['task', 'get', '--project', 'p']);
    match(err.message, /--seq/);
    match(err.message, /required/i);
  });

  it('a missing value at the end of argv throws', () => {
    const err = parseFail(['task', 'get', '--project', 'p', '--seq']);
    match(err.message, /missing value/i);
    match(err.message, /--seq/);
  });

  it('a missing value followed by another recognized flag throws', () => {
    const err = parseFail(['task', 'add', '--project', 'p', '--title', '--type', 'fix']);
    match(err.message, /missing value/i);
    match(err.message, /--title/);
  });

  it('the two missing-value cases are distinguishable in the message', () => {
    const atEnd = parseFail(['task', 'get', '--project', 'p', '--seq']);
    const beforeFlag = parseFail(['task', 'add', '--project', 'p', '--title', '--type', 'fix']);
    notStrictEqual(atEnd.message, beforeFlag.message);
    match(atEnd.message, /end of/i);
  });

  it('--flag=value is accepted, including a value that starts with a dash', () => {
    const action = parseOk(['task', 'add', '--project=p', '--type=fix', '--title=-not-a-flag']);
    strictEqual(action.opts.title, '-not-a-flag');
    strictEqual(action.opts.type, 'fix');
    strictEqual(action.global.project, 'p');
  });

  it('a bool flag rejects an attached value', () => {
    match(
      parseFail(['task', 'changelog', 'list', '--project', 'p', '--new-only=true']).message,
      /--new-only/,
    );
  });

  it('int coercion rejects non-integers and yields numbers', () => {
    parseFail(['task', 'get', '--project', 'p', '--seq', 'abc']);
    parseFail(['task', 'get', '--project', 'p', '--seq', '1.5']);
    parseFail(['task', 'get', '--project', 'p', '--seq', '-1']);
    strictEqual(parseOk(['task', 'get', '--project', 'p', '--seq', '42']).opts.seq, 42);
  });

  it('taskref coercion normalizes projects and preserves qualified sequences', () => {
    const action = parseOk([
      'plan', 'note', 'add', '--project', 'p', '--seq', '1', '--note', 'n',
      '--task', 'https://github.com/acme/backend.git#001', '--task', 'github.com/acme/frontend#2',
    ]);
    deepStrictEqual(action.opts.tasks, [
      { project: 'github.com/acme/backend', seq: 1 },
      { project: 'github.com/acme/frontend', seq: 2 },
    ]);
  });

  it('taskref rejects bare, malformed, zero, and empty-project references', () => {
    for (const value of ['1', 'github.com/acme/backend#0', '#1', 'github.com/acme/backend#x']) {
      const err = parseFail([
        'plan', 'note', 'add', '--project', 'p', '--seq', '1', '--note', 'n', '--task', value,
      ]);
      match(err.message, /project-qualified|positive-seq/);
    }
  });

  it('abspath rejects a relative path but path does not', () => {
    parseFail(['plan', 'create', '--project', 'p', '--title', 't', '--path', './x.md']);
    const action = parseOk(['plan', 'create', '--project', 'p', '--title', 't', '--content-file', './x.md']);
    strictEqual(action.opts.contentFile, './x.md');
  });

  it('ts accepts the documented shapes and rejects others', () => {
    for (const good of ['2026-08-09', '2026-08-09 12:00', '2026-08-09 12:00:30']) {
      strictEqual(
        parseOk(['task', 'update', '--project', 'p', '--seq', '1', '--created', good]).opts.created,
        good,
      );
    }
    parseFail(['task', 'update', '--project', 'p', '--seq', '1', '--created', '2026/08/09']);
    parseFail(['task', 'update', '--project', 'p', '--seq', '1', '--completed-at', '2026-08-09T12:00']);
  });

  it('sha accepts 7–40 hex characters and rejects anything else', () => {
    parseOk(['task', 'update', '--project', 'p', '--seq', '1', '--commit-sha', 'deadbee']);
    parseOk(['task', 'update', '--project', 'p', '--seq', '1', '--commit-sha', 'DEADBEEF']);
    parseFail(['task', 'update', '--project', 'p', '--seq', '1', '--commit-sha', 'zzz']);
    parseFail(['task', 'update', '--project', 'p', '--seq', '1', '--commit-sha', 'deadbe']);
  });

  it('an empty slug is a parse error naming the offending input', () => {
    // plan_anchor = '' is non-NULL, so the partial unique index treats every
    // empty anchor as the same key; `task add`'s ON CONFLICT DO NOTHING then
    // select-by-anchor would return an unrelated task's id and report success.
    for (const bad of ['🎉', '日本語', '!!!', '--- ___ ***']) {
      const err = parseFail([
        'task', 'add', '--project', 'p', '--type', 'fix', '--title', 'x',
        '--plan-id', '1', '--anchor', bad,
      ]);
      match(err.message, /--anchor/);
      ok(err.message.includes(bad), `error must name the offending input, got: ${err.message}`);
      match(err.message, /rename/i);
    }
  });

  it('--project is normalized through lib/normalize.mjs', () => {
    for (const raw of ['git@github.com:o/r.git', 'https://github.com/o/r/']) {
      strictEqual(parseOk(['task', 'list', '--project', raw]).global.project, 'github.com/o/r');
    }
  });

  it('--project that normalizes to nothing is rejected', () => {
    parseFail(['task', 'list', '--project', '   ']);
  });

  it('--project is required on task/plan commands and rejected on db commands', () => {
    match(parseFail(['task', 'list']).message, /--project/);
    match(parseFail(['plan', 'list']).message, /--project/);
    const err = parseFail(['db', 'init', '--project', 'foo']);
    match(err.message, /--project/);
    match(err.message, /db init/);
  });

  it('--output-file is accepted everywhere and lands in global', () => {
    const action = parseOk(['db', 'migrate', '--output-file', '/tmp/o.txt']);
    strictEqual(action.global.outputFile, '/tmp/o.txt');
    deepStrictEqual(action.opts, {});
  });
});

describe('cli — Group D: arity, the --seq contrast, and the --limit key', () => {
  it('repeating a non-repeatable flag throws', () => {
    const err = parseFail(['task', 'get', '--project', 'p', '--seq', '1', '--seq', '2']);
    match(err.message, /--seq/);
    match(err.message, /(repeat|more than once|already)/i);
  });

  // The contrasting pair is the point: identical shape, opposite outcome,
  // because differing ARITY is the one legitimate reason for a flag to map to
  // a different key.
  it('the same shape on task changelog mark collects into seqs', () => {
    const action = parseOk(['task', 'changelog', 'mark', '--project', 'p', '--seq', '1', '--seq', '2']);
    deepStrictEqual(action.opts.seqs, [1, 2]);
    ok(!('seq' in action.opts), 'the repeatable form must pluralize its key');
  });

  it('--seq maps to `seq` everywhere except task changelog mark', () => {
    for (const [command, spec] of Object.entries(COMMANDS) as any) {
      const opt = spec.opts['--seq'];
      if (!opt) continue;
      if (command === 'task changelog mark') {
        strictEqual(opt.key, 'seqs', `${command}: repeatable --seq must pluralize`);
        strictEqual(opt.type, 'int[]');
      } else {
        strictEqual(opt.key, 'seq', `${command}: --seq must map to 'seq'`);
        strictEqual(opt.type, 'int');
      }
    }
  });

  it('--limit maps to the same key at the same arity on every command', () => {
    const keys = new Set<string>();
    for (const spec of Object.values(COMMANDS) as any) {
      if (spec.opts['--limit']) keys.add(spec.opts['--limit'].key);
    }
    deepStrictEqual([...keys], ['limit']);
  });

  it('every repeatable flag pluralizes its key', () => {
    const expected: Record<string, string> = {
      '--tag': 'tags',
      '--req': 'reqs',
      '--dep': 'deps',
      '--task': 'tasks',
      '--seq': 'seqs',
    };
    for (const [command, spec] of Object.entries(COMMANDS) as any) {
      for (const [flag, opt] of Object.entries(spec.opts) as any) {
        if (!String(opt.type).endsWith('[]')) continue;
        ok(expected[flag], `${command}: repeatable flag ${flag} has no documented plural key`);
        strictEqual(opt.key, expected[flag], `${command} ${flag}`);
      }
    }
    strictEqual((COMMANDS as any)['plan note add'].opts['--task'].type, 'taskref[]');
    strictEqual((COMMANDS as any)['plan note replace'].opts['--task'].type, 'taskref[]');
  });

  it('repeatable flags collect in order', () => {
    const action = parseOk([
      'task', 'deps', 'validate', '--project', 'p', '--dep', '3', '--dep', '5', '--dep', '1',
    ]);
    deepStrictEqual(action.opts.deps, [3, 5, 1]);
  });
});

describe('cli — Group D: cross-flag rules', () => {
  it('mutual exclusion throws on both documented pairs', () => {
    match(
      parseFail(['plan', 'create', '--project', 'p', '--title', 't', '--path', '/a', '--content-file', '/b'])
        .message,
      /(exclusive|both|only one|mutually)/i,
    );
    match(
      parseFail(['plan', 'get', '--project', 'p', '--seq', '1', '--with-content', '--content-only']).message,
      /(exclusive|both|only one|mutually)/i,
    );
  });

  it('mutual exclusion throws for --clear-plan with --plan-id or --anchor', () => {
    match(
      parseFail(['task', 'update', '--project', 'p', '--seq', '1', '--clear-plan', '--plan-id', '7']).message,
      /mutually exclusive/i,
    );
    match(
      parseFail(['task', 'update', '--project', 'p', '--seq', '1', '--clear-plan', '--anchor', 'step-one']).message,
      /mutually exclusive/i,
    );
  });

  it('atLeastOne rejects a bare update on both update commands', () => {
    match(parseFail(['task', 'update', '--project', 'p', '--seq', '1']).message, /at least one/i);
    match(parseFail(['plan', 'update', '--project', 'p', '--seq', '1']).message, /at least one/i);
  });

  it('--clear-plan alone satisfies atLeastOne', () => {
    const action = parseOk(['task', 'update', '--project', 'p', '--seq', '1', '--clear-plan']);
    strictEqual(action.opts.clearPlan, true);
  });

  it('atLeastOne rejects a bare task changelog mark', () => {
    match(parseFail(['task', 'changelog', 'mark', '--project', 'p']).message, /at least one/i);
    parseOk(['task', 'changelog', 'mark', '--project', 'p', '--all']);
  });

  it('a default never satisfies atLeastOne', () => {
    // Asserted structurally: no flag in an atLeastOne set may carry a default,
    // because a default is applied unconditionally and would make the rule
    // permanently satisfied.
    for (const [command, spec] of Object.entries(COMMANDS) as any) {
      for (const set of spec.rules?.atLeastOne ?? []) {
        for (const flag of set.flags) {
          ok(
            !('default' in spec.opts[flag]),
            `${command} ${flag} carries a default and cannot gate atLeastOne '${set.name}'`,
          );
        }
      }
    }
  });

  it('requires: --anchor without --plan-id throws, with it parses', () => {
    match(
      parseFail(['task', 'add', '--project', 'p', '--type', 'fix', '--title', 'x', '--anchor', 'step-one'])
        .message,
      /--plan-id/,
    );
    const action = parseOk([
      'task', 'add', '--project', 'p', '--type', 'fix', '--title', 'x',
      '--plan-id', '7', '--anchor', 'step-one',
    ]);
    strictEqual(action.opts.planId, 7);
    strictEqual(action.opts.anchor, 'step-one');
  });

  it('requires: --origin without --content-file throws', () => {
    parseOk(['plan', 'create', '--project', 'p', '--title', 't', '--content-file', '/tmp/x', '--origin', '/tmp/x']);
    match(
      parseFail(['plan', 'create', '--project', 'p', '--title', 't', '--path', '/a', '--origin', '/b']).message,
      /--content-file/,
    );
  });

  it('--plan-id names the P### confusion rather than reporting a bare type error', () => {
    // Two id spaces coexist deliberately; this is the likeliest caller mistake
    // on the whole surface, and "expected integer" sends the reader elsewhere.
    const err = parseFail([
      'task', 'add', '--project', 'p', '--type', 'fix', '--title', 'x', '--plan-id', 'P001',
    ]);
    match(err.message, /--plan-id/);
    match(err.message, /P###/);
    match(err.message, /plan get/);
  });

  it('--seq accepts the display form the helper itself prints', () => {
    // Every output names a row `P002` / `#004`, and `task get` returns
    // plan_seq as the string "P002" — handing that straight back has to work,
    // or the docs are telling the reader to do something that fails.
    strictEqual(parseOk(['plan', 'get', '--project', 'p', '--seq', 'P002']).opts.seq, 2);
    strictEqual(parseOk(['plan', 'get', '--project', 'p', '--seq', 'p2']).opts.seq, 2);
    strictEqual(parseOk(['plan', 'get', '--project', 'p', '--seq', '2']).opts.seq, 2);
    strictEqual(parseOk(['task', 'get', '--project', 'p', '--seq', '#004']).opts.seq, 4);
    strictEqual(parseOk(['task', 'get', '--project', 'p', '--seq', '4']).opts.seq, 4);
  });

  it('--seq rejects a display form from the OTHER id space by name', () => {
    // Accepting either prefix everywhere would launder exactly the confusion
    // the two-space design exists to surface.
    const onPlan = parseFail(['plan', 'get', '--project', 'p', '--seq', '#001']);
    match(onPlan.message, /task space/);
    match(onPlan.message, /P###/);

    const onTask = parseFail(['task', 'get', '--project', 'p', '--seq', 'P001']);
    match(onTask.message, /plan space/);
    match(onTask.message, /#NNN/);
    // The hint must not render the prefix twice ("####").
    ok(!/####/.test(onTask.message), onTask.message);
  });

  it('--plan-id still refuses a display id, since the global id has no display form', () => {
    const err = parseFail([
      'task', 'add', '--project', 'p', '--type', 'fix', '--title', 'x', '--plan-id', 'P1',
    ]);
    match(err.message, /--plan-id/);
  });

  it('requiresValue: each confirmation is legal only against its own status', () => {
    parseOk(['plan', 'update', '--project', 'p', '--seq', '1', '--status', 'cancelled', '--confirm-cancel']);
    parseOk(['plan', 'update', '--project', 'p', '--seq', '1', '--status', 'completed', '--force-complete']);
    match(
      parseFail(['plan', 'update', '--project', 'p', '--seq', '1', '--status', 'completed', '--confirm-cancel'])
        .message,
      /--confirm-cancel/,
    );
    match(
      parseFail(['plan', 'update', '--project', 'p', '--seq', '1', '--status', 'cancelled', '--force-complete'])
        .message,
      /--force-complete/,
    );
  });

  it('requiresValue: a confirmation with no --status at all throws', () => {
    parseFail(['plan', 'update', '--project', 'p', '--seq', '1', '--title', 't', '--confirm-cancel']);
    parseFail(['plan', 'update', '--project', 'p', '--seq', '1', '--title', 't', '--force-complete']);
  });

  it('the confirmation flags do not satisfy the mutation requirement', () => {
    // Asserted twice — behaviorally (a bare confirmation throws) and
    // structurally (the registry's mutation set excludes them) — because the
    // behavioral case alone could be passing for the requiresValue reason.
    parseFail(['plan', 'update', '--project', 'p', '--seq', '1', '--confirm-cancel']);
    const mutations = (COMMANDS as any)['plan update'].rules.atLeastOne[0].flags;
    ok(!mutations.includes('--confirm-cancel'));
    ok(!mutations.includes('--force-complete'));
  });

  it('plan detach parses both confirmations clean — necessity is runtime', () => {
    const action = parseOk([
      'plan', 'detach', '--project', 'p', '--seq', '1', '--delete-file', '--confirm-source-change',
    ]);
    strictEqual(action.opts.deleteFile, true);
    strictEqual(action.opts.confirmSourceChange, true);
  });
});

describe('cli — Group D: enums', () => {
  // Every member of every enum a command actually references must be accepted,
  // and one non-member rejected per enum. Acceptances feed Group C.
  const ENUM_PROBES: Array<{ enumName: string; argv: (v: string) => string[]; bad: string }> = [
    { enumName: 'status', argv: (v) => ['task', 'list', '--project', 'p', '--status', v], bad: 'done' },
    {
      enumName: 'type',
      argv: (v) => ['task', 'add', '--project', 'p', '--title', 'x', '--type', v],
      bad: 'feature',
    },
    {
      enumName: 'priority',
      argv: (v) => ['task', 'add', '--project', 'p', '--title', 'x', '--type', 'fix', '--priority', v],
      bad: 'urgent',
    },
    {
      enumName: 'noteKindWritable',
      argv: (v) => ['plan', 'note', 'add', '--project', 'p', '--seq', '1', '--note', 'n', '--kind', v],
      bad: 'applied',
    },
  ];

  for (const probe of ENUM_PROBES) {
    for (const value of (ENUMS as any)[probe.enumName]) {
      it(`accepts ${probe.enumName} = ${value}`, () => {
        parseOk(probe.argv(value));
        ACCEPTED_ENUM_VALUES.add(`${probe.enumName}:${value}`);
      });
    }
    it(`rejects ${probe.enumName} = ${probe.bad}`, () => {
      match(parseFail(probe.argv(probe.bad)).message, new RegExp(probe.bad));
    });
  }

  it('the lifecycle note kinds are rejected from argv', () => {
    // The write-side half of the audit-trail invariant: `created`, `applied`
    // and `status` are emitted by lifecycle hooks, and accepting them from
    // argv would let a caller forge audit history.
    for (const kind of ENUMS.noteKind.filter((k: string) => !ENUMS.noteKindWritable.includes(k))) {
      parseFail(['plan', 'note', 'add', '--project', 'p', '--seq', '1', '--note', 'n', '--kind', kind]);
    }
    for (const kind of ENUMS.noteKindWritable) {
      parseOk(['plan', 'note', 'add', '--project', 'p', '--seq', '1', '--note', 'n', '--kind', kind]);
    }
  });
});

describe('cli — Group D: remaining surface coverage', () => {
  // Hand-written, not generated. These exist so that Group C's "specified but
  // never exercised" assertion has real fixtures to be satisfied by — a
  // registry-derived generator would make that assertion unfalsifiable.
  const FIXTURES: Array<[string, string[]]> = [
    ['db migrate', ['db', 'migrate']],
    // The parent plan's Verification block never invokes `plan discard`, so
    // Group A cannot reach it. Without this fixture the command would be
    // specified, shipped, and never once parsed by a test.
    ['plan discard', ['plan', 'discard', '--project', 'p', '--seq', '1']],
    [
      'task add with every flag',
      ['task', 'add', '--project', 'p', '--type', 'fix', '--title', 'T', '--priority', 'high',
       '--tag', 'ui', '--req', 'r1', '--dep', '3', '--created', '2026-08-09',
       '--plan-id', '7', '--anchor', 'Step 1', '--commit-sha', 'deadbeef'],
    ],
    [
      'task update with every flag',
      ['task', 'update', '--project', 'p', '--seq', '1', '--status', 'pending', '--priority', 'low',
       '--type', 'todo', '--title', 'T', '--created', '2026-08-09', '--updated', '2026-08-09',
       '--completed-at', '2026-08-09', '--commit-sha', 'deadbeef', '--feedback', 'f',
       '--plan-id', '7', '--anchor', 'Step 2', '--tag', 't', '--req', 'r', '--dep', '2'],
    ],
    ['task update clearing the plan link', ['task', 'update', '--project', 'p', '--seq', '1', '--clear-plan']],
    ['task recent with an explicit limit', ['task', 'recent', '--project', 'p', '--limit', '5']],
    ['task deps check', ['task', 'deps', 'check', '--project', 'p', '--seq', '1']],
    ['task deps blocked', ['task', 'deps', 'blocked', '--project', 'p']],
    ['task deps unblocked', ['task', 'deps', 'unblocked', '--project', 'p', '--seq', '1']],
    ['plan create with tags', ['plan', 'create', '--project', 'p', '--title', 'T', '--path', '/a/b.md', '--tag', 'x']],
    ['plan list filtered', ['plan', 'list', '--project', 'p', '--status', 'pending']],
    ['plan get with content', ['plan', 'get', '--project', 'p', '--seq', '1', '--with-content']],
    ['plan tasks filtered', ['plan', 'tasks', '--project', 'p', '--seq', '1', '--status', 'pending']],
    ['plan status with an explicit limit', ['plan', 'status', '--project', 'p', '--seq', '1', '--limit', '5']],
    ['plan note list with a limit', ['plan', 'note', 'list', '--project', 'p', '--seq', '1', '--limit', '5']],
    [
      'plan note replace with every flag',
      ['plan', 'note', 'replace', '--project', 'p', '--seq', '1', '--id', '2', '--note', 'n',
       '--task', 'testproj#003', '--force'],
    ],
    ['plan update with title and tags', ['plan', 'update', '--project', 'p', '--seq', '1', '--title', 'T', '--tag', 'x']],
  ];

  for (const [label, argv] of FIXTURES) {
    it(`parses ${label}`, () => {
      strictEqual(parseOk(argv).kind, 'run');
    });
  }
});

describe('cli — Group D: purity and exit codes', () => {
  it('parseArgv is deterministic and does not mutate its input', () => {
    const argv = ['task', 'add', '--project', 'p', '--type', 'fix', '--title', 'x', '--tag', 'a', '--tag', 'b'];
    const copy = [...argv];
    const first = parseArgv(argv);
    const second = parseArgv(argv);
    deepStrictEqual(argv, copy);
    deepStrictEqual(first, second);
    notStrictEqual(first.opts.tags, second.opts.tags, 'each call must return fresh arrays');
  });

  it('CliError carries exitCode 1 and never a handler signal', () => {
    ok(THROWN_EXIT_CODES.size > 0, 'no CliError was observed — parseFail is not being exercised');
    deepStrictEqual([...THROWN_EXIT_CODES], [1]);
    for (const reserved of [2, 3, 4]) {
      ok(!THROWN_EXIT_CODES.has(reserved), `exit code ${reserved} belongs to a handler, not the parser`);
    }
  });
});

// ── Group C — coverage assertions ─────────────────────────────
//
// Derived from COMMANDS, so they cannot go stale. Reads only the ledger fed by
// Groups A and D. The canonical round-trip at the bottom builds its argv from
// the registry and deliberately does NOT feed that ledger — otherwise
// "specified but never exercised" would be unfalsifiable.

describe('cli — Group C: coverage', () => {
  it('every command in COMMANDS is exercised by a hand-written or doc-derived fixture', () => {
    const missing = Object.keys(COMMANDS).filter((c) => !EXERCISED_COMMANDS.has(c));
    deepStrictEqual(missing, [], `commands specified but never exercised: ${missing.join(', ')}`);
  });

  it('every option of every command is exercised', () => {
    const missing: string[] = [];
    for (const [command, spec] of Object.entries(COMMANDS) as any) {
      for (const flag of Object.keys(spec.opts)) {
        if (!EXERCISED_FLAGS.has(`${command} ${flag}`)) missing.push(`${command} ${flag}`);
      }
    }
    deepStrictEqual(missing, [], `options specified but never exercised: ${missing.join(', ')}`);
  });

  it('every member of every referenced enum is accepted somewhere', () => {
    const referenced = new Set<string>();
    for (const spec of Object.values(COMMANDS) as any) {
      for (const opt of Object.values(spec.opts) as any) {
        if (opt.type !== 'enum') continue;
        const name = enumNameFor(opt.values);
        ok(name, `an enum option's values array is not one of ENUMS: ${JSON.stringify(opt.values)}`);
        referenced.add(name!);
      }
    }
    const missing: string[] = [];
    for (const name of referenced) {
      for (const value of (ENUMS as any)[name]) {
        if (!ACCEPTED_ENUM_VALUES.has(`${name}:${value}`)) missing.push(`${name}:${value}`);
      }
    }
    deepStrictEqual(missing, [], `enum members never accepted: ${missing.join(', ')}`);
  });

  it('ENUMS.noteKind is the read-side vocabulary and is referenced by no command', () => {
    // Spelled out because the generic rule above ("every member of every
    // referenced enum is accepted") is impossible for noteKind BY DESIGN:
    // `created`, `applied` and `status` are lifecycle-only and must never be
    // writable. Scoping that rule to referenced enums is therefore correct
    // rather than a loophole, and this test pins the reason.
    for (const spec of Object.values(COMMANDS) as any) {
      for (const opt of Object.values(spec.opts) as any) {
        if (opt.type === 'enum') notStrictEqual(enumNameFor(opt.values), 'noteKind');
      }
    }
    for (const k of ENUMS.noteKindWritable) ok(ENUMS.noteKind.includes(k));
    ok(ENUMS.noteKind.length > ENUMS.noteKindWritable.length);
  });

  it('every entry in RENAMES throws naming its replacement', () => {
    for (const [legacy, replacement] of Object.entries(RENAMES) as any) {
      const err = parseFail([legacy]);
      const target = replacement.join(' ');
      ok(err.message.includes(target), `'${legacy}' error must name '${target}', got: ${err.message}`);
      ok(target in COMMANDS, `RENAMES points '${legacy}' at '${target}', which is not a command`);
    }
  });

  it('every declared option type is one the parser knows', () => {
    // The typo catcher: `type: 'ini'` would sail past every hand-written case.
    const KNOWN = ['str', 'int', 'bool', 'enum', 'path', 'abspath', 'ts', 'sha', 'slug', 'taskref'];
    for (const [command, spec] of Object.entries(COMMANDS) as any) {
      for (const [flag, opt] of Object.entries(spec.opts) as any) {
        const raw = String(opt.type);
        const base = raw.endsWith('[]') ? raw.slice(0, -2) : raw;
        ok(KNOWN.includes(base), `${command} ${flag}: unknown type '${raw}'`);
        ok(!(raw.endsWith('[]') && base === 'bool'), `${command} ${flag}: bool is never repeatable`);
        strictEqual(typeof opt.key, 'string');
      }
      strictEqual(typeof spec.handler, 'string');
      strictEqual(typeof spec.project, 'boolean');
    }
  });

  it('every command declares a unique handler', () => {
    const handlers = Object.values(COMMANDS).map((s: any) => s.handler);
    strictEqual(new Set(handlers).size, handlers.length);
  });

  it('every GROUPS leaf resolves to a real command or a nested group', () => {
    for (const [group, leaves] of Object.entries(GROUPS) as any) {
      for (const leaf of leaves) {
        const full = `${group} ${leaf}`;
        ok(full in COMMANDS || full in GROUPS, `GROUPS lists '${full}', which is neither`);
      }
    }
  });

  it('every command is reachable through GROUPS', () => {
    for (const command of Object.keys(COMMANDS)) {
      const parts = command.split(' ');
      const group = parts.slice(0, -1).join(' ');
      ok(group in GROUPS, `'${command}' sits under '${group}', which GROUPS does not declare`);
      ok((GROUPS as any)[group].includes(parts.at(-1)), `GROUPS['${group}'] omits '${parts.at(-1)}'`);
    }
  });

  // Round-trip: a canonical argv built from each command's own spec parses back
  // to the declared keys and JS types. Weakly self-referential by construction,
  // which is why it stays out of the coverage ledger.
  function scalarTypeOk(base: string, v: any): boolean {
    switch (base) {
      case 'int':
        return typeof v === 'number' && Number.isInteger(v);
      case 'bool':
        return typeof v === 'boolean';
      default:
        return typeof v === 'string';
    }
  }

  function canonicalValue(opt: any): string | null {
    const raw = String(opt.type);
    const base = raw.endsWith('[]') ? raw.slice(0, -2) : raw;
    switch (base) {
      case 'bool':
        return null;
      case 'int':
        return '7';
      case 'enum':
        return opt.values[0];
      case 'abspath':
        return '/tmp/canonical.md';
      case 'path':
        return 'canonical.md';
      case 'ts':
        return '2026-08-09 12:00';
      case 'sha':
        return 'deadbeef';
      case 'slug':
        return 'Canonical Heading';
      default:
        return 'x';
    }
  }

  for (const [command, spec] of Object.entries(COMMANDS) as any) {
    it(`round-trips a canonical argv for '${command}'`, () => {
      const argv: string[] = command.split(' ');
      if (spec.project) argv.push('--project', 'p');
      const chosen: string[] = [];
      const push = (flag: string) => {
        if (chosen.includes(flag)) return;
        chosen.push(flag);
        argv.push(flag);
        const v = canonicalValue(spec.opts[flag]);
        if (v !== null) argv.push(v);
      };
      for (const [flag, opt] of Object.entries(spec.opts) as any) if (opt.required) push(flag);
      for (const set of spec.rules?.atLeastOne ?? []) {
        if (set.flags.some((f: string) => chosen.includes(f))) continue;
        push(set.flags[0]);
      }
      for (const rule of spec.rules?.requires ?? []) {
        if (chosen.includes(rule.flag)) push(rule.needs);
      }

      const action = parseArgv(argv); // NOT parseOk — must not feed the ledger
      strictEqual(action.kind, 'run');
      strictEqual(action.command, command);
      strictEqual(action.handler, spec.handler);
      deepStrictEqual(action.route, command.split(' '));

      for (const flag of chosen) {
        const opt = spec.opts[flag];
        ok(opt.key in action.opts, `${command}: ${flag} did not land on key '${opt.key}'`);
        const value = action.opts[opt.key];
        const raw = String(opt.type);
        if (raw.endsWith('[]')) {
          ok(Array.isArray(value), `${command} ${flag}: repeatable must produce an array`);
          ok(
            value.every((v: any) => scalarTypeOk(raw.slice(0, -2), v)),
            `${command} ${flag}: wrong element type for '${raw}'`,
          );
        } else {
          ok(scalarTypeOk(raw, value), `${command} ${flag}: wrong JS type for '${raw}'`);
        }
      }

      for (const [flag, opt] of Object.entries(spec.opts) as any) {
        if (chosen.includes(flag)) continue;
        if ('default' in opt) {
          strictEqual(action.opts[opt.key], opt.default, `${command}: default for ${flag} not applied`);
        } else if (opt.type === 'bool') {
          strictEqual(action.opts[opt.key], false, `${command}: an absent bool ${flag} must be false`);
        } else {
          ok(!(opt.key in action.opts), `${command}: an absent ${flag} must not appear in opts`);
        }
      }
    });
  }
});
