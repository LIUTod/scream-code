import { appendFile } from 'node:fs/promises';

/**
 * Serialization gate for journal appends.
 *
 * Why it exists (an incident observed in the field): the session journal is an
 * append-only file holding one JSON record per line, and lines used to be
 * appended with `writeFile(path, line + '\n', { flag: 'a' })`. A
 * `web.message.finalized` entry carries an entire assistant body (hundreds of
 * thousands of characters in practice) while small entries such as turn.ended
 * are written at the same time — the two writes interleaved at the byte level,
 * so what landed on disk were malformed lines with the two records spliced
 * into each other:
 *
 *   ..."content":"...{"type":"journal","seq":38354,...   ← another record spliced into the body
 *
 * Consequence: the whole line fails JSON.parse and the message disappears from
 * the UI (the reader can only skip it), which the user perceives as a garbled
 * or lost body. Queueing the writes inside the process eliminates the
 * interleaving; the append itself still goes through appendFile (O_APPEND), so
 * a single write is never split by another fd.
 *
 * The queue is keyed by file path and dropped once drained, so a long-running
 * process does not grow it without bound. No cross-process writer exists today
 * (only the web server writes the journal); if one appears, this needs a
 * file-lock based scheme instead.
 */
const writeChains = new Map<string, Promise<void>>();

/**
 * Append one line (plus its newline) to the journal; concurrent calls for the
 * same file land in arrival order.
 */
export async function appendJournalLineSerialized(
  path: string,
  line: string,
  onError: (error: unknown) => void,
): Promise<void> {
  const previous = writeChains.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined) // A previous failure must not block later writes.
    .then(async () => {
      try {
        await appendFile(path, line + '\n');
      } catch (error) {
        onError(error);
      }
    });
  writeChains.set(path, next);
  try {
    await next;
  } finally {
    // The queue is drained (no newer task chained behind) → clear the entry and
    // release the Map slot.
    if (writeChains.get(path) === next) {
      writeChains.delete(path);
    }
  }
}

/** Test helper: clear the write-queue state (not needed on the production path). */
export function resetJournalWriteChains(): void {
  writeChains.clear();
}
