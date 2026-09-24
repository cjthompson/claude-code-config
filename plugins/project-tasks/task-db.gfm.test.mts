/*  Run the tests:
 *    node --experimental-strip-types --test plugins/project-tasks/task-db.gfm.test.mts
 *
 *  Unit tests for the standalone GFM writer (lib/gfm.mjs): exact-output
 *  assertions for each function, plus a validity check that `table()` output
 *  parses as GFM under `micromark` — the writer has no runtime dependency,
 *  but its correctness is checked against a real GFM parser here.
 */
import { describe, it } from 'node:test';
import { strictEqual, throws, ok } from 'node:assert/strict';
import { micromark } from 'micromark';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';
import { blockquote, cell, heading, paragraph, table } from './lib/gfm.mjs';

/** Render markdown to HTML with GFM table support enabled. */
function renderTable(md: string): string {
    return micromark(md, {
        extensions: [gfmTable()],
        htmlExtensions: [gfmTableHtml()],
    });
}

describe('gfm cell', () => {
    it('renders null and undefined as empty', () => {
        strictEqual(cell(null), '');
        strictEqual(cell(undefined), '');
    });

    it('renders falsy-but-present values', () => {
        strictEqual(cell(0), '0');
    });

    it('escapes a pipe', () => {
        strictEqual(cell('a|b'), 'a\\|b');
    });

    it('escapes backslash before pipe, so a\\|b becomes a\\\\\\|b', () => {
        strictEqual(cell('a\\|b'), 'a\\\\\\|b');
    });

    it('escapes a trailing backslash', () => {
        strictEqual(cell('a\\'), 'a\\\\');
    });

    it('collapses a newline with surrounding whitespace to one space', () => {
        strictEqual(cell('x\n  y'), 'x y');
    });

    it('collapses a CRLF the same way', () => {
        strictEqual(cell('x\r\ny'), 'x y');
    });
});

describe('gfm table', () => {
    it('renders a normal table', () => {
        strictEqual(
            table(['A', 'B'], [['1', '2'], ['3', '4']]),
            '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
        );
    });

    it('renders header and delimiter only for zero rows', () => {
        strictEqual(table(['A', 'B'], []), '| A | B |\n| --- | --- |');
    });

    it('renders empty cells', () => {
        strictEqual(table(['A', 'B'], [['', null]]), '| A | B |\n| --- | --- |\n|  |  |');
    });

    it('renders a pipe, multi-line, backslash-pipe, and trailing-backslash cell', () => {
        strictEqual(
            table(['A'], [['a|b'], ['x\n  y'], ['a\\|b'], ['a\\']]),
            '| A |\n| --- |\n| a\\|b |\n| x y |\n| a\\\\\\|b |\n| a\\\\ |',
        );
    });

    it('has no leading or trailing blank line', () => {
        const out = table(['A'], [['1']]);
        strictEqual(out.startsWith('\n'), false);
        strictEqual(out.endsWith('\n'), false);
    });

    it('throws when a row length differs from the header length', () => {
        throws(() => table(['A', 'B'], [['1']]), /row has 1 cells, expected 2/);
    });
});

describe('gfm heading', () => {
    it('renders each level', () => {
        strictEqual(heading(1, 'Title'), '# Title');
        strictEqual(heading(6, 'Title'), '###### Title');
    });

    it('collapses newlines', () => {
        strictEqual(heading(2, 'x\n  y'), '## x y');
    });

    it('throws for an invalid level', () => {
        throws(() => heading(0, 'x'), /heading level must be an integer 1-6/);
        throws(() => heading(7, 'x'), /heading level must be an integer 1-6/);
        throws(() => heading(1.5, 'x'), /heading level must be an integer 1-6/);
    });
});

describe('gfm paragraph', () => {
    it('renders text verbatim', () => {
        strictEqual(paragraph('hello\nworld'), 'hello\nworld');
    });

    it('renders null/undefined as empty', () => {
        strictEqual(paragraph(null), '');
        strictEqual(paragraph(undefined), '');
    });
});

describe('gfm blockquote', () => {
    it('prefixes every line', () => {
        strictEqual(blockquote('a\nb'), '> a\n> b');
    });

    it('renders an empty line as a bare >', () => {
        strictEqual(blockquote('a\n\nb'), '> a\n>\n> b');
    });
});

describe('gfm table validity (micromark)', () => {
    it('parses a zero-row table as exactly one table with the right column count', () => {
        const html = renderTable(table(['A', 'B', 'C'], []));
        strictEqual((html.match(/<table>/g) ?? []).length, 1);
        strictEqual((html.match(/<th>/g) ?? []).length, 3);
        const trCount = (html.match(/<tr>/g) ?? []).length;
        strictEqual(trCount - 1, 0);
    });

    it('parses a backslash-pipe cell as one cell, round-tripping the literal text', () => {
        const html = renderTable(table(['A'], [['a\\|b']]));
        strictEqual((html.match(/<table>/g) ?? []).length, 1);
        strictEqual((html.match(/<th>/g) ?? []).length, 1);
        const trCount = (html.match(/<tr>/g) ?? []).length;
        strictEqual(trCount - 1, 1);
        // The original value has a literal backslash before the pipe, so the
        // round-trip keeps the backslash: 'a\|b' escapes to 'a\\\|b' and
        // parses back to 'a\|b', not 'a|b'.
        ok(html.includes('a\\|b'), `expected literal a\\|b in ${html}`);
        // Exactly one <td>: a mis-escaped pipe would have split the cell.
        strictEqual((html.match(/<td>/g) ?? []).length, 1);
    });

    it('parses a plain pipe cell as one cell', () => {
        const html = renderTable(table(['A'], [['a|b']]));
        strictEqual((html.match(/<table>/g) ?? []).length, 1);
        strictEqual((html.match(/<th>/g) ?? []).length, 1);
        strictEqual((html.match(/<td>/g) ?? []).length, 1);
        const trCount = (html.match(/<tr>/g) ?? []).length;
        strictEqual(trCount - 1, 1);
        ok(html.includes('a|b'), `expected literal a|b in ${html}`);
    });

    it('parses a multi-line cell (collapsed to one line) as one row', () => {
        const html = renderTable(table(['A'], [['x\n  y']]));
        strictEqual((html.match(/<table>/g) ?? []).length, 1);
        const trCount = (html.match(/<tr>/g) ?? []).length;
        strictEqual(trCount - 1, 1);
        strictEqual((html.match(/<td>/g) ?? []).length, 1);
    });

    it('parses an empty-cell table as one row with an empty cell', () => {
        const html = renderTable(table(['A', 'B'], [['', 'x']]));
        strictEqual((html.match(/<table>/g) ?? []).length, 1);
        strictEqual((html.match(/<th>/g) ?? []).length, 2);
        const trCount = (html.match(/<tr>/g) ?? []).length;
        strictEqual(trCount - 1, 1);
        strictEqual((html.match(/<td>/g) ?? []).length, 2);
    });
});
