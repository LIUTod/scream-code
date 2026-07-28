export type TodoStatus = 'pending' | 'in_progress' | 'done';

/** Canonical public todo item exposed through RPC, SDK reads, and events. */
export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
  /** Optional phase name. Items sharing the same phase are grouped together when rendered. */
  readonly phase?: string;
}

