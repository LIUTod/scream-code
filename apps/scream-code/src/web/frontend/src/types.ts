export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tools: ToolMessage[];
  isError?: boolean;
  pending?: boolean;
  /** Client-side creation time (ms epoch). Absent for snapshot-restored messages. */
  ts?: number;
}

export interface ToolMessage {
  toolCallId: string;
  name: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** Tool call awaiting an external signal (e.g. approval) before it can finish. */
  suspended?: boolean;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  action?: string;
  display?: unknown;
}

export interface SessionStatus {
  busy: boolean;
  model?: string;
  thinkingLevel?: string;
  permission?: 'manual' | 'auto' | 'yolo' | string;
  contextTokens?: number;
  maxContextTokens?: number;
  /** Context usage fraction (0..1) or percent (0..100). */
  contextUsage?: number;
}

export interface SessionSnapshot {
  sessionId: string;
  workDir: string;
  messages: ChatMessage[];
  pendingApprovals: ApprovalRequest[];
  status: SessionStatus;
  busy: boolean;
}

export interface SessionListItem {
  sessionId: string;
  workDir: string;
  title: string;
  createdAt: number;
  messageCount: number;
  active: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** Files with changes (staged + unstaged + untracked). */
  changed?: number;
  adds?: number;
  dels?: number;
  /** `git diff --stat HEAD` summary text. */
  diffStat?: string;
}

export interface ServerHello {
  type: 'server_hello';
  heartbeat_ms: number;
  epoch: number;
  sessionId: string;
  workDir: string;
  active: boolean;
}

export interface JournalEvent {
  type: 'event';
  seq: number;
  epoch: number;
  payload: {
    type: string;
    [key: string]: unknown;
  };
}

export type WsMessage =
  | ServerHello
  | JournalEvent
  | { type: 'approval_request'; id: string; toolName: string; action?: string; display?: unknown }
  | { type: 'approval_resolved'; id: string }
  | { type: 'user_message'; clientMessageId?: string; text: string }
  | { type: 'command_result'; command: string; ok: boolean; message: string }
  | { type: 'resync_required'; reason: string }
  | { type: 'pong' }
  | { type: 'error'; code?: string; message: string };
