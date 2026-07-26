export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tools: ToolMessage[];
  isError?: boolean;
  pending?: boolean;
}

export interface ToolMessage {
  toolCallId: string;
  name: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
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
  contextTokens?: number;
  maxContextTokens?: number;
  contextUsage?: number;
}

export interface SessionSnapshot {
  sessionId: string;
  workDir: string;
  model: string;
  permission: string;
  messages: ChatMessage[];
  pendingApprovals: ApprovalRequest[];
  status: SessionStatus;
}

export interface ServerHello {
  type: 'server_hello';
  heartbeat_ms: number;
  epoch: number;
  sessionId: string;
  workDir: string;
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
  | { type: 'resync_required'; reason: string }
  | { type: 'error'; code?: string; message: string };
