import { Text } from '@liutod-scream/pi-tui';
import { describe, expect, it } from 'vitest';

import { StatusBarPaneComponent } from '#/tui/components/panes/status-bar-pane';

/** Minimal PulseWaveLoader stand-in: only getFrameText() is consumed. */
function fakeWave(frame = '⬝') {
  return { getFrameText: () => frame, invalidate: () => {} } as never;
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

  it('renders the spinner (with its own label) for thinking/composing', () => {
    const thinking = new StatusBarPaneComponent({
      mode: 'thinking',
      label: '',
      spinner: new Text('⠋ Thinking...', 0, 0) as never,
    });
    expect(thinking.render(80).map((line) => line.trimEnd())).toEqual(['⠋ Thinking...']);
  });

  it('renders nothing when idle', () => {
    expect(new StatusBarPaneComponent({ mode: 'idle', label: '' }).render(80)).toEqual([]);
  });

  it('update() replaces content without leaking old children', () => {
    const component = new StatusBarPaneComponent({
      mode: 'thinking',
      label: '',
      spinner: new Text('⠋ Thinking...', 0, 0) as never,
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
