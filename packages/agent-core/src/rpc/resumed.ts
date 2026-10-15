import type { AgentType } from '#/agent';
import type { AgentConfigData, AgentConfigUpdateData } from '#/agent/config';
import type { ContextMessage } from '#/agent/context';
import type {
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
} from '#/agent/permission';
import type { PlanData } from '#/agent/plan';
import type { ToolInfo } from '#/agent/tool';
import type { SessionSummary } from '#/rpc/core-api';
import type { UsageStatus } from '#/rpc/events';
import type { SessionMeta } from '#/session';
import type { BackgroundTaskInfo } from '#/tools/builtin';

export type AgentReplayRecord =
  | { type: 'message'; message: ContextMessage }
  /**
   * Surviving draft of a stream that never drained (process crash/kill mid
   * turn). Rendered as an honestly-marked partial assistant message; never
   * part of the model context.
   */
  | { type: 'stream_draft_partial'; turnId: string; text: string; think: string }
  | { type: 'plan_updated'; enabled: boolean; strategy?: 'normal' | 'fusion' }
  | { type: 'config_updated'; config: AgentConfigUpdateData }
  | { type: 'permission_updated'; mode: PermissionMode }
  | { type: 'approval_result'; record: PermissionApprovalResultRecord };

export interface ResumedAgentState {
  readonly type: AgentType;
  readonly config: AgentConfigData;
  /**
   * Token accounting only — the client reads `tokenCount` for the status bar
   * and nothing else. The full history is fetched on demand through
   * `getContext({ agentId })`; inlining it here made the resume payload grow
   * with session size (see {@link ResumeSessionResult.agents}).
   */
  readonly context: { readonly tokenCount: number };
  readonly replay: readonly AgentReplayRecord[];
  readonly permission: PermissionData;
  readonly plan: PlanData;
  readonly usage: UsageStatus;
  readonly tools: readonly ToolInfo[];
  readonly toolStore?: Readonly<Record<string, unknown>>;
  readonly background: readonly BackgroundTaskInfo[];
}

export interface ResumeSessionResult extends SessionSummary {
  readonly sessionMetadata: SessionMeta;
  /**
   * Interactive agent state, under its agent id (`main`), and nothing else.
   *
   * Every other agent in the session is deliberately omitted: no client reads
   * a subagent entry, while shipping them — with each one's context history —
   * made the payload scale with session size until the RPC "network" deep copy
   * overflowed V8's string limit and permanently killed resume on large
   * sessions. Non-interactive agents are served on demand through the
   * `AgentAPIWithId` family, whose payloads carry the `agentId` to read.
   */
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string | undefined;
}
