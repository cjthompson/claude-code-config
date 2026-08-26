/**
 * cli — argument parsing for `task-db`.
 *
 * `parseArgv` is PURE: it takes `process.argv.slice(2)`, returns a validated
 * `Action`, or throws `CliError`. It never calls `process.exit` and never
 * writes to a stream, so the whole command surface is unit-testable without
 * sqlite3, a temp DB, or a subprocess.
 *
 * The division of labour is fixed and worth stating once, because every
 * "should this be validated here?" question reduces to it:
 *
 *     the parser validates flag SHAPE; the handler validates against STATE.
 *
 * A confirmation flag's *legality* (does `--confirm-cancel` match the status it
 * modifies?) is shape and lives here. Its *necessity* (is there anything to
 * confirm?) is state and does not. Likewise FK violations, source-type guards,
 * and live-file hash comparisons all parse clean here and fail in a handler.
 *
 * The command table lives in registry.mjs as plain data, so handlers can be
 * attached later without touching this file.
 */

import { isAbsolute } from 'node:path';
import { COMMANDS, GROUPS, RENAMES, GLOBALS, HELP_FLAGS } from './registry.mjs';
import { normalizeProject, slugify } from './normalize.mjs';

/**
 * @typedef {{ kind:'run', command:string, route:string[], handler:string,
 *             opts:Object, global:{ project:string|null, outputFile:string|null } }} RunAction
 * @typedef {{ kind:'help', command:string|null, usage:string }} HelpAction
 * @typedef {{ project:string, seq:number }} TaskRef
 * @typedef {RunAction|HelpAction} Action
 */

/**
 * A user-facing argument error.
 *
 * `exitCode` travels WITH the error rather than being decided by the caller, so
 * it is assertable in unit tests today and the dispatch wiring has nothing to
 * invent later. It is always 1, matching the current `default` branch of
 * `bin/task-db`. Codes 2 (`db init` first run) and 3/4 (`plan propose`) are
 * runtime outcomes owned by handlers; the parser must never squat on them.
 */
export class CliError extends Error {
    /**
     * @param {string} message
     * @param {{ exitCode?: number }} [options]
     */
    constructor(message, options = {}) {
        super(message);
        this.name = 'CliError';
        this.exitCode = options.exitCode ?? 1;
    }
}

const MAX_ROUTE_DEPTH = 3;

const TS_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const INT_RE = /^\d+$/;
const TASK_REF_RE = /^([^#]+)#(0*[1-9]\d*)$/;

// ── nearest-match hinting ─────────────────────────────────────

/**
 * Levenshtein distance, bounded only by the inputs (both are short).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        prev = row;
    }
    return prev[b.length];
}

/**
 * Nearest candidate within distance 2, or null.
 *
 * @param {string} input
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function suggest(input, candidates) {
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        const d = levenshtein(input, candidate);
        if (d < bestDistance) {
            bestDistance = d;
            best = candidate;
        }
    }
    return bestDistance <= 2 ? best : null;
}

/**
 * @param {string} message
 * @param {string|null} hint
 * @returns {never}
 */
function fail(message, hint = null) {
    throw new CliError(hint ? `${message}\n       ${hint}` : message);
}

// ── usage text ────────────────────────────────────────────────

/**
 * Usage text for a level: the whole surface, one group, or one command.
 *
 * @param {string|null} command
 * @returns {string}
 */
function usageFor(command) {
    const lines = [];
    if (command && command in COMMANDS) {
        const spec = COMMANDS[command];
        lines.push(`Usage: task-db ${command}${spec.project ? ' --project <project>' : ''} [options]`);
        const flags = Object.entries(spec.opts);
        if (flags.length) {
            lines.push('', 'Options:');
            for (const [flag, opt] of flags) {
                const parts = [];
                if (opt.required) parts.push('required');
                if (String(opt.type).endsWith('[]')) parts.push('repeatable');
                if ('default' in opt) parts.push(`default ${opt.default}`);
                if (opt.values) parts.push(opt.values.join('|'));
                const note = parts.length ? `  (${parts.join(', ')})` : '';
                lines.push(`  ${flag} <${opt.type}>${note}`);
            }
        }
    } else if (command && command in GROUPS) {
        lines.push(`Usage: task-db ${command} <subcommand> [options]`);
        lines.push('', 'Subcommands:');
        for (const leaf of GROUPS[command]) lines.push(`  ${command} ${leaf}`);
    } else {
        lines.push('Usage: task-db <group> <command> [options]', '', 'Commands:');
        for (const name of Object.keys(COMMANDS)) lines.push(`  ${name}`);
    }
    lines.push('', 'Global options:');
    for (const [flag, opt] of Object.entries(GLOBALS)) lines.push(`  ${flag} <${opt.type}>`);
    lines.push('  --help, -h');
    return lines.join('\n');
}

// ── routing ───────────────────────────────────────────────────

/**
 * Resolve the leading run of non-dash tokens to a command, a group, or an error.
 *
 * @param {string[]} words
 * @returns {{ kind:'run', command:string, depth:number }|{ kind:'help', command:string|null }}
 */
function resolveRoute(words) {
    if (words.length === 0) return { kind: 'help', command: null };

    // Longest-first, so `task deps check` wins over a hypothetical `task deps`.
    for (let depth = Math.min(MAX_ROUTE_DEPTH, words.length); depth >= 1; depth--) {
        const candidate = words.slice(0, depth).join(' ');
        if (candidate in COMMANDS) return { kind: 'run', command: candidate, depth };
    }

    // The cutover check runs BEFORE the unknown-command path, so a caller still
    // on a legacy name gets told what replaced it rather than a spelling hint.
    if (words[0] in RENAMES) {
        const replacement = RENAMES[words[0]].join(' ');
        fail(`ERROR: '${words[0]}' was renamed. Use '${replacement}'.`);
    }

    // A group reached with no leaf is help for that level, not an error.
    for (let depth = Math.min(MAX_ROUTE_DEPTH, words.length); depth >= 1; depth--) {
        const candidate = words.slice(0, depth).join(' ');
        if (candidate in GROUPS && depth === words.length) return { kind: 'help', command: candidate };
    }

    // Unknown. Hint over all command names, and additionally spell out the
    // matched group's leaves — with no aliases, a caller who mistypes a
    // subcommand has no way to discover the right one from the failure alone.
    const attempted = words.slice(0, Math.min(MAX_ROUTE_DEPTH, words.length)).join(' ');
    let group = null;
    for (let depth = Math.min(MAX_ROUTE_DEPTH - 1, words.length - 1); depth >= 1; depth--) {
        const candidate = words.slice(0, depth).join(' ');
        if (candidate in GROUPS) {
            group = candidate;
            break;
        }
    }

    const candidates = Object.keys(COMMANDS);
    if (group) for (const leaf of GROUPS[group]) candidates.push(`${group} ${leaf}`);

    const hintParts = [];
    const near = suggest(attempted, candidates);
    if (near) hintParts.push(`Did you mean '${near}'?`);
    if (group) {
        hintParts.push(
            `Available under '${group}': ${GROUPS[group].map((l) => `${group} ${l}`).join(', ')}.`,
        );
    }
    fail(`ERROR: unknown command '${attempted}'.`, hintParts.join('\n       ') || null);
}

// ── value coercion ────────────────────────────────────────────

/**
 * Coerce and validate one option value against its declared type.
 *
 * @param {string} flag
 * @param {string} value
 * @param {{ type:string, values?:string[] }} opt
 * @param {string} command
 * @returns {string|number|boolean|{project:string,seq:number}}
 */
function coerce(flag, value, opt, command) {
    const raw = String(opt.type);
    const type = raw.endsWith('[]') ? raw.slice(0, -2) : raw;

    switch (type) {
        case 'str':
        case 'path':
            return value;

        case 'taskref': {
            const match = TASK_REF_RE.exec(value);
            if (!match) {
                fail(
                    `ERROR: '${flag}' expects <project>#<positive-seq>, got '${value}'.`,
                    "Use a project-qualified task reference such as 'github.com/acme/backend#001'.",
                );
            }
            const project = normalizeProject(match[1]);
            if (project === '') {
                fail(`ERROR: '${flag}' project segment normalizes to nothing in '${value}'.`);
            }
            return { project, seq: Number(match[2]) };
        }

        case 'int': {
            if (INT_RE.test(value)) return Number(value);

            // `--seq` accepts the display form the helper itself prints.
            //
            // Every output names a row as `P002` or `#004`, and `task get`
            // returns `plan_seq` as the string "P002" — so the natural move,
            // for a person and for a small model alike, is to hand that value
            // straight back. Rejecting it taught nothing: the reader saw
            // "expects an integer" and had to work out that the P is
            // decorative. Accepting it makes the round trip honest.
            //
            // The prefix must match the command's own space. A `#NNN` on a
            // plan command, or a `P###` on a task command, is the two-ID-space
            // confusion this surface is most prone to, and it gets a message
            // naming the mix-up rather than a bare type error. Note that
            // `--plan-id` is deliberately NOT included: it takes the global id,
            // which has no display form, so any prefixed value there is a
            // genuine mistake and keeps its own targeted error below.
            if (flag === '--seq') {
                const isPlanCommand = command.startsWith('plan');
                const wanted = isPlanCommand ? 'P' : '#';
                const other = isPlanCommand ? '#' : 'P';
                const wantedForm = isPlanCommand ? 'P###' : '#NNN';
                const match = /^([P#p])0*(\d+)$/.exec(value);
                if (match) {
                    const prefix = match[1].toUpperCase() === 'P' ? 'P' : '#';
                    if (prefix === wanted) return Number(match[2]);
                    fail(
                        `ERROR: '${flag}' on '${command}' expects ${
                            isPlanCommand ? 'a plan' : 'a task'
                        } sequence, got '${value}'.`,
                        `'${other}' ids belong to the ${
                            isPlanCommand ? 'task' : 'plan'
                        } space. Pass ${wantedForm} (or its bare number) for '${command}'.`,
                    );
                }
            }

            // The two id spaces coexisting is the single likeliest caller
            // mistake on the whole surface, so --plan-id gets a message that
            // names it rather than a bare type error that sends the reader
            // looking in the wrong place.
            if (flag === '--plan-id') {
                fail(
                    `ERROR: '--plan-id' expects an integer, got '${value}'.`,
                    "'--plan-id' takes the global numeric id from 'plan get', not the P### display id.",
                );
            }
            fail(`ERROR: '${flag}' expects an integer, got '${value}'.`);
            break;
        }

        case 'enum': {
            if (opt.values.includes(value)) return value;
            fail(
                `ERROR: invalid value '${value}' for '${flag}' on '${command}'.`,
                `Expected one of: ${opt.values.join(', ')}.`,
            );
            break;
        }

        case 'abspath': {
            if (isAbsolute(value)) return value;
            fail(`ERROR: '${flag}' requires an absolute path, got '${value}'.`);
            break;
        }

        case 'ts': {
            if (TS_RE.test(value)) return value;
            fail(
                `ERROR: '${flag}' expects a timestamp, got '${value}'.`,
                'Expected YYYY-MM-DD, YYYY-MM-DD HH:MM, or YYYY-MM-DD HH:MM:SS.',
            );
            break;
        }

        case 'sha': {
            if (SHA_RE.test(value)) return value;
            fail(`ERROR: '${flag}' expects 7-40 hexadecimal characters, got '${value}'.`);
            break;
        }

        case 'slug': {
            const slug = slugify(value);
            // An empty anchor is the one value that breaks the plan/task join
            // silently rather than loudly: plan_anchor = '' is non-NULL, so the
            // partial unique index treats every empty anchor as the same key,
            // and `task add`'s ON CONFLICT DO NOTHING then select-by-anchor
            // would return an unrelated task's id while reporting success.
            if (slug === '') {
                fail(
                    `ERROR: '${flag}' value '${value}' contains no letters or digits, so it has no anchor.`,
                    'Anchors are ASCII [a-z0-9-]; rename the heading to include at least one letter or digit.',
                );
            }
            return slug;
        }

        default:
            fail(`ERROR: internal: unknown option type '${opt.type}' for '${flag}'.`);
    }
    /* c8 ignore next */
    throw new CliError('unreachable');
}

// ── the parser ────────────────────────────────────────────────

/**
 * Parse `process.argv.slice(2)` into a validated Action.
 *
 * @param {string[]} argv
 * @returns {Action}
 * @throws {CliError}
 */
export function parseArgv(argv) {
    const tokens = [...argv]; // never mutate the caller's array

    // The leading run of non-dash tokens is the route. Everything after it is
    // flags, and a bare token appearing there is an error rather than a late
    // route word (see the `unexpected argument` guard below).
    const words = [];
    while (words.length < tokens.length && !tokens[words.length].startsWith('-')) {
        words.push(tokens[words.length]);
    }

    // --help short-circuits at ANY depth, before route validation, so
    // `task-db plan aply --help` explains the surface instead of nitpicking.
    if (tokens.some((t) => HELP_FLAGS.includes(t))) {
        let command = null;
        for (let depth = Math.min(MAX_ROUTE_DEPTH, words.length); depth >= 1; depth--) {
            const candidate = words.slice(0, depth).join(' ');
            if (candidate in COMMANDS || candidate in GROUPS) {
                command = candidate;
                break;
            }
        }
        return { kind: 'help', command, usage: usageFor(command) };
    }

    const route = resolveRoute(words);
    if (route.kind === 'help') {
        return { kind: 'help', command: route.command, usage: usageFor(route.command) };
    }

    const { command, depth } = route;
    const spec = COMMANDS[command];

    if (words.length > depth) {
        fail(`ERROR: unexpected argument '${words[depth]}' for '${command}'.`);
    }

    const known = { ...spec.opts, ...GLOBALS };
    /** @type {Record<string, string|number|boolean|TaskRef|Array<string|number|TaskRef>>} */
    const opts = {};
    const seen = new Set();
    /** @type {Record<string, string>} */
    const rawValues = {};
    let project = null;
    let outputFile = null;

    /** Is this token a flag this command would recognize? */
    const isKnownFlag = (token) =>
        token.startsWith('-') && (known[token.split('=')[0]] !== undefined || HELP_FLAGS.includes(token));

    for (let i = depth; i < tokens.length; i++) {
        const token = tokens[i];

        // The route rule only governs the LEADING run of non-dash tokens, so a
        // bare token appearing once flag parsing has begun needs its own guard.
        if (!token.startsWith('-')) {
            fail(`ERROR: unexpected argument '${token}' for '${command}'.`);
        }

        const eq = token.indexOf('=');
        const flag = eq === -1 ? token : token.slice(0, eq);
        const inlineValue = eq === -1 ? null : token.slice(eq + 1);
        const opt = known[flag];

        if (!opt) {
            const hint = suggest(flag, Object.keys(known));
            fail(
                `ERROR: unknown option '${flag}' for '${command}'.`,
                hint ? `Did you mean '${hint}'?` : null,
            );
        }

        const isGlobal = GLOBALS[flag] !== undefined && spec.opts[flag] === undefined;

        // `project: false` means REJECTED, not optional. Reading it as
        // "ignore if present" is what makes `db init --project foo` succeed
        // silently — the exact class of quiet failure this layer removes.
        if (flag === '--project' && !spec.project) {
            fail(`ERROR: '--project' is not accepted by '${command}'.`);
        }

        const repeatable = String(opt.type).endsWith('[]');
        if (seen.has(flag) && !repeatable) {
            fail(`ERROR: '${flag}' was repeated, but it accepts only one value on '${command}'.`);
        }
        seen.add(flag);

        if (opt.type === 'bool') {
            if (inlineValue !== null) {
                fail(`ERROR: '${flag}' is a switch on '${command}' and takes no value.`);
            }
            opts[opt.key] = true;
            continue;
        }

        let value;
        if (inlineValue !== null) {
            value = inlineValue;
        } else if (i + 1 >= tokens.length) {
            // Kept distinct from the next-token-is-a-flag case below. End-of-argv
            // is the more common of the two typos and the one the old
            // `get(flag)` silently returned undefined for.
            fail(`ERROR: missing value for '${flag}' on '${command}': reached the end of the arguments.`);
        } else if (isKnownFlag(tokens[i + 1])) {
            fail(
                `ERROR: missing value for '${flag}' on '${command}': the next token is the option '${tokens[i + 1]}'.`,
                `Use '${flag}=<value>' if the value really does start with a dash.`,
            );
        } else {
            value = tokens[i + 1];
            i++;
        }

        if (flag === '--project') {
            const normalized = normalizeProject(value);
            if (normalized === '') fail(`ERROR: '--project' value '${value}' normalizes to nothing.`);
            project = normalized;
            continue;
        }
        if (isGlobal) {
            outputFile = coerce(flag, value, opt, command);
            continue;
        }

        rawValues[flag] = value;
        const coerced = coerce(flag, value, opt, command);
        if (repeatable) {
            if (!Array.isArray(opts[opt.key])) opts[opt.key] = [];
            opts[opt.key].push(coerced);
        } else {
            opts[opt.key] = coerced;
        }
    }

    if (spec.project && project === null) {
        fail(`ERROR: '--project' is required for '${command}'.`);
    }

    for (const [flag, opt] of Object.entries(spec.opts)) {
        if (opt.required && !seen.has(flag)) {
            fail(`ERROR: '${flag}' is required for '${command}'.`);
        }
    }

    applyRules(command, spec, seen, rawValues);

    // Bools default to false and declared defaults are applied LAST, so neither
    // can satisfy a cross-flag rule that a caller did not actually satisfy.
    for (const [flag, opt] of Object.entries(spec.opts)) {
        if (seen.has(flag)) continue;
        if (opt.type === 'bool') opts[opt.key] = false;
        else if ('default' in opt) opts[opt.key] = opt.default;
    }

    return {
        kind: 'run',
        command,
        route: command.split(' '),
        handler: spec.handler,
        opts,
        global: { project, outputFile },
    };
}

/**
 * Cross-flag rules, evaluated against PRESENCE (and, for requiresValue, the
 * raw value) — never against defaults.
 *
 * Order matters only where two rules can both fire. `requiresValue` runs before
 * `atLeastOne` so that `plan update --seq 1 --confirm-cancel` reports the
 * actionable cause ("--confirm-cancel requires --status cancelled") rather than
 * the more generic mutation complaint. Both diagnoses are true; this one tells
 * the caller what to type next.
 *
 * @param {string} command
 * @param {any} spec
 * @param {Set<string>} seen
 * @param {Record<string,string>} rawValues
 */
function applyRules(command, spec, seen, rawValues) {
    const rules = spec.rules;
    if (!rules) return;

    for (const set of rules.exclusive ?? []) {
        const present = set.filter((flag) => seen.has(flag));
        if (present.length > 1) {
            fail(
                `ERROR: ${present.map((f) => `'${f}'`).join(' and ')} are mutually exclusive on '${command}'.`,
                `Pass only one of: ${set.join(', ')}.`,
            );
        }
    }

    for (const rule of rules.requires ?? []) {
        if (seen.has(rule.flag) && !seen.has(rule.needs)) {
            fail(`ERROR: '${rule.flag}' requires '${rule.needs}' on '${command}'.`);
        }
    }

    for (const rule of rules.requiresValue ?? []) {
        if (!seen.has(rule.flag)) continue;
        if (!seen.has(rule.needs)) {
            fail(`ERROR: '${rule.flag}' requires '${rule.needs} ${rule.value}' on '${command}'.`);
        }
        if (rawValues[rule.needs] !== rule.value) {
            fail(
                `ERROR: '${rule.flag}' is only valid with '${rule.needs} ${rule.value}' on '${command}', ` +
                    `but '${rule.needs}' is '${rawValues[rule.needs]}'.`,
            );
        }
    }

    for (const set of rules.atLeastOne ?? []) {
        if (set.flags.some((flag) => seen.has(flag))) continue;
        fail(
            `ERROR: '${command}' requires at least one ${set.name} option.`,
            `Pass one of: ${set.flags.join(', ')}.`,
        );
    }
}
