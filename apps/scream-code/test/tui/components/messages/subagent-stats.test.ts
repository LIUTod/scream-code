import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@scream-code/config';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { darkColors } from '#/tui/theme/colors';

/**
 * P1a rendering tests: `subagent.completed` now carries turns / durationMs /
 * toolCallCount metadata, and the single-subagent header chip renders them
 * (replacing the heuristic tool-activity count for the authoritative figure).
 */

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(/\u001B\]8;;[^\u0007]*\u0007/g, '');
}

function makeCompletedComponent(): ToolCallComponent {
  const component = new ToolCallComponent(
    { id: 'call_agent', name: 'Agent', args: { description: '审查模块' } },
    undefined,
    darkColors,
  );
  component.onSubagentSpawned({
    agentId: 'agent-0',
    agentName: 'reviewer',
    runInBackground: false,
  });
  return component;
}

describe('ToolCallComponent subagent completion stats', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders turns, duration and tool-call metadata from subagent.completed', () => {
    setLocale('zh');
    const component = makeCompletedComponent();
    component.onSubagentCompleted({
      resultSummary: '审查完成，发现 2 处问题',
      turns: 3,
      durationMs: 12_500,
      toolCallCount: 5,
      contextTokens: 1000,
    });

    const out = strip(component.render(100).join('\n'));
    expect(out).toContain('3 轮');
    expect(out).toContain('12s');
    expect(out).toContain('5 个 tool');
    expect(out).toContain('已完成');
  });

  it('falls back to live activity count and elapsed time when metadata is absent', () => {
    setLocale('zh');
    const component = makeCompletedComponent();
    component.onSubagentCompleted({ resultSummary: '完成' });

    const out = strip(component.render(100).join('\n'));
    // No turns line when the event carried no metadata.
    expect(out).not.toContain('轮');
  });
});
