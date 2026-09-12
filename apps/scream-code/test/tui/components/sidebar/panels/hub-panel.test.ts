import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { visibleWidth } from '@liutod-scream/pi-tui';
import { getLocale, setLocale } from '@scream-code/config';

import { hubPanel } from '#/tui/components/sidebar/panels/hub-panel';
import type {
  SidebarData,
  SidebarHubData,
  SidebarPanelContext,
} from '#/tui/components/sidebar/sidebar-panel';
import type { ColorPalette } from '#/tui/theme/colors';
import { HUB_MODEL_ROW_ID, type HubSample } from '#/tui/utils/hub-probe';

const fakePalette = {
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
const GREEN = '38;2;63;185;80m';
const AMBER = '38;2;224;174;33m';
const RED = '38;2;248;81;73m';
const GREY = '38;2;136;136;136m';

function sample(id: string, ms: number | undefined, tone: HubSample['tone']): HubSample {
  return { id, label: id, ms, tone };
}

function hub(samples: readonly HubSample[], rest: Partial<SidebarHubData> = {}): SidebarData {
  return { hub: { samples, pending: false, ...rest } };
}

function ctx(data: SidebarData): SidebarPanelContext {
  return { requestRender: () => {}, getData: () => data, colors: fakePalette };
}

function render(data: SidebarData, width = 30): string[] {
  return hubPanel.build(ctx(data)).render(width);
}

function plain(line: string): string {
  return line.replace(ANSI, '');
}

const rows = [
  sample(HUB_MODEL_ROW_ID, 128, 'warn'),
  sample('github', 32, 'ok'),
  sample('google', 940, 'warn'),
  sample('x', undefined, 'down'),
];

// Capture the ambient locale inside beforeAll, not at describe time: vitest
// shares one worker across files, so a describe-time snapshot could inherit
// another file's zh and get "restored" as if it were neutral.
let originalLocale: ReturnType<typeof getLocale> | undefined;

describe('hub panel', () => {
  const originalChalkLevel = chalk.level;
  beforeAll(() => {
    originalLocale = getLocale();
    chalk.level = 3;
    setLocale('en');
  });

  afterAll(() => {
    if (originalLocale !== undefined) setLocale(originalLocale);
    chalk.level = originalChalkLevel;
  });

  it('renders one row per reading, provider first', () => {
    const lines = render(hub(rows)).map(plain);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('model');
    expect(lines[0]).toContain('128ms');
    expect(lines[1]).toContain('github');
    expect(lines[1]).toContain('32ms');
    expect(lines[3]).toContain('x');
    expect(lines[3]).toContain('--');
  });

  it('right-aligns every value to one shared right edge', () => {
    const lines = render(hub(rows));
    // Labels differ in width (model/github/google/x) yet every row ends at the
    // same column — that is the whole point of the two-column engine.
    const widths = lines.map((line) => visibleWidth(plain(line)));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeGreaterThan(0);
    // And each value sits flush at that edge.
    for (const line of lines) expect(plain(line)).toBe(plain(line).trimEnd());
  });

  it('maps tone onto the palette: green, amber, red, dim', () => {
    const [model, github, google, x] = render(hub(rows));
    expect(github).toContain(GREEN);
    expect(model).toContain(AMBER);
    expect(google).toContain(AMBER);
    expect(x).toContain(RED);
    const dimmed = render(hub([sample('baidu', 12, 'dim')]))[0]!;
    expect(dimmed).toContain(GREY);
  });

  it('paints probe rows as dots while the first round runs, the measured row as empty', () => {
    const lines = render(
      hub(
        [sample(HUB_MODEL_ROW_ID, undefined, 'dim'), sample('github', undefined, 'dim')],
        { pending: true },
      ),
    );
    // The provider row is measured, not probed: a probe in flight says nothing
    // about it, so it must not borrow the "measuring" marker.
    expect(plain(lines[0]!)).toContain('--');
    expect(plain(lines[1]!)).toContain('···');
    expect(plain(lines[1]!)).not.toContain('--');
  });

  it('falls back to `--` once nothing is pending and nothing was measured', () => {
    const line = render(hub([sample(HUB_MODEL_ROW_ID, undefined, 'dim')]))[0]!;
    expect(plain(line)).toContain('--');
  });

  it('labels the provider row through i18n and keeps endpoint ids verbatim', () => {
    setLocale('zh');
    try {
      const line = plain(render(hub(rows))[0]!);
      // Rows pay the shared marker column, so compare from the label onward.
      expect(line.replace(/^[●○]\s*/, '').startsWith('模型')).toBe(true);
      expect(plain(render(hub(rows))[1]!).replace(/^[●○]\s*/, '').startsWith('github')).toBe(true);
    } finally {
      setLocale('en');
    }
  });

  it('shows a configured endpoint label verbatim', () => {
    const line = plain(
      render(hub([{ id: 'x', label: 'x (twitter)', ms: 210, tone: 'warn' }]))[0]!,
    );
    expect(line).toContain('x (twitter)');
    expect(line).toContain('210ms');
  });

  it('switches to seconds above a one-second round trip', () => {
    const line = plain(render(hub([sample('baidu', 65_400, 'warn')]))[0]!);
    expect(line).toContain('65.4s');
    expect(line).not.toContain('65400');
  });

  it('stays inside the panel width from the narrowest sidebar to the widest', () => {
    for (const width of [24, 30, 45, 60]) {
      for (const line of render(hub(rows), width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('titles the panel in the active language, with no extra chrome', () => {
    expect(hubPanel.title).toBe('Network Hub');
    setLocale('zh');
    try {
      expect(hubPanel.title).toBe('网络 Hub');
    } finally {
      setLocale('en');
    }
  });

  it('renders nothing when the hub block is absent', () => {
    expect(render({})).toEqual([]);
  });
});
