import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@liutod-scream/pi-tui';

import { StatusBarPaneComponent } from '#/tui/components/panes/status-bar-pane';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');

/** Minimal PulseWaveLoader stand-in: only getFrameText()/invalidate() are used. */
function fakeWave(frame = '⬝') {
  return { getFrameText: () => frame, invalidate: () => {} } as never;
}

function activity(text: string, color?: string) {
  return () => ({ text, color });
}

describe('StatusBarPaneComponent', () => {
  it('renders the label snug after the pulse wave on one line for waiting/tool modes', () => {
    const waiting = new StatusBarPaneComponent({
      mode: 'waiting',
      label: 'Waiting...',
      pulseWave: fakeWave(),
    });
    const waitingLines = waiting.render(80).map((line) => line.trimEnd());
    // One line, wave and label adjacent (no full-width gap in between).
    expect(waitingLines.length).toBe(1);
    expect(waitingLines[0]).toBe(' ⬝  Waiting...');

    const tool = new StatusBarPaneComponent({
      mode: 'tool',
      label: '[working]',
      pulseWave: fakeWave(),
    });
    const toolLines = tool.render(80).map((line) => line.trimEnd());
    expect(toolLines.length).toBe(1);
    expect(toolLines[0]).toBe(' ⬝  [working]');
  });

  it('renders a bare wave without padding when there is no label or activity', () => {
    const pane = new StatusBarPaneComponent({ mode: 'thinking', label: '', pulseWave: fakeWave() });
    expect(pane.render(80)).toEqual(['⬝']);
  });

  it('appends the collaboration ticker after the wave and label', () => {
    const pane = new StatusBarPaneComponent({
      mode: 'tool',
      label: '重连中 2/10',
      pulseWave: fakeWave(),
      activity: activity('coder 向 Scream 求助中！问题：因为缺少基线'),
    });
    const line = strip(pane.render(120)[0] ?? '');
    expect(line).toBe(' ⬝  重连中 2/10  coder 向 Scream 求助中！问题：因为缺少基线');
  });

  it('re-reads the activity getter on every render (newest notice wins, no rebuild)', () => {
    let notice: { text: string; color?: string } | null = null;
    const pane = new StatusBarPaneComponent({
      mode: 'thinking',
      label: '',
      pulseWave: fakeWave(),
      activity: () => notice,
    });
    // Bare wave keeps the pre-existing unpadded form.
    expect(strip(pane.render(120)[0] ?? '')).toBe('⬝');

    notice = { text: 'coder 向 Scream 求助中！问题：因为 A' };
    expect(strip(pane.render(120)[0] ?? '')).toContain('因为 A');

    notice = { text: 'Scream 已处理 coder 的请求！' };
    expect(strip(pane.render(120)[0] ?? '')).toContain('已处理 coder');
  });

  it('keeps the row to one line and truncates to the width', () => {
    const pane = new StatusBarPaneComponent({
      mode: 'waiting',
      label: 'Waiting...',
      pulseWave: fakeWave(),
      activity: activity('coder 向 Scream 求助中！问题：因为需要确认迁移后的测试基线是否覆盖全部用例'),
    });
    const lines = pane.render(40);
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(40);
  });

  it('survives widths 1-3 without throwing or overflowing', () => {
    for (const width of [1, 2, 3]) {
      const pane = new StatusBarPaneComponent({
        mode: 'waiting',
        label: 'Waiting...',
        pulseWave: fakeWave(),
        activity: activity('coder 向 Scream 求助中！'),
      });
      for (const line of pane.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      const idle = new StatusBarPaneComponent({
        mode: 'idle',
        label: '',
        activity: activity('Scream 已处理 coder 的请求！'),
      });
      for (const line of idle.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('renders the ticker alone while idle, and nothing when it is empty', () => {
    const withNotice = new StatusBarPaneComponent({
      mode: 'idle',
      label: '',
      activity: activity('Scream 已处理 coder 的请求！'),
    });
    expect(strip(withNotice.render(120)[0] ?? '')).toBe(' Scream 已处理 coder 的请求！');

    const empty = new StatusBarPaneComponent({ mode: 'idle', label: '' });
    expect(empty.render(80)).toEqual([]);
  });

  it('lets an idle notice supersede the tip instead of being truncated away', () => {
    const pane = new StatusBarPaneComponent({
      mode: 'idle',
      label: 'Ctrl+F: 模型提供方',
      labelColor: '#999999',
      activity: activity('Scream 已处理 coder 的请求！'),
    });
    const line = strip(pane.render(80)[0] ?? '');
    expect(line).toContain('已处理');
    expect(line).not.toContain('Ctrl+F');
  });

  it('shows the idle tip when there is no ticker', () => {
    const pane = new StatusBarPaneComponent({
      mode: 'idle',
      label: 'Ctrl+F: 模型提供方',
      labelColor: '#999999',
      activity: () => null,
    });
    expect(strip(pane.render(80)[0] ?? '')).toBe(' Ctrl+F: 模型提供方');
  });

  it('update() replaces content without leaking old children', () => {
    const component = new StatusBarPaneComponent({
      mode: 'thinking',
      label: '',
      pulseWave: fakeWave(),
    });
    component.update({ mode: 'idle', label: '' });
    expect(component.render(80)).toEqual([]);
    component.update({
      mode: 'waiting',
      label: 'Waiting...',
      pulseWave: fakeWave(),
    });
    const lines = component.render(80).map((line) => line.trimEnd());
    expect(lines.length).toBe(1);
    expect(lines[0]!.includes('Waiting...')).toBe(true);
  });
});
