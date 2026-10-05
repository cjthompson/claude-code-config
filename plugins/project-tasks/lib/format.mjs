/**
 * Result model, formatters, and value renderers for task-db output.
 */

import * as gfm from './gfm.mjs';

/**
 * Create a records part: tabular data with named columns.
 * @param {string} name - part name
 * @param {string[]} columns - column names (declared by caller)
 * @param {Object[]} rows - array of row objects
 * @returns {{kind: 'records', name: string, columns: string[], rows: Object[]}}
 */
export function records(name, columns, rows) {
    return { kind: 'records', name, columns, rows };
}

/**
 * Create a text part: unstructured text.
 * @param {string} name - part name
 * @param {unknown} value - value to stringify
 * @returns {{kind: 'text', name: string, text: string}}
 */
export function text(name, value) {
    return { kind: 'text', name, text: String(value ?? '') };
}

/**
 * Create a result: a collection of parts.
 * @param {...(Object)} parts - parts (records or text)
 * @returns {{kind: 'result', parts: Object[]}}
 */
export function result(...parts) {
    return { kind: 'result', parts };
}

/**
 * Check if a value is a result.
 * @param {unknown} x
 * @returns {boolean}
 */
export function isResult(x) {
    return x && typeof x === 'object' && x.kind === 'result';
}

/**
 * Create a status part.
 * @param {string} status
 * @param {string} message
 * @returns {Object}
 */
export function statusPart(status, message) {
    return records('status', ['status', 'message'], [{ status, message }]);
}

/**
 * Append warnings to a result (only if messages.length > 0).
 * @param {Object} res - result
 * @param {string[]} messages
 * @returns {Object}
 */
export function withWarnings(res, messages) {
    if (messages.length > 0) {
        res.parts.push(records('warnings', ['message'], messages.map(m => ({ message: m }))));
    }
    return res;
}

export const FORMATS = ['md', 'json', 'pipe'];

/**
 * Render a value as it appears in markdown output.
 * @param {unknown} v
 * @returns {string}
 */
function mdValue(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) {
        return v.map(item => (typeof item === 'object' ? JSON.stringify(item) : item)).join(', ');
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

/**
 * Render a value as it appears in pipe output, with escaping.
 * @param {unknown} v
 * @returns {string}
 */
function pipeField(v) {
    // Serialize first
    if (v === null || v === undefined) {
        v = '';
    } else if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
        v = JSON.stringify(v);
    } else {
        v = String(v);
    }

    // Escape in order: \, |, \r, \n, then leading ##
    v = v.replace(/\\/g, '\\\\');      // \ -> \\
    v = v.replace(/\|/g, '\\|');      // | -> \|
    v = v.replace(/\r/g, '\\r');      // CR -> literal \r
    v = v.replace(/\n/g, '\\n');      // LF -> literal \n
    if (v.startsWith('##')) {
        v = '\\' + v;                  // leading ## -> \##
    }
    return v;
}

/**
 * Render a value as it appears in JSON output.
 * @param {unknown} v
 * @returns {unknown}
 */
function jsonValue(v) {
    if (v === null || v === undefined) return null;
    return v;
}

/**
 * Format a result to a string.
 * @param {Object} res - result object
 * @param {string} kind - format kind: 'md', 'json', or 'pipe'
 * @returns {string}
 */
export function format(res, kind) {
    if (!isResult(res)) {
        throw new Error('format: expected a result object');
    }

    if (kind === 'json') {
        return formatJson(res);
    } else if (kind === 'pipe') {
        return formatPipe(res);
    } else if (kind === 'md') {
        return formatMd(res);
    } else {
        throw new Error(`unknown format: ${kind}`);
    }
}

/**
 * Format result as JSON: compact, one line, one key per part name.
 * @param {Object} res
 * @returns {string}
 */
function formatJson(res) {
    const obj = {};
    for (const part of res.parts) {
        if (part.kind === 'records') {
            // Array of objects built from declared columns only
            obj[part.name] = part.rows.map(row => {
                const record = {};
                for (const col of part.columns) {
                    record[col] = jsonValue(row[col]);
                }
                return record;
            });
        } else if (part.kind === 'text') {
            obj[part.name] = part.text;
        }
    }
    return JSON.stringify(obj);
}

/**
 * Format result as pipe-delimited: lines joined with \n.
 * @param {Object} res
 * @returns {string}
 */
function formatPipe(res) {
    if (res.parts.length === 0) return '';

    const lines = [];
    for (const part of res.parts) {
        lines.push(`## ${part.name}`);
        if (part.kind === 'records') {
            for (const row of part.rows) {
                const values = part.columns.map(col => pipeField(row[col]));
                lines.push(values.join('|'));
            }
        } else if (part.kind === 'text') {
            lines.push(pipeField(part.text));
        }
    }
    return lines.join('\n');
}

/**
 * Format result as Markdown: parts joined with \n\n.
 * @param {Object} res
 * @returns {string}
 */
function formatMd(res) {
    if (res.parts.length === 0) return '';

    const parts = [];
    for (const part of res.parts) {
        let body = '';
        if (part.kind === 'records') {
            // Table with gfm.table (zero rows -> header+delimiter only)
            const rows = part.rows.map(r =>
                part.columns.map(c => mdValue(r[c]))
            );
            body = gfm.table(part.columns, rows);
        } else if (part.kind === 'text') {
            body = part.text;
        }

        const heading = gfm.heading(2, part.name);
        if (body) {
            parts.push(heading + '\n\n' + body);
        } else {
            parts.push(heading);
        }
    }
    return parts.join('\n\n');
}
