import type { Event, Session } from '@scream-code/scream-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { runPromptToEnd } from '#/host/run-to-end';

function session(script: (emit: (event: Record<string, unknown>) => void) => void) {
  const listeners = new Set<(event: Event) => void>();
  const cancel = vi.fn(async () => {});
  const value = {
    onEvent(listener: (event: Event) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel,
    async prompt() {
      setTimeout(() => {
        script((event) => {
          for (const l of listeners) l(event as unknown as Event);
        });
      }, 1);
    },
  } as unknown as Session;
  return { value, cancel };
}

describe('runPromptToEnd', () => {
  it('returns the last answer once the main agent settles', async () => {
    const { value } = session((emit) => {
      emit({ type: 'turn.started', agentId: 'main' });
      emit({ type: 'assistant.delta', agentId: 'main', delta: 'done' });
      emit({ type: 'turn.ended', agentId: 'main', reason: 'completed' });
    });
    await expect(runPromptToEnd(value, 'go', { settleMs: 10 })).resolves.toEqual({ ok: true, text: 'done', timedOut: false });
  });

  it('cancels and fails a run that never ends', async () => {
    const { value, cancel } = session((emit) => {
      emit({ type: 'turn.started', agentId: 'main' });
    });
    const result = await runPromptToEnd(value, 'go', { settleMs: 10, deadlineMs: 50 });
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(cancel).toHaveBeenCalled();
  });

  it('ignores subagent events', async () => {
    const { value } = session((emit) => {
      emit({ type: 'turn.started', agentId: 'main' });
      emit({ type: 'turn.ended', agentId: 'sub-1', reason: 'completed' });
      emit({ type: 'assistant.delta', agentId: 'main', delta: 'main answer' });
      emit({ type: 'turn.ended', agentId: 'main', reason: 'completed' });
    });
    await expect(runPromptToEnd(value, 'go', { settleMs: 10 })).resolves.toMatchObject({ text: 'main answer' });
  });
});

describe('runPromptToEnd — why a run failed', () => {
  it('carries the turn reason so an answerless failure can name itself', async () => {
    const { value } = session((emit) => {
      emit({ type: 'turn.started', agentId: 'main' });
      emit({ type: 'turn.ended', agentId: 'main', reason: 'failed' });
    });
    // No answer text at all: without the reason this is indistinguishable from
    // a run that quietly produced nothing.
    await expect(runPromptToEnd(value, 'go', { settleMs: 10 })).resolves.toEqual({
      ok: false,
      text: '',
      timedOut: false,
      failedReason: "the turn ended with reason 'failed'",
    });
  });

  it('names the error the turn failed with, code included, so a timeout can be told apart', async () => {
    const { value } = session((emit) => {
      emit({ type: 'turn.started', agentId: 'main' });
      emit({
        type: 'turn.ended',
        agentId: 'main',
        reason: 'failed',
        error: { code: 'provider.timeout', message: 'Request timed out.', retryable: true },
      });
    });
    await expect(runPromptToEnd(value, 'go', { settleMs: 10 })).resolves.toEqual({
      ok: false,
      text: '',
      timedOut: false,
      failedReason: 'Request timed out. [provider.timeout]',
      failure: { code: 'provider.timeout', message: 'Request timed out.' },
    });
  });

  it('names the token cap, and says nothing when the turn completed', async () => {
    const capped = session((emit) => {
      emit({ type: 'turn.started', agentId: 'main' });
      emit({ type: 'turn.ended', agentId: 'main', reason: 'completed', tokenCapReached: true });
    });
    await expect(runPromptToEnd(capped.value, 'go', { settleMs: 10 })).resolves.toMatchObject({
      ok: false,
      failedReason: 'the turn ended at the token cap',
    });

    const done = session((emit) => {
      emit({ type: 'turn.started', agentId: 'main' });
      emit({ type: 'turn.ended', agentId: 'main', reason: 'completed' });
    });
    const result = await runPromptToEnd(done.value, 'go', { settleMs: 10 });
    expect(result).not.toHaveProperty('failedReason');
  });
});
