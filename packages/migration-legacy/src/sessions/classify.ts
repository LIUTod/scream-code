import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { analyzeContextContent } from './translator.js';

export type SessionClass = 'placeholder' | 'empty' | 'malformed' | 'real';

export async function classifySessionDir(sessionDir: string): Promise<SessionClass> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return 'malformed';
  }
  if (entries.length === 0) return 'empty';
  if (entries.length === 1 && entries[0] === 'test') return 'placeholder';
  // `migrateOneSession` hard-fails without `context.jsonl`, so a dir lacking it
  // is not migratable. Classify as `malformed` so it is surfaced in the
  // skipped-malformed counter rather than entering the migration pipeline.
  if (!entries.includes('context.jsonl')) return 'malformed';

  // Inspect the context payload to distinguish three cases:
  //  - real:    has user/assistant/tool rows → migratable.
  //  - empty:   parses but only carries markers (`_system_prompt` etc.) or is
  //             blank → an unused session, or one the user cleared/reverted
  //             in scream-cli. Reported as skipped, never enters the pipeline.
  //  - corrupt: every non-blank line failed to parse → a real data problem
  //             (truncated write, disk error). Route through `'real'` so the
  //             migration step can run, fail with a diagnostic reason, and
  //             surface it via `sessionsFailed` + `migration-errors.log` —
  //             classify-level `'malformed'` would silently absorb it into
  //             `sessionsSkippedMalformed`, which the result screen does not
  //             render and the error log does not include.
  let contextText: string;
  try {
    contextText = await readFile(join(sessionDir, 'context.jsonl'), 'utf-8');
  } catch {
    // Listed by `readdir` but unreadable — treat as malformed, not migratable.
    return 'malformed';
  }
  const content = analyzeContextContent(contextText.split(/\r?\n/));
  if (content === 'real' || content === 'corrupt') return 'real';
  return 'empty';
}
