/*  Run the tests:
 *    node --experimental-strip-types --test ~/.claude/statusline-render.test.ts
 */
import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripAnsi,
  formatDuration,
  formatLocalTime,
  cacheAge,
  shortenPath,
  progressBar,
  plTransition,
  plEnd,
  joinSep,
  formatQuotaWindow,
} from './statusline-render.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── formatDuration ────────────────────────────────────────────

describe('formatDuration', () => {
  it('returns "now" for zero seconds', () => {
    strictEqual(formatDuration(0), 'now');
  });

  it('returns "now" for negative seconds', () => {
    strictEqual(formatDuration(-10), 'now');
  });

  it('returns minutes for sub-hour durations', () => {
    strictEqual(formatDuration(120), '2m');
    strictEqual(formatDuration(300), '5m');
  });

  it('returns 0m for sub-minute positive durations', () => {
    strictEqual(formatDuration(30), '0m');
    strictEqual(formatDuration(59), '0m');
  });

  it('returns hours and minutes', () => {
    strictEqual(formatDuration(3661), '1h1m');
    strictEqual(formatDuration(5400), '1h30m');
  });

  it('returns hours only when no remainder minutes', () => {
    strictEqual(formatDuration(3600), '1h');
    strictEqual(formatDuration(7200), '2h');
  });
});

// ── formatLocalTime ───────────────────────────────────────────

describe('formatLocalTime', () => {
  it('returns H:MMAM/PM format', () => {
    const result = formatLocalTime('2025-06-15T14:30:00Z');
    match(result, /^\d{1,2}:\d{2}(AM|PM)$/);
  });

  it('handles midnight UTC', () => {
    const result = formatLocalTime('2025-01-01T00:00:00Z');
    match(result, /^\d{1,2}:00(AM|PM)$/);
  });

  it('pads minutes to two digits', () => {
    const result = formatLocalTime('2025-01-01T12:05:00Z');
    match(result, /:\d{2}/);
  });
});

// ── cacheAge ──────────────────────────────────────────────────

describe('cacheAge', () => {
  it('returns "new" for timestamps less than 60 seconds ago', () => {
    const now = Math.floor(Date.now() / 1000);
    strictEqual(cacheAge(now), 'new');
    strictEqual(cacheAge(now - 30), 'new');
    strictEqual(cacheAge(now - 59), 'new');
  });

  it('returns minutes for older timestamps', () => {
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    strictEqual(cacheAge(fiveMinAgo), '5m old');
  });

  it('returns correct minutes for boundary', () => {
    const oneMinAgo = Math.floor(Date.now() / 1000) - 60;
    strictEqual(cacheAge(oneMinAgo), '1m old');
  });
});

// ── shortenPath ───────────────────────────────────────────────

describe('shortenPath', () => {
  it('returns path unchanged when within maxLen', () => {
    strictEqual(shortenPath('/short/path', 50), '/short/path');
  });

  it('replaces HOME prefix with ~', () => {
    const home = process.env.HOME;
    if (home) {
      strictEqual(shortenPath(home + '/dev', 50), '~/dev');
    }
  });

  it('abbreviates intermediate segments to first char', () => {
    const result = shortenPath('/aaa/bbb/ccc/deep/path', 15);
    ok(result.length <= '/aaa/bbb/ccc/deep/path'.length);
    ok(result.endsWith('deep/path')); // last 2 segments preserved
  });

  it('abbreviates dotfile segments to 2 chars', () => {
    const result = shortenPath('/a/.worktrees/nested/deep/path', 15);
    ok(result.includes('.w'));
  });

  it('preserves last two segments fully', () => {
    const result = shortenPath('/very/long/directory/structure/last/two', 20);
    ok(result.endsWith('last/two'));
  });

  it('does not abbreviate ~ or empty segments', () => {
    const home = process.env.HOME;
    if (home) {
      const result = shortenPath(home + '/long-name/another-long/final/segment', 20);
      ok(result.startsWith('~/'));
    }
  });
});

// ── progressBar ───────────────────────────────────────────────

describe('progressBar', () => {
  it('produces correct total width of bar characters', () => {
    const bar = stripAnsi(progressBar(50, '', 10));
    const filled = (bar.match(/\u2588/g) || []).length;
    const empty = (bar.match(/\u2591/g) || []).length;
    strictEqual(filled + empty, 10);
    strictEqual(filled, 5);
  });

  it('shows all filled at 100%', () => {
    const bar = stripAnsi(progressBar(100, '', 8));
    const filled = (bar.match(/\u2588/g) || []).length;
    strictEqual(filled, 8);
  });

  it('shows all empty at 0%', () => {
    const bar = stripAnsi(progressBar(0, '', 8));
    const empty = (bar.match(/\u2591/g) || []).length;
    strictEqual(empty, 8);
  });

  it('clamps values above 100', () => {
    const bar = stripAnsi(progressBar(150, '', 10));
    const filled = (bar.match(/\u2588/g) || []).length;
    strictEqual(filled, 10);
  });

  it('clamps values below 0', () => {
    const bar = stripAnsi(progressBar(-20, '', 10));
    const filled = (bar.match(/\u2588/g) || []).length;
    strictEqual(filled, 0);
  });

  it('appends bgStr suffix', () => {
    const bar = progressBar(50, '[BG]', 4);
    ok(bar.endsWith('[BG]'));
  });
});

// ── Powerline helpers ─────────────────────────────────────────

describe('plTransition', () => {
  it('contains the right-arrow separator', () => {
    ok(plTransition(22, 24).includes('\u25b6'));
  });

  it('contains ANSI sequences for both bg colors', () => {
    const result = plTransition(22, 24);
    ok(result.includes('\x1b[38;5;22m')); // fg(22)
    ok(result.includes('\x1b[48;5;24m')); // bg(24)
  });
});

describe('plEnd', () => {
  it('contains the right-arrow separator', () => {
    ok(plEnd(237).includes('\u25b6'));
  });

  it('ends with reset', () => {
    ok(plEnd(237).endsWith('\x1b[0m'));
  });
});

describe('joinSep', () => {
  it('contains the pipe separator', () => {
    ok(joinSep('', 240).includes('\u2502'));
  });

  it('includes the background string', () => {
    ok(joinSep('[BG]', 240).includes('[BG]'));
  });
});

// ── formatQuotaWindow ─────────────────────────────────────────

describe('formatQuotaWindow', () => {
  it('returns null for undefined window', () => {
    strictEqual(formatQuotaWindow(undefined, '5h', '', true, () => ''), null);
  });

  it('includes percentage in output', () => {
    const result = formatQuotaWindow(
      { utilization: 42 },
      '5h', '', true, () => '',
    );
    ok(result !== null);
    ok(stripAnsi(result!).includes('42%'));
  });

  it('includes label in output', () => {
    const result = formatQuotaWindow(
      { utilization: 10 },
      '7d', '', false, () => '',
    );
    ok(stripAnsi(result!).includes('7d'));
  });

  it('includes reset text when resets_at is present', () => {
    const result = formatQuotaWindow(
      { utilization: 50, resets_at: '2025-01-01T12:00:00Z' },
      '5h', '', true, () => 'reset-marker',
    );
    ok(stripAnsi(result!).includes('reset-marker'));
  });

  it('omits reset text when resets_at is absent', () => {
    const result = formatQuotaWindow(
      { utilization: 50 },
      '5h', '', true, () => 'should-not-appear',
    );
    ok(!stripAnsi(result!).includes('should-not-appear'));
  });

  it('uses narrow bar width when isWide is false', () => {
    const narrow = stripAnsi(formatQuotaWindow(
      { utilization: 50 }, '5h', '', false, () => '',
    )!);
    const wide = stripAnsi(formatQuotaWindow(
      { utilization: 50 }, '5h', '', true, () => '',
    )!);
    ok(wide.length > narrow.length);
  });
});

// ── stripAnsi ─────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes ANSI escape sequences', () => {
    strictEqual(stripAnsi('\x1b[31mhello\x1b[0m'), 'hello');
  });

  it('handles strings with no ANSI', () => {
    strictEqual(stripAnsi('plain text'), 'plain text');
  });

  it('handles empty string', () => {
    strictEqual(stripAnsi(''), '');
  });
});

// ── End-to-end ────────────────────────────────────────────────

describe('end-to-end rendering', () => {
  const cacheFile = '/tmp/claude-statusline-test-cache';
  const renderScript = `${__dirname}/statusline-render.ts`;

  it('produces two lines of output with valid input', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 25, resets_at: '2025-06-15T18:00:00Z' },
      seven_day: { utilization: 10, resets_at: '2025-06-20T00:00:00Z' },
    });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.50, total_duration_ms: 120000 },
      cwd: '/tmp',
    });

    const now = String(Math.floor(Date.now() / 1000));
    const result = execFileSync('node', [
      '--experimental-strip-types',
      renderScript,
      cacheFile, now, '120', session, 'main',
    ], { encoding: 'utf8', timeout: 10_000 });

    const lines = result.trimEnd().split('\n');
    strictEqual(lines.length, 2, `Expected 2 lines, got ${lines.length}`);

    // Line 1: model name and path
    ok(stripAnsi(lines[0]).includes('TestModel'));
    ok(stripAnsi(lines[0]).includes('/tmp'));

    // Line 2: quota percentages
    ok(stripAnsi(lines[1]).includes('25%'));
    ok(stripAnsi(lines[1]).includes('10%'));

    unlinkSync(cacheFile);
  });

  it('includes git branch when provided', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 50 },
    });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({ cwd: '/tmp' });
    const now = String(Math.floor(Date.now() / 1000));
    const result = execFileSync('node', [
      '--experimental-strip-types',
      renderScript,
      cacheFile, now, '120', session, 'feature/test-branch',
    ], { encoding: 'utf8', timeout: 10_000 });

    ok(stripAnsi(result).includes('feature/test-branch'));
    unlinkSync(cacheFile);
  });

  it('renders without session data (empty object)', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 75 },
    });
    writeFileSync(cacheFile, cacheData);

    const now = String(Math.floor(Date.now() / 1000));
    const result = execFileSync('node', [
      '--experimental-strip-types',
      renderScript,
      cacheFile, now, '80', '{}', '',
    ], { encoding: 'utf8', timeout: 10_000 });

    const lines = result.trimEnd().split('\n');
    strictEqual(lines.length, 2);
    ok(stripAnsi(lines[1]).includes('75%'));

    unlinkSync(cacheFile);
  });
});
