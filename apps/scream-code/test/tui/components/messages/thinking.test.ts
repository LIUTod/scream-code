import type { TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const longThinking = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');

describe('ThinkingComponent', () => {
  it('shows the live spinner header before thinking content', () => {
    const component = new ThinkingComponent('working it out', darkColors, true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('⠋ 思考中...');
    expect(out).not.toContain('  ⠋ 思考中...');
    expect(out).not.toContain(`${STATUS_BULLET}⠋`);
    expect(out).toContain('  working it out');
  });

  it('keeps live thinking height-limited to the tail', () => {
    const component = new ThinkingComponent(longThinking, darkColors, true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).not.toContain('line1');
    expect(out).not.toContain('line4');
    expect(out).not.toContain('line5');
    expect(out).toContain('line6');
    expect(out).toContain('line7');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('animates the live spinner and stops on finalize', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const component = new ThinkingComponent('step', darkColors, true, 'live', {
      requestRender,
    } as unknown as TUI);

    expect(strip(component.render(80).join('\n'))).toContain('⠋ 思考中...');

    vi.advanceTimersByTime(80);
    expect(requestRender).toHaveBeenCalled();
    expect(strip(component.render(80).join('\n'))).toContain('⠙ 思考中...');

    component.finalize();
    requestRender.mockClear();
    vi.advanceTimersByTime(160);
    expect(requestRender).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('finalizes in place into a collapsed preview', () => {
    const component = new ThinkingComponent(longThinking, darkColors, true, 'live');

    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).not.toContain('line4');
    expect(out).toContain('... (5 more lines, ctrl+o to expand)');
  });

  it('expands and collapses after finalization', () => {
    const component = new ThinkingComponent(longThinking, darkColors, true, 'live');
    component.finalize();

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('line7');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).not.toContain('line7');
    expect(collapsed).toContain('ctrl+o to expand');
  });

  it('caches finalized mode renders for the same width', () => {
    const component = new ThinkingComponent(longThinking, darkColors, true, 'live');
    component.finalize();

    const first = component.render(80);
    const second = component.render(80);

    expect(second).toBe(first);
  });

  it('does not cache live mode renders', () => {
    const component = new ThinkingComponent('step', darkColors, true, 'live');

    const first = component.render(80);
    const second = component.render(80);

    expect(second).not.toBe(first);
  });

  it('invalidates cache on setText, setExpanded, finalize, and invalidate', () => {
    const component = new ThinkingComponent(longThinking, darkColors, true, 'live');
    component.finalize();

    const initial = component.render(80);

    component.setText('changed');
    expect(component.render(80)).not.toBe(initial);

    const afterText = component.render(80);
    component.setExpanded(true);
    expect(component.render(80)).not.toBe(afterText);

    const live = new ThinkingComponent('x', darkColors, true, 'live');
    const liveFirst = live.render(80);
    live.finalize();
    expect(live.render(80)).not.toBe(liveFirst);

    const finalized = live.render(80);
    live.invalidate();
    expect(live.render(80)).not.toBe(finalized);
  });
});
