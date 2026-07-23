import type { Agent } from '..';
import type { PrepareToolExecutionResult } from '../../loop';
import { createPermissionDecisionPolicies } from './policies';
import type {
  ApprovalResponse,
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResolution,
  PermissionPolicyResult,
  PermissionRule
} from './types';

export * from './types';

/** Default timeout for user approval requests (ms). */
const APPROVAL_TIMEOUT_MS = 300_000;

export interface PermissionManagerOptions {
  readonly initialRules?: readonly PermissionRule[];
  readonly parent?: PermissionManager;
}

interface PendingApproval {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: unknown;
  readonly startedAt: number;
  resolve(value: ApprovalResponse): void;
  reject(error: Error): void;
}

export interface PendingApprovalInfo {
  readonly id: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: unknown;
  readonly startedAt: number;
}

interface PolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export class PermissionManager {
  rules: PermissionRule[] = [];
  private modeOverride: PermissionMode | undefined;
  private readonly parent: PermissionManager | undefined;
  private readonly localSessionApprovalRulePatterns = new Set<string>();
  private readonly policies: readonly PermissionPolicy[];
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private nextApprovalId = 0;

  constructor(
    protected readonly agent: Agent,
    options: PermissionManagerOptions = {},
  ) {
    this.rules = [...(options.initialRules ?? [])];
    this.parent = options.parent;
    this.policies = createPermissionDecisionPolicies(this.agent);
  }

  /** List all currently pending approval requests. */
  getPendingApprovals(): PendingApprovalInfo[] {
    const result: PendingApprovalInfo[] = [];
    for (const [id, p] of this.pendingApprovals) {
      result.push({
        id,
        turnId: p.turnId,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        action: p.action,
        display: p.display,
        startedAt: p.startedAt,
      });
    }
    return result;
  }

  /** Resolve a pending approval request by ID. */
  resolveApproval(id: string, response: ApprovalResponse): boolean {
    const pending = this.pendingApprovals.get(id);
    if (pending === undefined) return false;
    this.pendingApprovals.delete(id);
    pending.resolve(response);
    return true;
  }

  /** Cancel a pending approval request by ID. */
  cancelApproval(id: string): boolean {
    const pending = this.pendingApprovals.get(id);
    if (pending === undefined) return false;
    this.pendingApprovals.delete(id);
    pending.reject(new Error('Approval request cancelled'));
    return true;
  }

  /** Cancel all pending approval requests. */
  cancelAllApprovals(): void {
    for (const [, pending] of this.pendingApprovals) {
      pending.reject(new Error('Approval request cancelled'));
    }
    this.pendingApprovals.clear();
  }

  get mode(): PermissionMode {
    return this.modeOverride ?? this.parent?.mode ?? 'manual';
  }

  set mode(mode: PermissionMode) {
    this.modeOverride = mode;
  }

  data(): PermissionData {
    return {
      mode: this.mode,
      rules: this.effectiveRules,
    };
  }

  setMode(mode: PermissionMode): void {
    this.agent.records.logRecord({
      type: 'permission.set_mode',
      mode,
    });
    this.agent.replayBuilder.push({
      type: 'permission_updated',
      mode,
    });
    this.modeOverride = mode;
    this.agent.emitStatusUpdated();
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.agent.records.logRecord({
      type: 'permission.record_approval_result',
      ...record,
    });
    this.agent.replayBuilder.push({
      type: 'approval_result',
      record,
    });
    if (record.result.decision !== 'approved' || record.result.scope !== 'session') {
      return;
    }
    const pattern = record.sessionApprovalRule;
    if (pattern === undefined) return;
    this.localSessionApprovalRulePatterns.add(pattern);
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [
      ...this.localSessionApprovalRulePatterns,
      ...(this.parent?.sessionApprovalRulePatterns ?? []),
    ];
  }

  async beforeToolCall(
    context: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const evaluation = await this.evaluatePolicies(context);
    if (evaluation === undefined) return undefined;

    return this.permissionPolicyResolutionToPrepare(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  private async requestToolApproval(
    context: PermissionPolicyContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    policyName: string | undefined,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const { signal } = context;
    const id = context.toolCall.id;
    const name = context.toolCall.name;
    const display =
      context.execution.display ?? {
        kind: 'generic',
        summary: context.execution.description ?? `Approve ${name}`,
        detail: context.args,
      };
    const action = context.execution.description ?? `Call ${name}`;
    const startedAt = Date.now();

    let response: ApprovalResponse;
    if (this.agent.rpc?.requestApproval) {
      const approvalId = `approval-${String(++this.nextApprovalId)}`;
      try {
        const customPromise = new Promise<ApprovalResponse>((resolve, reject) => {
          this.pendingApprovals.set(approvalId, {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            display,
            startedAt,
            resolve,
            reject,
          });
          // RPC response also drives the same promise
          const rpcRequestApproval = this.agent.rpc?.requestApproval;
          if (rpcRequestApproval !== undefined) {
            rpcRequestApproval(
              {
                turnId: Number(context.turnId),
                toolCallId: id,
                toolName: name,
                action,
                display,
              },
              { signal },
            ).then(resolve, reject);
          }
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Approval request timed out after ${String(APPROVAL_TIMEOUT_MS)}ms`));
          }, APPROVAL_TIMEOUT_MS);
        });
        response = await Promise.race([customPromise, timeoutPromise]);
      } catch (error) {
        this.pendingApprovals.delete(approvalId);
        const resolved = result.resolveError?.(error);
        return await (resolved === undefined
          ? Promise.reject(error)
          : this.permissionPolicyResolutionToPrepare(resolved, context, policyName));
      } finally {
        this.pendingApprovals.delete(approvalId);
      }
    } else {
      response = {
        decision: 'cancelled',
        feedback: 'Approval handler is unavailable.',
      };
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;

    this.recordApprovalResult({
      turnId: Number(context.turnId),
      toolCallId: id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
    }

    if (response.decision === 'approved') {
      return undefined;
    }

    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, response),
    };
  }

  private async evaluatePolicies(
    context: PermissionPolicyContext,
  ): Promise<PolicyEvaluation | undefined> {
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) {
        return { policyName: policy.name, result };
      }
    }
    return undefined;
  }

  private get effectiveRules(): PermissionRule[] {
    return [...this.rules, ...(this.parent?.effectiveRules ?? [])];
  }

  private permissionPolicyResolutionToPrepare(
    result: PermissionPolicyResolution,
    context: PermissionPolicyContext,
    policyName?: string,
  ): Promise<PrepareToolExecutionResult | undefined> | PrepareToolExecutionResult | undefined {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          block: true,
          reason: result.message ?? this.formatPolicyDenyMessage(context.toolCall.name),
        };
      case 'ask':
        return this.requestToolApproval(context, result, policyName);
      case 'result': {
        const { kind: _kind, ...prepareResult } = result;
        return prepareResult;
      }
    }
  }

  protected formatApprovalRejectionMessage(
    toolName: string,
    result: { decision: 'approved' | 'rejected' | 'cancelled'; feedback?: string },
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.agent.type === 'sub') {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatPolicyDenyMessage(toolName: string): string {
    const prefix = `Tool "${toolName}" was denied by permission policy.`;
    if (this.agent.type === 'sub') {
      return `${prefix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return prefix;
  }
}
