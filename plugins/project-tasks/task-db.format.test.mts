/*  Run the tests:
 *    node --experimental-strip-types --test plugins/project-tasks/task-db.format.test.mts
 *
 *  Unit tests for the result model and formatters (lib/format.mjs): exact-output
 *  assertions for records, text, and result construction; format functions for
 *  json, pipe, and md; value rendering; and pipe escaping round-trip tests.
 */
import { describe, it } from 'node:test';
import { strictEqual, throws, ok, deepStrictEqual } from 'node:assert/strict';
import {
    records,
    text,
    result,
    isResult,
    statusPart,
    withWarnings,
    FORMATS,
    format,
} from './lib/format.mjs';

describe('format constructors', () => {
    it('records() creates a records part', () => {
        const part = records('test', ['a', 'b'], [{ a: 1, b: 2 }]);
        strictEqual(part.kind, 'records');
        strictEqual(part.name, 'test');
        deepStrictEqual(part.columns, ['a', 'b']);
        deepStrictEqual(part.rows, [{ a: 1, b: 2 }]);
    });

    it('text() creates a text part', () => {
        const part = text('note', 'hello');
        strictEqual(part.kind, 'text');
        strictEqual(part.name, 'note');
        strictEqual(part.text, 'hello');
    });

    it('text() stringifies non-string values', () => {
        strictEqual(text('x', 42).text, '42');
        strictEqual(text('x', null).text, '');
        strictEqual(text('x', undefined).text, '');
    });

    it('result() creates a result', () => {
        const r = result(
            records('a', ['x'], []),
            text('b', 'y')
        );
        strictEqual(r.kind, 'result');
        strictEqual(r.parts.length, 2);
        strictEqual(r.parts[0].name, 'a');
        strictEqual(r.parts[1].name, 'b');
    });

    it('result() with no args creates an empty result', () => {
        const r = result();
        strictEqual(r.kind, 'result');
        strictEqual(r.parts.length, 0);
    });

    it('isResult() detects result objects', () => {
        ok(isResult(result()));
        ok(!isResult({}));
        ok(!isResult(null));
        ok(!isResult(undefined));
    });

    it('statusPart() creates a status record', () => {
        const part = statusPart('success', 'done');
        strictEqual(part.name, 'status');
        deepStrictEqual(part.columns, ['status', 'message']);
        strictEqual(part.rows[0].status, 'success');
        strictEqual(part.rows[0].message, 'done');
    });

    it('withWarnings() appends warnings when non-empty', () => {
        const r = result(records('task', ['id'], [{ id: 1 }]));
        withWarnings(r, ['warning 1', 'warning 2']);
        strictEqual(r.parts.length, 2);
        strictEqual(r.parts[1].name, 'warnings');
        strictEqual(r.parts[1].rows.length, 2);
    });

    it('withWarnings() does nothing when messages are empty', () => {
        const r = result(records('task', ['id'], [{ id: 1 }]));
        withWarnings(r, []);
        strictEqual(r.parts.length, 1);
    });

    it('FORMATS contains expected values', () => {
        deepStrictEqual(FORMATS, ['md', 'json', 'pipe']);
    });
});

describe('format: json', () => {
    it('formats single record part as compact JSON object', () => {
        const r = result(records('task', ['id', 'title'], [
            { id: 1, title: 'foo' },
            { id: 2, title: 'bar' },
        ]));
        const out = format(r, 'json');
        const obj = JSON.parse(out);
        deepStrictEqual(obj.task, [
            { id: 1, title: 'foo' },
            { id: 2, title: 'bar' },
        ]);
    });

    it('renders only declared columns', () => {
        const r = result(records('task', ['id'], [
            { id: 1, title: 'foo', extra: 'ignored' },
        ]));
        const out = format(r, 'json');
        const obj = JSON.parse(out);
        ok(!('title' in obj.task[0]));
        ok(!('extra' in obj.task[0]));
    });

    it('renders null/undefined as null', () => {
        const r = result(records('task', ['a', 'b', 'c'], [
            { a: null, b: undefined, c: 'ok' },
        ]));
        const out = format(r, 'json');
        const obj = JSON.parse(out);
        strictEqual(obj.task[0].a, null);
        strictEqual(obj.task[0].b, null);
        strictEqual(obj.task[0].c, 'ok');
    });

    it('preserves arrays and objects in JSON', () => {
        const r = result(records('task', ['tags', 'meta'], [
            { tags: ['a', 'b'], meta: { x: 1 } },
        ]));
        const out = format(r, 'json');
        const obj = JSON.parse(out);
        deepStrictEqual(obj.task[0].tags, ['a', 'b']);
        deepStrictEqual(obj.task[0].meta, { x: 1 });
    });

    it('formats text part as string value', () => {
        const r = result(text('body', 'some markdown'));
        const out = format(r, 'json');
        const obj = JSON.parse(out);
        strictEqual(obj.body, 'some markdown');
    });

    it('formats multi-part result with all parts as object keys', () => {
        const r = result(
            records('items', ['id'], [{ id: 1 }]),
            text('note', 'hello')
        );
        const out = format(r, 'json');
        const obj = JSON.parse(out);
        ok('items' in obj);
        ok('note' in obj);
    });

    it('formats empty result as empty object', () => {
        const r = result();
        const out = format(r, 'json');
        strictEqual(out, '{}');
    });

    it('formats zero-row record part as empty array', () => {
        const r = result(records('empty', ['col'], []));
        const out = format(r, 'json');
        const obj = JSON.parse(out);
        deepStrictEqual(obj.empty, []);
    });

    it('produces no trailing newline', () => {
        const r = result(records('t', ['a'], [{ a: 1 }]));
        const out = format(r, 'json');
        ok(!out.endsWith('\n'));
    });
});

describe('format: pipe', () => {
    it('formats single record part with ## header and pipe-delimited rows', () => {
        const r = result(records('tasks', ['id', 'title'], [
            { id: 1, title: 'foo' },
            { id: 2, title: 'bar' },
        ]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines[0], '## tasks');
        strictEqual(lines[1], '1|foo');
        strictEqual(lines[2], '2|bar');
    });

    it('escapes backslash and pipe', () => {
        const r = result(records('t', ['text'], [
            { text: 'a\\b|c' },
        ]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines[1], 'a\\\\b\\|c');
    });

    it('escapes CR as literal \\r and LF as literal \\n', () => {
        const r = result(records('t', ['text'], [
            { text: 'a\rb\nc' },
        ]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines[1], 'a\\rb\\nc');
    });

    it('escapes leading ## as \\##', () => {
        const r = result(records('t', ['text'], [
            { text: '## heading' },
        ]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines[1], '\\## heading');
    });

    it('does NOT escape leading single #', () => {
        const r = result(records('t', ['text'], [
            { text: '#002' },
        ]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines[1], '#002');
    });

    it('renders null/undefined as empty', () => {
        const r = result(records('t', ['a', 'b'], [
            { a: null, b: undefined },
        ]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines[1], '|');
    });

    it('JSON-stringifies arrays', () => {
        const r = result(records('t', ['arr'], [
            { arr: [1, 2, 3] },
        ]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines[1], '[1,2,3]');
    });

    it('formats text part as pipeField value after ## header', () => {
        const r = result(text('note', 'hello|world'));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines[0], '## note');
        strictEqual(lines[1], 'hello\\|world');
    });

    it('formats zero-row record as ## header only', () => {
        const r = result(records('empty', ['col'], []));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        strictEqual(lines.length, 1);
        strictEqual(lines[0], '## empty');
    });

    it('formats empty result as empty string', () => {
        const r = result();
        const out = format(r, 'pipe');
        strictEqual(out, '');
    });

    it('produces no trailing newline', () => {
        const r = result(records('t', ['a'], [{ a: 1 }]));
        const out = format(r, 'pipe');
        ok(!out.endsWith('\n'));
    });
});

describe('format: md', () => {
    it('formats single record part as heading and table', () => {
        const r = result(records('tasks', ['id', 'title'], [
            { id: 1, title: 'foo' },
            { id: 2, title: 'bar' },
        ]));
        const out = format(r, 'md');
        ok(out.includes('## tasks'));
        ok(out.includes('| id | title |'));
        ok(out.includes('| --- | --- |'));
        ok(out.includes('| 1 | foo |'));
    });

    it('renders null/undefined as empty in table cells', () => {
        const r = result(records('t', ['a', 'b'], [
            { a: null, b: undefined },
        ]));
        const out = format(r, 'md');
        // Cells with empty values render with spaces: |  |  |
        ok(out.includes('|  |  |'));
    });

    it('renders arrays as comma-separated items', () => {
        const r = result(records('t', ['tags'], [
            { tags: ['a', 'b', 'c'] },
        ]));
        const out = format(r, 'md');
        ok(out.includes('| a, b, c |'));
    });

    it('JSON-stringifies object array items and plain objects', () => {
        const r = result(records('t', ['items', 'meta'], [
            { items: [{ x: 1 }, { y: 2 }], meta: { key: 'val' } },
        ]));
        const out = format(r, 'md');
        ok(out.includes('{"x":1}, {"y":2}'));
        ok(out.includes('{"key":"val"}'));
    });

    it('formats text part as heading and text body', () => {
        const r = result(text('note', 'some content'));
        const out = format(r, 'md');
        ok(out.includes('## note'));
        ok(out.includes('some content'));
    });

    it('formats empty text part as heading only', () => {
        const r = result(text('note', ''));
        const out = format(r, 'md');
        strictEqual(out, '## note');
    });

    it('formats zero-row record as heading and empty table', () => {
        const r = result(records('empty', ['col'], []));
        const out = format(r, 'md');
        ok(out.includes('## empty'));
        ok(out.includes('| col |'));
        ok(out.includes('| --- |'));
    });

    it('joins multi-part results with blank lines', () => {
        const r = result(
            records('items', ['id'], [{ id: 1 }]),
            text('note', 'hello')
        );
        const out = format(r, 'md');
        // Multi-part output should have both headings separated by blank lines
        ok(out.includes('## items'));
        ok(out.includes('## note'));
        ok(out.includes('## items\n\n| id |'));  // heading, blank line, table
        ok(out.includes('| 1 |\n\n## note'));     // table row, blank line, next heading
    });

    it('formats empty result as empty string', () => {
        const r = result();
        const out = format(r, 'md');
        strictEqual(out, '');
    });

    it('produces no trailing newline', () => {
        const r = result(records('t', ['a'], [{ a: 1 }]));
        const out = format(r, 'md');
        ok(!out.endsWith('\n'));
    });
});

describe('pipe escaping round-trip', () => {
    /**
     * Single left-to-right decoder for one pipe field: a leading `\##` is `##`, then each
     * backslash escape (`\\`, `\|`, `\n`, `\r`) is consumed exactly once. Chained global
     * replaces cannot do this: they mis-decode a literal backslash followed by `n`.
     */
    function decodePipeField(escaped: string): string {
        const head = escaped.startsWith('\\##') ? '##' : '';
        const rest = head ? escaped.slice(3) : escaped;
        return head + rest.replace(/\\([\\|nr])/g, (_m, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
    }

    it('round-trips a field with |, \\, newline, and leading ## ', () => {
        const original = '## text|with\\\nnewline';
        const r = result(records('t', ['field'], [{ field: original }]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        const escaped = lines[1];
        const decoded = decodePipeField(escaped);
        strictEqual(decoded, original);
    });

    it('round-trips multiple special characters', () => {
        const original = '\\|##+##|text';
        const r = result(records('t', ['field'], [{ field: original }]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        const escaped = lines[1];
        const decoded = decodePipeField(escaped);
        strictEqual(decoded, original);
    });

    it('round-trips #002 unchanged (no leading ## escape)', () => {
        const original = '#002';
        const r = result(records('t', ['field'], [{ field: original }]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        const escaped = lines[1];
        strictEqual(escaped, '#002');
        const decoded = decodePipeField(escaped);
        strictEqual(decoded, original);
    });

    it('round-trips a literal backslash-n, |, a real newline, and a leading ## losslessly', () => {
        const original = '## a\\nb|c\nd\\';
        const out = format(result(records('t', ['field'], [{ field: original }])), 'pipe');
        const lines = out.split('\n');
        strictEqual(lines.length, 2);
        strictEqual(lines[1], '\\## a\\\\nb\\|c\\nd\\\\');
        strictEqual(decodePipeField(lines[1]), original);
    });

    it('escapes a field beginning with ### as \\###', () => {
        const original = '### heading';
        const r = result(records('t', ['field'], [{ field: original }]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        const escaped = lines[1];
        ok(escaped.startsWith('\\###'), `expected to start with \\###, got ${escaped}`);
        strictEqual(decodePipeField(escaped), original);
    });

    it('escapes a field beginning with ##x (no space) as \\##x', () => {
        const original = '##noheader';
        const r = result(records('t', ['field'], [{ field: original }]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        const escaped = lines[1];
        strictEqual(escaped, '\\##noheader');
        strictEqual(decodePipeField(escaped), original);
    });

    it('round-trips a literal backslash followed by ##', () => {
        const original = '\\##text';
        const r = result(records('t', ['field'], [{ field: original }]));
        const out = format(r, 'pipe');
        const lines = out.split('\n');
        const escaped = lines[1];
        // A backslash followed by ## should become: \\ (backslash escaped) then \## (leading ##)
        // But the leading ## escape happens first in the algorithm, so a value starting with \
        // gets that backslash escaped to \\, making it \\##, which is NOT a leading ##, so no further escape
        // Actually, let me think: the value is \##. The escape order is: \, |, \r, \n, then leading ##.
        // So: \## -> \\## (backslash escaped) -> this doesn't start with ##, so no leading ## escape
        // Result: \\##
        strictEqual(escaped, '\\\\##text', `expected \\\\##text, got ${escaped}`);
        strictEqual(decodePipeField(escaped), original);
    });

    it('round-trips multiple values including ##, #, |, backslash, and newline', () => {
        const testCases = [
            '\\##a',          // literal backslash-hash-hash
            '##a',            // leading ##
            '#001',           // single hash (not escaped)
            'a|b\\c',         // pipe and backslash
            'a\nb',           // newline in middle
        ];
        for (const original of testCases) {
            const r = result(records('t', ['field'], [{ field: original }]));
            const out = format(r, 'pipe');
            const lines = out.split('\n');
            const escaped = lines[1];
            const decoded = decodePipeField(escaped);
            strictEqual(decoded, original, `round-trip failed for ${JSON.stringify(original)}`);
        }
    });

    it('does not confuse a literal backslash + n with a newline', () => {
        const out = format(result(records('t', ['field'], [{ field: 'a\\nb' }])), 'pipe');
        strictEqual(out.split('\n')[1], 'a\\\\nb');
        strictEqual(decodePipeField(out.split('\n')[1]), 'a\\nb');
    });
});

describe('format: warnings', () => {
    it('includes warnings part when present', () => {
        const r = result(records('task', ['id'], [{ id: 1 }]));
        withWarnings(r, ['warning 1', 'warning 2']);
        const jsonOut = format(r, 'json');
        const obj = JSON.parse(jsonOut);
        ok('warnings' in obj);
        strictEqual(obj.warnings.length, 2);
        strictEqual(obj.warnings[0].message, 'warning 1');
    });

    it('renders the warnings part in pipe', () => {
        const r = withWarnings(result(records('task', ['id'], [{ id: 1 }])), ['w1', 'w|2']);
        strictEqual(format(r, 'pipe'), '## task\n1\n## warnings\nw1\nw\\|2');
    });

    it('renders the warnings part in md', () => {
        const r = withWarnings(result(records('task', ['id'], [{ id: 1 }])), ['w1', 'w|2']);
        strictEqual(format(r, 'md'), '## task\n\n| id |\n| --- |\n| 1 |\n\n## warnings\n\n| message |\n| --- |\n| w1 |\n| w\\|2 |');
    });
});
