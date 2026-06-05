/** Memory memo types — structured work logs extracted from conversations. */

export type MemoryCategory =
  | 'user_preference'   // 用户偏好: 角色、习惯、风格
  | 'feedback'          // 反馈: 从错误中学到的经验
  | 'project_context'   // 项目上下文: 架构决策、bug、进行中的工作
  | 'reference';        // 引用: 外部系统指针 (Linear, Slack, 文档 URL)

export interface MemoryMemo {
  /** Unique ID generated at creation time. */
  id: string;
  /** Session ID this memo was extracted from. */
  sourceSessionId: string;
  /** Session title for display purposes. */
  sourceSessionTitle?: string;
  /** The user's original request or question. */
  userRequirement: string;
  /** The approach or solution that was applied. */
  solution: string;
  /** Current status of the task. */
  completionStatus: 'done' | 'partially done' | 'blocked' | 'abandoned';
  /** Problems encountered and how they were resolved (or "none"). */
  problemsEncountered: string;
  /** How this memo was triggered. */
  extractionSource: 'compaction' | 'exit';
  /** Memory category for targeted recall and formatting. */
  category: MemoryCategory;
  /** Epoch milliseconds when this entry was created. */
  recordedAt: number;
  /** Optional free-form tags. */
  tags?: string[];
}

/** JSONL envelope — one line in entries.jsonl. */
export interface MemoryMemoRecord {
  type: 'memory_memo';
  version: 1;
  entry: MemoryMemo;
}

/** Summary view shown in picker lists. Includes key fields for display and injection. */
export interface MemoryMemoSummary {
  id: string;
  sourceSessionTitle?: string;
  sourceSessionId: string;
  userRequirement: string;
  solution: string;
  completionStatus: string;
  problemsEncountered: string;
  extractionSource: string;
  category: string;
  recordedAt: number;
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
  partial: Omit<MemoryMemo, 'id' | 'recordedAt'> & { id?: string; recordedAt?: number },
): MemoryMemo {
  return {
    id: partial.id ?? generateId(),
    sourceSessionId: partial.sourceSessionId,
    sourceSessionTitle: partial.sourceSessionTitle,
    userRequirement: partial.userRequirement,
    solution: partial.solution,
    completionStatus: partial.completionStatus,
    problemsEncountered: partial.problemsEncountered,
    extractionSource: partial.extractionSource,
    category: partial.category ?? 'project_context',
    recordedAt: partial.recordedAt ?? Date.now(),
    tags: partial.tags,
  };
}

export function toSummary(memo: MemoryMemo): MemoryMemoSummary {
  return {
    id: memo.id,
    sourceSessionTitle: memo.sourceSessionTitle,
    sourceSessionId: memo.sourceSessionId,
    userRequirement: memo.userRequirement,
    solution: memo.solution,
    completionStatus: memo.completionStatus,
    problemsEncountered: memo.problemsEncountered,
    extractionSource: memo.extractionSource,
    category: memo.category,
    recordedAt: memo.recordedAt,
  };
}
