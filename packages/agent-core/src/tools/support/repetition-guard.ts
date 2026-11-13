import { createHash } from 'node:crypto';

/**
 * Content-repetition signal for read/search tools.
 *
 * Repetition is a signal, never a block: the tool result itself is always
 * returned unaltered and `isError` stays false. The guard only counts how many
 * times the *same* content (same key, same fingerprint) has been fetched in
 * this session so the `<system>` notice can escalate from a gentle note to a
 * "stop re-reading" instruction. It mirrors the philosophy of the noop edit
 * guard, but for content fetches instead of failed edits.
 *
 * The fingerprint includes the fetch window plus a content anchor, so a
 * re-read after the file changed (different anchor) or a different window
 * (different offset/limit) resets the count — post-edit re-reads are naturally
 * exempt and never counted as repetition.
 *
 * One instance per Agent: subagents get their own Agent, so their counts are
 * independent. Keys are bounded with LRU eviction — a long session must not
 * grow the map without limit, and evicting the least-recently-used key merely
 * loses one stale count, which is harmless.
 */
export type RepetitionLevel = 0 | 1 | 2;

/** Cap on tracked keys; insertion-order Map gives cheap LRU semantics. */
const MAX_KEYS = 256;

interface RepetitionEntry {
  fingerprint: string;
  count: number;
}

function levelForCount(count: number): RepetitionLevel {
  if (count < 2) return 0;
  return count < 4 ? 1 : 2;
}

/**
 * JSON.stringify with object keys sorted at every level, so two spellings of
 * the same argument object (differing key order) hash to one key. Tool-call
 * arguments are plain JSON with no cycles, so a recursive walk is safe.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export class RepetitionGuard {
  /** Key → latest fingerprint + repeat count; Map order doubles as the LRU list. */
  private readonly entries = new Map<string, RepetitionEntry>();

  /**
   * Record one fetch. Same key + same fingerprint → count++; same key + a
   * different fingerprint (file changed, different window) → reset to 1.
   * The key moves to most-recent on every touch, and inserting past the cap
   * evicts the least-recently-used key.
   */
  record(key: string, fingerprint: string): { count: number; level: RepetitionLevel } {
    const prev = this.entries.get(key);
    const count = prev !== undefined && prev.fingerprint === fingerprint ? prev.count + 1 : 1;
    // Delete-then-set re-inserts at the Map tail so the key counts as touched.
    this.entries.delete(key);
    this.entries.set(key, { fingerprint, count });
    if (this.entries.size > MAX_KEYS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return { count, level: levelForCount(count) };
  }

  /** Drop a key's count entirely — used when compaction elides a result and the model may legitimately re-fetch. */
  forget(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Guard key for a Read of a file. Both the live read path and the
   * compaction elision site must build the key from the SAME raw
   * `args.path` string (no path canonicalization) so they always match:
   * canonicalization needs workspace context the compaction layer does not
   * have, and a raw-string mismatch would silently break the exemption.
   */
  static readKey(rawPath: string): string {
    return `read:${rawPath}`;
  }

  /**
   * Guard key for a Grep call: a short hash over the canonical (key-sorted)
   * argument object. Takes the arguments JSON as persisted on the tool call —
   * the live tool passes `JSON.stringify(parsedArgs)`, compaction passes the
   * model's raw arguments string, and stableStringify makes both agree.
   */
  static grepKey(argsJson: string): string {
    let canonical: string;
    try {
      canonical = stableStringify(JSON.parse(argsJson));
    } catch {
      // Defensive: arguments are always valid JSON from both callers, but a
      // deterministic fallback beats throwing from a notice path.
      canonical = argsJson;
    }
    return `grep:${shortHash(canonical)}`;
  }
}
