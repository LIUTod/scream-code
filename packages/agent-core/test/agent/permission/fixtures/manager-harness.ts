/**
 * Shared harness for permission-policy tests.
 *
 * The fake Agent exposes exactly the surface the policy chain touches while
 * raising an approval (`approval-source.test.ts` keeps its own copy because it
 * predates this fixture). `permission` is assigned after construction because
 * the policies resolve it lazily.
 */

import type { ToolCall } from '@scream-code/ltod';
import { vi } from 'vitest';

import type { Agent } from '../../../../src/agent';
import { PermissionManager } from '../../../../src/agent/permission';
import type {
  ApprovalResponse,
  PermissionMode,
  PermissionPolicyContext,
} from '../../../../src/agent/permission/types';
import type { ScreamConfig } from '../../../../src/config';
import { createFakeJian } from '../../../tools/fixtures/fake-jian';

const signal = new AbortController().signal;

export interface PermissionHarness {
  readonly agent: Agent;
  readonly manager: PermissionManager;
  readonly requestApproval: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
}

export interface PermissionHarnessOptions {
  readonly mode?: PermissionMode;
  readonly handler?: (request: unknown) => Promise<ApprovalResponse>;
  /** Host configuration the policies read (e.g. `permission.egressAllowlist`). */
  readonly screamConfig?: ScreamConfig;
  /** What the fake turn reports as the last prompt summary. */
  readonly promptSummary?: string;
}

export function makePermissionHarness(options: PermissionHarnessOptions = {}): PermissionHarness {
  const requestApproval = vi.fn(
    options.handler ?? (async () => ({ decision: 'approved' }) satisfies ApprovalResponse),
  );
  const warn = vi.fn();
  const agent = {
    agentId: 'main',
    config: { cwd: '/workspace', profileName: 'agent' },
    type: 'main',
    jian: createFakeJian(),
    emitStatusUpdated: vi.fn(),
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval },
    log: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    getCapabilityMode: () => 'all' as const,
    planMode: {
      get isActive() {
        return false;
      },
      get planFilePath() {
        return null;
      },
      data: vi.fn(async () => null),
      exit: vi.fn(),
    },
    wolfpackMode: { isActive: false },
    screamConfig: options.screamConfig,
    turn: { getLastPromptSummary: () => options.promptSummary },
  } as unknown as Agent;
  const manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  if (options.mode !== undefined) manager.mode = options.mode;
  return { agent, manager, requestApproval, warn };
}

export function toolContext(
  toolName: string,
  args: Record<string, unknown>,
): PermissionPolicyContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: `call_${toolName.toLowerCase()}`,
    name: toolName,
    arguments: JSON.stringify(args),
  };
  const command = typeof args['command'] === 'string' ? args['command'] : '';
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {} as never,
    args,
    toolCall,
    execution: {
      description: `Running: ${toolName}`,
      display: { kind: 'command', command, cwd: '/workspace' },
      accesses: [],
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

export function bashContext(command: string): PermissionPolicyContext {
  return toolContext('Bash', { command, timeout: 60 });
}

/** Memorize an approve-for-session grant for Bash the way the TUI does. */
export function grantBashForSession(manager: PermissionManager): void {
  manager.recordApprovalResult({
    turnId: 0,
    toolCallId: 'call_bash',
    toolName: 'Bash',
    action: 'Run a command',
    sessionApprovalRule: 'Bash',
    result: { decision: 'approved', scope: 'session' },
  });
}
