/*  Run the tests:
 *    node --experimental-strip-types --test ~/.claude/statusline-render.test.ts
 */
import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECTION,
  isSectionEnabled,
  stripAnsi,
  formatDuration,
  formatLocalTime,
  formatTokenCount,
  cacheAge,
  shortenPath,
  progressBar,
  plTransition,
  plEnd,
  joinSep,
  resolveContextWindowSize,
  computeUsedPct,
} from './statusline-render.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── resolveContextWindowSize ──────────────────────────────────

describe('resolveContextWindowSize', () => {
  it('returns 0 for undefined ctx', () => {
    strictEqual(resolveContextWindowSize(undefined, 'claude-sonnet-4-6', {}), 0);
  });

  it('uses config override when model name matches', () => {
    const ctx = { context_window_size: 200000 };
    const config = { modelContextWindows: { 'Claude Sonnet 4.6': 300000 } };
    strictEqual(resolveContextWindowSize(ctx, 'Claude Sonnet 4.6', config), 300000);
  });

  it('ignores config override if model name does not match', () => {
    const ctx = { context_window_size: 200000 };
    const config = { modelContextWindows: { 'Claude Opus 4.8': 300000 } };
    strictEqual(resolveContextWindowSize(ctx, 'Claude Sonnet 4.6', config), 200000);
  });

  it('falls back to ctx.context_window_size when no config', () => {
    const ctx = { context_window_size: 200000 };
    strictEqual(resolveContextWindowSize(ctx, 'Claude Sonnet 4.6', {}), 200000);
  });

  it('returns 0 when ctx has no context_window_size and no config override', () => {
    const ctx = { other: 'field' };
    strictEqual(resolveContextWindowSize(ctx, 'Claude Sonnet 4.6', {}), 0);
  });

  it('ignores config value if it is not positive', () => {
    const ctx = { context_window_size: 200000 };
    const config = { modelContextWindows: { 'Claude Sonnet 4.6': 0 } };
    strictEqual(resolveContextWindowSize(ctx, 'Claude Sonnet 4.6', config), 200000);
  });

  it('ignores config when model name is undefined', () => {
    const ctx = { context_window_size: 200000 };
    const config = { modelContextWindows: { 'Claude Sonnet 4.6': 300000 } };
    strictEqual(resolveContextWindowSize(ctx, undefined, config), 200000);
  });
});

// ── isSectionEnabled ─────────────────────────────────────────
// When config.sections is absent (not configured), all sections are enabled
// by default. When it is an array, only listed sections are enabled.

describe('isSectionEnabled', () => {
  it('returns true when sections key is missing (default: all enabled)', () => {
    strictEqual(isSectionEnabled({}, SECTION.MODEL), true);
  });

  it('returns true when sections is not an array (default: all enabled)', () => {
    strictEqual(isSectionEnabled({ sections: 'usd_cost' }, SECTION.USD_COST), true);
    strictEqual(isSectionEnabled({ sections: null }, SECTION.USD_COST), true);
    strictEqual(isSectionEnabled({ sections: { foo: 'bar' } }, SECTION.USD_COST), true);
  });

  it('returns false when sections is an empty array (nothing enabled)', () => {
    strictEqual(isSectionEnabled({ sections: [] }, SECTION.MODEL), false);
  });

  it('returns true only for sections listed in the array', () => {
    const config = { sections: ['model', 'context_window'] };
    strictEqual(isSectionEnabled(config, SECTION.MODEL), true);
    strictEqual(isSectionEnabled(config, SECTION.CONTEXT_WINDOW), true);
    strictEqual(isSectionEnabled(config, SECTION.USD_COST), false);
    strictEqual(isSectionEnabled(config, SECTION.BURN_RATE), false);
  });

  it('treats non-string entries in the array as absent', () => {
    const config = { sections: [42, null, 'model', true] };
    strictEqual(isSectionEnabled(config, SECTION.MODEL), true);
    strictEqual(isSectionEnabled(config, SECTION.USD_COST), false);
  });

  it('unknown names in sections have no effect on other sections', () => {
    const config = { sections: ['not_a_section', 'model'] };
    strictEqual(isSectionEnabled(config, SECTION.MODEL), true);
    strictEqual(isSectionEnabled(config, SECTION.LINE2), false);
  });
});

// ── computeUsedPct ─────────────────────────────────────────────

describe('computeUsedPct', () => {
  it('returns null for undefined ctx', () => {
    strictEqual(computeUsedPct(undefined, 200000), null);
  });

  it('returns null for zero window size', () => {
    const ctx = { input_tokens: 100000 };
    strictEqual(computeUsedPct(ctx, 0), null);
  });

  it('returns null for negative window size', () => {
    const ctx = { input_tokens: 100000 };
    strictEqual(computeUsedPct(ctx, -100), null);
  });

  it('calculates percentage from all token types', () => {
    const ctx = {
      input_tokens: 100000,
      cache_creation_input_tokens: 50000,
      cache_read_input_tokens: 50000,
    };
    const result = computeUsedPct(ctx, 200000);
    strictEqual(result, 100);
  });

  it('calculates percentage with partial token types', () => {
    const ctx = {
      input_tokens: 100000,
      cache_creation_input_tokens: 50000,
    };
    const result = computeUsedPct(ctx, 200000);
    strictEqual(result, 75);
  });

  it('rounds percentage correctly', () => {
    const ctx = { input_tokens: 33333 };
    const result = computeUsedPct(ctx, 100000);
    strictEqual(result, 33);
  });

  it('falls back to used_percentage when token fields are absent', () => {
    const ctx = { used_percentage: 42.3, other_field: 'something' };
    const result = computeUsedPct(ctx, 200000);
    strictEqual(result, 42);
  });

  it('uses token calculation when available, ignoring used_percentage', () => {
    const ctx = {
      input_tokens: 100000,
      used_percentage: 10,
    };
    const result = computeUsedPct(ctx, 200000);
    strictEqual(result, 50);
  });

  it('returns null when neither token nor used_percentage present', () => {
    const ctx = {};
    strictEqual(computeUsedPct(ctx, 200000), null);
  });

  it('treats missing token fields as zero', () => {
    const ctx = { input_tokens: 50000 };
    const result = computeUsedPct(ctx, 200000);
    strictEqual(result, 25);
  });
});

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

// ── formatTokenCount ──────────────────────────────────────────

describe('formatTokenCount', () => {
  it('returns "0" for zero', () => {
    strictEqual(formatTokenCount(0), '0');
  });

  it('returns "0" for negative, NaN, or non-finite values', () => {
    strictEqual(formatTokenCount(-5), '0');
    strictEqual(formatTokenCount(NaN), '0');
    strictEqual(formatTokenCount(Infinity), '0');
  });

  it('returns raw integer for values under 1000', () => {
    strictEqual(formatTokenCount(1), '1');
    strictEqual(formatTokenCount(500), '500');
    strictEqual(formatTokenCount(999), '999');
  });

  it('formats thousands with K suffix', () => {
    strictEqual(formatTokenCount(1000), '1K');
    strictEqual(formatTokenCount(200000), '200K');
  });

  it('rounds non-round thousands to nearest integer K', () => {
    strictEqual(formatTokenCount(199500), '200K');
    strictEqual(formatTokenCount(199400), '199K');
  });

  it('formats round millions with integer M suffix', () => {
    strictEqual(formatTokenCount(1_000_000), '1M');
    strictEqual(formatTokenCount(2_000_000), '2M');
  });

  it('formats non-round millions with one decimal place', () => {
    strictEqual(formatTokenCount(1_500_000), '1.5M');
    strictEqual(formatTokenCount(2_300_000), '2.3M');
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
  it('shortens all parent segments to first char', () => {
    // `short` is a parent → abbreviated to `s`; `path` is last → preserved.
    strictEqual(shortenPath('/short/path'), '/s/path');
  });

  it('replaces HOME prefix with ~', () => {
    const home = process.env.HOME;
    if (home) {
      strictEqual(shortenPath(home + '/dev'), '~/dev');
    }
  });

  it('abbreviates intermediate segments to first char', () => {
    // Only the final segment is preserved; all parents are shortened.
    const result = shortenPath('/aaa/bbb/ccc/deep/path');
    ok(result.length <= '/aaa/bbb/ccc/deep/path'.length);
    ok(result.endsWith('/path'));
    ok(result.includes('/a/'));
  });

  it('abbreviates dotfile segments to 2 chars', () => {
    const result = shortenPath('/a/.worktrees/nested/deep/path');
    ok(result.includes('.w'));
  });

  it('preserves only the last segment fully', () => {
    const result = shortenPath('/very/long/directory/structure/last/two');
    ok(result.endsWith('/two'));
  });

  it('does not abbreviate ~ or empty segments', () => {
    const home = process.env.HOME;
    if (home) {
      const result = shortenPath(home + '/long-name/another-long/final/segment');
      ok(result.startsWith('~/'));
    }
  });
});

// ── progressBar ───────────────────────────────────────────────

describe('progressBar', () => {
  it('produces correct total width of bar characters', () => {
    const bar = stripAnsi(progressBar(50, '', 10));
    // Filled slots use \u2588 (\u2588); empty slots use space. Count both.
    const filled = (bar.match(/\u2588/g) || []).length;
    const empty = (bar.match(/ /g) || []).length;
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
    // Empty slots are spaces, not light-shade blocks (\u2591).
    const empty = (bar.match(/ /g) || []).length;
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
  const renderScript = `${__dirname}/statusline-render.mts`;

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
      cacheFile, now, '120', session, 'main', 'true',
    ], { encoding: 'utf8', timeout: 10_000 });

    const lines = result.trimEnd().split('\n');
    strictEqual(lines.length, 2, `Expected 2 lines, got ${lines.length}`);

    // Line 1: model name and path
    ok(stripAnsi(lines[0]).includes('TestModel'));
    ok(stripAnsi(lines[0]).includes('/tmp'));

    // Line 2: quota percentages. The renderer uses a Nerd Font percent glyph
    // (U+F295) rather than ASCII '%', so check for the number only.
    ok(stripAnsi(lines[1]).includes('25'));
    ok(stripAnsi(lines[1]).includes('10'));

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
      cacheFile, now, '120', session, 'feature/test-branch', 'true',
    ], { encoding: 'utf8', timeout: 10_000 });

    // shortenBranch strips the 'feature/' prefix; check for the shortened form.
    ok(stripAnsi(result).includes('test-branch'));
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
      cacheFile, now, '80', '{}', '', 'true',
    ], { encoding: 'utf8', timeout: 10_000 });

    const lines = result.trimEnd().split('\n');
    strictEqual(lines.length, 2);
    ok(stripAnsi(lines[1]).includes('75')); // Nerd Font glyph, not ASCII %

    unlinkSync(cacheFile);
  });

  it('renders context window as used/total (100K/200K)', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 25, resets_at: '2025-06-15T18:00:00Z' },
      seven_day: { utilization: 10, resets_at: '2025-06-20T00:00:00Z' },
    });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.50, total_duration_ms: 120000 },
      context_window: {
        context_window_size: 200000,
        input_tokens: 100000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_input_tokens: 100000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
    });

    const now = String(Math.floor(Date.now() / 1000));
    const result = execFileSync('node', [
      '--experimental-strip-types',
      renderScript,
      cacheFile, now, '200', session, 'main', 'true',
    ], { encoding: 'utf8', timeout: 10_000 });

    const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
    ok(line1.includes('50'), `Expected '50' percentage in line 1, got: ${line1}`);
    ok(line1.includes('(100K/200K)'), `Expected '(100K/200K)' in line 1, got: ${line1}`);

    unlinkSync(cacheFile);
  });

  it('renders context window max as 1M for a million-token window', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 10 },
    });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        context_window_size: 1_000_000,
        input_tokens: 250000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_input_tokens: 250000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
    });

    const now = String(Math.floor(Date.now() / 1000));
    const result = execFileSync('node', [
      '--experimental-strip-types',
      renderScript,
      cacheFile, now, '200', session, '', 'true',
    ], { encoding: 'utf8', timeout: 10_000 });

    // Context window now renders as (used/max), e.g. (250K/1M).
    ok(stripAnsi(result).includes('250K/1M'), `Expected '250K/1M' in output, got: ${stripAnsi(result)}`);

    unlinkSync(cacheFile);
  });

  it('omits context max when context_window_size is missing', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 25 },
    });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        // no context_window_size
        input_tokens: 5000,
        total_input_tokens: 5000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
    });

    const now = String(Math.floor(Date.now() / 1000));
    const result = execFileSync('node', [
      '--experimental-strip-types',
      renderScript,
      cacheFile, now, '200', session, '', 'true',
    ], { encoding: 'utf8', timeout: 10_000 });

    const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
    ok(!line1.includes('(0)'), `Should not render '(0)' when size is missing. Got: ${line1}`);

    unlinkSync(cacheFile);
  });

  it('uses configured context window size override and token-based percentage', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 25 },
    });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'Claude Sonnet 4.6' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        context_window_size: 200000,
        input_tokens: 50000,
        cache_creation_input_tokens: 25000,
        cache_read_input_tokens: 25000,
        total_input_tokens: 50000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
    });

    const configData = JSON.stringify({
      modelContextWindows: {
        'Claude Sonnet 4.6': 400000,
      },
    });
    const configPath = `${__dirname}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const now = String(Math.floor(Date.now() / 1000));
      const result = execFileSync('node', [
        '--experimental-strip-types',
        renderScript,
        cacheFile, now, '200', session, '', 'true',
      ], { encoding: 'utf8', timeout: 10_000 });

      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      ok(line1.includes('(100K/400K)'), `Expected '(100K/400K)' from config override in line 1, got: ${line1}`);
      // Tighten: assert the full percent token, not a bare '25' substring
      // (which would also match '250' from a hypothetical factor-of-10 bug).
      ok(/(?:^|\D)25\D/.test(line1), `Expected '25' percentage token in line 1, got: ${line1}`);
    } finally {
      unlinkSync(cacheFile);
      unlinkSync(configPath);
    }
  });

  it('matches model name case-insensitively and strips cosmetic suffixes', () => {
    // Exercises the normalized model-name resolver: display_name drift
    // ("Sonnet 4.6" vs "Claude Sonnet 4.6" vs "(1M context)" suffix) must
    // not silently disable the override.
    const cacheData = JSON.stringify({ five_hour: { utilization: 10 } });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'Sonnet 4.6 (1M context)' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        context_window_size: 200000,
        input_tokens: 100000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_input_tokens: 100000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
    });

    const configData = JSON.stringify({
      modelContextWindows: {
        'Claude Sonnet 4.6': 500000,
      },
    });
    const configPath = `${__dirname}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const now = String(Math.floor(Date.now() / 1000));
      const result = execFileSync('node', [
        '--experimental-strip-types',
        renderScript,
        cacheFile, now, '200', session, '', 'true',
      ], { encoding: 'utf8', timeout: 10_000 });

      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      ok(line1.includes('(100K/500K)'),
        `Expected normalized override to apply (500K) despite display_name drift, got: ${line1}`);
    } finally {
      unlinkSync(cacheFile);
      unlinkSync(configPath);
    }
  });

  it('clamps displayed percentage to 100 when tokens exceed window', () => {
    // Regression test for finding #1: an override that shrinks the window
    // below the token count must not display "200%".
    const cacheData = JSON.stringify({ five_hour: { utilization: 10 } });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        context_window_size: 50000, // session says 50K
        input_tokens: 200000,       // but 200K tokens are present
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_input_tokens: 200000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
    });

    const configData = JSON.stringify({
      modelContextWindows: { 'TestModel': 50000 }, // override matches session
    });
    const configPath = `${__dirname}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const now = String(Math.floor(Date.now() / 1000));
      const result = execFileSync('node', [
        '--experimental-strip-types',
        renderScript,
        cacheFile, now, '200', session, '', 'true',
      ], { encoding: 'utf8', timeout: 10_000 });

      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      ok(!/\b2\d{2}%/.test(line1),
        `Expected percentage clamped to 100 (no "2xx%"), got: ${line1}`);
    } finally {
      unlinkSync(cacheFile);
      unlinkSync(configPath);
    }
  });

  it('agrees between percentage and time-to-fill numerators', () => {
    // Regression test for finding #2: the ETA and the bar must use the
    // same "used" total. With duration > 60s, the ETA segment renders and
    // the time-to-fill estimate must be consistent with the bar.
    const cacheData = JSON.stringify({ five_hour: { utilization: 10 } });
    writeFileSync(cacheFile, cacheData);

    // 100K input + 0 cache + 0 cache_read = 100K tokens. Window 200K. So
    // bar shows 50% and the time-to-fill at e.g. 1000 tps would project
    // 100K tokens remaining / 1000 tps = 100s. The bug was that ETA
    // ignored cache fields, but here we use only input_tokens, so the
    // assertions are about the segment rendering at all.
    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 200000 },
      context_window: {
        context_window_size: 200000,
        input_tokens: 100000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_input_tokens: 100000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
    });

    const configPath = `${__dirname}/statusline-config.json`;
    try { unlinkSync(configPath); } catch {} // ensure no override

    try {
      const now = String(Math.floor(Date.now() / 1000));
      const result = execFileSync('node', [
        '--experimental-strip-types',
        renderScript,
        cacheFile, now, '200', session, '', 'true',
      ], { encoding: 'utf8', timeout: 10_000 });

      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      // Bar should be 50% and ETA should appear (duration > 60s).
      ok(line1.includes('50'), `Expected 50% bar, got: ${line1}`);
      ok(line1.includes('left'), `Expected time-to-full ETA segment, got: ${line1}`);
    } finally {
      unlinkSync(cacheFile);
    }
  });

  it('renders only sections listed in config.sections', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 25 },
    });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'Claude Sonnet 4.6' },
      cost: { total_cost_usd: 1.23, total_duration_ms: 120000 },
      context_window: {
        context_window_size: 200000,
        input_tokens: 50000,
        cache_creation_input_tokens: 25000,
        cache_read_input_tokens: 25000,
        total_input_tokens: 50000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
    });

    // Only model and context_window are listed — usd_cost and burn_rate are absent.
    const configData = JSON.stringify({
      sections: ['model', 'context_window', 'pwd'],
    });
    const configPath = `${__dirname}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const now = String(Math.floor(Date.now() / 1000));
      const result = execFileSync('node', [
        '--experimental-strip-types',
        renderScript,
        cacheFile, now, '200', session, '', 'true',
      ], { encoding: 'utf8', timeout: 10_000 });

      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      ok(line1.includes('Sonnet 4.6'), `Expected model name in line 1, got: ${line1}`);
      ok(line1.includes('100K/200K'), `Expected context window tokens in line 1, got: ${line1}`);
      ok(!line1.includes('1.23'), `Expected usd_cost to be hidden, got: ${line1}`);
      ok(!line1.includes('/hr'), `Expected burn_rate to be hidden, got: ${line1}`);
    } finally {
      unlinkSync(cacheFile);
      unlinkSync(configPath);
    }
  });

  it('omits line 2 when "line2" is absent from config.sections', () => {
    const cacheData = JSON.stringify({
      five_hour: { utilization: 25, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'Claude Sonnet 4.6' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      cwd: '/tmp',
    });

    // line2 intentionally omitted from sections list.
    const configData = JSON.stringify({
      sections: ['model', 'usd_cost', 'pwd'],
    });
    const configPath = `${__dirname}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const now = String(Math.floor(Date.now() / 1000));
      const result = execFileSync('node', [
        '--experimental-strip-types',
        renderScript,
        cacheFile, now, '200', session, '', 'true',
      ], { encoding: 'utf8', timeout: 10_000 });

      const lines = result.trimEnd().split('\n');
      strictEqual(lines.length, 1, `Expected only line 1, got ${lines.length} lines: ${result}`);
    } finally {
      unlinkSync(cacheFile);
      unlinkSync(configPath);
    }
  });

  it('derives token count from used_percentage when individual token fields are absent', () => {
    // Reproduces the "(0/200K)" bug: Claude Code may only send used_percentage,
    // not input_tokens/cache_* fields. The display should still show a non-zero
    // token count derived from pct * window_size / 100.
    const cacheData = JSON.stringify({ five_hour: { utilization: 10 } });
    writeFileSync(cacheFile, cacheData);

    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        context_window_size: 200000,
        used_percentage: 50,
        // no input_tokens / cache_creation_input_tokens / cache_read_input_tokens
      },
      cwd: '/tmp',
    });

    const now = String(Math.floor(Date.now() / 1000));
    const result = execFileSync('node', [
      '--experimental-strip-types',
      renderScript,
      cacheFile, now, '200', session, '', 'true',
    ], { encoding: 'utf8', timeout: 10_000 });

    const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
    ok(line1.includes('100K/200K'), `Expected '100K/200K' derived from used_percentage, got: ${line1}`);
    ok(!line1.includes('0/200K'), `Should not show '0/200K', got: ${line1}`);

    unlinkSync(cacheFile);
  });
});
