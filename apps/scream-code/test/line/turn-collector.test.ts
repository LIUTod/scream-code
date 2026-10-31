import { describe, expect, it, vi } from 'vitest';

import { LineTurnCollector } from '#/line/turn-collector';

function baseEvent(fields: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: 's1', agentId: 'main', turnId: 1, ...fields };
}

function makeCollector(): { collector: LineTurnCollector; settled: () => boolean } {
  let settled = false;
  const collector = new LineTurnCollector(() => {
    settled = true;
  });
  return { collector, settled: () => settled };
}

describe('LineTurnCollector (remote reply policy: final content only)', () => {
  it('accumulates plain assistant deltas and settles on turn end', () => {
    const { collector, settled } = makeCollector();
    collector.handleEvent(baseEvent({ type: 'turn.started' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '你好' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '，世界' }) as never);
    collector.handleEvent(baseEvent({ type: 'turn.ended', reason: 'completed' }) as never);
    expect(collector.text).toBe('你好，世界');
    expect(collector.ended).toBe('completed');
    expect(settled()).toBe(true);
  });

  it('never accumulates thinking deltas (separate event type)', () => {
    const { collector } = makeCollector();
    collector.handleEvent(baseEvent({ type: 'turn.started' }) as never);
    collector.handleEvent(baseEvent({ type: 'thinking.delta', delta: '让我想想：' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '答案' }) as never);
    collector.handleEvent(baseEvent({ type: 'turn.ended', reason: 'completed' }) as never);
    expect(collector.text).toBe('答案');
  });

  it('discards narration before a tool call and keeps only the final answer', () => {
    const { collector } = makeCollector();
    collector.handleEvent(baseEvent({ type: 'turn.started' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '我先看看文件…' }) as never);
    collector.handleEvent(baseEvent({ type: 'tool.call.started', toolCallId: 't1', name: 'read' }) as never);
    collector.handleEvent(baseEvent({ type: 'tool.call.delta', toolCallId: 't1', delta: '{}' }) as never);
    collector.handleEvent(baseEvent({ type: 'tool.result', toolCallId: 't1' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '最终答案是 42' }) as never);
    collector.handleEvent(baseEvent({ type: 'turn.ended', reason: 'completed' }) as never);
    expect(collector.text).toBe('最终答案是 42');
  });

  it('discards narration before EACH tool call in multi-round turns', () => {
    const { collector } = makeCollector();
    collector.handleEvent(baseEvent({ type: 'turn.started' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '先查一下' }) as never);
    collector.handleEvent(baseEvent({ type: 'tool.call.started', toolCallId: 't1' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '再查一下' }) as never);
    collector.handleEvent(baseEvent({ type: 'tool.call.started', toolCallId: 't2' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '结论：没问题' }) as never);
    collector.handleEvent(baseEvent({ type: 'turn.ended', reason: 'completed' }) as never);
    expect(collector.text).toBe('结论：没问题');
  });

  it('captures main-agent errors only', () => {
    const { collector, settled } = makeCollector();
    collector.handleEvent(baseEvent({ type: 'turn.started' }) as never);
    collector.handleEvent(baseEvent({ type: 'error', agentId: 'sub1', code: 'provider.api_error', message: 'x' }) as never);
    expect(collector.failure).toBeUndefined();
    expect(settled()).toBe(false);
    collector.handleEvent(baseEvent({ type: 'error', code: 'provider.timeout', message: 'boom' }) as never);
    expect(collector.failure).toEqual({ code: 'provider.timeout', message: 'boom' });
    expect(settled()).toBe(true);
  });

  it('ignores other agents\u2019 turns and steps', () => {
    const { collector } = makeCollector();
    collector.handleEvent(baseEvent({ type: 'turn.started' }) as never);
    collector.handleEvent(baseEvent({ type: 'turn.started', agentId: 'sub1', turnId: 2 }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', agentId: 'sub1', delta: '子代理文本' }) as never);
    collector.handleEvent(baseEvent({ type: 'turn.ended', agentId: 'sub1', reason: 'completed' }) as never);
    expect(collector.text).toBe('');
    expect(collector.ended).toBeUndefined();
  });

  it('records step budget exhaustion', () => {
    const { collector } = makeCollector();
    collector.handleEvent(baseEvent({ type: 'turn.started' }) as never);
    collector.handleEvent(baseEvent({ type: 'assistant.delta', delta: '部分内容' }) as never);
    collector.handleEvent(baseEvent({ type: 'turn.ended', reason: 'completed', stepBudgetExhausted: true }) as never);
    expect(collector.stepBudgetExhausted).toBe(true);
    expect(collector.text).toBe('部分内容');
  });
});
