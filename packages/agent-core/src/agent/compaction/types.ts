export interface CompactionResult {
  summary: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /** True when this compaction merged into an existing summary (iterative
   *  update mode) rather than producing a fresh one. */
  isUpdate?: boolean;
}

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  instruction?: string;
  source: CompactionSource;
}
