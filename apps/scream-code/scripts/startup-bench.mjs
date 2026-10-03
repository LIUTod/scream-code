#!/usr/bin/env node
/**
 * Startup benchmark: measures CLI wall time for `--version` on both entry
 * paths, so the dev-vs-built startup gap is a repeatable number instead of a
 * guess.
 *
 *   A  dist: node dist/main.mjs --version            (run `build:cli` first)
 *   B  dev:  node <tsx cli> --import ../../build/register-raw-text-loader.mjs ./src/main.ts --version
 *
 * `build:cli` is CLI-only: tsdown runs with clean:true and wipes the whole
 * dist directory, including the dist/public web assets produced by the vite
 * web build. Run the full `pnpm build` (tsdown + vite + copy-web-assets) when
 * the web bundle is needed as well.
 *
 * Each scenario runs RUNS times and reports every run plus the median.
 * Zero third-party dependencies.
 *
 * Usage: pnpm -C apps/scream-code run bench:startup
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');
const RUNS = 2;

const DIST_ENTRY = resolve(APP_ROOT, 'dist', 'main.mjs');

// The `tsx` CLI is run through this process's own Node binary rather than
// through the `tsx` bin shim — same reasoning as scripts/dev.mjs: the shim is
// a `.cmd` batch file on Windows, which `spawn` cannot launch directly.
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const scenarios = [
  {
    name: 'dist: node dist/main.mjs',
    command: process.execPath,
    args: ['dist/main.mjs', '--version'],
    available: existsSync(DIST_ENTRY),
  },
  {
    name: 'dev:  tsx ./src/main.ts',
    command: process.execPath,
    args: [
      tsxCli,
      '--import',
      '../../build/register-raw-text-loader.mjs',
      './src/main.ts',
      '--version',
    ],
    available: true,
  },
];

/** Runs one invocation to completion and returns its wall time in ms. */
function timeRun(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      const ms = performance.now() - startedAt;
      if (code !== 0) {
        rejectRun(
          new Error(
            `${command} ${args.join(' ')} exited with code ${String(code)}\n${stderr.trim()}`,
          ),
        );
        return;
      }
      resolveRun({ ms, stdout: stdout.trim() });
    });
  });
}

/** Median of a small sample: middle value, or the mean of the two middles. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatMs(value) {
  return value.toFixed(1);
}

const results = [];
for (const scenario of scenarios) {
  if (!scenario.available) {
    results.push({ ...scenario, runs: undefined });
    continue;
  }
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(await timeRun(scenario.command, scenario.args));
  }
  results.push({ ...scenario, runs });
}

const skipped = results.filter((r) => r.runs === undefined);
const measured = results.filter((r) => r.runs !== undefined);

console.log(
  `\nStartup benchmark — ${RUNS} run(s) per scenario, wall time of \`--version\` (ms)\n`,
);
const labelWidth = Math.max(...measured.map((r) => r.name.length));
const runHeader = Array.from({ length: RUNS }, (_, i) => `run ${i + 1}`.padStart(9)).join('  ');
console.log(`${'scenario'.padEnd(labelWidth)}  ${runHeader}   median`);
for (const scenario of measured) {
  const times = scenario.runs.map((r) => r.ms);
  const row = times.map((ms) => formatMs(ms).padStart(9)).join('  ');
  console.log(
    `${scenario.name.padEnd(labelWidth)}  ${row}  ${formatMs(median(times)).padStart(8)}`,
  );
}

for (const r of measured) {
  console.log(`${r.name}: first run stdout = ${JSON.stringify(r.runs[0].stdout)}`);
}

if (skipped.length > 0) {
  console.error(
    '\ndist build not found — run `pnpm -C apps/scream-code run build:cli` first.\n' +
      'Note: `build:cli` is CLI-only and runs tsdown with clean:true, so it wipes\n' +
      'all of dist (including the dist/public web assets). Run the full `pnpm build`\n' +
      'when you need the web bundle as well.',
  );
  process.exitCode = 1;
}
