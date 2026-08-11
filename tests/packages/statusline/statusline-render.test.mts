/*  Run the tests:
 *    node --experimental-strip-types --test tests/packages/statusline/statusline-render.test.mts
 */
import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECTION,
  isSectionEnabled,
  stripAnsi,
  formatDuration,
  formatLocalTime,
  formatTokenCount,
  shortenPath,
  progressBar,
  plTransition,
  plEnd,
  joinSep,
  resolveContextWindowSize,
  computeUsedPct,
  fitSegments,
  renderPowerline,
  buildContextTiers,
  buildBranchTiers,
  buildModelTiers,
  buildPathTiers,
  PROTECTED_PRIORITY,
} from '../../../packages/statusline/statusline-render.mts';

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

  it('leaves the last segment untouched when maxLastLen is omitted', () => {
    strictEqual(shortenPath('/a/a-genuinely-long-final-directory-name'), '/a/a-genuinely-long-final-directory-name');
  });

  it('ellipsis-truncates the last segment when it exceeds maxLastLen', () => {
    const result = shortenPath('/a/a-genuinely-long-final-directory-name', 12);
    ok(result.endsWith('…'), `expected ellipsis, got: ${result}`);
    ok(stripAnsi(result.split('/').pop()!).length === 12);
  });

  it('does not truncate a last segment already shorter than maxLastLen', () => {
    strictEqual(shortenPath('/a/short', 12), '/a/short');
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

describe('fitSegments', () => {
  // Regression test for the "drops down to empty" bug: fitSegments used to
  // have no floor and would remove every segment, including protected
  // ones, at a narrow enough width.
  it('never drops protected (priority >= PROTECTED_PRIORITY) segments even when maxWidth is far too small', () => {
    const segs = [
      { section: 22, priority: PROTECTED_PRIORITY, content: 'model-content' },
      { section: 22, priority: 5, content: 'optional-content' },
    ];
    const fitted = fitSegments(segs, 1);
    ok(fitted.some(s => s.priority >= PROTECTED_PRIORITY), 'protected segment should survive');
    ok(!fitted.some(s => s.priority < PROTECTED_PRIORITY), 'droppable segment should be dropped');
  });

  it('removes droppable segments in ascending priority order (lowest priority = dropped first)', () => {
    const segs = [
      { section: 22, priority: 3, content: 'AAAAAAAAAA' },
      { section: 22, priority: 1, content: 'BBBBBBBBBB' },
      { section: 22, priority: 5, content: 'CCCCCCCCCC' },
    ];
    // Width tight enough to force dropping the two lowest-priority segments,
    // leaving only the priority:5 segment.
    const fitted = fitSegments(segs, 12);
    strictEqual(fitted.length, 1);
    strictEqual(fitted[0].content, 'CCCCCCCCCC');
  });

  it('keeps everything when it already fits', () => {
    const segs = [
      { section: 22, priority: PROTECTED_PRIORITY, content: 'x' },
      { section: 22, priority: 5, content: 'y' },
    ];
    const fitted = fitSegments(segs, 100);
    strictEqual(fitted.length, 2);
  });
});

describe('buildContextTiers', () => {
  it('full tier includes bar and used/total suffix', () => {
    const tiers = buildContextTiers(45, 200000, { input_tokens: 90000 });
    ok(stripAnsi(tiers[0]).includes('45'));
    ok(stripAnsi(tiers[0]).includes('90K/200K'));
  });

  it('middle tier drops the used/total suffix but keeps the bar', () => {
    const tiers = buildContextTiers(45, 200000, { input_tokens: 90000 });
    ok(!stripAnsi(tiers[1]).includes('90K/200K'));
    ok(stripAnsi(tiers[1]).includes('45'));
  });

  it('third tier drops the bar too, keeping icon + percentage only', () => {
    const tiers = buildContextTiers(45, 200000, { input_tokens: 90000 });
    const tier = stripAnsi(tiers[2]);
    ok(tier.includes('45'));
    ok(!tier.includes('90K'));
    ok(tier.length < stripAnsi(tiers[1]).length);
  });

  it('shortest (fourth) tier drops the percentage too, leaving only the icon', () => {
    const tiers = buildContextTiers(45, 200000, { input_tokens: 90000 });
    const shortest = stripAnsi(tiers[3]);
    ok(!shortest.includes('45'), `expected no percentage digits, got: ${shortest}`);
    ok(shortest.length < stripAnsi(tiers[2]).length);
  });
});

describe('buildBranchTiers', () => {
  const longBranch = 'feature/a-genuinely-long-branch-name-for-testing';

  it('produces progressively shorter tiers for a long branch name', () => {
    const tiers = buildBranchTiers(longBranch);
    const lengths = tiers.map(t => stripAnsi(t).length);
    ok(lengths[0] > lengths[1]);
    ok(lengths[1] > lengths[2]);
  });

  it('strips known prefixes and preserves short names in every tier', () => {
    const tiers = buildBranchTiers('fix/short');
    for (const tier of tiers) {
      ok(stripAnsi(tier).includes('short'), `expected 'short' in: ${stripAnsi(tier)}`);
      ok(!stripAnsi(tier).includes('fix/'), `prefix should be stripped in: ${stripAnsi(tier)}`);
    }
  });
});

describe('buildModelTiers', () => {
  it('full tier shows the complete display name', () => {
    const tiers = buildModelTiers('Opus 4.6');
    ok(stripAnsi(tiers[0]).includes('Opus 4.6'));
  });

  it('shrinks to the first letter of the normalized family name', () => {
    strictEqual(stripAnsi(buildModelTiers('Opus 4.6')[1]).trim().slice(-1), 'O');
    strictEqual(stripAnsi(buildModelTiers('Claude Sonnet 4.6')[1]).trim().slice(-1), 'S');
    strictEqual(stripAnsi(buildModelTiers('Haiku 3.5')[1]).trim().slice(-1), 'H');
  });

  it('strips "Claude " and "(...context)" decoration before taking the letter', () => {
    strictEqual(stripAnsi(buildModelTiers('Claude Sonnet 4.6 (1M context)')[1]).trim().slice(-1), 'S');
  });
});

describe('buildPathTiers', () => {
  const longDir = '/a/a-genuinely-long-final-directory-name';

  it('first tier leaves the last segment untouched', () => {
    const tiers = buildPathTiers(longDir);
    ok(stripAnsi(tiers[0]).includes('a-genuinely-long-final-directory-name'));
  });

  it('produces progressively shorter tiers for a long final segment', () => {
    const tiers = buildPathTiers(longDir);
    const lengths = tiers.map(t => stripAnsi(t).length);
    ok(lengths[0] > lengths[1], `tier 0 (${lengths[0]}) should be longer than tier 1 (${lengths[1]})`);
    ok(lengths[1] > lengths[2], `tier 1 (${lengths[1]}) should be longer than tier 2 (${lengths[2]})`);
  });

  it('every tier still abbreviates parent directories', () => {
    const tiers = buildPathTiers(longDir);
    for (const tier of tiers) {
      ok(stripAnsi(tier).includes('/a/'), `expected abbreviated parent in: ${stripAnsi(tier)}`);
    }
  });

  it('leaves a short final segment untouched across all tiers', () => {
    const tiers = buildPathTiers('/a/short');
    for (const tier of tiers) {
      ok(stripAnsi(tier).includes('/a/short'), `expected untruncated 'short' in: ${stripAnsi(tier)}`);
    }
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
  // The renderer resolves its config file (statusline-config.json) relative
  // to its own module location, not the test file's -- rendererDir below
  // must point there for the config-override tests' temp files to be seen.
  const renderScript = resolve(__dirname, '../../../packages/statusline/statusline-render.mts');
  const rendererDir = dirname(renderScript);

  // Helper: Unix timestamps for quota resets (future values so reset labels render)
  const fiveHourResets = Math.floor(Date.now() / 1000) + 3600;
  const sevenDayResets = Math.floor(Date.now() / 1000) + 604800;

  const run = (termWidth: string, session: string, branch = '') =>
    execFileSync('node', [
      '--experimental-strip-types', renderScript, termWidth, session, branch,
    ], { encoding: 'utf8', timeout: 10_000 });

  it('does not throw when a rate_limits bucket has usage but no resets_at', () => {
    // Regression: `resets_at` can be absent on a bucket that has usage but
    // hasn't started its reset window yet. `new Date(undefined * 1000)` is
    // an Invalid Date, and `.toISOString()` on it throws uncaught, which
    // crashes the renderer (statusline.sh then shows "Usage: parse error").
    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cwd: '/tmp',
      rate_limits: {
        five_hour: { used_percentage: 10 },
        seven_day: { used_percentage: 5 },
      },
    });

    const result = run('120', session, 'main');
    const lines = result.trimEnd().split('\n');
    strictEqual(lines.length, 2, `Expected 2 lines, got ${lines.length}`);
  });

  it('produces two lines of output with valid input', () => {
    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.50, total_duration_ms: 120000 },
      cwd: '/tmp',
      rate_limits: {
        five_hour: { used_percentage: 25, resets_at: fiveHourResets },
        seven_day: { used_percentage: 10, resets_at: sevenDayResets },
      },
    });

    const result = run('120', session, 'main');
    const lines = result.trimEnd().split('\n');
    strictEqual(lines.length, 2, `Expected 2 lines, got ${lines.length}`);

    ok(stripAnsi(lines[0]).includes('TestModel'));
    ok(stripAnsi(lines[0]).includes('/tmp'));

    // Line 2: quota percentages (Nerd Font % glyph, check number only)
    ok(stripAnsi(lines[1]).includes('25'));
    ok(stripAnsi(lines[1]).includes('10'));
  });

  it('includes git branch when provided', () => {
    const session = JSON.stringify({
      cwd: '/tmp',
      rate_limits: { five_hour: { used_percentage: 50, resets_at: fiveHourResets } },
    });

    const result = run('120', session, 'feature/test-branch');
    ok(stripAnsi(result).includes('test-branch'));
  });

  it('renders without session data (empty object)', () => {
    const session = JSON.stringify({
      rate_limits: { five_hour: { used_percentage: 75, resets_at: fiveHourResets } },
    });

    const result = run('80', session);
    const lines = result.trimEnd().split('\n');
    strictEqual(lines.length, 2);
    ok(stripAnsi(lines[1]).includes('75'));
  });

  it('renders context window as used/total (100K/200K)', () => {
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
      rate_limits: {
        five_hour: { used_percentage: 25, resets_at: fiveHourResets },
        seven_day: { used_percentage: 10, resets_at: sevenDayResets },
      },
    });

    const result = run('200', session, 'main');
    const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
    ok(line1.includes('50'), `Expected '50' percentage in line 1, got: ${line1}`);
    ok(line1.includes('(100K/200K)'), `Expected '(100K/200K)' in line 1, got: ${line1}`);
  });

  it('renders context window max as 1M for a million-token window', () => {
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
      rate_limits: { five_hour: { used_percentage: 10, resets_at: fiveHourResets } },
    });

    const result = run('200', session);
    ok(stripAnsi(result).includes('250K/1M'), `Expected '250K/1M' in output, got: ${stripAnsi(result)}`);
  });

  it('omits context max when context_window_size is missing', () => {
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
      rate_limits: { five_hour: { used_percentage: 25, resets_at: fiveHourResets } },
    });

    const result = run('200', session);
    const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
    ok(!line1.includes('(0)'), `Should not render '(0)' when size is missing. Got: ${line1}`);
  });

  it('uses configured context window size override and token-based percentage', () => {
    const session = JSON.stringify({
      model: { display_name: 'Claude Sonnet 4.6' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        context_window_size: 200000,
        input_tokens: 50000,
        cache_creation_input_tokens: 25000,
        cache_read_input_tokens: 25000,
        total_input_tokens: 100000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
      rate_limits: { five_hour: { used_percentage: 25, resets_at: fiveHourResets } },
    });

    const configData = JSON.stringify({ modelContextWindows: { 'Claude Sonnet 4.6': 400000 } });
    const configPath = `${rendererDir}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const result = run('200', session);
      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      ok(line1.includes('(100K/400K)'), `Expected '(100K/400K)' from config override in line 1, got: ${line1}`);
      ok(/(?:^|\D)25\D/.test(line1), `Expected '25' percentage token in line 1, got: ${line1}`);
    } finally {
      unlinkSync(configPath);
    }
  });

  it('matches model name case-insensitively and strips cosmetic suffixes', () => {
    // Exercises the normalized model-name resolver: display_name drift
    // ("Sonnet 4.6" vs "Claude Sonnet 4.6" vs "(1M context)" suffix) must
    // not silently disable the override.
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
      rate_limits: { five_hour: { used_percentage: 10, resets_at: fiveHourResets } },
    });

    const configData = JSON.stringify({ modelContextWindows: { 'Claude Sonnet 4.6': 500000 } });
    const configPath = `${rendererDir}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const result = run('200', session);
      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      ok(line1.includes('(100K/500K)'),
        `Expected normalized override to apply (500K) despite display_name drift, got: ${line1}`);
    } finally {
      unlinkSync(configPath);
    }
  });

  it('clamps displayed percentage to 100 when tokens exceed window', () => {
    // Regression: an override that shrinks the window below the token count
    // must not display "200%".
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
      rate_limits: { five_hour: { used_percentage: 10, resets_at: fiveHourResets } },
    });

    const configData = JSON.stringify({ modelContextWindows: { 'TestModel': 50000 } });
    const configPath = `${rendererDir}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const result = run('200', session);
      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      ok(!/\b2\d{2}%/.test(line1),
        `Expected percentage clamped to 100 (no "2xx%"), got: ${line1}`);
    } finally {
      unlinkSync(configPath);
    }
  });

  it('agrees between percentage and time-to-fill numerators', () => {
    // Regression: the ETA and bar must use the same "used" total.
    // 100K input = 50% of 200K → bar shows 50%, ETA segment renders.
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
      rate_limits: { five_hour: { used_percentage: 10, resets_at: fiveHourResets } },
    });

    const configPath = `${rendererDir}/statusline-config.json`;
    try { unlinkSync(configPath); } catch {} // ensure no override

    const result = run('200', session);
    const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
    ok(line1.includes('50'), `Expected 50% bar, got: ${line1}`);
    ok(line1.includes('left'), `Expected time-to-full ETA segment, got: ${line1}`);
  });

  it('renders only sections listed in config.sections', () => {
    const session = JSON.stringify({
      model: { display_name: 'Claude Sonnet 4.6' },
      cost: { total_cost_usd: 1.23, total_duration_ms: 120000 },
      context_window: {
        context_window_size: 200000,
        input_tokens: 50000,
        cache_creation_input_tokens: 25000,
        cache_read_input_tokens: 25000,
        total_input_tokens: 100000,
        total_output_tokens: 0,
      },
      cwd: '/tmp',
      rate_limits: { five_hour: { used_percentage: 25, resets_at: fiveHourResets } },
    });

    const configData = JSON.stringify({ sections: ['model', 'context_window', 'pwd'] });
    const configPath = `${rendererDir}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const result = run('200', session);
      const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
      ok(line1.includes('Sonnet 4.6'), `Expected model name in line 1, got: ${line1}`);
      ok(line1.includes('100K/200K'), `Expected context window tokens in line 1, got: ${line1}`);
      ok(!line1.includes('1.23'), `Expected usd_cost to be hidden, got: ${line1}`);
      ok(!line1.includes('/hr'), `Expected burn_rate to be hidden, got: ${line1}`);
    } finally {
      unlinkSync(configPath);
    }
  });

  it('omits line 2 when "line2" is absent from config.sections', () => {
    const session = JSON.stringify({
      model: { display_name: 'Claude Sonnet 4.6' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      cwd: '/tmp',
      rate_limits: { five_hour: { used_percentage: 25, resets_at: fiveHourResets } },
    });

    const configData = JSON.stringify({ sections: ['model', 'usd_cost', 'pwd'] });
    const configPath = `${rendererDir}/statusline-config.json`;
    writeFileSync(configPath, configData);

    try {
      const result = run('200', session);
      const lines = result.trimEnd().split('\n');
      strictEqual(lines.length, 1, `Expected only line 1, got ${lines.length} lines: ${result}`);
    } finally {
      unlinkSync(configPath);
    }
  });

  it('reads total_input_tokens from current_usage nested structure (Claude Code 2.x format)', () => {
    // Real-world format: token breakdown is nested under current_usage and
    // total_input_tokens holds the authoritative sum at the top level.
    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        total_input_tokens: 152589,
        total_output_tokens: 8,
        context_window_size: 200000,
        current_usage: {
          input_tokens: 3,
          output_tokens: 8,
          cache_creation_input_tokens: 1472,
          cache_read_input_tokens: 151114,
        },
        used_percentage: 76,
        remaining_percentage: 24,
      },
      cwd: '/tmp',
      rate_limits: { five_hour: { used_percentage: 10, resets_at: fiveHourResets } },
    });

    const result = run('200', session);
    const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
    ok(line1.includes('153K/200K'), `Expected '153K/200K' from total_input_tokens, got: ${line1}`);
    ok(!line1.includes('0/200K'), `Should not show '0/200K', got: ${line1}`);
  });

  it('derives token count from used_percentage when individual token fields are absent', () => {
    // Reproduces the "(0/200K)" bug: Claude Code may only send used_percentage,
    // not input_tokens/cache_* fields. The display should derive a non-zero count.
    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      cost: { total_cost_usd: 0.10, total_duration_ms: 30000 },
      context_window: {
        context_window_size: 200000,
        used_percentage: 50,
        // no input_tokens / cache_creation_input_tokens / cache_read_input_tokens
      },
      cwd: '/tmp',
      rate_limits: { five_hour: { used_percentage: 10, resets_at: fiveHourResets } },
    });

    const result = run('200', session);
    const line1 = stripAnsi(result.trimEnd().split('\n')[0]);
    ok(line1.includes('100K/200K'), `Expected '100K/200K' derived from used_percentage, got: ${line1}`);
    ok(!line1.includes('0/200K'), `Should not show '0/200K', got: ${line1}`);
  });

  it('never drops a block as the terminal widens, and protected blocks always survive', () => {
    // Regression test for the RIGHT_RESERVE cliff (termWidth 79 -> maxWidth 79,
    // termWidth 80 -> maxWidth 60) and for fitSegments dropping protected
    // segments: widening the terminal must never remove a previously-shown
    // block, or shrink a previously-longer model/branch/path string, and
    // model/context/branch/pwd must appear (in some tier) at every width
    // tested, however narrow.
    const longBranch = 'feature/a-genuinely-long-branch-name-for-monotonic-testing';
    // Matching literals from statusline-render.mts (private-use Nerd Font glyphs).
    const ICON_BOLT = '';
    const ICON_GIT = '';
    const ICON_FOLDER = '';

    const session = JSON.stringify({
      model: { display_name: 'MonoModel' },
      cost: { total_cost_usd: 1.23, total_duration_ms: 4_000_000, total_lines_added: 12, total_lines_removed: 3 },
      context_window: {
        context_window_size: 200000,
        input_tokens: 90000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      cwd: '/tmp/a-genuinely-long-monotonic-directory-name',
    });

    const widths = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 150, 200];
    const markers = ['$1.23', '/hr', '+12', 'left'];

    // Extracts the text between an icon and the next segment/transition
    // separator, for tracking a protected segment's rendered length.
    const extractLen = (line1: string, icon: string) => {
      const m = line1.match(new RegExp(`${icon} (.*?) [▶│]`, 'u'));
      return m ? m[1].trim().length : 0;
    };

    let prevPresent = new Set<string>();
    let prevModelLen = 0, prevBranchLen = 0, prevPathLen = 0;
    for (const w of widths) {
      const line1 = stripAnsi(run(String(w), session, longBranch).trimEnd().split('\n')[0]);

      ok(line1.includes(ICON_BOLT), `model missing at width ${w}`);
      ok(line1.includes(ICON_GIT), `branch missing at width ${w}`);
      ok(line1.includes(ICON_FOLDER), `pwd missing at width ${w}`);

      const modelLen = extractLen(line1, ICON_BOLT);
      ok(modelLen >= prevModelLen, `widening to ${w} shortened the model string (was ${prevModelLen} chars, now ${modelLen})`);
      prevModelLen = modelLen;

      const branchLen = extractLen(line1, ICON_GIT);
      ok(branchLen >= prevBranchLen, `widening to ${w} shortened the branch string (was ${prevBranchLen} chars, now ${branchLen})`);
      prevBranchLen = branchLen;

      const pathLen = extractLen(line1, ICON_FOLDER);
      ok(pathLen >= prevPathLen, `widening to ${w} shortened the path string (was ${prevPathLen} chars, now ${pathLen})`);
      prevPathLen = pathLen;

      const present = new Set(markers.filter(m => line1.includes(m)));
      for (const m of prevPresent) {
        ok(present.has(m), `widening to ${w} dropped '${m}' that was present at a narrower width`);
      }
      prevPresent = present;
    }
  })

  it('shrinks context usage instead of dropping it as the terminal narrows', () => {
    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      context_window: {
        context_window_size: 200000,
        input_tokens: 90000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      cwd: '/tmp',
    });

    const wide = stripAnsi(run('200', session).trimEnd().split('\n')[0]);
    ok(wide.includes('90K/200K'), `expected full context tier at width 200, got: ${wide}`);

    const narrow = stripAnsi(run('25', session).trimEnd().split('\n')[0]);
    ok(!narrow.includes('90K/200K'), `expected shrunk context tier at width 25, got: ${narrow}`);
    ok(narrow.includes('45'), 'percentage should still be present at width 25 (bar dropped, not yet the icon-only tier)');

    // Narrower still: the fourth tier drops the percentage too, leaving only the icon.
    const narrowest = stripAnsi(run('15', session).trimEnd().split('\n')[0]);
    ok(!narrowest.includes('45'), `expected icon-only context tier at width 15, got: ${narrowest}`);
  });

  it('shrinks branch through its length ladder only after context is fully shrunk', () => {
    const longBranch = 'feature/a-genuinely-long-branch-name-for-tier-testing';
    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      context_window: {
        context_window_size: 200000,
        input_tokens: 90000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      cwd: '/tmp',
    });

    const wide = stripAnsi(run('200', session, longBranch).trimEnd().split('\n')[0]);
    ok(wide.includes('a-genuinely-long-branch'), `expected untruncated branch at width 200, got: ${wide}`);

    // Narrow enough that context has already dropped to its shortest tier
    // (no '90K/200K', no bar) before branch needs to shrink at all.
    const mid = stripAnsi(run('45', session, longBranch).trimEnd().split('\n')[0]);
    ok(!mid.includes('90K/200K'), `expected context already shrunk at width 45, got: ${mid}`);

    // Narrower still: branch must now be shrinking too.
    const narrow = stripAnsi(run('30', session, longBranch).trimEnd().split('\n')[0]);
    ok(narrow.includes('…'), `expected truncated branch at width 30, got: ${narrow}`);
  });

  it('shrinks path last, only after model, context, and branch are all fully shrunk', () => {
    const longBranch = 'feature/short'; // short enough to never need to shrink itself
    const session = JSON.stringify({
      model: { display_name: 'TestModel' },
      context_window: {
        context_window_size: 200000,
        input_tokens: 90000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      cwd: '/Users/someone/dev/a-genuinely-long-final-directory-name',
    });

    const wide = stripAnsi(run('200', session, longBranch).trimEnd().split('\n')[0]);
    ok(wide.includes('a-genuinely-long-final-directory-name'), `expected untruncated path at width 200, got: ${wide}`);

    // Narrow enough that model and context have both already given up
    // everything they can (branch here is short and never needs to shrink),
    // before path needs to shrink at all.
    const mid = stripAnsi(run('72', session, longBranch).trimEnd().split('\n')[0]);
    ok(!mid.includes('45'), `expected context already at its icon-only tier at width 72, got: ${mid}`);
    ok(mid.includes('a-genuinely-long-final-directory-name'), `expected path still untruncated at width 72, got: ${mid}`);

    // Narrower still: path must now be shrinking too.
    const narrow = stripAnsi(run('65', session, longBranch).trimEnd().split('\n')[0]);
    ok(narrow.includes('…'), `expected truncated path at width 65, got: ${narrow}`);
  });
});
