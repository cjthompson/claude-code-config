#!/usr/bin/env node
// Claude Code statusline renderer — two-line powerline with session, environment, and quota info
// Called by statusline.sh with args: <usage-cache-path> <cache-mtime> <term-width> <session-json> <git-branch>

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// ── ANSI ──────────────────────────────────────────────────────
const RST  = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM  = '\x1b[2m';

const PL_RIGHT = '\u25b6'; // ▶
const PL_SOFT  = '\u2502'; // │

const bg = (n: number): string => '\x1b[48;5;' + n + 'm';
const fg = (n: number): string => '\x1b[38;5;' + n + 'm';

// Named backgrounds
const BG_GREEN = bg(22);
const BG_DARK  = bg(233);
const BG_BLUE  = bg(24);

// Named foregrounds
const WHITE      = fg(255);
const GRAY_FG    = fg(245);
const CYAN_FG    = fg(117);
const GREEN_FG   = fg(156);
const GREEN_DIM  = fg(108);
const YELLOW_FG  = fg(221);
const RED_FG     = fg(203);
const ORANGE_FG  = fg(215);
const BLUE_FG    = fg(111);
const MAGENTA_FG = fg(176);
const GREEN_114  = fg(114);

// Reset-to-background shortcuts
const R_GREEN = RST + BG_GREEN;
const R_DARK  = RST + BG_DARK;

// ── Utilities ─────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Powerline helpers ─────────────────────────────────────────

// Transition between two background colors
function plTransition(bgNumFrom: number, bgNumTo: number): string {
  return fg(bgNumFrom) + bg(bgNumTo) + PL_RIGHT + RST + bg(bgNumTo);
}

// Cap off a powerline line (transition to default terminal bg)
function plEnd(bgNum: number): string {
  return fg(bgNum) + PL_RIGHT + RST;
}

// Join separator for powerline sections within the same background
function joinSep(bgStr: string, sepColorNum: number): string {
  return fg(sepColorNum) + PL_SOFT + RST + bgStr;
}

// ── Progress bar ──────────────────────────────────────────────
function progressBar(pct: number, bgStr: string, width: number): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let barColor: string;
  if (pct >= 80) barColor = RED_FG;
  else if (pct >= 60) barColor = ORANGE_FG;
  else if (pct >= 40) barColor = YELLOW_FG;
  else barColor = GREEN_114;

  return barColor + '\u2588'.repeat(filled) + fg(248) + '\u2591'.repeat(empty) + RST + bgStr;
}

// ── Formatters ────────────────────────────────────────────────
function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h' + (m > 0 ? m + 'm' : '');
  return m + 'm';
}

function formatLocalTime(isoStr: string): string {
  const d = new Date(isoStr);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ampm;
}

function cacheAge(mtime: number): string {
  const ageSec = Math.floor(Date.now() / 1000) - mtime;
  if (ageSec < 60) return 'new';
  return Math.floor(ageSec / 60) + 'm old';
}

// Shorten path: ~/dev/neat-core-js/.worktrees/sso → ~/d/n/.w/sso
// Always shortens parent dirs: ~/dev/neat-core-js → ~/d/neat-core-js
// Keeps only the last segment intact; shortens all parent dirs to first char (or .X for dotdirs)
function shortenPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);

  const parts = p.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === '~' || parts[i] === '') continue;
    if (parts[i].startsWith('.')) {
      parts[i] = parts[i].slice(0, 2);
    } else {
      parts[i] = parts[i][0];
    }
  }
  return parts.join('/');
}

// Shorten branch: chore/improve-playwright-tests → improve-playwri…
function shortenBranch(branch: string, maxLen: number): string {
  branch = branch.replace(/^(chore|feature|feat|fix|bugfix|hotfix|release)\//i, '');
  if (branch.length <= maxLen) return branch;
  return branch.slice(0, maxLen - 1) + '\u2026';
}

// ── Quota window formatter ────────────────────────────────────
function formatQuotaWindow(
  window: Record<string, any> | undefined,
  label: string,
  labelColor: string,
  isWide: boolean,
  formatReset: (iso: string) => string,
): string | null {
  if (!window) return null;
  const pct = Math.round(window.utilization);
  let resetStr = '';
  if (window.resets_at) {
    resetStr = ' ' + GRAY_FG + formatReset(window.resets_at) + R_DARK;
  }
  return ' ' + labelColor + BOLD + label + ' ' + R_DARK +
    WHITE + pct + '% ' + R_DARK +
    progressBar(pct, BG_DARK, isWide ? 12 : 8) +
    resetStr + ' ';
}

// ── Exports (for testing) ─────────────────────────────────────
export {
  stripAnsi,
  formatDuration,
  formatLocalTime,
  cacheAge,
  shortenPath,
  shortenBranch,
  progressBar,
  plTransition,
  plEnd,
  joinSep,
  formatQuotaWindow,
};

// ── Powerline renderer ────────────────────────────────────────
// Renders an array of segments into a powerline string.
// Consecutive segments with the same section bg are joined with │ separators.
// Different section bgs get ▶ transitions.

interface PowerlineSeg {
  section: number;  // background color number (22=green, 24=blue, 237=gray)
  content: string;  // ANSI styled content
  drop: number;     // higher = less important = dropped first
}

const SECTION_STYLES: Record<number, { bg: string; sep: number }> = {
  22:  { bg: BG_GREEN, sep: 34 },
  24:  { bg: BG_BLUE,  sep: 30 },
  237: { bg: bg(237),  sep: 240 },
};

function renderPowerline(segs: PowerlineSeg[]): string {
  if (segs.length === 0) return '';

  // Group consecutive same-section segments
  const groups: { bgNum: number; parts: string[] }[] = [];
  for (const seg of segs) {
    const last = groups[groups.length - 1];
    if (last && last.bgNum === seg.section) {
      last.parts.push(seg.content);
    } else {
      groups.push({ bgNum: seg.section, parts: [seg.content] });
    }
  }

  let line = '';
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const style = SECTION_STYLES[g.bgNum] || { bg: bg(g.bgNum), sep: 240 };
    if (i === 0) {
      line += RST + bg(g.bgNum);
    } else {
      line += plTransition(groups[i - 1].bgNum, g.bgNum);
    }
    line += g.parts.join(joinSep(style.bg, style.sep));
  }
  line += RST + plEnd(groups[groups.length - 1].bgNum);
  return line;
}

// Fit segments to a width budget by dropping least-important segments first
function fitSegments(segs: PowerlineSeg[], maxWidth: number): PowerlineSeg[] {
  const active = [...segs];
  while (active.length > 0 && stripAnsi(renderPowerline(active)).length >= maxWidth) {
    // Find and remove the segment with the highest drop value
    let maxDrop = -1, maxIdx = -1;
    for (let i = 0; i < active.length; i++) {
      if (active[i].drop > maxDrop) { maxDrop = active[i].drop; maxIdx = i; }
    }
    active.splice(maxIdx, 1);
  }
  return active;
}

// ── Quota segment builder ─────────────────────────────────────
function quotaSeg(
  window: Record<string, any> | undefined,
  label: string,
  labelColor: string,
  opts: { bar?: number; reset?: string },
): string | null {
  if (!window) return null;
  const pct = Math.round(window.utilization);
  let s = ' ' + labelColor + BOLD + label + ' ' + R_DARK + WHITE + pct + '% ' + R_DARK;
  if (opts.bar != null) s += progressBar(pct, BG_DARK, opts.bar);
  if (opts.reset) s += ' ' + GRAY_FG + opts.reset + R_DARK;
  return s + ' ';
}

export { renderPowerline, fitSegments, quotaSeg };

// ── Main rendering ────────────────────────────────────────────
function main(): void {
  const usageCachePath: string = process.argv[2];
  const cacheMtime: number = Number(process.argv[3]);
  const termWidth: number = Number(process.argv[4]);
  const session: Record<string, any> = JSON.parse(process.argv[5] || '{}');
  const gitBranch: string = process.argv[6] || '';

  const data: Record<string, any> = JSON.parse(readFileSync(usageCachePath, 'utf8'));

  const cost = session.cost;
  const ctx = session.context_window;
  const model = session.model;
  const cwd: string = session.cwd || process.cwd();

  // Claude Code's right column sits inline when wide enough, wraps below when narrow
  const RIGHT_RESERVE = termWidth >= 80 ? 37 : 0;
  const maxWidth = termWidth - RIGHT_RESERVE;
  const isWide = termWidth >= 120;
  const barWidth = isWide ? 12 : 8;

  // ════════════════════════════════════════════════════════════════
  // LINE 1: Segments in display order, each with a drop priority
  // ════════════════════════════════════════════════════════════════

  const shortPath = shortenPath(cwd);
  const branchMaxLen = isWide ? 25 : 18;
  const shortBranch = gitBranch ? shortenBranch(gitBranch, branchMaxLen) : '';

  //                                                          drop priority:
  //                                                          (higher = dropped first)
  const line1Segs: PowerlineSeg[] = [];

  if (model?.display_name)
    line1Segs.push({ section: 22, drop: 0, content:
      WHITE + BOLD + ' ' + model.display_name + ' ' });

  if (cost?.total_cost_usd != null)
    line1Segs.push({ section: 22, drop: 5, content:
      ' ' + GREEN_FG + BOLD + '\u0024' + cost.total_cost_usd.toFixed(2) + R_GREEN + ' ' });

  if (cost?.total_cost_usd != null && cost.total_duration_ms > 60_000) {
    const rate = cost.total_cost_usd / (cost.total_duration_ms / 3_600_000);
    line1Segs.push({ section: 22, drop: 10, content:
      ' ' + GREEN_DIM + '\u0024' + rate.toFixed(2) + '/hr' + R_GREEN + ' ' });
  }

  if (ctx?.used_percentage != null) {
    const pct = Math.round(ctx.used_percentage);
    line1Segs.push({ section: 22, drop: 2, content:
      WHITE + ' ' + pct + '% ' + R_GREEN + progressBar(pct, BG_GREEN, 8) + ' ' });
  }

  if (ctx?.total_input_tokens > 0 && ctx?.context_window_size > 0 && cost?.total_duration_ms > 60_000) {
    const used = ctx.total_input_tokens + ctx.total_output_tokens;
    const rem = ctx.context_window_size - used;
    if (rem > 0) {
      const tps = used / (cost.total_duration_ms / 1000);
      if (tps > 0)
        line1Segs.push({ section: 22, drop: 9, content:
          ' ' + GREEN_DIM + '~' + formatDuration(Math.floor(rem / tps)) + ' left' + R_GREEN + ' ' });
    }
  }

  if (cost && (cost.total_lines_added > 0 || cost.total_lines_removed > 0))
    line1Segs.push({ section: 22, drop: 7, content:
      ' ' + GREEN_114 + '+' + (cost.total_lines_added || 0) + R_GREEN + ' ' +
      RED_FG + '-' + (cost.total_lines_removed || 0) + R_GREEN + ' ' });

  if (cost?.total_duration_ms > 0)
    line1Segs.push({ section: 22, drop: 6, content:
      ' ' + GREEN_DIM + formatDuration(Math.floor(cost.total_duration_ms / 1000)) + R_GREEN + ' ' });

  line1Segs.push({ section: 24, drop: 4, content:
    CYAN_FG + ' \uf07c ' + WHITE + shortPath + ' ' });

  if (shortBranch)
    line1Segs.push({ section: 237, drop: 3, content:
      fg(148) + ' \ue0a0 ' + shortBranch + ' ' });

  const line1 = renderPowerline(fitSegments(line1Segs, maxWidth));

  // ════════════════════════════════════════════════════════════════
  // LINE 2: Quota — pre-computed tiers from most to least detailed
  // ════════════════════════════════════════════════════════════════

  // Pre-compute reset strings
  const fiveHrFullReset = data.five_hour?.resets_at
    ? formatDuration(Math.max(0, Math.floor((new Date(data.five_hour.resets_at).getTime() - Date.now()) / 1000)))
      + ' (' + formatLocalTime(data.five_hour.resets_at) + ')'
    : '';
  const fiveHrTime = data.five_hour?.resets_at ? formatLocalTime(data.five_hour.resets_at) : '';
  const sevenDayFull = data.seven_day?.resets_at
    ? new Date(data.seven_day.resets_at).toLocaleDateString('en-US', { weekday: 'short' })
      + ' ' + formatLocalTime(data.seven_day.resets_at)
    : '';
  const ageStr = ' ' + DIM + GRAY_FG + '(' + cacheAge(cacheMtime) + ')' + R_DARK + ' ';
  const sep2 = joinSep(BG_DARK, 240);

  const f = (bar: boolean, reset: string) => quotaSeg(data.five_hour, '5h', CYAN_FG, { bar: bar ? barWidth : undefined, reset });
  const s = (bar: boolean, reset: string) => quotaSeg(data.seven_day, '7d', BLUE_FG, { bar: bar ? barWidth : undefined, reset });

  function wrapL2(parts: (string | null)[]): string {
    const valid = parts.filter(Boolean) as string[];
    if (valid.length === 0) return '';
    return BG_DARK + valid.join(sep2) + plEnd(233);
  }

  // Tiers: most detailed → least detailed
  const line2Tiers = [
    wrapL2([f(true, fiveHrFullReset), s(true, sevenDayFull), ageStr]),   // full
    wrapL2([f(true, fiveHrFullReset), s(true, sevenDayFull)]),           // drop cache age
    wrapL2([f(true, fiveHrTime),      s(true, sevenDayFull)]),           // 5h: time only
    wrapL2([f(true, fiveHrTime),      s(true, '')]),                     // drop 7d reset
    wrapL2([f(true, fiveHrTime),      s(false, '')]),                    // drop 7d bar
    wrapL2([f(false, fiveHrTime),     s(false, '')]),                    // drop 5h bar
    wrapL2([f(false, fiveHrTime)]),                                      // drop 7d entirely
    wrapL2([f(false, '')]),                                              // drop 5h reset
  ];

  let line2 = '';
  for (const tier of line2Tiers) {
    if (tier && stripAnsi(tier).length < maxWidth) { line2 = tier; break; }
  }

  // ════════════════════════════════════════════════════════════════
  // Output
  // ════════════════════════════════════════════════════════════════
  console.log(line1);
  if (line2) console.log(line2);
}

// Run only when executed directly (not when imported by tests)
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main();
}
