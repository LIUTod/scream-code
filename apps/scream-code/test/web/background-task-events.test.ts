// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  createClientSharedState,
  type ClientContext,
  type ClientSharedState,
} from '../../src/web/frontend/src/composables/webClient/state';
import {
  createStreamingModule,
  type StreamingModule,
} from '../../src/web/frontend/src/composables/webClient/streaming';

/**
 * `background.task.*` consumption on the web client (batch 2.2, web side).
 *
 * The task panel keeps its 3s poll; these frames are only a latency cut, and
 * they follow the REST list's 口径 = main: `GET /sessions/:id/tasks` reads the
 * main agent's registry, so a subagent-owned frame (agentId ≠ main) describes a
 * task that list cannot show and must not trigger a refetch.
 */

function makeCtx(): { s: ClientSharedState; refresh: Mock; streaming: StreamingModule } {
  const s = createClientSharedState();
  const refresh = vi.fn(async () => undefined);
  const ctx = {
    s,
    showToast: vi.fn(),
    connect: vi.fn(),
    stopHeartbeat: vi.fn(),
    resetGoalRequestState: vi.fn(),
    syncGoalRequestPending: vi.fn(),
    fetchSessions: vi.fn(async () => undefined),
    fetchGitStatus: vi.fn(async () => undefined),
    fetchSnapshot: vi.fn(async () => undefined),
    refreshBackgroundTasks: refresh,
  } as unknown as ClientContext;
  const streaming = createStreamingModule(ctx); // installs the `event` WS handler
  return { s, refresh, streaming };
}

/** Deliver one journal frame through the same handler the dispatcher uses. */
function fire(s: ClientSharedState, seq: number, payload: Record<string, unknown>): void {
  const handler = s.wsHandlers.get('event');
  if (!handler) throw new Error('no event handler registered');
  handler({ type: 'event', seq, epoch: s.epoch, payload } as never);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('web background.task.* frames', () => {
  it('coalesces a lifecycle burst into a single refetch', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { s, refresh } = makeCtx();

    fire(s, 1, { type: 'background.task.started', agentId: 'main', info: {} });
    fire(s, 2, { type: 'background.task.updated', agentId: 'main', info: {} });
    fire(s, 3, { type: 'background.task.terminated', agentId: 'main', info: {} });

    // Debounced, not per-frame: the burst has not fired yet.
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores a subagent-owned task frame — the REST list cannot show it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { s, refresh } = makeCtx();

    fire(s, 1, { type: 'background.task.started', agentId: 'agent-7', info: {} });
    vi.advanceTimersByTime(1_000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('treats a frame without agentId as main', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { s, refresh } = makeCtx();

    fire(s, 1, { type: 'background.task.terminated', info: {} });
    vi.advanceTimersByTime(250);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('drops the pending refetch on dispose', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { s, refresh, streaming } = makeCtx();

    fire(s, 1, { type: 'background.task.started', agentId: 'main', info: {} });
    streaming.disposeStreaming();
    vi.advanceTimersByTime(1_000);

    expect(refresh).not.toHaveBeenCalled();
  });
});
