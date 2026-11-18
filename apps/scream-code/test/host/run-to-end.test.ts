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
