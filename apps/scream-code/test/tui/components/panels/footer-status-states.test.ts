import { describe, it, expect, vi } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';

import { FooterComponent } from '#/tui/components/chrome/footer';
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
    contextUsage: 0.288,
    contextTokens: 288_000,
    maxContextTokens: 1_000_000,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    pendingUserAction: null,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

const uiMock = { requestRender: () => {} } as any;
const NOW = 1_700_000_000_000;

/** Render line 1 and return the trailing status segment (SGR stripped). */
function statusSegment(state: AppState, width = 200): string {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const footer = new FooterComponent(state, darkColors, uiMock);
  const line = strip(footer.render(width)[0] ?? '');
  footer.dispose();
  vi.restoreAllMocks();
  return line.trimEnd();
}

describe('footer status block — non-phase states', () => {
  it('renders 压缩中 (no elapsed) while a compaction runs, even though the phase is waiting', () => {
    const out = statusSegment(
      baseState({
        streamingPhase: 'waiting',
        streamingStartTime: NOW - 12_000,
        isCompacting: true,
      }),
    );
    expect(out.endsWith('压缩中')).toBe(true);
    expect(out).not.toContain('等待中');
  });

  it('renders 等待批准 while an approval panel blocks the turn (no elapsed clock)', () => {
    const out = statusSegment(
      baseState({
        streamingPhase: 'tool',
        streamingStartTime: NOW - 30_000,
        pendingUserAction: 'approval',
      }),
    );
    expect(out.endsWith('等待批准')).toBe(true);
    expect(out).not.toContain('执行中');
  });

  it('renders 等待回答 while a question dialog blocks the turn', () => {
    const out = statusSegment(
      baseState({
        streamingPhase: 'tool',
        streamingStartTime: NOW - 5_000,
        pendingUserAction: 'question',
      }),
    );
    expect(out.endsWith('等待回答')).toBe(true);
  });

  it('renders 重连中 n/m during a step retry instead of the stale phase label', () => {
    const out = statusSegment(
      baseState({
        streamingPhase: 'thinking',
        streamingStartTime: NOW - 9_000,
        reconnectAttempt: 2,
        reconnectMaxAttempts: 10,
      }),
    );
    expect(out.endsWith('重连中 2/10')).toBe(true);
    expect(out).not.toContain('思考中');
  });

  it('a human-blocked panel outranks a compaction', () => {
    const out = statusSegment(
      baseState({
        streamingPhase: 'waiting',
        isCompacting: true,
        pendingUserAction: 'approval',
      }),
    );
    expect(out.endsWith('等待批准')).toBe(true);
    expect(out).not.toContain('压缩中');
  });

  it('tolerates fixtures without the new fields (older AppState shapes)', () => {
    const legacy = baseState({ streamingPhase: 'waiting', streamingStartTime: NOW - 3000 });
    delete (legacy as { pendingUserAction?: unknown }).pendingUserAction;
    expect(statusSegment(legacy).endsWith('等待中 3s')).toBe(true);
  });
});

describe('footer status block — phase regressions', () => {
  it('keeps the five phase labels and their elapsed formats', () => {
    expect(statusSegment(baseState({ streamingPhase: 'idle' })).endsWith('○ 空闲中')).toBe(true);
    expect(
      statusSegment(baseState({ streamingPhase: 'waiting', streamingStartTime: NOW - 3000 })).endsWith(
        '等待中 3s',
      ),
    ).toBe(true);
    expect(
      statusSegment(baseState({ streamingPhase: 'thinking', streamingStartTime: NOW - 65_000 })).endsWith(
        '思考中 1m5s',
      ),
    ).toBe(true);
    expect(
      statusSegment(baseState({ streamingPhase: 'composing', streamingStartTime: NOW - 7000 })).endsWith(
        '输出中 7s',
      ),
    ).toBe(true);
    expect(
      statusSegment(baseState({ streamingPhase: 'tool', streamingStartTime: NOW - 1000 })).endsWith(
        '执行中 1s',
      ),
    ).toBe(true);
  });

  it('still right-aligns the status block to the terminal edge at narrow widths', () => {
    const out = statusSegment(
      baseState({ streamingPhase: 'waiting', streamingStartTime: NOW - 3000 }),
      80,
    );
    // Display columns, not UTF-16 units: CJK labels are two cells wide.
    expect(visibleWidth(out)).toBe(80);
    expect(out.endsWith('等待中 3s')).toBe(true);
  });
});
