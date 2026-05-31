import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { migrationErrorsLogFile } from './paths.js';

export interface MigrationFailureEntry {
  readonly sourcePath: string;
  readonly reason: string;
}

export interface MigrationErrorsLogInput {
  readonly startedAt: string;
  readonly failures: readonly MigrationFailureEntry[];
}

/**
 * Append this run's outcome to `<targetHome>/migration-errors.log` — an
 * append-only cross-run diagnostic record.
 *
 * Each call contributes one block prefixed by a timestamped header. A run
 * with failures appends per-session diagnostics (source path, reason, and a
 * `context.jsonl` line-count + role histogram). A run with no failures
 * appends a one-line `no failures.` marker — the file therefore captures the
 * complete history of every migration attempt, so a single log shared by a
 * user covers all retries.
 *
 * Best-effort: a finished migration must not be turned into a failure by a
 * log write error, so all I/O is guarded.
 */
export async function writeMigrationErrorsLog(
  targetHome: string,
  input: MigrationErrorsLogInput,
): Promise<void> {
  const lines: string[] = [`===== migration run @ ${input.startedAt} =====`];

  if (input.failures.length === 0) {
    lines.push('no failures.', '');
  } else {
    lines.push(`${input.failures.length} session(s) failed to migrate.`, '');
    let index = 0;
    for (const failure of input.failures) {
      index += 1;
      lines.push(
        `[${index}] ${basename(failure.sourcePath)}`,
        `  source: ${failure.sourcePath}`,
        `  reason: ${failure.reason}`,
        `  ${await describeContext(failure.sourcePath)}`,
        '',
      );
    }
  }

  try {
    await mkdir(targetHome, { recursive: true, mode: 0o700 });
    // POSIX `O_APPEND` makes a single `appendFile` atomic — concurrent runs
    // would still produce well-formed blocks. `mode` only applies when the
    // file is created; an existing log keeps its prior 0600.
    await appendFile(migrationErrorsLogFile(targetHome), lines.join('\n'), {
      mode: 0o600,
    });
  } catch {
    // Best-effort — see the doc comment above.
  }
}

/**
 * One-line `context.jsonl` summary for a failed session: line count plus a
 * role histogram. The histogram is the key diagnostic — it tells a genuine
 * write failure from a session whose context held only markers.
 */
async function describeContext(sessionDir: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(sessionDir, 'context.jsonl'), 'utf-8');
  } catch {
    return 'context.jsonl: unreadable';
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const roleCounts = new Map<string, number>();
  for (const line of lines) {
    let role = '<unparseable>';
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        const raw = (parsed as Record<string, unknown>)['role'];
        role = typeof raw === 'string' ? raw : '<no-role>';
      }
    } catch {
      // role stays '<unparseable>'
    }
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  const histogram = [...roleCounts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([role, count]) => `${role}=${count}`)
    .join(' ');
  return `context.jsonl: ${lines.length} lines${histogram === '' ? '' : ` - ${histogram}`}`;
}
