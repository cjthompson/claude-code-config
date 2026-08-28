// Command specification table for `task-db`.
//
// Plain data only. No logic lives here, so the follow-up plan attaches handlers
// without touching the parser, and the parser consumes this table without
// knowing what any command does.
//
// Option value types:
//   str | int | bool | enum | path | abspath | ts | sha | slug | taskref
// A `[]` suffix on any non-bool type marks the flag repeatable; values are
// collected into an array under `key`. `bool` flags take no value and are never
// repeatable.
//
// Per-option shape:
//   { key, type, required?, default?, values? }
// `required` is declared on the option itself rather than in `rules` below,
// because it constrains a single flag rather than a relationship between flags.
//
// Per-command `project` is BOOLEAN BUT NOT OPTIONALITY:
//   true  — `--project` is required; omitting it is an error.
//   false — `--project` is REJECTED; supplying it is an error.
// There is no third state. `false` never means "optional, ignore if present" —
// reading it that way makes `db init --project foo` succeed silently, which is
// the exact class of quiet failure this parsing layer exists to remove.
//
// Per-command `rules` express the relationships:
//   exclusive     — at most one of the listed flags may appear (xor). Pair with
//                   `atLeastOne` over the same set to get exactly-one.
//   requires      — flag is only legal when another flag is present.
//   requiresValue — flag is only legal when another flag is present AND carries
//                   a specific value. The one rule that inspects a value rather
//                   than mere presence.
//   atLeastOne    — a named set, at least one member of which must be present.
//                   Defaults never satisfy it.

export const ENUMS = {
  status: ['pending', 'in_progress', 'completed', 'cancelled'],
  type: ['fix', 'task', 'todo'],
  priority: ['high', 'medium', 'low'],
  noteKind: ['created', 'tasks-created', 'applied', 'reconciled', 'status', 'manual'],
  // Kinds a caller may WRITE. `created`, `applied`, and `status` are emitted only by
  // the helper's own lifecycle hooks; accepting them from argv would let a caller forge
  // audit history, which is exactly what the --force guard on delete/replace prevents at
  // the other end. Guarding one side of an invariant and not the other is worse than
  // guarding neither, because it reads as protected.
  noteKindWritable: ['manual', 'tasks-created', 'reconciled'],
};

// Global options. `--project` is required on every `task *` and `plan *` command
// (see each command's `project` field) and rejected on `db *`. On `plan *` it scopes
// the P### sequence lookup — it identifies whose plan, and never filters a plan's
// child tasks, which may span repositories. Both land in `action.global`, not `opts`.
export const GLOBALS = {
  '--project': { key: 'project', type: 'str' },
  '--output-file': { key: 'outputFile', type: 'path' },
};

// `--help` / `-h` short-circuits to { kind:'help' } at any depth.
export const HELP_FLAGS = ['--help', '-h'];

export const COMMANDS = {
  'db init': {
    handler: 'dbInit',
    project: false,
    opts: {},
  },

  'db migrate': {
    handler: 'dbMigrate',
    project: false,
    opts: {},
  },

  'task add': {
    handler: 'taskAdd',
    project: true,
    opts: {
      '--type': { key: 'type', type: 'enum', values: ENUMS.type, required: true },
      '--title': { key: 'title', type: 'str', required: true },
      '--priority': { key: 'priority', type: 'enum', values: ENUMS.priority, default: 'medium' },
      '--tag': { key: 'tags', type: 'str[]' },
      '--req': { key: 'reqs', type: 'str[]' },
      '--dep': { key: 'deps', type: 'int[]' },
      '--created': { key: 'created', type: 'ts' },
      // Global numeric id from `plan get`, NOT the P### display sequence.
      '--plan-id': { key: 'planId', type: 'int' },
      '--anchor': { key: 'anchor', type: 'slug' },
      '--commit-sha': { key: 'commitSha', type: 'sha' },
    },
    rules: {
      requires: [{ flag: '--anchor', needs: '--plan-id' }],
    },
  },

  'task update': {
    handler: 'taskUpdate',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--status': { key: 'status', type: 'enum', values: ENUMS.status },
      '--priority': { key: 'priority', type: 'enum', values: ENUMS.priority },
      '--type': { key: 'type', type: 'enum', values: ENUMS.type },
      '--title': { key: 'title', type: 'str' },
      '--created': { key: 'created', type: 'ts' },
      '--updated': { key: 'updated', type: 'ts' },
      '--completed-at': { key: 'completedAt', type: 'ts' },
      '--commit-sha': { key: 'commitSha', type: 'sha' },
      '--feedback': { key: 'feedback', type: 'str' },
      // Global numeric id from `plan get`, NOT the P### display sequence.
      '--plan-id': { key: 'planId', type: 'int' },
      '--anchor': { key: 'anchor', type: 'slug' },
      // Nulls plan_id AND plan_anchor together; unlinks the task without deleting
      // it or its history. Mutually exclusive with --plan-id/--anchor.
      '--clear-plan': { key: 'clearPlan', type: 'bool' },
      '--tag': { key: 'tags', type: 'str[]' },
      '--req': { key: 'reqs', type: 'str[]' },
      '--dep': { key: 'deps', type: 'int[]' },
    },
    rules: {
      requires: [{ flag: '--anchor', needs: '--plan-id' }],
      exclusive: [
        ['--clear-plan', '--plan-id'],
        ['--clear-plan', '--anchor'],
      ],
      // A bare --seq errors rather than writing a no-op timestamp.
      atLeastOne: [
        {
          name: 'mutation',
          flags: [
            '--status',
            '--priority',
            '--type',
            '--title',
            '--created',
            '--updated',
            '--completed-at',
            '--commit-sha',
            '--feedback',
            '--plan-id',
            '--anchor',
            '--tag',
            '--req',
            '--dep',
            '--clear-plan',
          ],
        },
      ],
    },
  },

  'task get': {
    handler: 'taskGet',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
    },
  },

  'task list': {
    handler: 'taskList',
    project: true,
    opts: {
      '--status': { key: 'status', type: 'enum', values: ENUMS.status },
    },
  },

  'task recent': {
    handler: 'taskRecent',
    project: true,
    opts: {
      '--limit': { key: 'limit', type: 'int', default: 20 },
    },
  },

  'task deps check': {
    handler: 'taskDepsCheck',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
    },
  },

  'task deps validate': {
    handler: 'taskDepsValidate',
    project: true,
    opts: {
      '--dep': { key: 'deps', type: 'int[]', required: true },
    },
  },

  'task deps blocked': {
    handler: 'taskDepsBlocked',
    project: true,
    opts: {},
  },

  'task deps unblocked': {
    handler: 'taskDepsUnblocked',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
    },
  },

  'task changelog list': {
    handler: 'taskChangelogList',
    project: true,
    opts: {
      '--new-only': { key: 'newOnly', type: 'bool' },
    },
  },

  'task changelog mark': {
    handler: 'taskChangelogMark',
    project: true,
    opts: {
      '--all': { key: 'all', type: 'bool' },
      '--seq': { key: 'seqs', type: 'int[]' },
    },
    rules: {
      exclusive: [['--all', '--seq']],
      atLeastOne: [{ name: 'target', flags: ['--all', '--seq'] }],
    },
  },

  'plan create': {
    handler: 'planCreate',
    project: true,
    opts: {
      '--title': { key: 'title', type: 'str', required: true },
      '--path': { key: 'path', type: 'abspath' },
      '--content-file': { key: 'contentFile', type: 'path' },
      '--origin': { key: 'origin', type: 'abspath' },
      '--tag': { key: 'tags', type: 'str[]' },
    },
    rules: {
      // Both optional — an empty inline plan is valid; its body arrives via a
      // later `plan propose --content-file`.
      exclusive: [['--path', '--content-file']],
      // `origin_path` records where an *imported* plan came from, so it is
      // meaningless alongside `--path` (the file is still there, in `path`).
      requires: [{ flag: '--origin', needs: '--content-file' }],
    },
  },

  'plan list': {
    handler: 'planList',
    project: true,
    opts: {
      '--status': { key: 'status', type: 'enum', values: ENUMS.status },
    },
  },

  'plan get': {
    handler: 'planGet',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--with-content': { key: 'withContent', type: 'bool' },
      '--content-only': { key: 'contentOnly', type: 'bool' },
    },
    rules: {
      exclusive: [['--with-content', '--content-only']],
    },
  },

  'plan tasks': {
    handler: 'planTasks',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--status': { key: 'status', type: 'enum', values: ENUMS.status },
    },
  },

  'plan status': {
    handler: 'planStatus',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--limit': { key: 'limit', type: 'int', default: 10 },
    },
  },

  'plan progress': {
    handler: 'planProgress',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--counts': { key: 'counts', type: 'bool' },
    },
  },

  'plan propose': {
    handler: 'planPropose',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--content-file': { key: 'contentFile', type: 'path' },
    },
  },

  'plan attach': {
    handler: 'planAttach',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--path': { key: 'path', type: 'abspath', required: true },
    },
  },

  'plan detach': {
    handler: 'planDetach',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--delete-file': { key: 'deleteFile', type: 'bool' },
      // No parse-level precondition. Whether it is *required* depends on
      // comparing the live file against the applied hash, which is runtime.
      '--confirm-source-change': { key: 'confirmSourceChange', type: 'bool' },
    },
  },

  'plan apply': {
    handler: 'planApply',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
    },
  },

  'plan discard': {
    handler: 'planDiscard',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
    },
  },

  'plan update': {
    handler: 'planUpdate',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--title': { key: 'title', type: 'str' },
      '--status': { key: 'status', type: 'enum', values: ENUMS.status },
      '--tag': { key: 'tags', type: 'str[]' },
      '--confirm-cancel': { key: 'confirmCancel', type: 'bool' },
      '--force-complete': { key: 'forceComplete', type: 'bool' },
    },
    rules: {
      // A confirmation attached to the wrong status is a caller bug worth
      // catching at the boundary, not a no-op to ignore.
      requiresValue: [
        { flag: '--confirm-cancel', needs: '--status', value: 'cancelled' },
        { flag: '--force-complete', needs: '--status', value: 'completed' },
      ],
      // The confirmation flags do NOT count as mutations: `plan update --seq 1
      // --confirm-cancel` with no --status still fails atLeastOne. They are
      // modifiers on a mutation, not one themselves, and treating them as
      // satisfying the rule would let a bare confirmation through as a no-op write.
      atLeastOne: [{ name: 'mutation', flags: ['--title', '--status', '--tag'] }],
    },
  },

  'plan note add': {
    handler: 'planNoteAdd',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--note': { key: 'note', type: 'str', required: true },
      '--kind': { key: 'kind', type: 'enum', values: ENUMS.noteKindWritable, default: 'manual' },
      '--task': { key: 'tasks', type: 'taskref[]' },
    },
  },

  'plan note list': {
    handler: 'planNoteList',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--limit': { key: 'limit', type: 'int' },
    },
  },

  'plan note replace': {
    handler: 'planNoteReplace',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--id': { key: 'id', type: 'int', required: true },
      '--note': { key: 'note', type: 'str', required: true },
      '--task': { key: 'tasks', type: 'taskref[]' },
      '--force': { key: 'force', type: 'bool' },
    },
  },

  'plan note delete': {
    handler: 'planNoteDelete',
    project: true,
    opts: {
      '--seq': { key: 'seq', type: 'int', required: true },
      '--id': { key: 'id', type: 'int', required: true },
      '--force': { key: 'force', type: 'bool' },
    },
  },
};

// Namespace nodes and their children, for "unknown subcommand of a known group"
// errors and their nearest-match hints. A group reached with no leaf
// (`task deps`, `plan note`) returns help for that level rather than erroring.
export const GROUPS = {
  db: ['init', 'migrate'],
  task: ['add', 'update', 'get', 'list', 'recent', 'deps', 'changelog'],
  'task deps': ['check', 'validate', 'blocked', 'unblocked'],
  'task changelog': ['list', 'mark'],
  plan: [
    'create',
    'list',
    'get',
    'tasks',
    'status',
    'progress',
    'propose',
    'attach',
    'detach',
    'apply',
    'discard',
    'update',
    'note',
  ],
  'plan note': ['add', 'list', 'replace', 'delete'],
};

// Hard cutover — no aliases. Every legacy flat name errors naming its replacement.
export const RENAMES = {
  insert: ['task', 'add'],
  update: ['task', 'update'],
  get: ['task', 'get'],
  list: ['task', 'list'],
  recent: ['task', 'recent'],
  'check-deps': ['task', 'deps', 'check'],
  'validate-deps': ['task', 'deps', 'validate'],
  blocked: ['task', 'deps', 'blocked'],
  unblocked: ['task', 'deps', 'unblocked'],
  changelog: ['task', 'changelog', 'list'],
  'mark-changelog': ['task', 'changelog', 'mark'],
  init: ['db', 'init'],
  migrate: ['db', 'migrate'],
};
