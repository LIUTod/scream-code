import { describe, expect, it } from 'vitest';

import { buildBackgroundTaskNotificationBody } from '../../../src/agent/background';
import type { BackgroundTaskInfo } from '../../../src/tools/background/manager';

/**
 * P1b: a user-stopped (killed) background subagent is a deliberate
 * cancellation — mirroring the reference implementation's auto-wake gate, its
 * completion notification must NOT suggest resuming it. Tasks that fail or get
 * lost on their own keep the recovery hint.
 */

function info(overrides: Partial<BackgroundTaskInfo>): BackgroundTaskInfo {
  return {
    taskId: 'agent-task-1',
    command: '[agent] some task',
    description: 'some task',
    status: 'running',
    exitCode: null,
    startedAt: 0,
    endedAt: null,
    timeoutMs: 600_000,
    agentId: 'agent-0',
    subagentType: 'coder',
    pid: 0,
    ...overrides,
  } as BackgroundTaskInfo;
}

describe('buildBackgroundTaskNotificationBody cancel semantics', () => {
  it('killed agent task: states the cancellation and does NOT suggest resume', () => {
    const body = buildBackgroundTaskNotificationBody(
      info({ status: 'killed', stopReason: 'user stopped it' }),
      true,
    );
    expect(body).toContain('cancelled by the user');
    expect(body).not.toContain('resume=');
    expect(body).toContain('user stopped it');
  });

  it('killed non-agent task: plain base line, no recovery text', () => {
    const body = buildBackgroundTaskNotificationBody(
      info({ status: 'killed', stopReason: 'user stopped it', agentId: undefined }),
      false,
    );
    expect(body).not.toContain('resume=');
    expect(body).not.toContain('cancelled by the user');
    expect(body).toContain('was killed');
  });

  it('failed agent task: keeps the recovery hint (not a user cancellation)', () => {
    const body = buildBackgroundTaskNotificationBody(info({ status: 'failed' }), true);
    expect(body).toContain('resume=');
    expect(body).not.toContain('cancelled by the user');
  });

  it('lost agent task: keeps the recovery hint', () => {
    const body = buildBackgroundTaskNotificationBody(info({ status: 'lost' }), true);
    expect(body).toContain('resume=');
  });

  it('completed agent task: no recovery text', () => {
    const body = buildBackgroundTaskNotificationBody(info({ status: 'completed' }), true);
    expect(body).not.toContain('resume=');
  });
});
