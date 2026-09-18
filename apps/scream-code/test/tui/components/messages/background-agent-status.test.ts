import { describe, expect, it } from 'vitest';

import {
  BackgroundAgentStatusComponent,
  renderBackgroundStatus,
} from '#/tui/components/messages/background-agent-status';
import { darkColors } from '#/tui/theme/colors';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Timers under a loaded test run can slip well past their 80 ms beat, so poll
 *  for the change instead of sampling once at a fixed moment. */
async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('BackgroundAgentStatusComponent', () => {
  it('renders started with the running glyph and finished phases with the status marks', () => {
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
      `⠋ explore agent started in background (Explore project structure)`,
    );
    expect(completedLines[1]).toBe(
      `✓ explore agent completed in background (Explore project structure)`,
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

  it('draws the running bullet at the caller frame so a block row matches its header', () => {
    const bulletAt = (frameIndex: number): string =>
      renderBackgroundStatus(
        { phase: 'started', headline: 'bg task', detail: 'CI' },
        darkColors,
        undefined,
        frameIndex,
      ).bullet.replaceAll(ANSI_SGR, '');

    expect(bulletAt(0)).toBe('⠋ ');
    expect(bulletAt(3)).toBe('⠸ ');
    // An out-of-range frame falls back to the first glyph instead of throwing.
    expect(bulletAt(99)).toBe('⠋ ');
  });

  it('spins a running notice when a UI is attached, and stops on dispose()', async () => {
    let renders = 0;
    const component = new BackgroundAgentStatusComponent(
      { phase: 'started', headline: 'bg task', detail: 'CI' },
      darkColors,
      {
        requestRender: () => {
          renders += 1;
        },
      } as never,
    );

    const first = strip(component.render(100)[1] ?? '');
    await waitFor(() => renders > 0 && strip(component.render(100)[1] ?? '') !== first);
    const second = strip(component.render(100)[1] ?? '');

    expect(renders).toBeGreaterThan(0);
    expect(second).not.toBe(first);

    component.dispose();
    const settled = renders;
    await sleep(400);
    expect(renders).toBe(settled);
  });

  it('never spins a finished notice, even with a UI attached', async () => {
    let renders = 0;
    const component = new BackgroundAgentStatusComponent(
      { phase: 'completed', headline: 'bg task', detail: 'CI' },
      darkColors,
      {
        requestRender: () => {
          renders += 1;
        },
      } as never,
    );

    const first = component.render(100);
    await sleep(400);

    expect(renders).toBe(0);
    expect(component.render(100)).toBe(first);
    component.dispose();
  });
});
