import { describe, expect, it } from 'vitest';
import { computeLatestActivity } from '#/tui/components/messages/tool-call';

/** Minimal structural shapes for the helper's inputs (types are not exported). */
type OngoingSubCall = { name: string; args: Record<string, unknown>; output?: unknown };
type FinishedSubCall = { name: string; args: Record<string, unknown>; output: string; isError: boolean };

function ongoing(name: string, args: Record<string, unknown> = {}): Map<string, OngoingSubCall> {
  return new Map([['c1', { name, args } as unknown as OngoingSubCall]]);
}
function finished(name: string, args: Record<string, unknown> = {}): FinishedSubCall[] {
  return [{ name, args, output: '', isError: false } as unknown as FinishedSubCall];
}

describe('computeLatestActivity (P2/P3)', () => {
  it('prefers ongoing tool over finished and text (P2 order)', () => {
    const out = computeLatestActivity(
      ongoing('Read', { path: 'src/index.ts' }),
      finished('Grep'),
      'some text',
      '/wd',
    );
    expect(out).toContain('Using Read');
    expect(out).toContain('src/index.ts');
  });

  it('falls back to finished tool when nothing ongoing (P2)', () => {
    const out = computeLatestActivity(new Map(), finished('Glob'), '', '/wd');
    expect(out).toContain('Used Glob');
  });

  it('falls back to last non-empty text line (existing behavior)', () => {
    const out = computeLatestActivity(new Map(), [], 'line1\n\nfinal answer', '/wd');
    expect(out).toBe('final answer');
  });

  it('returns the waiting label when idle heuristic is set (P3)', () => {
    const out = computeLatestActivity(new Map(), [], '', '/wd', true);
    expect(out).toBe('Waiting for subagent…');
  });

  it('returns undefined when idle heuristic is unset (no false label)', () => {
    const out = computeLatestActivity(new Map(), [], '', '/wd', undefined);
    expect(out).toBeUndefined();
  });
});
