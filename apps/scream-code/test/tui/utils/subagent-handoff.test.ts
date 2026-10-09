import { describe, expect, it } from 'vitest';

import { isBackgroundedHandoffResult } from '#/tui/utils/subagent-handoff';

describe('isBackgroundedHandoffResult', () => {
  it('matches the protocol line when it stands on its own line', () => {
    expect(
      isBackgroundedHandoffResult(
        ['task_id: agent-1', 'status: backgrounded', 'agent_id: agent-7'].join('\n'),
      ),
    ).toBe(true);
  });

  it('tolerates surrounding whitespace and CRLF line endings', () => {
    expect(isBackgroundedHandoffResult('agent_id: agent-7\r\nstatus: backgrounded   \r\n')).toBe(
      true,
    );
  });

  it('does not match the phrase quoted inside a line of prose', () => {
    expect(
      isBackgroundedHandoffResult(
        'summary: the earlier run resumed after status: backgrounded was reported.',
      ),
    ).toBe(false);
  });

  it('does not match other statuses or empty output', () => {
    expect(isBackgroundedHandoffResult('status: completed')).toBe(false);
    expect(isBackgroundedHandoffResult('')).toBe(false);
  });
});
