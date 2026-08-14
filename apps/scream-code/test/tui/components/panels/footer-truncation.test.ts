import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';

import { FooterComponent, truncateMiddle } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp',
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: 'off',
    thinkingLevel: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

const uiMock = { requestRender: () => {} } as any;

/**
 * Build a footer with a long LEFT (plan badge + goal + model + two background
 * badges) and a long RIGHT (cc dot + context with token counts + idle status),
 * so progressive truncation has something to chew on. `workDir` stays `/tmp`
 * (not a git repo) so the git badge is absent and the LEFT width is stable.
 */
function wideFooter(): FooterComponent {
  const footer = new FooterComponent(
    baseState({
      planMode: 'plan',
      goalActive: true,
      goal: {
        objective: 'ship footer truncation',
        turnsUsed: 7,
        wallClockMs: 3 * 60_000,
        wallClockBaseAt: Date.now(),
      },
      model: 'scream-k2-5',
      availableModels: {
        'scream-k2-5': { displayName: 'scream-k2-5', model: 'scream-k2-5' } as any,
      },
      contextUsage: 0.5,
      contextTokens: 50_000,
      maxContextTokens: 200_000,
    }),
    darkColors,
    uiMock,
  );
  footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 3 });
  return footer;
}

describe('FooterComponent - progressive truncation', () => {
  it('fits without truncation at columns=190 (no ellipsis, RIGHT visible)', () => {
    const footer = wideFooter();
    const [line1] = footer.render(190);
    expect(line1).toBeDefined();
    expect(visibleWidth(line1!)).toBeLessThanOrEqual(190);
    const stripped = strip(line1!);
    expect(stripped).not.toContain('…');
    expect(stripped).toContain('GOAL');
    expect(stripped).toContain('HitR: --');
  });

  it('never overflows at columns=40', () => {
    const footer = wideFooter();
    const [line1] = footer.render(40);
    expect(line1).toBeDefined();
    expect(visibleWidth(line1!)).toBeLessThanOrEqual(40);
  });

  it('stage 1: shrinks LEFT with a middle ellipsis to keep RIGHT visible', () => {
    const footer = wideFooter();
    // width 96: full LEFT+RIGHT > 96, so a shrunk LEFT (head + tail via
    // truncateMiddle) + gap + RIGHT fits. RIGHT now carries the five-segment
    // metrics (remote/hit/in-out/context/status), so it needs more room than
    // before — the LEFT head keeps the 计划 badge plus the GOAL badge's
    // leading letter (G), not "GO".
    const [line1] = footer.render(96);
    expect(line1).toBeDefined();
    const stripped = strip(line1!);
    expect(visibleWidth(line1!)).toBeLessThanOrEqual(96);
    expect(stripped).toContain('…');
    expect(stripped).toContain('HitR: --'); // RIGHT survived
    expect(stripped).toContain('计划'); // head of LEFT kept (计划 badge)
  });

  it('stage 2: drops RIGHT when it cannot fit even after shrinking LEFT', () => {
    // Short LEFT (model only) + long RIGHT: any width below RIGHT+gap drops RIGHT.
    const footer = new FooterComponent(
      baseState({
        contextUsage: 0.5,
        contextTokens: 50_000,
        maxContextTokens: 200_000,
      }),
      darkColors,
      uiMock,
    );
    const [line1] = footer.render(20);
    expect(line1).toBeDefined();
    const stripped = strip(line1!);
    expect(visibleWidth(line1!)).toBeLessThanOrEqual(20);
    expect(stripped).not.toContain('HitR'); // RIGHT dropped
    expect(stripped).not.toContain('…'); // LEFT fit whole, no ellipsis needed
  });

  it('stage 3: truncates LEFT to the width when LEFT alone overflows', () => {
    const footer = wideFooter();
    const [line1] = footer.render(10);
    expect(line1).toBeDefined();
    expect(visibleWidth(line1!)).toBeLessThanOrEqual(10);
    // RIGHT is gone and LEFT is clipped to the narrow width.
    expect(strip(line1!)).not.toContain('HitR');
  });

  it('pads stage 2 to the full width so the line never wraps', () => {
    const footer = new FooterComponent(
      baseState({
        contextUsage: 0.5,
        contextTokens: 50_000,
        maxContextTokens: 200_000,
      }),
      darkColors,
      uiMock,
    );
    const [line1] = footer.render(20);
    expect(visibleWidth(line1!)).toBe(20);
  });
});

describe('truncateMiddle', () => {
  it('returns the input unchanged when it already fits', () => {
    expect(truncateMiddle('abc', 10, '…')).toBe('abc');
  });

  it('keeps a head and a tail fragment joined by the ellipsis', () => {
    const out = truncateMiddle('GOAL 3m · 7 turns', 10, '…');
    const stripped = strip(out);
    expect(stripped).toContain('…');
    expect(stripped).toMatch(/^GOAL/); // head keeps the start
    expect(stripped).toMatch(/urns$/); // tail keeps the end (head 5 cols, tail 4 cols)
    expect(visibleWidth(out)).toBeLessThanOrEqual(10);
  });

  it('respects maxWidth=0', () => {
    expect(truncateMiddle('abc', 0, '…')).toBe('');
  });

  it('preserves ANSI colour on both sides of the ellipsis', () => {
    const colored = `\u001B[38;2;121;235;0mGOAL 3m · 7 turns\u001B[39m`;
    const out = truncateMiddle(colored, 10, '…');
    expect(visibleWidth(out)).toBeLessThanOrEqual(10);
    // The original colour code is still present (on the tail via pendingAnsi).
    expect(out).toContain('\u001B[38;2;121;235;0m');
  });
});
