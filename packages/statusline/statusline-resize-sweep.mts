#!/usr/bin/env node
// Manual dev tool: render the statusline at every terminal width across a
// range (default 120 -> 20) with one fixed session payload, so you can see
// exactly how segments drop and shrink as you tweak fitSegments/tiers.
//
// This is not part of the installed package (see manifest.json's "files")
// and not a node:test suite -- it's for eyeballing behavior, not asserting
// it. See statusline-render.test.mts for the automated regression tests
// (fitSegments, buildContextTiers, buildBranchTiers, monotonicity, etc).
//
// Usage:
//   node --experimental-strip-types statusline-resize-sweep.mts [options]
//
// Options:
//   --from <n>       Widest width to test (default: 120)
//   --to <n>         Narrowest width to test (default: 20)
//   --branch <name>  Git branch to render (default: current branch via git)
//   --payload <path> Session JSON fixture (default: statusline-resize-sweep-fixture.json next to this script)
//   --out <path>     Also write a plain (ANSI-stripped) copy of the sweep here
//   --summary        Only show widths where line 1 actually changes (compact transition view)
//
// Examples:
//   node --experimental-strip-types statusline-resize-sweep.mts --summary
//   node --experimental-strip-types statusline-resize-sweep.mts --out /tmp/sweep.txt
//   node --experimental-strip-types statusline-resize-sweep.mts --from 200 --to 10 --branch chore/long-branch-name

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const from = Number(opts.from ?? 120);
const to = Number(opts.to ?? 20);
const step = from <= to ? 1 : -1;

const branch = typeof opts.branch === 'string'
  ? opts.branch
  : (() => {
      try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    })();

const payloadPath = typeof opts.payload === 'string'
  ? resolve(opts.payload)
  : resolve(__dirname, 'statusline-resize-sweep-fixture.json');
const payload = readFileSync(payloadPath, 'utf8');

const renderScript = resolve(__dirname, 'statusline-render.mts');
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Header line is exactly `w` characters wide -- a visual ruler you can
// compare the rendered line below it against, at the actual column count
// under test.
function widthHeader(w: number): string {
  const label = ` width ${w} `;
  const pad = Math.max(0, w - label.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `${'='.repeat(left)}${label}${'='.repeat(right)}`;
}

const summaryOnly = !!opts.summary;
const outPath = typeof opts.out === 'string' ? resolve(opts.out) : undefined;

const plainEntries: string[] = [];
let prevLine1: string | null = null;

for (let w = from; step > 0 ? w <= to : w >= to; w += step) {
  const raw = execFileSync('node', [
    '--experimental-strip-types', renderScript, String(w), payload, branch,
  ], { encoding: 'utf8', timeout: 10_000 });
  const plain = stripAnsi(raw).trimEnd();
  const line1 = plain.split('\n')[0] ?? '';

  const changed = line1 !== prevLine1;
  prevLine1 = line1;

  if (!summaryOnly || changed) {
    const header = widthHeader(w);
    process.stdout.write(`${header}\n${raw}\n`);
    if (outPath) plainEntries.push(`${header}\n${plain}\n`);
  }
}

if (outPath) {
  writeFileSync(outPath, plainEntries.join('\n'));
  console.error(`\nWrote ${plainEntries.length} entries to ${outPath}`);
}
