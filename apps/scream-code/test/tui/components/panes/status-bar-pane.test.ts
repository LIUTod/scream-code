import { Text } from '@liutod-scream/pi-tui';
import { describe, expect, it } from 'vitest';

import { StatusBarPaneComponent } from '#/tui/components/panes/status-bar-pane';

describe('StatusBarPaneComponent', () => {
  it('renders the label after a pulse wave on one line for waiting/tool modes', () => {
    const waiting = new StatusBarPaneComponent({
      mode: 'waiting',
      label: 'Waiting...',
      pulseWave: new Text('⬝', 0, 0) as never,
    });
    const waitingLines = waiting.render(80).map((line) => line.trimEnd());
    // One line, containing both the pulse and the label (ANSI/OSC8 wrapping
    // around the mock Text is stripped by the terminal; we assert content).
    expect(waitingLines.length).toBe(1);
    expect(waitingLines[0]!.includes('Waiting...')).toBe(true);

    const tool = new StatusBarPaneComponent({
      mode: 'tool',
      label: '[working]',
      pulseWave: new Text('⬝', 0, 0) as never,
    });
    const toolLines = tool.render(80).map((line) => line.trimEnd());
    expect(toolLines.length).toBe(1);
    expect(toolLines[0]!.includes('[working]')).toBe(true);
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
      pulseWave: new Text('⬝', 0, 0) as never,
    });
    const lines = component.render(80).map((line) => line.trimEnd());
    expect(lines.length).toBe(1);
    expect(lines[0]!.includes('Waiting...')).toBe(true);
  });
});
