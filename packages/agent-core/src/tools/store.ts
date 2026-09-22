import type { TodoItem } from '../todo';
import type { ArchFinding } from './builtin/collaboration/report-arch-finding';
import type { ReviewFinding } from './builtin/collaboration/report-finding';

export interface ToolStoreData {
  /** Structured todo list used by TodoListTool. */
  todo?: TodoItem[];
  /** Structured findings produced by reviewer subagents via ReportFindingTool. */
  findings?: ReviewFinding[];
  /** Findings produced by oracle code-health diagnoses via ReportArchFindingTool. */
  archFindings?: ArchFinding[];
}

export type ToolStoreKey = Extract<keyof ToolStoreData, string>;

export interface ToolStore {
  get(key: 'todo'): TodoItem[] | undefined;
  get(key: 'findings'): ReviewFinding[] | undefined;
  get(key: 'archFindings'): ArchFinding[] | undefined;
  set(key: 'todo', value: TodoItem[]): void;
  set(key: 'findings', value: ReviewFinding[]): void;
  set(key: 'archFindings', value: ArchFinding[]): void;
}

export interface ToolStoreUpdate<K extends ToolStoreKey = ToolStoreKey> {
  readonly key: K;
  readonly value: ToolStoreData[K];
}
