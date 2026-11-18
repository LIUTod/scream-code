import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context/types';
import { LocalDateInjector } from '../../../src/agent/injection/local-date';

function makeAgent(history: ContextMessage[]): Agent {
  return {
    type: 'main',
    context: {
      history,
      appendSystemReminder: (content: string, origin: unknown) => {
        history.push({
          role: 'user',
          content: [{ type: 'text', text: `<system-reminder>\n${content}\n</system-reminder>` }],
          toolCalls: [],
          origin: origin as ContextMessage['origin'],
        });
      },
    },
  } as unknown as Agent;
}

const HOUR = 60 * 60 * 1000;

function text(message: ContextMessage | undefined): string {
  return (message?.content[0] as { text: string } | undefined)?.text ?? '';
}

describe('LocalDateInjector', () => {
  it('injects nothing while the local day is the one the session opened on', async () => {
    const history: ContextMessage[] = [];
    let now = new Date(2026, 10, 18, 9, 0).getTime();
    const injector = new LocalDateInjector(makeAgent(history), () => now);

    await injector.inject();
    now += 10 * HOUR;
    await injector.inject();

    expect(history).toHaveLength(0);
  });

  it('tells the new date once after the day changes, and again on the next change', async () => {
    const history: ContextMessage[] = [];
    let now = new Date(2026, 10, 18, 23, 0).getTime();
    const injector = new LocalDateInjector(makeAgent(history), () => now);

    now += 2 * HOUR; // 01:00 the next day
    await injector.inject();
    await injector.inject();
    expect(history).toHaveLength(1);
    expect(text(history[0])).toContain('2026-11-19T01:00');

    now += 24 * HOUR;
    await injector.inject();
    expect(history).toHaveLength(2);
    expect(text(history[1])).toContain('2026-11-20');
  });

  it('tells the date again when the previous reminder left the context', async () => {
    const history: ContextMessage[] = [];
    let now = new Date(2026, 10, 18, 12, 0).getTime();
    const injector = new LocalDateInjector(makeAgent(history), () => now);

    now += 24 * HOUR;
    await injector.inject();
    injector.onContextClear();
    await injector.inject();

    expect(history).toHaveLength(2);
  });
});
