/** `scream report [--since <duration>]`: what background work did (see `host/report.ts`). */

import { t } from '@scream-code/config';
import { resolveScreamHome } from '@scream-code/scream-code-sdk';
import { InvalidArgumentError, type Command } from 'commander';

import { buildReport } from '#/host/report';

import { parseDurationMs } from '../duration';

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description(t('cli.report.description'))
    .option('--since <duration>', t('cli.report.since'), (value: string) => {
      const ms = parseDurationMs(value);
      if (ms === undefined) throw new InvalidArgumentError(t('cli.report.bad_since'));
      return ms;
    })
    .action((opts: { since?: number }) => {
      process.stdout.write(`${buildReport(resolveScreamHome(), opts.since ?? DEFAULT_SINCE_MS).join('\n')}\n`);
    });
}
