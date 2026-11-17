/**
 * Guard: the cron tool docs are read by the model and repeated to users, so they
 * must only name commands that exist. Resuming a session is `scream -C`,
 * `scream -r <id>` or /sessions; there is no `scream resume` subcommand.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { join } from 'pathe';

const CRON_DIR = join(import.meta.dirname, '../../../src/tools/cron');

describe('cron tool docs', () => {
  it.each(['cron-create.md', 'cron-list.md', 'cron-delete.md'])(
    '%s does not send the reader to a non-existent `scream resume`',
    (file) => {
      expect(readFileSync(join(CRON_DIR, file), 'utf8')).not.toMatch(/scream resume/i);
    },
  );

  it('still tells the model how a session is resumed', () => {
    const text = readFileSync(join(CRON_DIR, 'cron-create.md'), 'utf8');
    expect(text).toContain('scream -C');
  });
});
