import type { ContentPart } from '@scream-code/ltod';

import type { ApprovalGrant } from '../agent/permission/types';
import type { SubagentCapabilityMode } from '../session/subagent-capability';
import type { RPCMethods } from './client';
import type { AgentEvent, ToolInputDisplay } from './events';
import type { WithAgentId, WithSessionId } from './types';

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';
export type ApprovalScope = 'session';
/**
 * Scope a user can grant from an approval prompt. Re-exported from the
 * permission module, which owns the policy contract that produces it, so the
 * wire and the domain cannot drift apart.
 */
export type { ApprovalGrant } from '../agent/permission/types';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: ApprovalScope | undefined;
  readonly feedback?: string | undefined;
  readonly selectedLabel?: string | undefined;
}

export interface ApprovalRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
  /** Id of the agent that asked ('main' for the root agent). Optional so
   *  older emitters and replayed payloads stay valid. */
  readonly sourceAgentId?: string | undefined;
  /** Human-readable name of the asking agent (its profile name). Optional:
   *  falls back to `sourceAgentId` in the UI when absent. */
  readonly sourceAgentName?: string | undefined;
  /** Tool that triggered the approval; mirrors `toolName` on the origin side,
   *  present so consumers can attribute without re-deriving. */
  readonly sourceToolName?: string | undefined;
  /** Capability contract the asking agent runs under (`read-only` /
   *  `read-write` / `execute`); absent when the asker is unrestricted. */
  readonly sourceCapabilityMode?: SubagentCapabilityMode | undefined;
  /** Risk notes from the asking policy; the approval UI renders one row per
   *  entry. Optional so older emitters and replayed payloads stay valid. */
  readonly reasons?: readonly string[] | undefined;
  /** Grants the prompt may offer. Absent means every grant is on offer;
   *  a narrowed list filters the UI's choices. */
  readonly grantOptions?: readonly ApprovalGrant[] | undefined;
  /** Plain-text summary of the prompt that started the current turn; the
   *  approval UI shows it dimmed. Optional so older emitters stay valid. */
  readonly requestSummary?: string | undefined;
}

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';
export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod | undefined;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export interface QuestionRequest {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export interface ToolCallRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly args: unknown;
}

export interface ToolCallResponse {
  readonly output: string | ContentPart[];
  readonly isError?: boolean | undefined;
}

export interface SDKAgentAPI {
  emitEvent: (event: AgentEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  requestQuestion: (request: QuestionRequest) => Promise<QuestionResult>;
  toolCall: (request: ToolCallRequest) => Promise<ToolCallResponse>;
}
export type SDKAgentRPC = RPCMethods<SDKAgentAPI>;

export type SDKSessionAPI = WithAgentId<SDKAgentAPI>;
export type SDKSessionRPC = RPCMethods<SDKSessionAPI>;

export type SDKAPI = WithSessionId<SDKSessionAPI>;
export type SDKRPC = RPCMethods<SDKAPI>;
