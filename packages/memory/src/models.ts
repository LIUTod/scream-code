import { normalizeTags } from './tags.js';

/** Memory memo types — structured task experience records extracted from conversations. */

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
  /** How this memo was triggered. */
  extractionSource: 'compaction' | 'exit' | 'manual';
  /** Epoch milliseconds when this entry was created. */
  recordedAt: number;
  /** Project directory this memo belongs to. */
  projectDir: string;
  /** Semantic tags summarizing the task domain (3-5 items). */
  tags?: string[];
  /** Optional note/suggestion attached to this memo — a soft, AI-readable
   * supplement (e.g. a reusable behavioural hint) that helps future turns
   * understand the memo. Advisory only, not a user-enforced preference. */
  note?: string;
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
  extractionSource: string;
  recordedAt: number;
  projectDir: string;
  tags?: string[];
  note?: string;
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
  partial: Omit<MemoryMemo, 'id' | 'recordedAt' | 'projectDir' | 'tags'> & {
    id?: string;
    recordedAt?: number;
    projectDir?: string;
    tags?: string[] | unknown;
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
    extractionSource: partial.extractionSource,
    recordedAt: partial.recordedAt ?? Date.now(),
    projectDir: partial.projectDir ?? '',
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
    extractionSource: memo.extractionSource,
    recordedAt: memo.recordedAt,
    projectDir: memo.projectDir,
    tags: memo.tags,
    note: memo.note,
  };
}
