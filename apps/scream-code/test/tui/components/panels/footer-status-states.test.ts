import { describe, it, expect, vi } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

/** SGR sequence chalk emits for a hex colour at level 3. */
function hexToSgr(hex: string): string {
  const value = hex.replace(/^#/, '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001B[38;2;${String(r)};${String(g)};${String(b)}m`;
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
    pendingUserActionSince: null,
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
    delete (legacy as { pendingUserActionSince?: unknown }).pendingUserActionSince;
    expect(statusSegment(legacy).endsWith('等待中 3s')).toBe(true);
  });

  it('shows how long a blocked wait has lasted once it passes a minute', () => {
    const out = statusSegment(
      baseState({
        streamingPhase: 'tool',
        pendingUserAction: 'approval',
        pendingUserActionSince: NOW - 4 * 60_000,
      }),
    );
    expect(out.endsWith('等待批准 · 4m')).toBe(true);
  });

  it('hides the wait clock under a minute — and without a start time', () => {
    expect(
      statusSegment(
        baseState({
          streamingPhase: 'tool',
          pendingUserAction: 'question',
          pendingUserActionSince: NOW - 30_000,
        }),
      ).endsWith('等待回答'),
    ).toBe(true);
    expect(
      statusSegment(
        baseState({
          streamingPhase: 'tool',
          pendingUserAction: 'question',
          pendingUserActionSince: null,
        }),
      ).endsWith('等待回答'),
    ).toBe(true);
  });
});

describe('footer status block — line channel segment', () => {
  it('shows Line: 未连接 when the daemon is down or no channel is configured', () => {
    expect(statusSegment(baseState({ streamingPhase: 'idle' }))).toContain('◆ Line: 未连接');
    expect(statusSegment(baseState({ linePlatform: 'wechat' }))).toContain('◆ Line: 未连接');
    expect(statusSegment(baseState({ linePlatform: 'lark' }))).toContain('◆ Line: 未连接');
  });

  it('shows the channel brand once connected', () => {
    expect(statusSegment(baseState({ linePlatform: 'lark', lineActive: true }))).toContain('◆ Line: Lark');
    expect(statusSegment(baseState({ linePlatform: 'wechat', lineActive: true }))).toContain('◆ Line: Wechat');
    expect(statusSegment(baseState({ linePlatform: 'wechat', lineActive: true }))).not.toContain('未连接');
  });

  it('lights only the dot: blue for Lark, green for WeChat, muted when disconnected', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const renderLine = (state: AppState): string => {
        const footer = new FooterComponent(state, darkColors, uiMock);
        const line = footer.render(200)[0] ?? '';
        footer.dispose();
        return line;
      };
      expect(renderLine(baseState({ linePlatform: 'lark', lineActive: true }))).toContain(
        `${hexToSgr(darkColors.lineLark)}◆`,
      );
      expect(renderLine(baseState({ linePlatform: 'wechat', lineActive: true }))).toContain(
        `${hexToSgr(darkColors.success)}◆`,
      );
      expect(renderLine(baseState({ linePlatform: 'lark' }))).toContain(
        `${hexToSgr(darkColors.textDim)}◆`,
      );
      // The label itself never takes the channel colour.
      expect(renderLine(baseState({ linePlatform: 'lark', lineActive: true }))).not.toContain(
        `${hexToSgr(darkColors.lineLark)}Line`,
      );
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('marks the model name with the 📟️ glyph (2 cells) without breaking the row', () => {
    for (const width of [60, 80, 120]) {
      const footer = new FooterComponent(baseState({ model: 'k2' }), darkColors, uiMock);
      const line1 = strip(footer.render(width)[0] ?? '');
      footer.dispose();
      expect(line1).toContain('📟️ k2');
      expect(visibleWidth(line1)).toBeLessThanOrEqual(width);
    }
  });

  it('pins the ↓ cache-hit marker as the first item of line 2', () => {
    const footer = new FooterComponent(baseState({ streamingPhase: 'idle' }), darkColors, uiMock);
    const [line1, line2] = footer.render(120).map(strip);
    footer.dispose();
    // Line 1 is the channel/status strip; the hit rate moved to line 2.
    expect(line1).not.toContain('Hitr');
    expect(line2!.startsWith('↓ Hitr: --')).toBe(true);
    // Exactly one space after the colon — no doubled separator.
    expect(line2).toContain('↓ Hitr: --');
    expect(line2).not.toContain('↓ Hitr:  --');
  });

  it('keeps the channel segment ahead of the status label on line 1', () => {
    const out = statusSegment(
      baseState({
        streamingPhase: 'waiting',
        streamingStartTime: NOW - 3000,
        linePlatform: 'lark',
        lineActive: true,
      }),
    );
    expect(out.indexOf('Line:')).toBeLessThan(out.indexOf('等待中'));
    // The hit rate no longer shares this row.
    expect(out).not.toContain('Hitr:');
  });
});

describe('footer status block — phase regressions', () => {
  it('keeps the six phase labels and their elapsed formats', () => {
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
      statusSegment(baseState({ streamingPhase: 'tool-args', streamingStartTime: NOW - 4000 })).endsWith(
        '调用中 4s',
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
