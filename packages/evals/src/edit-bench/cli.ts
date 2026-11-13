/**
 * Manual CLI entry for the edit benchmark. This runs REAL model sessions —
 * it is not part of any vitest suite and is never imported by tests.
 *
 *   SCREAM_EVAL_MODEL=provider/model pnpm -C packages/evals exec tsx \
 *     --import ../../build/register-raw-text-loader.mjs src/edit-bench/cli.ts
 *
 * Flags: --seed=N --max=N --categories=a,b --scream-home=/path
 */

import { runEditBenchmark, type EditBenchReport } from './run';

interface CliOptions {
  seed?: number;
  maxCases?: number;
  categories?: string[];
  screamHome?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (const arg of argv) {
    const seed = /^--seed=(\d+)$/.exec(arg);
    if (seed !== null && seed[1] !== undefined) options.seed = Number(seed[1]);
    const max = /^--max=(\d+)$/.exec(arg);
    if (max !== null && max[1] !== undefined) options.maxCases = Number(max[1]);
    const categories = /^--categories=([\w-]+(?:,[\w-]+)*)$/.exec(arg);
    if (categories !== null && categories[1] !== undefined) {
      options.categories = categories[1].split(',');
    }
    const home = /^--scream-home=(.+)$/.exec(arg);
    if (home !== null && home[1] !== undefined) options.screamHome = home[1];
  }
  return options;
}

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printReport(report: EditBenchReport): void {
  writeLine(
    `edit-bench: ${report.passed} passed, ${report.failed} failed, ` +
      `${report.skipped} skipped, ${report.totalTokens} tokens`,
  );
  for (const [category, stat] of Object.entries(report.byCategory)) {
    writeLine(`  ${category}: ${stat.passed} passed, ${stat.failed} failed`);
  }
  for (const result of report.results) {
    if (result.passed) continue;
    const detail = result.error === undefined ? '' : ` — ${result.error}`;
    writeLine(`  FAIL ${result.mutation} on ${result.fixture}${detail}`);
  }
}

async function main(): Promise<void> {
  const model = process.env['SCREAM_EVAL_MODEL'];
  if (model === undefined || model.length === 0) {
    process.stderr.write('edit-bench: set SCREAM_EVAL_MODEL, e.g. SCREAM_EVAL_MODEL=provider/model\n');
    process.exitCode = 1;
    return;
  }
  const cliOptions = parseArgs(process.argv.slice(2));
  const report = await runEditBenchmark({ model, ...cliOptions });
  printReport(report);
  process.exitCode = report.failed === 0 ? 0 : 1;
}

await main();
