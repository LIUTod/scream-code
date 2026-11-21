import { normalizeTags } from './tags.js';

/** Memory memo types — structured task experience records extracted from conversations. */

/** What produced a memo: an extracted session experience, a /dream rule, or a user rewrite. */
export type MemoOrigin = 'session' | 'dream' | 'user';

/** Snapshot of a memo folded into a distilled conclusion. */
export interface DistilledSource {
  id: string;
  /** Source memo's userNeed, truncated for storage. */
  title: string;
  at: number;
}

export interface MemoryMemo {
  /** Unique ID generated at creation time. */
  id: string;
  /** Session ID this memo was extracted from. */
  sourceSessionId: string;
  /** Session title for display purposes. */
  sourceSessionTitle?: string;
  /** The user's need or goal, one sentence. */
  userNeed: string;
  /** The approach taken — what was done. */
  approach: string;
  /** Final outcome (free text, e.g. "完成", "部分完成", "失败"). */
  outcome: string;
  /** Dead ends tried — things that didn't work. 'none' if nothing notable. */
  whatFailed: string;
  /** What ultimately worked — key actions that led to success. 'none' if nothing notable. */
  whatWorked: string;
  /** Latest one-sentence distillation written by /dream; empty/undefined when never distilled. */
  distilled?: string;
  /** What produced this memo. Defaults to 'session' for extracted experiences. */
  origin?: MemoOrigin;
  /** Memos folded into `distilled`; kept across generations of consolidation. */
  distilledFrom?: DistilledSource[];
  /** Epoch milliseconds when `distilled` was generated or last rewritten. */
  distilledAt?: number;
  /** How this memo was triggered. */
  extractionSource: 'compaction' | 'exit' | 'manual';
  /** Epoch milliseconds when this entry was created. */
  recordedAt: number;
  /** Directory the session ran in when this memo was written. */
  projectDir: string;
  /** Git working-tree root of `projectDir`, when there is one (see `resolveProjectRoot`).
   * Recorded separately because `projectDir` is only the directory a session was
   * started in — starting scream in `$HOME` made every memo claim the same
   * "project" and switched the cross-project guard off. */
  projectRoot?: string;
  /** Semantic tags summarizing the task domain (3-5 items). */
  tags?: string[];
  /** Optional note/suggestion attached to this memo — a soft, AI-readable
   * supplement (e.g. a reusable behavioural hint) that helps future turns
   * understand the memo. Advisory only, not a user-enforced preference. */
  note?: string;
  /** Bookkeeping, not content: how many times this memo was brought back into
   * a conversation (recalled automatically or returned by a lookup). Set by
   * the store only — `update()` never writes it, and the change history
   * leaves it out. */
  recallCount?: number;
  /** Bookkeeping like `recallCount`: epoch ms of the latest recall. */
  lastRecalledAt?: number;
  /** Bookkeeping: epoch ms when /dream last considered this memo. NULL/undefined
   * means never considered, so the next run picks it up. Written by
   * `markDreamed()` only. */
  dreamedAt?: number;
}

/** JSONL envelope — one line in entries.jsonl. */
export interface MemoryMemoRecord {
  type: 'memory_memo';
  version: 2;
  entry: MemoryMemo;
}

/** Summary view shown in picker lists. Includes key fields for display and injection. */
export interface MemoryMemoSummary {
  id: string;
  sourceSessionTitle?: string;
  sourceSessionId: string;
  userNeed: string;
  approach: string;
  outcome: string;
  whatFailed: string;
  whatWorked: string;
  distilled?: string;
  origin?: MemoOrigin;
  distilledFrom?: DistilledSource[];
  distilledAt?: number;
  extractionSource: string;
  recordedAt: number;
  projectDir: string;
  projectRoot?: string;
  tags?: string[];
  note?: string;
  recallCount?: number;
  lastRecalledAt?: number;
}

/** Result of listing/filtering memos. */
export interface MemoryMemoListResult {
  memos: MemoryMemoSummary[];
  total: number;
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `memo-${ts}-${rand}`;
}

export function createMemoryMemo(
  partial: Omit<
    MemoryMemo,
    'id' | 'recordedAt' | 'projectDir' | 'tags' | 'distilled' | 'origin' | 'distilledFrom' | 'distilledAt'
  > & {
    id?: string;
    recordedAt?: number;
    projectDir?: string;
    tags?: string[] | unknown;
    distilled?: string;
    origin?: MemoOrigin;
    distilledFrom?: DistilledSource[];
    distilledAt?: number;
  },
): MemoryMemo {
  return {
    id: partial.id ?? generateId(),
    sourceSessionId: partial.sourceSessionId,
    sourceSessionTitle: partial.sourceSessionTitle,
    userNeed: partial.userNeed,
    approach: partial.approach,
    outcome: partial.outcome,
    whatFailed: partial.whatFailed,
    whatWorked: partial.whatWorked,
    distilled: partial.distilled,
    origin: partial.origin ?? 'session',
    distilledFrom: partial.distilledFrom,
    distilledAt: partial.distilledAt,
    extractionSource: partial.extractionSource,
    recordedAt: partial.recordedAt ?? Date.now(),
    projectDir: partial.projectDir ?? '',
    projectRoot: partial.projectRoot,
    tags: normalizedTags(partial.tags),
    note: partial.note,
  };
}

function normalizedTags(value: unknown): string[] | undefined {
  const tags = normalizeTags(value);
  return tags.length > 0 ? tags : undefined;
}

export function toSummary(memo: MemoryMemo): MemoryMemoSummary {
  return {
    id: memo.id,
    sourceSessionTitle: memo.sourceSessionTitle,
    sourceSessionId: memo.sourceSessionId,
    userNeed: memo.userNeed,
    approach: memo.approach,
    outcome: memo.outcome,
    whatFailed: memo.whatFailed,
    whatWorked: memo.whatWorked,
    distilled: memo.distilled,
    origin: memo.origin,
    distilledFrom: memo.distilledFrom,
    distilledAt: memo.distilledAt,
    extractionSource: memo.extractionSource,
    recordedAt: memo.recordedAt,
    projectDir: memo.projectDir,
    projectRoot: memo.projectRoot,
    tags: memo.tags,
    note: memo.note,
    recallCount: memo.recallCount,
    lastRecalledAt: memo.lastRecalledAt,
  };
}
