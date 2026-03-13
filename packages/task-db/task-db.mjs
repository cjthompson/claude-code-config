#!/usr/bin/env node
/**
 * task-db — SQLite helper for the project-tasks Claude Code skill.
 * Installed to ~/.claude/task-db.mjs and called as:
 *   node ~/.claude/task-db.mjs <command> [options]
 *
 * All SQL is handled internally. Callers pass plain string arguments;
 * no shell escaping is needed on the caller side.
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const DB_PATH = join(process.env.HOME, '.claude', 'tasks.db');

/** Run SQL via sqlite3 stdin. Returns trimmed stdout. */
function sql(query, flags = '') {
    return execSync(`sqlite3 ${flags} "${DB_PATH}"`, {
        input: query,
        encoding: 'utf-8',
    }).trim();
}

/** SQL-escape a value: double single quotes. */
function esc(val) {
    return String(val ?? '').replace(/'/g, "''");
}

const argv = process.argv.slice(2);
const cmd = argv[0];

/** Get the value of the first occurrence of a named flag. */
function get(flag) {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] ?? null : null;
}

/** Get all values for a repeatable flag. */
function all(flag) {
    const vals = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === flag && i + 1 < argv.length) vals.push(argv[++i]);
    }
    return vals;
}

const has = (flag) => argv.includes(flag);

const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

switch (cmd) {
    case 'init': {
        // Check before creating — exit 2 if this is a first-time setup
        const existing = sql("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks';");
        const firstTime = existing === '';

        sql(`CREATE TABLE IF NOT EXISTS tasks(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL CHECK(type IN('fix','task','todo')),
            title TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN('high','medium','low')),
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_progress','completed','cancelled')),
            tags TEXT DEFAULT '[]',
            reqs TEXT DEFAULT '[]',
            depends_on TEXT DEFAULT '[]',
            created TEXT NOT NULL,
            updated TEXT,
            in_changelog INTEGER NOT NULL DEFAULT 0,
            UNIQUE(project,seq)
        );`);

        // Migration: add depends_on column for databases created before it existed
        try { sql("ALTER TABLE tasks ADD COLUMN depends_on TEXT DEFAULT '[]';"); } catch {}

        process.exit(firstTime ? 2 : 0);
        break;
    }

    case 'insert': {
        const p       = esc(get('--project'));
        const type    = get('--type');
        const title   = esc(get('--title'));
        const priority = get('--priority') ?? 'medium';
        const tags    = esc(JSON.stringify(all('--tag')));
        const reqs    = esc(JSON.stringify(all('--req')));
        const deps    = esc(JSON.stringify(all('--dep').map(Number)));
        const created = esc(get('--created') ?? now());

        const result = sql(`
            INSERT INTO tasks(project,seq,type,title,priority,tags,reqs,depends_on,created)
            VALUES('${p}',(SELECT COALESCE(MAX(seq),0)+1 FROM tasks WHERE project='${p}'),'${type}','${title}','${priority}','${tags}','${reqs}','${deps}','${created}');
            SELECT printf('#%03d',seq) FROM tasks WHERE id=last_insert_rowid();
        `);
        process.stdout.write(result + '\n');
        break;
    }

    case 'update': {
        const p    = esc(get('--project'));
        const seq  = get('--seq');
        const sets = [];
        const status   = get('--status');
        const priority = get('--priority');
        if (status)   sets.push(`status='${status}'`);
        if (priority) sets.push(`priority='${priority}'`);
        sets.push(`updated='${esc(get('--updated') ?? now())}'`);
        sql(`UPDATE tasks SET ${sets.join(',')} WHERE project='${p}' AND seq=${seq};`);
        break;
    }

    case 'get': {
        const p   = esc(get('--project'));
        const seq = get('--seq');
        const result = sql(
            `SELECT seq,type,title,priority,tags,reqs,depends_on,status FROM tasks WHERE project='${p}' AND seq=${seq};`,
            '-json',
        );
        process.stdout.write(result + '\n');
        break;
    }

    case 'list': {
        const p      = esc(get('--project'));
        const status = get('--status');
        const where  = status ? `AND status='${status}'` : `AND status!='cancelled'`;
        const result = sql(
            `SELECT printf('#%03d',seq),type,title,priority,status,tags,depends_on FROM tasks WHERE project='${p}' ${where} ORDER BY seq DESC;`,
            '-separator "|"',
        );
        if (result) process.stdout.write(result + '\n');
        break;
    }

    case 'blocked': {
        // Returns seq numbers (newline-separated) of pending tasks with incomplete dependencies
        const p = esc(get('--project'));
        const result = sql(`
            SELECT seq FROM tasks
            WHERE project='${p}' AND status='pending' AND depends_on!='[]'
            AND EXISTS (
                SELECT 1 FROM json_each(depends_on) j
                JOIN tasks d ON d.project='${p}' AND d.seq=j.value
                WHERE d.status!='completed'
            );
        `);
        if (result) process.stdout.write(result + '\n');
        break;
    }

    case 'unblocked': {
        // Returns pipe-separated rows (#NNN|title) of tasks newly unblocked by completing seq N
        const p   = esc(get('--project'));
        const seq = get('--seq');
        const result = sql(`
            SELECT printf('#%03d',seq),title FROM tasks
            WHERE project='${p}' AND status='pending' AND depends_on!='[]'
            AND EXISTS (SELECT 1 FROM json_each(depends_on) j WHERE j.value=${seq})
            AND NOT EXISTS (
                SELECT 1 FROM json_each(depends_on) j
                JOIN tasks d ON d.project='${p}' AND d.seq=j.value
                WHERE d.status!='completed'
            );
        `, '-separator "|"');
        if (result) process.stdout.write(result + '\n');
        break;
    }

    case 'check-deps': {
        // Returns pipe-separated rows (#NNN|title|status) of incomplete dependencies for seq N
        const p   = esc(get('--project'));
        const seq = get('--seq');
        const result = sql(`
            SELECT printf('#%03d',seq),title,status FROM tasks
            WHERE project='${p}'
            AND seq IN (
                SELECT j.value FROM tasks t, json_each(t.depends_on) j
                WHERE t.project='${p}' AND t.seq=${seq}
            )
            AND status!='completed';
        `, '-separator "|"');
        if (result) process.stdout.write(result + '\n');
        break;
    }

    case 'validate-deps': {
        // Prints any dep seq numbers that don't exist in the project
        const p    = esc(get('--project'));
        const deps = esc(JSON.stringify(all('--dep').map(Number)));
        const result = sql(`
            SELECT j.value FROM json_each('${deps}') j
            WHERE j.value NOT IN (SELECT seq FROM tasks WHERE project='${p}');
        `);
        if (result) process.stdout.write(result + '\n');
        break;
    }

    case 'changelog': {
        const p      = esc(get('--project'));
        const filter = has('--new-only') ? 'AND in_changelog=0' : '';
        const result = sql(`
            SELECT seq,substr(updated,1,10),type,title,tags FROM tasks
            WHERE project='${p}' AND status='completed' ${filter}
            ORDER BY updated DESC;
        `, '-separator "|"');
        if (result) process.stdout.write(result + '\n');
        break;
    }

    case 'mark-changelog': {
        const p = esc(get('--project'));
        if (has('--all')) {
            sql(`UPDATE tasks SET in_changelog=1 WHERE project='${p}' AND status='completed';`);
        } else {
            const seqs = all('--seq');
            if (seqs.length > 0) {
                sql(`UPDATE tasks SET in_changelog=1 WHERE project='${p}' AND seq IN (${seqs.join(',')});`);
            }
        }
        break;
    }

    case 'recent': {
        const p     = esc(get('--project'));
        const limit = get('--limit') ?? '20';
        const result = sql(`
            SELECT printf('#%03d',seq),type,title,status FROM tasks
            WHERE project='${p}' ORDER BY seq DESC LIMIT ${limit};
        `, '-separator "|"');
        if (result) process.stdout.write(result + '\n');
        break;
    }

    default: {
        const commands = 'init|insert|update|get|list|blocked|unblocked|check-deps|validate-deps|changelog|mark-changelog|recent';
        process.stderr.write(`Unknown command: ${cmd ?? '(none)'}\nUsage: node task-db.mjs <${commands}> [options]\n`);
        process.exit(1);
    }
}
