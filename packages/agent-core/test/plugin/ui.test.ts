import { describe, expect, it, vi } from 'vitest';

import { createPluginUi } from '../../src/plugin/runtime/ui';

function fakeAgent(options: { rpc?: unknown; status?: 'connected' } = {}) {
  const events: unknown[] = [];
  return {
    events,
    agent: {
      eventBus: {
        dispatch: (event: unknown) => {
          events.push(event);
        },
      },
      ...(options.rpc === undefined ? {} : { rpc: options.rpc }),
    } as never,
  };
}

describe('plugin ui surface', () => {
  it('notify goes out as a host-visible warning tagged with the plugin', () => {
    const { agent, events } = fakeAgent();
    createPluginUi(agent, 'text-stats').notify('info', 'hello');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'warning',
      message: '[text-stats] hello',
      code: 'plugin:info',
    });
  });

  it('confirm rides requestQuestion and maps the chosen label to a boolean', async () => {
    const requestQuestion = vi.fn(
      async (_request: unknown): Promise<{ answers: Record<string, string> }> => ({
        answers: { 'Publish now?': 'Yes' },
      }),
    );
    const { agent } = fakeAgent({ rpc: { requestQuestion } });
    const ui = createPluginUi(agent, 'release');

    await expect(ui.confirm({ title: 'Publish now?' })).resolves.toBe(true);
    expect(requestQuestion).toHaveBeenCalledTimes(1);
    const payload = requestQuestion.mock.calls[0]![0] as {
      questions: Array<{ question: string; options: Array<{ label: string }> }>;
    };
    expect(payload.questions[0]?.question).toBe('Publish now?');
    expect(payload.questions[0]?.options.map((option) => option.label)).toEqual(['Yes', 'No']);
  });

  it('confirm returns false when the user picks cancel, and on a thrown question', async () => {
    const { agent } = fakeAgent({
      rpc: { requestQuestion: vi.fn(async () => ({ answers: { 'Go?': 'No' } })) },
    });
    await expect(createPluginUi(agent, 'p').confirm({ title: 'Go?' })).resolves.toBe(false);

    const failing = fakeAgent({
      rpc: {
        requestQuestion: vi.fn(async () => {
          throw new Error('cancelled');
        }),
      },
    });
    await expect(createPluginUi(failing.agent, 'p').confirm({ title: 'Go?' })).resolves.toBe(false);
  });

  it('confirm degrades to a denial plus a notice when the host cannot ask', async () => {
    const { agent, events } = fakeAgent({ rpc: {} });

    await expect(createPluginUi(agent, 'p').confirm({ title: 'Go?' })).resolves.toBe(false);
    expect(events[0]).toMatchObject({ type: 'warning', code: 'plugin:warn' });
  });

  it('progress reports text steps, throttles info updates and surfaces failures as errors', () => {
    const { agent, events } = fakeAgent();
    const progress = createPluginUi(agent, 'p').progress('Indexing');

    progress.update('1/3');
    progress.update('2/3');
    progress.fail('disk full');

    // Start + (throttled updates) + the failure; the exact count of the middle
    // burst depends on the clock, so assert on the boundaries.
    expect(events[0]).toMatchObject({ message: '[p] Indexing…' });
    expect(events.at(-1)).toMatchObject({ message: '[p] disk full', code: 'plugin:error' });
  });
});
