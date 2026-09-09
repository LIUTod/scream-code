import { describe, expect, it } from 'vitest';

import { SubagentSlots } from '#/tui/utils/subagent-slots';

describe('SubagentSlots', () => {
  it('always exposes the 8 default types in fixed order, idle initially', () => {
    const slots = new SubagentSlots();
    const types = slots.getSlots().map((s) => s.type);
    expect(types).toEqual([
      'coder',
      'explore',
      'plan',
      'verify',
      'reviewer',
      'oracle',
      'worker',
      'writer',
    ]);
    expect(slots.getSlots().every((s) => s.status === 'idle')).toBe(true);
  });

  it('tracks the lifecycle: spawn → tool → output → completed → idle', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-1', 'coder', 'Review the sidebar change');
    expect(slots.getSlots().find((s) => s.type === 'coder')?.status).toBe('working');

    slots.onActivity('agent-1', 'tool', 'tool: Read');
    expect(slots.getSlots().find((s) => s.type === 'coder')?.status).toBe('working');

    slots.onActivity('agent-1', 'output', 'looks good');
    expect(slots.getSlots().find((s) => s.type === 'coder')?.status).toBe('outputting');

    slots.onTerminated('agent-1');
    expect(slots.getSlots().find((s) => s.type === 'coder')?.status).toBe('idle');
  });

  it('reworked: a second spawn of the same agentId marks the slot reworking', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-2', 'reviewer', 'First review');
    slots.onTerminated('agent-2');
    expect(slots.getSlots().find((s) => s.type === 'reviewer')?.status).toBe('idle');

    slots.onSpawned('agent-2', 'reviewer', 'Redo the review');
    const slot = slots.getSlots().find((s) => s.type === 'reviewer');
    expect(slot?.status).toBe('reworking');
    expect(slot?.detail).toContain('resume');
    slots.onTerminated('agent-2');
    expect(slots.getSlots().find((s) => s.type === 'reviewer')?.status).toBe('idle');
  });

  it('concurrent instances of one type share a slot and only go idle after the LAST one ends', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-7', 'coder', 'First coder');
    slots.onSpawned('agent-8', 'coder', 'Second coder'); // same type, different instance
    const slot = () => slots.getSlots().find((s) => s.type === 'coder');
    expect(slot()?.status).toBe('working');
    expect(slot()?.count).toBe(2);

    slots.onTerminated('agent-7');
    expect(slot()?.status).toBe('working'); // sibling still running
    expect(slot()?.count).toBe(1);

    slots.onTerminated('agent-8');
    expect(slot()?.status).toBe('idle'); // last one ended
    expect(slot()?.count).toBe(0);
  });

  it('messaging restores the pre-chat state even with a concurrent sibling terminating', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-9', 'worker', 'a');
    slots.onSpawned('agent-10', 'worker', 'b');
    slots.onMessagingStart('call-3', 'agent-9', 'steer');
    slots.onTerminated('agent-10'); // sibling ends while agent-9 is being messaged
    expect(slots.getSlots().find((s) => s.type === 'worker')?.status).toBe('messaging');
    slots.onMessagingEnd('call-3');
    expect(slots.getSlots().find((s) => s.type === 'worker')?.status).toBe('working');
    slots.onTerminated('agent-9');
    expect(slots.getSlots().find((s) => s.type === 'worker')?.status).toBe('idle');
  });

  it('messaging: SendSubagentMessage start marks the target messaging until result', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-3', 'oracle', 'Fix the layout bug');
    slots.onMessagingStart('call-1', 'agent-3', 'steer');
    expect(slots.getSlots().find((s) => s.type === 'oracle')?.status).toBe('messaging');
    expect(slots.getSlots().find((s) => s.type === 'oracle')?.detail).toContain('steer');

    // The agent was working before the chat; closing the window restores it.
    slots.onMessagingEnd('call-1');
    expect(slots.getSlots().find((s) => s.type === 'oracle')?.status).toBe('working');
  });

  it('messaging end for an unknown call id is a safe no-op', () => {
    const slots = new SubagentSlots();
    expect(() => slots.onMessagingEnd('call-missing')).not.toThrow();
  });

  it('a live activity event overrides a stale messaging state', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-4', 'worker', 'Build the artifacts');
    slots.onMessagingStart('call-2', 'agent-4', 'queue');
    slots.onActivity('agent-4', 'output', 'Building…');
    expect(slots.getSlots().find((s) => s.type === 'worker')?.status).toBe('outputting');
    slots.onMessagingEnd('call-2'); // stale end must not clobber the newer state
    expect(slots.getSlots().find((s) => s.type === 'worker')?.status).toBe('outputting');
  });

  it('custom types are appended after the 8 defaults, capped at MAX_SUBAGENT_SLOTS', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-5', 'gaffer', 'Light the set');
    const types = slots.getSlots().map((s) => s.type);
    expect(types.slice(0, 9)).toContain('gaffer');
    expect(types.length).toBe(9);
    expect(types[8]).toBe('gaffer');

    // Spawn past the cap: the 17th distinct type must not appear (detached).
    for (let i = 0; i < 9; i += 1) {
      slots.onSpawned(`agent-extra-${i}`, `custom-type-${i}`, 'x');
    }
    expect(slots.getSlots().length).toBe(16);
  });

  it('reset clears all runtime state', () => {
    const slots = new SubagentSlots();
    slots.onSpawned('agent-6', 'coder', 'x');
    slots.reset();
    expect(slots.getSlots().every((s) => s.status === 'idle')).toBe(true);
  });
});
