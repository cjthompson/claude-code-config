#!/usr/bin/env node
// Claude Code statusline renderer — two-line powerline with session, environment, and quota info
// Called by statusline.sh with args: <term-width> <session-json> <git-branch>

import { readFileSync, existsSync, realpathSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── ANSI ──────────────────────────────────────────────────────
const RST  = '\x1b[0m';
const BOLD = '\x1b[1m';

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

// ── Section names (for config-driven allowlist) ──────────────
// Each name maps to a single segment in line 1, or to the whole line 2.
// A section renders only when its name appears in `config.sections`
// (an opt-in array). When the key is missing or not an array, nothing
// renders — the list is a whitelist, not a blacklist. New sections
// added in future versions stay off until the user opts in.
const SECTION = {
  MODEL: 'model',
  USD_COST: 'usd_cost',
  BURN_RATE: 'burn_rate',
  CONTEXT_WINDOW: 'context_window',
  TIME_TO_FULL: 'time_to_full',
  LINES_CHANGED: 'lines_changed',
  DURATION: 'duration',
  BRANCH: 'branch',
  PWD: 'pwd',
  LINE2: 'line2',
} as const;

type SectionName = typeof SECTION[keyof typeof SECTION];

// True when `name` is listed in config.sections. Defensive: missing
// key, non-array value, or non-string entries mean nothing is enabled.
function isSectionEnabled(config: Record<string, any>, name: SectionName): boolean {
  const arr = config.sections;
  if (!Array.isArray(arr)) return true;
  return arr.includes(name);
}

// Normalize a model display name for lookup against `modelContextWindows`.
// Anthropic renames display_name between releases (e.g. "Claude Sonnet 4.6"
// → "Sonnet 4.6", or appends "(1M context)" suffixes), so exact match breaks
// silently. Strip cosmetic decoration and lowercase the result.
function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(\d+[mk]?\s*context\)\s*/i, '') // "(1M context)", "(200K context)"
    .replace(/^claude\s+/, '')                     // leading "Claude "
    .trim();
}

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

// ── Context window helpers ─────────────────────────────────────
function resolveContextWindowSize(
  ctx: Record<string, any> | undefined,
  modelName: string | undefined,
  config: Record<string, any>,
): number {
  if (!ctx) return 0;
  const overrides = config.modelContextWindows;
  if (modelName && overrides && typeof overrides === 'object') {
    // Try exact match first, then normalized (handles "Sonnet 4.6" vs
    // "Claude Sonnet 4.6 (1M context)" display_name drift across versions).
    if (overrides[modelName] > 0) return overrides[modelName];
    const normalized = normalizeModelName(modelName);
    for (const key of Object.keys(overrides)) {
      if (normalizeModelName(key) === normalized && overrides[key] > 0) {
        return overrides[key];
      }
    }
  }
  return ctx.context_window_size ?? 0;
}

// Single source of truth for "tokens that count against the context window".
// Used by both the progress bar (computeUsedPct) and the time-to-fill ETA so
// the two segments agree on what "used" means.
//
// Claude Code 2.x moved the per-type breakdown into ctx.current_usage and
// added ctx.total_input_tokens as the authoritative sum. Older test fixtures
// still use the flat top-level layout.
function totalContextTokens(ctx: Record<string, any> | undefined): number {
  if (!ctx) return 0;
  if (ctx.total_input_tokens != null) return ctx.total_input_tokens;
  if (ctx.current_usage) {
    const u = ctx.current_usage;
    return (u.input_tokens ?? 0)
      + (u.cache_creation_input_tokens ?? 0)
      + (u.cache_read_input_tokens ?? 0);
  }
  return (ctx.input_tokens ?? 0)
    + (ctx.cache_creation_input_tokens ?? 0)
    + (ctx.cache_read_input_tokens ?? 0);
}

function computeUsedPct(
  ctx: Record<string, any> | undefined,
  windowSize: number,
): number | null {
  if (!ctx || windowSize <= 0) return null;

  const totalTokens = totalContextTokens(ctx);
  if (totalTokens > 0) {
    return Math.round((totalTokens / windowSize) * 100);
  }

  if (ctx.used_percentage != null) {
    return Math.round(ctx.used_percentage);
  }

  return null;
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

function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

// Shorten path: ~/dev/neat-core-js/.worktrees/sso → ~/d/n/.w/sso
// Always shortens parent dirs: ~/dev/neat-core-js → ~/d/neat-core-js
// Keeps the last segment intact by default; pass maxLastLen to also
// ellipsis-truncate it once nothing else is left to shrink.
function shortenPath(p: string, maxLastLen: number = Infinity): string {
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) p = `~${p.slice(home.length)}`;

  const parts = p.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === '~' || parts[i] === '') continue;
    parts[i] = parts[i].startsWith('.') ? parts[i].slice(0, 2) : parts[i][0];
  }

  const lastIdx = parts.length - 1;
  const last = parts[lastIdx];
  if (last.length > maxLastLen) {
    parts[lastIdx] = maxLastLen > 1 ? `${last.slice(0, maxLastLen - 1)}…` : last.slice(0, maxLastLen);
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
  SECTION,
  isSectionEnabled,
  stripAnsi,
  formatDuration,
  formatLocalTime,
  formatTokenCount,
  shortenPath,
  shortenBranch,
  progressBar,
  plTransition,
  plEnd,
  joinSep,
  resolveContextWindowSize,
  computeUsedPct,
};

// ── Powerline renderer ────────────────────────────────────────
// Renders an array of segments into a powerline string.
// Consecutive segments with the same section bg are joined with │ separators.
// Different section bgs get ▶ transitions.

interface PowerlineSeg {
  section: number;   // background color number (22=green, 24=blue, 237=gray)
  content: string;   // ANSI styled content
  priority: number;  // higher = more important = kept longer. >= PROTECTED_PRIORITY = never dropped.
}

// Segments at or above this priority (model, context, branch, pwd) are
// never removed by fitSegments — only shrunk (context/branch tiers) or
// left to overflow. Real droppable priorities are single digits, so 100
// leaves a wide, deliberate margin.
const PROTECTED_PRIORITY = 100;

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

// Fit segments to a width budget by dropping the lowest-priority segment
// first. Stops once only protected (priority >= PROTECTED_PRIORITY)
// segments remain, rather than falling through to an unguarded splice
// that would delete the wrong (protected) element.
function fitSegments(segs: PowerlineSeg[], maxWidth: number): PowerlineSeg[] {
  const active = [...segs];
  while (stripAnsi(renderPowerline(active)).length >= maxWidth) {
    let minPriority = Infinity, minIdx = -1;
    for (let i = 0; i < active.length; i++) {
      if (active[i].priority < minPriority) { minPriority = active[i].priority; minIdx = i; }
    }
    if (minIdx === -1 || minPriority >= PROTECTED_PRIORITY) break;
    active.splice(minIdx, 1);
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

export { renderPowerline, fitSegments, quotaSeg, PROTECTED_PRIORITY };

// ── Quota line builder ────────────────────────────────────────
// Bar width is tried widest-first, across the *entire* detail-tier ladder,
// before falling back to a narrower bar -- so it only shrinks when the
// line genuinely doesn't fit, not at a fixed termWidth threshold
// regardless of whether anything actually overflows (the same class of
// bug RIGHT_RESERVE was for line 1).
const QUOTA_BAR_WIDTH_CANDIDATES = [12, 8];

function buildQuotaLine(
  data: Record<string, any>,
  maxWidth: number,
): string {
  const fiveHrFullReset = data.five_hour?.resets_at
    ? `${formatDuration(Math.max(0, Math.floor((new Date(data.five_hour.resets_at).getTime() - Date.now()) / 1000)))} (${formatLocalTime(data.five_hour.resets_at)})`
    : '';
  const fiveHrTime = data.five_hour?.resets_at ? formatLocalTime(data.five_hour.resets_at) : '';
  const sevenDayFull = data.seven_day?.resets_at
    ? `${new Date(data.seven_day.resets_at).toLocaleDateString('en-US', { weekday: 'short' })} ${formatLocalTime(data.seven_day.resets_at)}`
    : '';
  const sep2 = joinSep(BG_DARK, 240);

  const wrapL2 = (parts: (string | null)[]) => {
    const valid = parts.filter(Boolean) as string[];
    return valid.length === 0 ? '' : `${BG_DARK}${valid.join(sep2)}${plEnd(233)}`;
  };

  for (const barWidth of QUOTA_BAR_WIDTH_CANDIDATES) {
    const f = (bar: boolean, reset: string) => quotaSeg(data.five_hour, `${FIVE}h`, CYAN_FG, batteryIcon, { bar: bar ? barWidth : undefined, reset });
    const s = (bar: boolean, reset: string) => quotaSeg(data.seven_day, `${SEVEN}d`, BLUE_FG, thermoIcon, { bar: bar ? barWidth : undefined, reset });

    const tiers = [
      wrapL2([f(true, fiveHrFullReset), s(true, sevenDayFull)]),
      wrapL2([f(true, fiveHrTime),      s(true, sevenDayFull)]),
      wrapL2([f(true, fiveHrTime),      s(true, '')]),
      wrapL2([f(true, fiveHrTime),      s(false, '')]),
      wrapL2([f(false, fiveHrTime),     s(false, '')]),
      wrapL2([f(false, fiveHrTime)]),
      wrapL2([f(false, '')]),
    ];

    const fit = tiers.find(tier => tier && stripAnsi(tier).length < maxWidth);
    if (fit) return fit;
  }
  return '';
}

export { buildQuotaLine };

// ── Context-usage tiers ─────────────────────────────────────────
// Context usage is a core (never-dropped) segment, so instead of vanishing
// under width pressure it shrinks: full → drop the (used/total) suffix →
// drop the bar too (icon + percentage only) → drop the percentage too
// (icon only — conveys "about how full", not an exact number). Mirrors
// the tier pattern buildQuotaLine already uses for line 2.
function buildContextTiers(
  usedPct: number,
  effectiveWindowSize: number,
  ctx: Record<string, any> | undefined,
): string[] {
  // Clamp for display so a percentage over 100% (e.g. an override that
  // shrinks the window below the token count) doesn't print as raw "200%"
  // alongside a fully-filled bar — show a cap of 100% in that case.
  const displayPct = Math.min(100, Math.max(0, usedPct));
  // When individual token fields are absent (Claude Code only sends
  // used_percentage), derive an approximate count from the percentage.
  const rawTokens = totalContextTokens(ctx);
  const totalTokens = rawTokens > 0 ? rawTokens
    : effectiveWindowSize > 0 ? Math.round(usedPct * effectiveWindowSize / 100)
    : 0;
  const icon = `${WHITE}${circleIcon(usedPct)}`;
  const head = ` ${icon} ${displayPct}${PCT} `;
  const bar = `${R_GREEN}${progressBar(usedPct, BG_GREEN, 8)}`;
  const tokens = effectiveWindowSize > 0
    ? ` ${GREEN_DIM}(${formatTokenCount(totalTokens)}/${formatTokenCount(effectiveWindowSize)})${R_GREEN}`
    : '';
  return [
    `${head}${bar}${tokens} `, // full
    `${head}${bar} `,          // drop the (used/total) suffix
    `${head}`,                 // drop the bar too — icon + % only
    ` ${icon} `,                // drop the percentage too — icon only
  ];
}

export { buildContextTiers };

// ── Branch tiers ─────────────────────────────────────────────
// Branch is protected (never dropped), so instead of a blunt width
// threshold picking one of two fixed caps regardless of whether the line
// actually needs the room, it gets its own shrink ladder.
const BRANCH_LENGTH_TIERS = [25, 18, 12];

function buildBranchTiers(branch: string): string[] {
  return BRANCH_LENGTH_TIERS.map(len =>
    `${CYAN_FG} ${ICON_GIT} ${WHITE}${shortenBranch(branch, len)} `);
}

export { buildBranchTiers };

// ── Model tiers ───────────────────────────────────────────────
// Model is protected (never dropped). Its one shrink step abbreviates the
// full display name down to a single letter from the normalized family
// name (handles "Claude " prefixes and "(1M context)" suffixes the same
// way resolveContextWindowSize's lookup does) -- e.g. "Claude Sonnet 4.6"
// -> "S", "Opus 4.6" -> "O", "Haiku 3.5" -> "H".
function buildModelTiers(displayName: string): string[] {
  const letter = (normalizeModelName(displayName)[0] ?? '?').toUpperCase();
  return [
    `${combo(255, 22, true)} ${ICON_BOLT} ${displayName} `,
    `${combo(255, 22, true)} ${ICON_BOLT} ${letter} `,
  ];
}

export { buildModelTiers };

// ── Path tiers ────────────────────────────────────────────────
// Path is protected (never dropped). Parent directories are always
// abbreviated to one character regardless of width (shortenPath's default
// behavior); the last segment stays full until every other lever --
// model, context, branch -- has already given up everything it can, at
// which point it starts ellipsis-truncating too, as the final squeeze.
const PATH_LAST_SEGMENT_LENGTH_TIERS = [Infinity, 12, 8];

function buildPathTiers(cwd: string): string[] {
  return PATH_LAST_SEGMENT_LENGTH_TIERS.map(len =>
    `${fg(148)} ${ICON_FOLDER} ${shortenPath(cwd, len)} `);
}

export { buildPathTiers };

// ── Main rendering ────────────────────────────────────────────
function main(): void {
  const termWidth = Number(process.argv[2]);
  const session: Record<string, any> = JSON.parse(process.argv[3] || '{}');
  const gitBranch = process.argv[4] ?? '';

  // Normalise session.rate_limits (Unix timestamps, used_percentage) into the
  // shape buildQuotaLine expects (ISO resets_at strings, utilization field).
  const rl = session.rate_limits;
  const data: Record<string, any> = rl ? {
    five_hour: rl.five_hour ? {
      utilization: rl.five_hour.used_percentage,
      resets_at: rl.five_hour.resets_at
        ? new Date(rl.five_hour.resets_at * 1000).toISOString()
        : undefined,
    } : undefined,
    seven_day: rl.seven_day ? {
      utilization: rl.seven_day.used_percentage,
      resets_at: rl.seven_day.resets_at
        ? new Date(rl.seven_day.resets_at * 1000).toISOString()
        : undefined,
    } : undefined,
  } : {};
  const hasUsage = !!(rl?.five_hour || rl?.seven_day);

  // Config is read on every render (the renderer is spawned fresh per cycle).
  // existsSync short-circuits the common case where no file exists, avoiding
  // a wasted syscall + exception construction per render. The negative
  // result is not module-cached because each invocation is a fresh process.
  let config: Record<string, any> = {};
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), 'statusline-config.json');
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      // Distinguish parse error from missing file: only the former is a user
      // misconfiguration. Log once per process so the user can see the cause.
      console.warn(`[statusline] config parse error in ${configPath}:`, (e as Error).message);
    }
  }

  const cost = session.cost;
  const ctx = session.context_window;
  const model = session.model;
  const cwd = session.cwd ?? process.cwd();

  const effectiveWindowSize = ctx ? resolveContextWindowSize(ctx, model?.display_name, config) : 0;
  const usedPct = ctx ? computeUsedPct(ctx, effectiveWindowSize) : null;

  const maxWidth = termWidth;

  // ════════════════════════════════════════════════════════════════
  // LINE 1: Segments in display order, each with a priority.
  // model/context/branch/pwd are PROTECTED_PRIORITY (never dropped).
  // Droppable priorities (higher = kept longer): usd_cost(5) drops first,
  // then duration(6), lines_changed(7), time_to_full(9), burn_rate(10) last.
  // ════════════════════════════════════════════════════════════════

  const line1Segs: PowerlineSeg[] = [];

  let modelSeg: PowerlineSeg | undefined;
  let modelTiers: string[] | undefined;
  if (model?.display_name && isSectionEnabled(config, SECTION.MODEL)) {
    modelTiers = buildModelTiers(model.display_name);
    modelSeg = { section: 22, priority: PROTECTED_PRIORITY, content: modelTiers[0] };
    line1Segs.push(modelSeg);
  }

  if (cost?.total_cost_usd != null && isSectionEnabled(config, SECTION.USD_COST))
    line1Segs.push({ section: 22, priority: 5, content:
      ` ${GREEN_FG}${BOLD}${ICON_DOLLAR}${cost.total_cost_usd.toFixed(2)}${R_GREEN} ` });

  if (cost?.total_cost_usd != null && cost.total_duration_ms > 60_000 && isSectionEnabled(config, SECTION.BURN_RATE)) {
    const rate = cost.total_cost_usd / (cost.total_duration_ms / 3_600_000);
    line1Segs.push({ section: 22, priority: 10, content:
      ` ${GREEN_DIM}${ICON_CLOCK} \$${rate.toFixed(2)}/hr${R_GREEN} ` });
  }

  let contextSeg: PowerlineSeg | undefined;
  let contextTiers: string[] | undefined;
  if (usedPct != null && isSectionEnabled(config, SECTION.CONTEXT_WINDOW)) {
    contextTiers = buildContextTiers(usedPct, effectiveWindowSize, ctx);
    contextSeg = { section: 22, priority: PROTECTED_PRIORITY, content: contextTiers[0] };
    line1Segs.push(contextSeg);
  }

  if (ctx && effectiveWindowSize > 0 && cost?.total_duration_ms > 60_000 && isSectionEnabled(config, SECTION.TIME_TO_FULL)) {
    // Use the same "used" numerator as the percentage above so the projected
    // time-to-fill agrees with what the bar is showing.
    const rawUsed = totalContextTokens(ctx);
    const used = rawUsed > 0 ? rawUsed
      : Math.round((usedPct ?? 0) * effectiveWindowSize / 100);
    if (used > 0) {
      const rem = effectiveWindowSize - used;
      if (rem > 0) {
        const tps = used / (cost.total_duration_ms / 1000);
        if (tps > 0)
          line1Segs.push({ section: 22, priority: 9, content:
            ` ${GREEN_DIM}${ICON_HOURGLASS} ~${formatDuration(Math.floor(rem / tps))} left${R_GREEN} ` });
      }
    }
  }

  if (cost && (cost.total_lines_added > 0 || cost.total_lines_removed > 0) && isSectionEnabled(config, SECTION.LINES_CHANGED))
    line1Segs.push({ section: 22, priority: 7, content:
      ` ${GREEN_DIM}${ICON_PENCIL} ${GREEN_114}${PLUS}${cost.total_lines_added || 0}${R_GREEN} ${RED_FG}${MINUS}${cost.total_lines_removed || 0}${R_GREEN} ` });

  if (cost?.total_duration_ms > 0 && isSectionEnabled(config, SECTION.DURATION))
    line1Segs.push({ section: 22, priority: 6, content:
      ` ${GREEN_DIM}${formatDuration(Math.floor(cost.total_duration_ms / 1000))}${R_GREEN} ` });

  let branchSeg: PowerlineSeg | undefined;
  let branchTiers: string[] | undefined;
  if (gitBranch && isSectionEnabled(config, SECTION.BRANCH)) {
    branchTiers = buildBranchTiers(gitBranch);
    branchSeg = { section: 24, priority: PROTECTED_PRIORITY, content: branchTiers[0] };
    line1Segs.push(branchSeg);
  }

  let pathSeg: PowerlineSeg | undefined;
  let pathTiers: string[] | undefined;
  if (isSectionEnabled(config, SECTION.PWD)) {
    pathTiers = buildPathTiers(cwd);
    pathSeg = { section: 237, priority: PROTECTED_PRIORITY, content: pathTiers[0] };
    line1Segs.push(pathSeg);
  }

  const fitted = fitSegments(line1Segs, maxWidth);
  // Protected segments never get dropped above, so once the droppable pool
  // is exhausted, shrink the remaining levers in priority order: model
  // first (abbreviate to one letter), then context (denser info per
  // column than a truncated name), then branch, then path last — the
  // final segment of the working directory only starts truncating once
  // every other lever above it is already fully exhausted.
  const stepTiers = (seg: PowerlineSeg | undefined, tiers: string[] | undefined) => {
    if (!seg || !tiers) return;
    let tier = 0;
    while (tier < tiers.length - 1 && stripAnsi(renderPowerline(fitted)).length >= maxWidth) {
      tier++;
      seg.content = tiers[tier];
    }
  };
  stepTiers(modelSeg, modelTiers);
  stepTiers(contextSeg, contextTiers);
  stepTiers(branchSeg, branchTiers);
  stepTiers(pathSeg, pathTiers);
  const line1 = renderPowerline(fitted);

  // ════════════════════════════════════════════════════════════════
  // LINE 2: Quota — pre-computed tiers from most to least detailed
  // ════════════════════════════════════════════════════════════════

  const line2 = (hasUsage && isSectionEnabled(config, SECTION.LINE2))
    ? buildQuotaLine(data, maxWidth)
    : '';

  // ════════════════════════════════════════════════════════════════
  // Output
  // ════════════════════════════════════════════════════════════════
  console.log(line1);
  if (line2) console.log(line2);
}

// Run only when executed directly (not when imported by tests)
if (realpathSync(resolve(process.argv[1] ?? '')) === fileURLToPath(import.meta.url)) {
  main();
}
