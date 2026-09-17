import type { AgentType } from '#/agent';
import type { AgentConfigData, AgentConfigUpdateData } from '#/agent/config';
import type { AgentContextData, ContextMessage } from '#/agent/context';
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
  readonly context: AgentContextData;
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
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string | undefined;
}
