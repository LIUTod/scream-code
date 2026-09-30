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
  /** Persistent key/value state for the script sandbox (RunScriptTool `store()`/`load()`). */
  scriptStore?: Record<string, unknown>;
}

export type ToolStoreKey = Extract<keyof ToolStoreData, string>;

export interface ToolStore {
  get(key: 'todo'): TodoItem[] | undefined;
  get(key: 'findings'): ReviewFinding[] | undefined;
  get(key: 'archFindings'): ArchFinding[] | undefined;
  get(key: 'scriptStore'): Record<string, unknown> | undefined;
  set(key: 'todo', value: TodoItem[]): void;
  set(key: 'findings', value: ReviewFinding[]): void;
  set(key: 'archFindings', value: ArchFinding[]): void;
  set(key: 'scriptStore', value: Record<string, unknown>): void;
}

export interface ToolStoreUpdate<K extends ToolStoreKey = ToolStoreKey> {
  readonly key: K;
  readonly value: ToolStoreData[K];
}
