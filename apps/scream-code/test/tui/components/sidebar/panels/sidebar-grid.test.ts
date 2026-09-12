import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { visibleWidth } from '@liutod-scream/pi-tui';
import { getLocale, setLocale } from '@scream-code/config';

import {
  layoutSidebarGrid,
  renderSidebarGridRow,
  SIDEBAR_LABEL_COLS,
  SIDEBAR_MARKER_COLS,
  SIDEBAR_MIN_GAP,
} from '#/tui/utils/display-width';
import { gitPanel } from '#/tui/components/sidebar/panels/git-panel';
import { sessionPanel } from '#/tui/components/sidebar/panels/session-panel';
import { agentsPanel } from '#/tui/components/sidebar/panels/agents-panel';
import { goalPanel } from '#/tui/components/sidebar/panels/goal-panel';
import { hubPanel } from '#/tui/components/sidebar/panels/hub-panel';
import type {
  SidebarData,
  SidebarPanelContext,
} from '#/tui/components/sidebar/sidebar-panel';
import type { ColorPalette } from '#/tui/theme/colors';
import { HUB_MODEL_ROW_ID, type HubSample } from '#/tui/utils/hub-probe';

const palette = {
  primary: '#79eb00',
  accent: '#f279a2',
  success: '#3fb950',
  warning: '#e0ae21',
  error: '#f85149',
  textDim: '#888888',
  text: '#cccccc',
  textStrong: '#ffffff',
} as unknown as ColorPalette;

const ANSI = /\u001B\[[0-9;]*m/g;
const PANELS = [gitPanel, sessionPanel, agentsPanel, goalPanel, hubPanel];

function ctx(data: SidebarData): SidebarPanelContext {
  return { requestRender: () => {}, getData: () => data, colors: palette };
}

function plain(line: string): string {
  return line.replace(ANSI, '');
}

const data: SidebarData = {
  git: { workDir: '/home/dev/scream-code', diffAdded: 205, diffDeleted: 15, filesCount: 6 },
  sessionStats: {
    turns: 2,
    toolCalls: 3,
    compactions: 2,
    apiCalls: 7,
    tokensTotal: 1050,
    tokensInputCacheHit: 100,
    tokensInputCacheMiss: 900,
    tokensOutput: 50,
    startedAt: Date.now() - 60_000,
  },
  agents: [
    {
      type: 'coder',
      agentId: 'agent-1',
      detail: 'tool: Read',
      status: 'working',
      count: 2,
      lastActivityAt: Date.now(),
    },
    { type: 'reviewer', agentId: 'agent-2', detail: '', status: 'idle', count: 1, lastActivityAt: Date.now() },
  ],
  hub: {
    samples: [
      { id: HUB_MODEL_ROW_ID, ms: 128, tone: 'warn' },
      { id: 'github', ms: 32, tone: 'ok' },
      { id: 'alibaba', label: 'Alibaba', ms: 18, tone: 'ok' },
    ] satisfies HubSample[],
    pending: false,
  },
  goal: {
    objective: 'ship the sidebar grid',
    status: 'active',
    turnsUsed: 8,
    wallClockMs: 60_000,
    wallClockBaseAt: Date.now() - 60_000,
    continuationCount: 0,
    completionCriterion: 'tests pass',
    tokensUsed: 12345,
    inputTokens: 9000,
    outputTokens: 3345,
    judge: 'awaiting',
  },
};

describe('sidebar grid layout', () => {
  it('pays the marker column and right-aligns values on the inner edge', () => {
    const lines = layoutSidebarGrid(
      [
        { label: 'model', value: '128ms' },
        { label: 'github', value: '32ms' },
      ],
      28,
    ).map(renderSidebarGridRow);
    for (const line of lines) {
      expect(line.startsWith(' '.repeat(SIDEBAR_MARKER_COLS))).toBe(true);
      // Same right edge for both rows despite different label and value widths.
      expect(visibleWidth(line)).toBe(28);
    }
  });

  it('truncates an over-long label before it lets a value cross the edge', () => {
    const line = renderSidebarGridRow(
      layoutSidebarGrid([{ label: 'a label far wider than the column', value: '32ms' }], 20)[0]!,
    );
    expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    expect(line).toContain('32ms');
    // The label is the part that gives way (pi-tui marks truncation with dots).
    expect(line).toMatch(/\.{3}|…/);
  });

  it('aligns free text to the value column when it fits', () => {
    const lines = layoutSidebarGrid(
      [
        { label: 'tokens', value: '12,345' },
        { label: 'criterion', note: 'tests pass' },
      ],
      34,
    ).map(renderSidebarGridRow);
    expect(lines[1]).toContain('tests pass');
    expect(lines.map((line) => visibleWidth(line))).toEqual([34, 34]);
  });

  it('pulls long free text left instead of truncating it early', () => {
    const line = renderSidebarGridRow(
      layoutSidebarGrid([{ label: 'criterion', note: 'the reviewer approves' }], 34)[0]!,
    );
    expect(line).toContain('the reviewer approves');
    expect(visibleWidth(line)).toBe(34);
  });

  it('sizes the shared label column for the labels panels actually render', () => {
    // Real labels from both locales (the session metrics are the binding ones).
    const realLabels = [
      'Tool calls',
      'API calls',
      'Compacts',
      'criterion',
      'reviewer',
      '总Token',
      '工作时长',
      '压缩次数',
      '会话轮次',
      '调用次数',
    ];
    for (const label of realLabels) {
      expect(SIDEBAR_LABEL_COLS, label).toBeGreaterThanOrEqual(visibleWidth(label));
    }
  });

  it('degrades instead of overflowing at absurd widths', () => {
    for (let width = 1; width <= 20; width += 1) {
      const lines = layoutSidebarGrid(
        [{ marker: '●', label: 'a label far longer than the column', value: '227,594,582' }],
        width,
      ).map(renderSidebarGridRow);
      // The floor of a row is marker + one label column + a gap + one value
      // column. Below that the grid has nothing left to give, so the invariant
      // is "degrade to the floor", never "grow without bound".
      const floor = SIDEBAR_MARKER_COLS + SIDEBAR_MIN_GAP * 2 + 1;
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(width, floor));
      }
    }
  });
});

// Locale is captured inside beforeAll: vitest reuses one worker across files,
// so a describe-time snapshot could inherit another file's zh.
let originalLocale: ReturnType<typeof getLocale> | undefined;

describe('cross-panel column consistency', () => {
  const originalLevel = chalk.level;
  beforeAll(() => {
    originalLocale = getLocale();
    chalk.level = 3;
    setLocale('en');
  });
  afterAll(() => {
    if (originalLocale !== undefined) setLocale(originalLocale);
    chalk.level = originalLevel;
  });

  it('starts every panel row on the marker column', () => {
    for (const panel of PANELS) {
      for (const line of panel.build(ctx(data)).render(28)) {
        const row = plain(line);
        const startsAtMarker =
          row.startsWith(' '.repeat(SIDEBAR_MARKER_COLS)) || /^[●○✓✗⏹⚖⏸⚠]/.test(row);
        expect(startsAtMarker, `${panel.id}: ${row}`).toBe(true);
      }
    }
  });

  it('ends reading rows of every panel on one shared right edge', () => {
    const width = 28;
    const rowsByPanel = new Map<string, string[]>(
      PANELS.map((panel) => [
        panel.id,
        panel
          .build(ctx(data))
          .render(width)
          .map(plain),
      ]),
    );
    // Labels as the English locale actually renders them.
    const probes: Array<[string, string, string]> = [
      ['session', 'Total', '1,050'],
      ['session', 'Compacts', '2'],
      ['hub', 'github', '32ms'],
      ['hub', 'model', '128ms'],
      ['goal', 'tokens', '12,345'],
      ['goal', 'criterion', 'tests pass'],
      ['agents', 'coder', '×2'],
    ];
    for (const [panelId, label, reading] of probes) {
      // Compare from the label column onward: panels with a status glyph
      // (agents) occupy the marker column with the glyph, not with spaces.
      const row = rowsByPanel
        .get(panelId)!
        .find(
          (line) =>
            line.slice(SIDEBAR_MARKER_COLS).startsWith(label) && line.includes(reading),
        );
      expect(row, `${panelId}/${label}`).toBeDefined();
      expect(visibleWidth(row!), `${panelId}/${label} -> ${row}`).toBe(width);
      expect(row!.trimEnd().endsWith(reading)).toBe(true);
    }
  });

  it('never overflows the panel at any supported sidebar width', () => {
    for (const panelWidth of [22, 24, 28, 43, 58]) {
      for (const panel of PANELS) {
        for (const line of panel.build(ctx(data)).render(panelWidth)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(panelWidth);
        }
      }
    }
  });

  it('keeps a clean git tree on the marker column like every other row', () => {
    // The clean tree is the default state, so a missing indent would show up
    // immediately as one panel hugging the border.
    const clean: SidebarData = {
      ...data,
      git: { workDir: '/home/dev/scream-code', diffAdded: 0, diffDeleted: 0, filesCount: 0 },
    };
    const rows = gitPanel.build(ctx(clean)).render(28).map(plain);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.startsWith('  ')).toBe(true);
  });

  it('does not truncate labels at the default sidebar width', () => {
    // Free-text rows may legitimately truncate; value rows must not.
    for (const panel of [sessionPanel, agentsPanel, hubPanel]) {
      for (const line of panel.build(ctx(data)).render(28)) {
        expect(plain(line)).not.toMatch(/…|\.{3}/);
      }
    }
  });
});
