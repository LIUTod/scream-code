import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context/types';
import { WorkingSetInjector } from '../../../src/agent/injection/working-set';

interface StubState {
  history: ContextMessage[];
  paths: string[];
}

function makeAgent(state: StubState): Agent {
  return {
    type: 'main',
    context: {
      history: state.history,
      appendSystemReminder: (content: string, origin: unknown) => {
        state.history.push({
          role: 'user',
          content: [{ type: 'text', text: `<system-reminder>\n${content}\n</system-reminder>` }],
          toolCalls: [],
          origin: origin as ContextMessage['origin'],
        });
      },
    },
    workingSet: { getPaths: () => state.paths },
  } as unknown as Agent;
}

describe('WorkingSetInjector', () => {
  it('does not inject while the set is empty', async () => {
    const state: StubState = { history: [], paths: [] };
    const injector = new WorkingSetInjector(makeAgent(state));

    await injector.inject();

    expect(state.history).toHaveLength(0);
  });

  it('injects when the set changes, not on a timer', async () => {
    const state: StubState = { history: [], paths: ['/w/a.ts'] };
    const injector = new WorkingSetInjector(makeAgent(state));

    await injector.inject();
    // Unchanged set → no second copy, regardless of how many turns pass.
    await injector.inject();
    expect(state.history).toHaveLength(1);

    state.paths = ['/w/a.ts', '/w/b.ts'];
    await injector.inject();
    expect(state.history).toHaveLength(2);
    expect((state.history[1]!.content[0] as { text: string }).text).toContain('/w/b.ts');
  });

  it('re-injects after the previous copy left the context', async () => {
    const state: StubState = { history: [], paths: ['/w/a.ts'] };
    const injector = new WorkingSetInjector(makeAgent(state));

    await injector.inject();
    injector.onContextMessageRemoved(0);
    await injector.inject();

    expect(state.history).toHaveLength(2);
  });
});
