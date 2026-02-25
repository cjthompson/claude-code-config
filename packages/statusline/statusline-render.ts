#!/usr/bin/env node
// Claude Code statusline renderer — two-line powerline with session, environment, and quota info
// Called by statusline.sh with args: <usage-cache-path> <cache-mtime> <term-width> <session-json> <git-branch>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
function shortenPath(p: string, maxLen: number): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  if (p.length <= maxLen) return p;

  const parts = p.split('/');
  for (let i = 0; i < parts.length - 2; i++) {
    if (parts[i] === '~' || parts[i] === '') continue;
    if (parts[i].startsWith('.')) {
      parts[i] = parts[i].slice(0, 2);
    } else {
      parts[i] = parts[i][0];
    }
    if (parts.join('/').length <= maxLen) break;
  }
  return parts.join('/');
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
  progressBar,
  plTransition,
  plEnd,
  joinSep,
  formatQuotaWindow,
};

// ── Main rendering ────────────────────────────────────────────
function main(): void {
  const usageCachePath: string = process.argv[2];
  const cacheMtime: number = Number(process.argv[3]);
  const termWidth: number = Number(process.argv[4]);
  const session: Record<string, any> = JSON.parse(process.argv[5] || '{}');
  const gitBranch: string = process.argv[6] || '';

  const data: Record<string, any> = JSON.parse(readFileSync(usageCachePath, 'utf8'));

  // ════════════════════════════════════════════════════════════════
  // LINE 1: Session info (green) + Environment (blue/gray)
  // ════════════════════════════════════════════════════════════════

  const cost = session.cost;
  const ctx = session.context_window;
  const model = session.model;
  const cwd: string = session.cwd || process.cwd();

  const greenParts: string[] = [];

  // Model name
  if (model && model.display_name) {
    greenParts.push(WHITE + BOLD + ' ' + model.display_name + ' ');
  }

  // Session cost
  if (cost && cost.total_cost_usd != null) {
    const usd: number = cost.total_cost_usd;
    greenParts.push(' ' + GREEN_FG + BOLD + '\u0024' + usd.toFixed(2) + R_GREEN + ' ');

    if (cost.total_duration_ms > 60_000) {
      const rate = usd / (cost.total_duration_ms / 3_600_000);
      greenParts.push(' ' + GREEN_DIM + '\u0024' + rate.toFixed(2) + '/hr' + R_GREEN + ' ');
    }
  }

  // Context window + time-to-limit
  if (ctx && ctx.used_percentage != null) {
    const pct = Math.round(ctx.used_percentage);
    let ctxStr = MAGENTA_FG + BOLD + ' context ' + R_GREEN +
      WHITE + pct + '% ' + R_GREEN +
      progressBar(pct, BG_GREEN, 8);

    if (ctx.total_input_tokens > 0 && ctx.context_window_size > 0 && cost && cost.total_duration_ms > 60_000) {
      const usedTokens = ctx.total_input_tokens + ctx.total_output_tokens;
      const remaining = ctx.context_window_size - usedTokens;
      if (remaining > 0) {
        const tokensPerSec = usedTokens / (cost.total_duration_ms / 1000);
        if (tokensPerSec > 0) {
          const secsLeft = remaining / tokensPerSec;
          ctxStr += ' ' + GREEN_DIM + '~' + formatDuration(Math.floor(secsLeft)) + ' left' + R_GREEN;
        }
      }
    }
    greenParts.push(ctxStr + ' ');
  }

  // Lines changed
  if (cost && (cost.total_lines_added > 0 || cost.total_lines_removed > 0)) {
    const added = cost.total_lines_added || 0;
    const removed = cost.total_lines_removed || 0;
    greenParts.push(' ' + GREEN_114 + '+' + added + R_GREEN + ' ' +
      RED_FG + '-' + removed + R_GREEN + ' ');
  }

  // Session duration
  if (cost && cost.total_duration_ms > 0) {
    const totalSec = Math.floor(cost.total_duration_ms / 1000);
    greenParts.push(' ' + GREEN_DIM + formatDuration(totalSec) + R_GREEN + ' ');
  }

  // ── Blue section: directory ──
  const isWide = termWidth >= 120;
  const pathMaxLen = isWide ? 40 : 25;
  const shortPath = shortenPath(cwd, pathMaxLen);

  // ── Gray section: git branch ──
  const branchStr = gitBranch ? (' \ue0a0 ' + gitBranch + ' ') : '';

  // Assemble line 1
  let line1 = '';
  if (greenParts.length > 0) {
    line1 += BG_GREEN + greenParts.join(joinSep(BG_GREEN, 34));
    line1 += plTransition(22, 24);
  } else {
    line1 += BG_BLUE;
  }
  line1 += CYAN_FG + ' \uf07c ' + WHITE + shortPath + ' ' + RST;
  if (branchStr) {
    line1 += plTransition(24, 237);
    line1 += fg(148) + branchStr + RST;
    line1 += plEnd(237);
  } else {
    line1 += plEnd(24);
  }

  // ════════════════════════════════════════════════════════════════
  // LINE 2: Quota (dark background)
  // ════════════════════════════════════════════════════════════════
  const quotaParts: string[] = [];

  const fiveHr = formatQuotaWindow(data.five_hour, '5h', CYAN_FG, isWide, (iso) => {
    const diff = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
    return formatDuration(diff) + ' (' + formatLocalTime(iso) + ')';
  });
  if (fiveHr) quotaParts.push(fiveHr);

  const sevenDay = formatQuotaWindow(data.seven_day, '7d', BLUE_FG, isWide, (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + formatLocalTime(iso);
  });
  if (sevenDay) quotaParts.push(sevenDay);

  // Cache age
  quotaParts.push(' ' + DIM + GRAY_FG + '(' + cacheAge(cacheMtime) + ')' + R_DARK + ' ');

  let line2 = BG_DARK + quotaParts.join(joinSep(BG_DARK, 240));
  line2 += plEnd(233);

  // ════════════════════════════════════════════════════════════════
  // Output
  // ════════════════════════════════════════════════════════════════
  console.log(line1);
  console.log(line2);
}

// Run only when executed directly (not when imported by tests)
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main();
}
