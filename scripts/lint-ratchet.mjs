#!/usr/bin/env node
/**
 * Lint warning-budget ratchet.
 *
 * Runs oxlint once (full output passed through), then enforces the locked
 * warning budget from scripts/lint-baseline.json: CI fails when the warning
 * count grows above the baseline, and suggests lowering the baseline when
 * the count drops. oxlint's own exit code (non-zero on lint errors) is
 * preserved.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASELINE_PATH = new URL('./lint-baseline.json', import.meta.url);
const { warnings: baseline } = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

const result = spawnSync('pnpm', ['exec', 'oxlint', '--type-aware'], {
  encoding: 'utf8',
  env: process.env,
});

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

const match = /Found (\d+) warnings and (\d+) errors/.exec(output);
if (match === null) {
  console.error('lint-ratchet: could not parse the oxlint summary line; failing safe.');
  process.exit(1);
}
const warnings = Number(match[1]);
const errors = Number(match[2]);

if (result.status !== 0) {
  // oxlint already reported lint errors (or crashed) — propagate as-is.
  process.exit(result.status ?? 1);
}
if (errors > 0) {
  console.error(`lint-ratchet: ${errors} lint errors present; failing.`);
  process.exit(1);
}
if (warnings > baseline) {
  console.error(
    `lint-ratchet: ${warnings} warnings exceeds the locked budget of ${baseline} ` +
      `(+${warnings - baseline}). Fix the new warnings instead of raising the baseline.`,
  );
  process.exit(1);
}
if (warnings < baseline) {
  console.log(
    `lint-ratchet: ${warnings} warnings (new low, baseline ${baseline}) — ` +
      'lower "warnings" in scripts/lint-baseline.json to lock the gain.',
  );
} else {
  console.log(`lint-ratchet: ${warnings} warnings within budget (baseline ${baseline}).`);
}
