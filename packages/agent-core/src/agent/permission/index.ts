import type { Agent } from '..';
import type { PrepareToolExecutionResult } from '../../loop';
import type { ToolFileAccess, ToolFileAccessOperation, ToolResourceAccess } from '../../loop/tool-access';
import { isWithinDirectory, type PathClass } from '../../tools/policies/path-access';
import { createPermissionDecisionPolicies } from './policies';
import { EGRESS_COMMAND_PATTERN } from './policies/private-read-egress-ask';
import type {
  ApprovalGrant,
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

/**
 * Readable view of a pending approval. Deliberately carries no source
 * attribution: `sourceAgentId` / `sourceAgentName` / `sourceToolName` are
 * stamped on the `ApprovalRequest` handed to `rpc.requestApproval` (the path
 * the TUI/web panels consume), and nothing reads them off the pending list.
 */
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
  /**
   * Two-phase private-read tracking (see `trackPendingPrivateRead` /
   * `settlePrivateRead`): the first phase records a candidate read of
   * outside-workspace data keyed by tool call id, the second promotes it to
   * `localTaintedPrivateReads` only after the call is known to have
   * succeeded. Both maps are in-memory session state — never persisted.
   */
  private readonly localPendingPrivateReads = new Map<string, string>();
  private readonly localTaintedPrivateReads = new Set<string>();
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

  /**
   * Forget one memorized approve-for-session pattern. Revocation is local
   * only: `sessionApprovalRulePatterns` merges the parent chain read-only, so
   * this manager cannot drop a grant its parent holds (and a child's grant is
   * invisible to the parent). Returns true when a local grant was removed.
   *
   * A real removal is recorded on the wire, otherwise a resumed session would
   * re-add the pattern from its own approval-result record and prompt again
   * for a grant the user took back. The same method serves the replay path:
   * `AgentRecords.logRecord` is a no-op while restoring, so restore cannot
   * re-write the record it is replaying.
   */
  revokeSessionGrant(pattern: string): boolean {
    const removed = this.localSessionApprovalRulePatterns.delete(pattern);
    if (removed) {
      this.agent.records.logRecord({
        type: 'permission.record_grant_revocation',
        pattern,
      });
    }
    return removed;
  }

  /**
   * Descriptions of the successful reads of outside-workspace data this
   * session has performed, merged with the parent chain read-only (same
   * shape as `sessionApprovalRulePatterns`). A subagent sees its parent's
   * taint but cannot add to it, and the taint dies with the agent: it is
   * never persisted.
   */
  get taintedPrivateReads(): readonly string[] {
    return [
      ...this.localTaintedPrivateReads,
      ...(this.parent?.taintedPrivateReads ?? []),
    ];
  }

  /**
   * True while a candidate private read has not settled yet, on this agent or
   * anywhere up the parent chain. Every call in one tool batch is authorized
   * before any of their results is finalized, so a same-batch
   * `[Read /tmp/secret, Bash(curl …)]` never sees the taint — the egress
   * guard reads this flag too and fails closed during that window.
   */
  hasPendingPrivateReads(): boolean {
    return (
      this.localPendingPrivateReads.size > 0 || (this.parent?.hasPendingPrivateReads() ?? false)
    );
  }

  /**
   * Second half of two-phase private-read tracking. A pending candidate read
   * is promoted to the tainted set only when the call succeeded; a failed
   * call never delivered its content to the model, so it is dropped. Both
   * outcomes clear the pending entry, so the map cannot grow unbounded.
   */
  settlePrivateRead(toolCallId: string, failed: boolean): void {
    const description = this.localPendingPrivateReads.get(toolCallId);
    if (description === undefined) return;
    this.localPendingPrivateReads.delete(toolCallId);
    if (failed) return;
    this.localTaintedPrivateReads.add(description);
  }

  /**
   * First half of two-phase private-read tracking: a call that reads,
   * searches, or read-writes a path outside the workspace is recorded as a
   * pending candidate here. Promotion happens in `settlePrivateRead` once the
   * result is known — denied, blocked, and failed calls must not taint the
   * session. The description never carries file content, only the path.
   */
  private trackPendingPrivateRead(context: PermissionPolicyContext): void {
    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return;
    const pathClass = this.agent.jian.pathClass();
    const accesses = context.execution.accesses;
    // Missing or opaque (`all`) accesses mean "the tool did not say" — the
    // loop treats that as a global conflict, so treating it as "no access"
    // would be fail-open. Shell commands are the case this covers today: the
    // command text is scanned for path references outside the workspace.
    if (accesses === undefined || accesses.some((access) => access.kind === 'all')) {
      const path = outsidePathInShellCommand(context, cwd, pathClass, this.agent.jian.gethome());
      if (path !== undefined) {
        this.localPendingPrivateReads.set(context.toolCall.id, formatPrivateReadDescription(path));
      }
      return;
    }
    const privateReads = accesses.filter(isPrivateReadAccess);
    if (privateReads.length === 0) return;
    const access = privateReads.find(
      (fileAccess) => !isWithinDirectory(fileAccess.path, cwd, pathClass),
    );
    if (access === undefined) return;
    this.localPendingPrivateReads.set(context.toolCall.id, formatPrivateReadDescription(access.path));
  }

  async beforeToolCall(
    context: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    this.trackPendingPrivateRead(context);
    const evaluation = await this.evaluatePolicies(context);
    if (evaluation === undefined) return undefined;

    const prepared = await this.permissionPolicyResolutionToPrepare(
      evaluation.result,
      context,
      evaluation.policyName,
    );
    // A blocked or synthesized call never executes, so its candidate read is
    // dropped here instead of waiting for a result that will not come.
    if (prepared?.block === true || prepared?.syntheticResult !== undefined) {
      this.localPendingPrivateReads.delete(context.toolCall.id);
    }
    return prepared;
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
    // Who is asking + what triggered it, carried on the wire so the UI can
    // attribute the request. `sourceAgentName` is omitted when the agent has
    // no profile name — consumers fall back to `sourceAgentId`. The capability
    // mode rides along only when the asker is restricted, so the common
    // main-agent payload keeps its existing shape.
    const sourceAgentId = this.agent.agentId;
    const sourceAgentName = this.agent.config.profileName;
    const sourceCapabilityMode = this.agent.getCapabilityMode();
    const source = {
      sourceAgentId,
      ...(sourceAgentName !== undefined ? { sourceAgentName } : {}),
      ...(sourceCapabilityMode !== 'all' ? { sourceCapabilityMode } : {}),
      sourceToolName: name,
    };
    // What the user asked for this turn; omitted when the prompt had no text.
    const requestSummary = this.agent.turn.getLastPromptSummary();

    let response: ApprovalResponse;
    if (this.agent.rpc?.requestApproval) {
      const approvalId = `approval-${String(++this.nextApprovalId)}`;
      // Captured outside `try` so `finally` can clear it once the race
      // settles: without clearTimeout a resolved approval leaves its
      // rejection timer alive for nothing (one leaked timer per approval).
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      // Set by the rejection timer so the catch below can tell a timeout from
      // a cancellation (both arrive as a rejected race).
      let timedOut = false;
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
                reasons: result.reasons,
                grantOptions: result.grantOptions,
                ...(requestSummary !== undefined ? { requestSummary } : {}),

                ...source,
              },
              { signal },
            ).then(resolve, reject);
          }
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Approval request timed out after ${String(APPROVAL_TIMEOUT_MS)}ms`));
          }, APPROVAL_TIMEOUT_MS);
        });
        response = await Promise.race([customPromise, timeoutPromise]);
      } catch (error) {
        this.pendingApprovals.delete(approvalId);
        this.recordDecision(context, {
          decision: timedOut ? 'timeout' : 'cancelled',
          reason: errorText(error),
        });
        const resolved = result.resolveError?.(error);
        return await (resolved === undefined
          ? Promise.reject(error)
          : this.permissionPolicyResolutionToPrepare(resolved, context, policyName));
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        this.pendingApprovals.delete(approvalId);
      }
    } else {
      response = {
        decision: 'cancelled',
        feedback: 'Approval handler is unavailable.',
      };
      this.recordDecision(context, {
        decision: 'cancelled',
        reason: 'Approval handler is unavailable.',
      });
    }

    response = this.downgradeUnofferedSessionScope(response, result.grantOptions, name);

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

  /**
   * Drop a session scope the policy never offered. Panels filter their buttons
   * by `grantOptions`, but the response is wire input — the core is the only
   * place that can guarantee a once-only prompt never memorizes a session
   * grant. Runs before the session rule is derived, so a downgraded response
   * leaves no `session-runtime` rule behind.
   */
  private downgradeUnofferedSessionScope(
    response: ApprovalResponse,
    grantOptions: readonly ApprovalGrant[] | undefined,
    toolName: string,
  ): ApprovalResponse {
    if (response.decision !== 'approved' || response.scope !== 'session') return response;
    if (grantOptions === undefined || grantOptions.includes('session')) return response;
    this.agent.log.warn(
      'Approval response requested a session grant that was not offered; downgrading to a one-time grant.',
      { toolName, grantOptions: [...grantOptions] },
    );
    const { scope: _scope, ...rest } = response;
    return rest;
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

  /**
   * Append a stop decision to the wire, so a session's denials and aborted
   * approvals stay auditable. Uses the low-level record API on purpose: the
   * record is an audit trail, and replaying a session must not re-run a
   * decision (the live UI state already comes from the approval-result
   * records and the blocked tool's own error result).
   */
  private recordDecision(
    context: PermissionPolicyContext,
    decision: {
      policyName?: string;
      decision: 'deny' | 'cancelled' | 'timeout';
      reason?: string;
    },
  ): void {
    this.agent.records.logRecord({
      type: 'permission.record_decision',
      turnId: Number(context.turnId),
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      ...decision,
    });
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
      case 'deny': {
        const reason =
          result.message ??
          (typeof result.reason === 'object' &&
          result.reason !== null &&
          typeof (result.reason as { reason?: unknown }).reason === 'string'
            ? `Tool "${context.toolCall.name}" was denied by permission policy: ${(result.reason as { reason: string }).reason}`
            : this.formatPolicyDenyMessage(context.toolCall.name));
        this.recordDecision(context, {
          ...(policyName !== undefined ? { policyName } : {}),
          decision: 'deny',
          reason,
        });
        return { block: true, reason };
      }
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
    if (result.decision === 'rejected') {
      return `${prefix}${suffix} Do not re-attempt the exact same call - think about why it was rejected, then adjust your approach or ask the user what they would prefer.`;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Operations that pull outside-workspace data into the session. */
const PRIVATE_READ_OPERATIONS: ReadonlySet<ToolFileAccessOperation> = new Set([
  'read',
  'search',
  'readwrite',
]);

function isPrivateReadAccess(access: ToolResourceAccess): access is ToolFileAccess {
  return access.kind === 'file' && PRIVATE_READ_OPERATIONS.has(access.operation);
}

/** Longest path kept in a taint description; the tail is what identifies the file. */
const PRIVATE_READ_PATH_LIMIT = 120;

function formatPrivateReadDescription(path: string): string {
  const shown =
    path.length > PRIVATE_READ_PATH_LIMIT ? `…${path.slice(-PRIVATE_READ_PATH_LIMIT)}` : path;
  return `read outside the workspace: ${shown}`;
}

/** Absolute paths, `~/…` and `$HOME/…` references in shell command text. */
const SHELL_PATH_REFERENCE = /(?<!:)(?:~|\$\{?HOME\}?)?\/[^\s'"`;|&<>()]*/g;

/** URLs are stripped before the scan: their host part is not a file path. */
const SHELL_URL_REFERENCE = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi;

/**
 * Read-class commands: only these pull file *content* into the session. A
 * command that merely names a path — `ls /tmp`, `echo /etc`, a redirect
 * target, an env assignment — must not taint it, or ordinary build/test
 * commands would leave a permanent taint (and a permanent bot-mode denial).
 */
const SHELL_READ_VERB =
  /\b(cat|head|tail|grep|rg|less|more|xxd|od|strings|base64|awk|sed|sort|uniq|cut)\b/;

/** Tokens that introduce a write target. */
const SHELL_WRITE_OPERATORS: ReadonlySet<string> = new Set([
  '>',
  '>>',
  '-o',
  '-O',
  '--output',
  'tee',
]);

/** Environment assignment (`PATH=…`), never a read. */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Glued redirects: `>/tmp/log` and fd forms like `2>/tmp/err`. */
const SHELL_REDIRECT_PREFIX = /^\d*>>?/;

/**
 * `github.com/foo` — a bare host followed by a path, as `curl`/`scp` accept
 * it. The leading segment makes it look like an absolute path to the scanner,
 * but it names a remote resource, not a local file.
 */
const SHELL_HOST_SHAPED_TOKEN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\//;

/**
 * First path reference in a shell command that resolves outside the workspace
 * (home expanded), or undefined.
 *
 * The scan only runs for read-class or egress commands and skips write targets,
 * assignments, and host-shaped tokens, because the guard exists to catch file
 * content entering the session — not every mention of a path. Known residues,
 * registered with the egress policy's blind-spot note: relative paths
 * (`cd / && cat .env`); readers or interpreters outside the verb list
 * (`python3 -c`, `perl -ne`, `dd`), which never taint through this scan; write
 * flag families that name a file without a redirect (`ssh-keygen -f`,
 * `openssl -i`) and commands such as `ssh-copy-id` that are not judged at all;
 * and paths hidden behind quoting or encoding.
 */
function outsidePathInShellCommand(
  context: PermissionPolicyContext,
  cwd: string,
  pathClass: PathClass,
  homeDir: string,
): string | undefined {
  if (context.toolCall.name !== 'Bash') return undefined;
  const command = (context.args as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string') return undefined;
  // Egress commands read local files through upload flags (`-d @file`, `-T`)
  // without any read verb, so they bypass the gate; every other command must
  // look like a read before its paths are considered.
  if (!EGRESS_COMMAND_PATTERN.test(command) && !SHELL_READ_VERB.test(command)) return undefined;
  const tokens = command.replace(SHELL_URL_REFERENCE, ' ').split(/\s+/);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (isShellWriteTarget(token, tokens[index - 1])) continue;
    if (SHELL_HOST_SHAPED_TOKEN.test(token)) continue;
    for (const match of token.matchAll(SHELL_PATH_REFERENCE)) {
      const path = expandHomeReference(match[0], homeDir);
      if (!isWithinDirectory(path, cwd, pathClass)) return path;
    }
  }
  return undefined;
}

function isShellWriteTarget(token: string, previous: string | undefined): boolean {
  if (token.length === 0) return false;
  if (SHELL_ASSIGNMENT.test(token)) return true;
  if (SHELL_REDIRECT_PREFIX.test(token)) return true;
  if (SHELL_WRITE_OPERATORS.has(token)) return true;
  return previous !== undefined && SHELL_WRITE_OPERATORS.has(previous);
}

function expandHomeReference(path: string, homeDir: string): string {
  if (path.startsWith('~/')) return `${homeDir}${path.slice(1)}`;
  if (path.startsWith('${HOME}/')) return `${homeDir}${path.slice('${HOME}'.length)}`;
  if (path.startsWith('$HOME/')) return `${homeDir}${path.slice('$HOME'.length)}`;
  return path;
}
