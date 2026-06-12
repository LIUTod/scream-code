import { describe, expect, it } from 'vitest';

import { BackgroundAgentStatusComponent } from '#/tui/components/messages/background-agent-status';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('BackgroundAgentStatusComponent', () => {
  it('renders started/completed with the shared bullet and failed with a red x marker', () => {
    const started = new BackgroundAgentStatusComponent(
      {
        phase: 'started',
        headline: 'explore agent started in background',
        detail: 'Explore project structure',
      },
      darkColors,
    );
    const completed = new BackgroundAgentStatusComponent(
      {
        phase: 'completed',
        headline: 'explore agent completed in background',
        detail: 'Explore project structure',
      },
      darkColors,
    );
    const failed = new BackgroundAgentStatusComponent(
      {
        phase: 'failed',
        headline: 'explore agent failed in background',
        detail: 'Explore project structure · boom',
      },
      darkColors,
    );

    const startedLines = started.render(120).map((line) => strip(line).trimEnd());
    const completedLines = completed.render(120).map((line) => strip(line).trimEnd());
    const failedLines = failed.render(120).map((line) => strip(line).trimEnd());

    expect(startedLines[0]).toBe('');
    expect(completedLines[0]).toBe('');
    expect(failedLines[0]).toBe('');

    expect(startedLines[1]).toBe(
      `${STATUS_BULLET}explore agent started in background (Explore project structure)`,
    );
    expect(completedLines[1]).toBe(
      `${STATUS_BULLET}explore agent completed in background (Explore project structure)`,
    );
    expect(failedLines[1]).toBe(
      '✗ explore agent failed in background (Explore project structure · boom)',
    );
  });

  it('caches render output for the same width', () => {
    const component = new BackgroundAgentStatusComponent(
      {
        phase: 'completed',
        headline: 'explore agent completed in background',
        detail: 'Explore project structure',
      },
      darkColors,
    );

    const first = component.render(120);
    const second = component.render(120);

    expect(second).toBe(first);
  });

  it('recomputes after invalidate()', () => {
    const component = new BackgroundAgentStatusComponent(
      {
        phase: 'completed',
        headline: 'explore agent completed in background',
        detail: 'Explore project structure',
      },
      darkColors,
    );

    const first = component.render(120);
    component.invalidate();
    const second = component.render(120);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});
