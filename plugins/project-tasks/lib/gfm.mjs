/**
 * gfm — a minimal, dependency-free writer for valid GitHub-flavored Markdown.
 *
 * Every function returns a string with no trailing newline; callers join
 * blocks with their own blank lines. This keeps the writer usable both for
 * one-off fragments (a heading, a paragraph) and for multi-part documents
 * built up line by line.
 */

/**
 * Escape one table cell. Backslash is escaped first so a value like `a\|b`
 * ends in `\\|` (an escaped backslash followed by an escaped pipe) rather
 * than a bare `|` that would split the cell.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function cell(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\s*\n\s*/g, ' ');
}

/**
 * A GFM table: header row, delimiter row, then one row per record. Zero rows
 * still produces a valid table (header and delimiter only), so an empty
 * result renders as a table with no data rather than nothing at all.
 *
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function table(headers, rows) {
    const lines = [
        `| ${headers.map(cell).join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
    ];
    for (const row of rows) {
        if (row.length !== headers.length) {
            throw new Error(`row has ${row.length} cells, expected ${headers.length}`);
        }
        lines.push(`| ${row.map(cell).join(' | ')} |`);
    }
    return lines.join('\n');
}

/**
 * An ATX heading. Newlines are collapsed rather than escaped: a heading is
 * always one physical line.
 *
 * @param {number} level
 * @param {unknown} text
 * @returns {string}
 */
export function heading(level, text) {
    if (!Number.isInteger(level) || level < 1 || level > 6) {
        throw new Error(`heading level must be an integer 1-6, got ${level}`);
    }
    return `${'#'.repeat(level)} ${String(text ?? '').replace(/\s*\n\s*/g, ' ')}`;
}

/**
 * A plain paragraph, verbatim.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function paragraph(text) {
    return String(text ?? '');
}

/**
 * A blockquote. Every line — including an empty one — is prefixed with `> `
 * so a multi-line note stays inside the quote instead of ending it partway
 * through.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function blockquote(text) {
    return String(text ?? '')
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n');
}
