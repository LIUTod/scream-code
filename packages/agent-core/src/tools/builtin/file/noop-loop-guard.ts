import { createHash } from 'node:crypto';

export const NOOP_HARD_LIMIT = 3;

interface NoopLoopEntry {
  hash: string;
  count: number;
}

const entries = new Map<string, NoopLoopEntry>();

export function recordFailedEdit(
  canonicalPath: string,
  inputHash: string,
): { count: number; escalate: boolean } {
  const prev = entries.get(canonicalPath);
  const count = prev && prev.hash === inputHash ? prev.count + 1 : 1;
  entries.set(canonicalPath, { hash: inputHash, count });
  return { count, escalate: count >= NOOP_HARD_LIMIT };
}

export function resetNoopLoop(canonicalPath: string): void {
  entries.delete(canonicalPath);
}

export function hashEditPayload(input: {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  anchor?: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
