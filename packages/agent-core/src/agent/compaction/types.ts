export interface CompactionResult {
  summary: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /** True when this compaction merged into an existing summary (iterative
   *  update mode) rather than producing a fresh one. */
  isUpdate?: boolean;
  /** Files read in the compacted history. Persisted so the next compaction
   *  can merge them into its own file context (file context survives
   *  repeated compactions instead of being reset each round). */
  readFiles?: string[];
  /** Files written or edited in the compacted history (same persistence
   *  semantics as `readFiles`). */
  modifiedFiles?: string[];
}

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  instruction?: string;
  source: CompactionSource;
}
