// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createClientSharedState,
  type ClientContext,
  type ClientSharedState,
} from '../../src/web/frontend/src/composables/webClient/state';
import { createSessionsModule } from '../../src/web/frontend/src/composables/webClient/sessions';
import { createSnapshotsModule } from '../../src/web/frontend/src/composables/webClient/snapshots';
import { createStreamingModule } from '../../src/web/frontend/src/composables/webClient/streaming';

/**
 * Regression pins for the journal gap-recovery path (module level: drives the
 * composable directly instead of mounting a component):
 *  - a snapshot refetch triggered by a gap must apply **immediately** — the frame
 *    that triggered it must not invalidate the result by advancing its own
 *    liveGeneration (that would degrade "recover now" into a 250ms retry chain);
 *  - journalGapCount counts *consecutive* gaps: switching sessions must reset it,
 *    otherwise the count left over from the previous session pushes the first two
 *    legitimate seq jumps of the new session (reconnect replay skipping volatile
 *    events) straight to the ≥3 error escalation line.
 */

const SNAPSHOT = {
  sessionId: 'sess-1',
  workDir: '/wd',
  seq: 3,
  epoch: 10,
  messages: [{ id: 'snap-1', role: 'user', content: 'from-snapshot', tools: [], ts: 1, seq: 3 }],
  pendingApprovals: [],
  status: { busy: false, model: 'test-model' },
  busy: false,
  goal: null,
  todos: [],
  olderAvailable: false,
  oldestSeq: 3,
};

function makeCtx(): { s: ClientSharedState; ctx: ClientContext } {
  const s = createClientSharedState();
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
  } as unknown as ClientContext;
  createSnapshotsModule(ctx); // installs ctx.fetchSnapshot (the real implementation)
  createStreamingModule(ctx); // registers the event / resync_required WS handlers
  return { s, ctx };
}

/** Delivers one journal frame (same handler table that dispatch uses). */
function fireJournal(s: ClientSharedState, seq: number, epoch: number): void {
  const handler = s.wsHandlers.get('event');
  if (!handler) throw new Error('no event handler registered');
  handler({ type: 'event', seq, epoch, payload: { type: 'todo.updated', todos: [] } } as never);
}

/** Drains the microtask chain: fetch → res.json() → canApplySnapshot → applySnapshot. */
async function flushAsync(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a journal gap triggers a snapshot refetch', () => {
  it('applies the refetched snapshot immediately, despite that frame advancing liveGeneration', async () => {
    const { s } = makeCtx();
    // The gap path is fail-loud: only silence the output, and also pin that the
    // first gap logs a warning (never an error).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.sessionId.value = 'sess-1';
    s.connectionStatus.value = 'connected';
    s.messages.value = [{ id: 'local-1', role: 'user', content: 'hi', tools: [], ts: 1 }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => SNAPSHOT })));

    fireJournal(s, 1, 10); // first continuation frame: apply
    expect(s.liveGeneration).toBe(1);

    fireJournal(s, 3, 10); // seq jump: gap → log + refetch the snapshot
    expect(s.journalGapCount).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    await flushAsync();

    // Effective immediately: the authoritative snapshot replaced the local
    // messages, with no retry chain.
    expect(s.messages.value.map((m) => m.content)).toContain('from-snapshot');
    expect(s.snapshotRetryTimer).toBeNull();

    fireJournal(s, 4, 10); // continuation frame: consecutive-gap counter resets
    expect(s.journalGapCount).toBe(0);
  });
});

describe('journalGapCount resets across sessions', () => {
  it('resets on session switch (otherwise a legitimate jump in the new session reads as the 3rd consecutive gap)', async () => {
    const { s, ctx } = makeCtx();
    const sessions = createSessionsModule(ctx);
    s.currentSessionId.value = 'sess-1';
    s.sessionId.value = 'sess-1';
    s.journalGapCount = 2; // consecutive gaps carried over from the previous session

    await sessions.switchSession('sess-2');

    expect(s.journalGapCount).toBe(0);
    expect(s.sessionId.value).toBe('sess-2');
  });
});

describe('createSession onCreated callback', () => {
  it('fires synchronously after a successful REST create (same parameter surface as the facade)', async () => {
    const { s, ctx } = makeCtx();
    const sessions = createSessionsModule(ctx);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sessionId: 'sess-new', workDir: '/wd' }) })),
    );
    const onCreated = vi.fn();

    await sessions.createSession('/wd', onCreated);

    expect(onCreated).toHaveBeenCalledWith('sess-new');
    expect(s.sessions.value.map((item) => item.sessionId)).toContain('sess-new');
  });
});
