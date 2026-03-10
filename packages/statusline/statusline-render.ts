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

const bg = (n: number) => `\x1b[48;5;${n}m`;
const fg = (n: number) => `\x1b[38;5;${n}m`;
// Combined sequence: reset + fg + bg (+ optional bold) in one atomic escape (survives terminal reflow)
const combo = (fgN: number, bgN: number, bold = false) =>
  `\x1b[0;${bold ? '1;' : ''}38;5;${fgN};48;5;${bgN}m`;

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
const GREEN_114  = fg(114);

// Reset-to-background shortcuts
const R_GREEN = RST + BG_GREEN;
const R_DARK  = RST + BG_DARK;

// ── Nerd Font Icons ──────────────────────────────────────────
const ICON_BOLT      = '\uf0e7';  // model
const ICON_DOLLAR    = '\uf155';  // cost
const ICON_CLOCK     = '\uf017';  // cost rate
const ICON_HOURGLASS = '\uf252';  // time left
const ICON_PENCIL    = '\uf044';  // lines changed
const ICON_FOLDER    = '\uf115';  // directory
const ICON_GIT       = '\ue725';  // git branch
const PCT            = '\uf295';  // powerline percent (replaces ASCII %)
const PLUS           = '\ueb71';  // up arrow
const MINUS          = '\ueb6e';  // down arrow
const FIVE           = '\udb82\udf3e'; // 5
const SEVEN          = '\udb82\udf40'; // 7
const BAR_BG         = bg(238);

// ── Multi-level icon sets ────────────────────────────────────
// Factory: picks an icon from an array based on percentage
const levelIcon = (icons: string[]) => (pct: number) =>
  icons[Math.min(icons.length - 1, Math.max(0, Math.round(pct / 100 * (icons.length - 1))))];

const FRAC_BLOCKS = [' ', '\u258f', '\u258e', '\u258d', '\u258c', '\u258b', '\u258a', '\u2589', '\u2588'];
//                    0    ▏ 1/8     ▎ 1/4     ▍ 3/8     ▌ 1/2     ▋ 5/8     ▊ 3/4     ▉ 7/8     █ full

// Circle slices (8 levels) — context window
const circleIcon = levelIcon([
  '\uDB82\uDE9E', '\uDB82\uDE9F', '\uDB82\uDEA0', '\uDB82\uDEA1',
  '\uDB82\uDEA2', '\uDB82\uDEA3', '\uDB82\uDEA4', '\uDB82\uDEA5',
]);

// Battery (9 levels) — 5h quota
const batteryIcon = levelIcon([
  '\uDB80\uDC7A', '\uDB80\uDC7B', '\uDB80\uDC7C', '\uDB80\uDC7D', '\uDB80\uDC7E',
  '\uDB80\uDC7F', '\uDB80\uDC80', '\uDB80\uDC81', '\uDB80\uDC82',
]);

// Thermometer (5 levels) — 7d quota
const thermoIcon = levelIcon(['\uf2cb', '\uf2ca', '\uf2c9', '\uf2c8', '\uf2c7']);

// ── Utilities ─────────────────────────────────────────────────

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── Powerline helpers ─────────────────────────────────────────

const plTransition = (bgFrom: number, bgTo: number) =>
  `${fg(bgFrom)}${bg(bgTo)}${PL_RIGHT}${RST}${bg(bgTo)}`;

const plEnd = (bgNum: number) =>
  `${fg(bgNum)}${PL_RIGHT}${RST}`;

const joinSep = (bgStr: string, sepColor: number) =>
  `${fg(sepColor)}${PL_SOFT}${RST}${bgStr}`;

// ── Progress bar (fractional blocks for sub-character precision) ──
function progressBar(pct: number, sectionBg: string, width: number): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width * 8);
  const fullBlocks = Math.floor(filled / 8);
  const frac = filled % 8;
  const empty = width - fullBlocks - (frac > 0 ? 1 : 0);

  const barColor = pct >= 80 ? RED_FG
    : pct >= 60 ? ORANGE_FG
    : pct >= 40 ? YELLOW_FG
    : GREEN_114;

  return `${barColor}${BAR_BG}${'\u2588'.repeat(fullBlocks)}${frac > 0 ? FRAC_BLOCKS[frac] : ''}${' '.repeat(Math.max(0, empty))}${RST}${sectionBg}`;
}

// ── Formatters ────────────────────────────────────────────────
function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h${m > 0 ? `${m}m` : ''}` : `${m}m`;
}

function formatLocalTime(isoStr: string): string {
  const d = new Date(isoStr);
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  return `${h}:${m}${ampm}`;
}

function cacheAge(mtime: number): string {
  const ageSec = Math.floor(Date.now() / 1000) - mtime;
  return ageSec < 60 ? 'new' : `${Math.floor(ageSec / 60)}m old`;
}

// Shorten path: ~/dev/neat-core-js/.worktrees/sso → ~/d/n/.w/sso
// Always shortens parent dirs: ~/dev/neat-core-js → ~/d/neat-core-js
// Keeps only the last segment intact; shortens all parent dirs to first char (or .X for dotdirs)
function shortenPath(p: string): string {
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) p = `~${p.slice(home.length)}`;

  const parts = p.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === '~' || parts[i] === '') continue;
    parts[i] = parts[i].startsWith('.') ? parts[i].slice(0, 2) : parts[i][0];
  }
  return parts.join('/');
}

// Shorten branch: chore/improve-playwright-tests → improve-playwri…
const BRANCH_PREFIXES = /^(chore|feature|feat|fix|bugfix|hotfix|release)\//i;

function shortenBranch(branch: string, maxLen: number): string {
  const shortened = branch.replace(BRANCH_PREFIXES, '');
  return shortened.length <= maxLen ? shortened : `${shortened.slice(0, maxLen - 1)}\u2026`;
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
    const last = groups.at(-1);
    if (last?.bgNum === seg.section) {
      last.parts.push(seg.content);
    } else {
      groups.push({ bgNum: seg.section, parts: [seg.content] });
    }
  }

  let line = '';
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const style = SECTION_STYLES[g.bgNum] ?? { bg: bg(g.bgNum), sep: 240 };
    line += i === 0
        ? `${RST}${bg(g.bgNum)}`
        : plTransition(groups[i - 1].bgNum, g.bgNum);
    line += g.parts.join(joinSep(style.bg, style.sep));
  }
  line += `${RST}${plEnd(groups.at(-1)!.bgNum)}`;
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
  iconFn: (pct: number) => string,
  opts: { bar?: number; reset?: string },
): string | null {
  if (!window) return null;
  const pct = Math.round(window.utilization);
  let s = ` ${labelColor}${BOLD}${iconFn(pct)} ${label} ${R_DARK}${WHITE}${pct}${PCT} ${R_DARK}`;
  if (opts.bar != null) s += progressBar(pct, BG_DARK, opts.bar);
  if (opts.reset) s += ` ${GRAY_FG}${opts.reset}${R_DARK}`;
  return `${s} `;
}

export { renderPowerline, fitSegments, quotaSeg };

// ── Quota line builder ────────────────────────────────────────
function buildQuotaLine(
  data: Record<string, any>,
  cacheMtime: number,
  barWidth: number,
  maxWidth: number,
): string {
  const fiveHrFullReset = data.five_hour?.resets_at
    ? `${formatDuration(Math.max(0, Math.floor((new Date(data.five_hour.resets_at).getTime() - Date.now()) / 1000)))} (${formatLocalTime(data.five_hour.resets_at)})`
    : '';
  const fiveHrTime = data.five_hour?.resets_at ? formatLocalTime(data.five_hour.resets_at) : '';
  const sevenDayFull = data.seven_day?.resets_at
    ? `${new Date(data.seven_day.resets_at).toLocaleDateString('en-US', { weekday: 'short' })} ${formatLocalTime(data.seven_day.resets_at)}`
    : '';
  const ageStr = ` ${DIM}${GRAY_FG}(${cacheAge(cacheMtime)})${R_DARK} `;
  const sep2 = joinSep(BG_DARK, 240);

  const f = (bar: boolean, reset: string) => quotaSeg(data.five_hour, `${FIVE}h`, CYAN_FG, batteryIcon, { bar: bar ? barWidth : undefined, reset });
  const s = (bar: boolean, reset: string) => quotaSeg(data.seven_day, `${SEVEN}d`, BLUE_FG, thermoIcon, { bar: bar ? barWidth : undefined, reset });

  const wrapL2 = (parts: (string | null)[]) => {
    const valid = parts.filter(Boolean) as string[];
    return valid.length === 0 ? '' : `${BG_DARK}${valid.join(sep2)}${plEnd(233)}`;
  };

  const tiers = [
    wrapL2([f(true, fiveHrFullReset), s(true, sevenDayFull), ageStr]),
    wrapL2([f(true, fiveHrFullReset), s(true, sevenDayFull)]),
    wrapL2([f(true, fiveHrTime),      s(true, sevenDayFull)]),
    wrapL2([f(true, fiveHrTime),      s(true, '')]),
    wrapL2([f(true, fiveHrTime),      s(false, '')]),
    wrapL2([f(false, fiveHrTime),     s(false, '')]),
    wrapL2([f(false, fiveHrTime)]),
    wrapL2([f(false, '')]),
  ];

  return tiers.find(tier => tier && stripAnsi(tier).length < maxWidth) ?? '';
}

export { buildQuotaLine };

// ── Main rendering ────────────────────────────────────────────
function main(): void {
  const usageCachePath = process.argv[2];
  const cacheMtime = Number(process.argv[3]);
  const termWidth = Number(process.argv[4]);
  const session: Record<string, any> = JSON.parse(process.argv[5] || '{}');
  const gitBranch = process.argv[6] ?? '';
  const hasUsage = process.argv[7] === 'true';

  const data: Record<string, any> = hasUsage
    ? JSON.parse(readFileSync(usageCachePath, 'utf8'))
    : {};

  const cost = session.cost;
  const ctx = session.context_window;
  const model = session.model;
  const cwd = session.cwd ?? process.cwd();

  // Claude Code's right column sits inline when wide enough, wraps below when narrow
  const RIGHT_RESERVE = termWidth >= 80 ? 37 : 0;
  const maxWidth = termWidth - RIGHT_RESERVE;
  const isWide = termWidth >= 120;
  const barWidth = isWide ? 12 : 8;

  // ════════════════════════════════════════════════════════════════
  // LINE 1: Segments in display order, each with a drop priority
  // ════════════════════════════════════════════════════════════════

  const shortPath = shortenPath(cwd);
  const shortBranch = gitBranch ? shortenBranch(gitBranch, isWide ? 25 : 18) : '';

  const line1Segs: PowerlineSeg[] = [];

  if (model?.display_name)
    line1Segs.push({ section: 22, drop: 0, content:
      `${combo(255, 22, true)} ${ICON_BOLT} ${model.display_name} ` });

  if (cost?.total_cost_usd != null)
    line1Segs.push({ section: 22, drop: 5, content:
      ` ${GREEN_FG}${BOLD}${ICON_DOLLAR}${cost.total_cost_usd.toFixed(2)}${R_GREEN} ` });

  if (cost?.total_cost_usd != null && cost.total_duration_ms > 60_000) {
    const rate = cost.total_cost_usd / (cost.total_duration_ms / 3_600_000);
    line1Segs.push({ section: 22, drop: 10, content:
      ` ${GREEN_DIM}${ICON_CLOCK} \$${rate.toFixed(2)}/hr${R_GREEN} ` });
  }

  if (ctx?.used_percentage != null) {
    const pct = Math.round(ctx.used_percentage);
    line1Segs.push({ section: 22, drop: 2, content:
      ` ${WHITE}${circleIcon(pct)} ${pct}${PCT} ${R_GREEN}${progressBar(pct, BG_GREEN, 8)} ` });
  }

  if (ctx?.total_input_tokens > 0 && ctx?.context_window_size > 0 && cost?.total_duration_ms > 60_000) {
    const used = ctx.total_input_tokens + ctx.total_output_tokens;
    const rem = ctx.context_window_size - used;
    if (rem > 0) {
      const tps = used / (cost.total_duration_ms / 1000);
      if (tps > 0)
        line1Segs.push({ section: 22, drop: 9, content:
          ` ${GREEN_DIM}${ICON_HOURGLASS} ~${formatDuration(Math.floor(rem / tps))} left${R_GREEN} ` });
    }
  }

  if (cost && (cost.total_lines_added > 0 || cost.total_lines_removed > 0))
    line1Segs.push({ section: 22, drop: 7, content:
      ` ${GREEN_DIM}${ICON_PENCIL} ${GREEN_114}${PLUS}${cost.total_lines_added || 0}${R_GREEN} ${RED_FG}${MINUS}${cost.total_lines_removed || 0}${R_GREEN} ` });

  if (cost?.total_duration_ms > 0)
    line1Segs.push({ section: 22, drop: 6, content:
      ` ${GREEN_DIM}${formatDuration(Math.floor(cost.total_duration_ms / 1000))}${R_GREEN} ` });

  line1Segs.push({ section: 24, drop: 4, content:
    `${CYAN_FG} ${ICON_FOLDER} ${WHITE}${shortPath} ` });

  if (shortBranch)
    line1Segs.push({ section: 237, drop: 3, content:
      `${fg(148)} ${ICON_GIT} ${shortBranch} ` });

  const line1 = renderPowerline(fitSegments(line1Segs, maxWidth));

  // ════════════════════════════════════════════════════════════════
  // LINE 2: Quota — pre-computed tiers from most to least detailed
  // ════════════════════════════════════════════════════════════════

  const line2 = hasUsage ? buildQuotaLine(data, cacheMtime, barWidth, maxWidth) : '';

  // ════════════════════════════════════════════════════════════════
  // Output
  // ════════════════════════════════════════════════════════════════
  console.log(line1);
  if (line2) console.log(line2);
}

// Run only when executed directly (not when imported by tests)
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
