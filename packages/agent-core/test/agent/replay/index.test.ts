import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import { REPLAY_TURN_LIMIT, ReplayBuilder } from '../../../src/agent/replay';
import type { AgentReplayRecord } from '../../../src/index';

function restoringAgent(): Agent {
  return { records: { restoring: true } } as unknown as Agent;
}

function idleAgent(): Agent {
  return { records: { restoring: false } } as unknown as Agent;
}

function userTurn(text: string): AgentReplayRecord {
  return {
    type: 'message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  } as unknown as AgentReplayRecord;
}

function assistantMessage(text: string): AgentReplayRecord {
  return {
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
  } as unknown as AgentReplayRecord;
}

function userTurnTexts(records: readonly AgentReplayRecord[]): string[] {
  return records
    .filter(
      (r) =>
        r.type === 'message' &&
        r.message.role === 'user' &&
        (r.message.origin === undefined || r.message.origin.kind === 'user'),
    )
    .map((r) => {
      const first = r.type === 'message' ? r.message.content[0] : undefined;
      return first !== undefined && first.type === 'text' ? first.text : '';
    });
}

describe('ReplayBuilder rolling window', () => {
  it('keeps only the last REPLAY_TURN_LIMIT user turns during restore', () => {
    const builder = new ReplayBuilder(restoringAgent());
    const totalTurns = REPLAY_TURN_LIMIT + 3;
    for (let i = 0; i < totalTurns; i++) {
      builder.push(userTurn(`question ${i}`));
      builder.push(assistantMessage(`answer ${i}`));
    }

    const result = builder.buildResult();
    const turns = userTurnTexts(result);
    expect(turns).toHaveLength(REPLAY_TURN_LIMIT);
    // Oldest retained turn is question 3 (turns 0-2 dropped).
    expect(turns[0]).toBe('question 3');
    expect(turns.at(-1)).toBe(`question ${totalTurns - 1}`);
    // The window starts exactly at a user-turn-start record.
    expect(result[0]!.type).toBe('message');
  });

  it('retains everything when turns fit within the window', () => {
    const builder = new ReplayBuilder(restoringAgent());
    for (let i = 0; i < 3; i++) {
      builder.push(userTurn(`q${i}`));
      builder.push(assistantMessage(`a${i}`));
    }
    expect(builder.buildResult()).toHaveLength(6);
  });

  it('does not count auto-triggered skill activations as user turns', () => {
    const builder = new ReplayBuilder(restoringAgent());
    const skillActivation = {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<scream-skill-loaded />' }],
        toolCalls: [],
        origin: { kind: 'skill_activation', trigger: 'auto' },
      },
    } as unknown as AgentReplayRecord;
    for (let i = 0; i < REPLAY_TURN_LIMIT; i++) {
      builder.push(userTurn(`q${i}`));
      builder.push(skillActivation);
      builder.push(assistantMessage(`a${i}`));
    }
    // Exactly at the limit — nothing dropped despite the extra user-role records.
    expect(userTurnTexts(builder.buildResult())).toHaveLength(REPLAY_TURN_LIMIT);
    expect(builder.buildResult()).toHaveLength(REPLAY_TURN_LIMIT * 3);
  });

  it('ignores pushes when the agent is not restoring', () => {
    const builder = new ReplayBuilder(idleAgent());
    builder.push(userTurn('q'));
    expect(builder.buildResult()).toHaveLength(0);
  });
});
