import chalk from 'chalk';
import { visibleWidth } from '@liutod-scream/pi-tui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatusBarPaneComponent, type StatusBarPaneOptions } from '#/tui/components/panes/status-bar-pane';
import { darkColors } from '#/tui/theme/colors';
import type { WorkState } from '#/tui/utils/status-text';

const strip = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
const sgr = (hex: string): string => {
  const v = hex.replace(/^#/, '');
  return `\u001B[38;2;${String(Number.parseInt(v.slice(0, 2), 16))};${String(Number.parseInt(v.slice(2, 4), 16))};${String(Number.parseInt(v.slice(4, 6), 16))}m`;
};

/** Minimal PulseWaveLoader stand-in: only getFrameText()/invalidate() are used. */
const fakeWave = (frame = '■······'): never => ({ getFrameText: () => frame, invalidate: () => {} }) as never;

const working = (variants: string[]): (() => WorkState) => () => ({ kind: 'working', variants });
const blocked = (variants: string[]): (() => WorkState) => () => ({ kind: 'blocked', variants });

function pane(options: Partial<StatusBarPaneOptions> & Pick<StatusBarPaneOptions, 'mode'>): StatusBarPaneComponent {
  return new StatusBarPaneComponent({ colors: darkColors, ...options });
}

const row = (p: StatusBarPaneComponent, width: number): string => strip(p.render(width)[0] ?? '');

let level = chalk.level;
beforeEach(() => {
  level = chalk.level;
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = level;
});

describe('StatusBarPaneComponent — working', () => {
  it('puts the phase and how long right after the wave, on one row', () => {
    const p = pane({ mode: 'working', pulseWave: fakeWave(), state: working(['思考中 · 12s', '思考中']) });
    expect(p.render(80)).toHaveLength(1);
    const left = '■······  思考中 · 12s';
    expect(row(p, 80)).toBe(left + ' '.repeat(80 - visibleWidth(left) - visibleWidth('Esc 中断')) + 'Esc 中断');
  });

  it('draws the phase in grey, never in the bright text colour', () => {
    const line = pane({ mode: 'working', pulseWave: fakeWave(), state: working(['输出中 · 0s']) }).render(80)[0] ?? '';
    expect(line).toContain(`${sgr(darkColors.textDim)}输出中 · 0s`);
    expect(line).not.toContain(sgr(darkColors.text));
  });

  it('reads the state on every render, so the clock moves without a rebuild', () => {
    let seconds = 12;
    const p = pane({
      mode: 'working',
      pulseWave: fakeWave(),
      state: () => ({ kind: 'working', variants: [`思考中 · ${String(seconds)}s`] }),
    });
    expect(row(p, 80)).toContain('12s');
    seconds = 13;
    expect(row(p, 80)).toContain('13s');
  });

  it('shows the reconnect detail in the warning colour instead of the phase', () => {
    const p = pane({
      mode: 'working',
      pulseWave: fakeWave(),
      state: working(['思考中 · 12s']),
      reconnect: '⚠️ 重连中 2/10：限流 (429) · 20s',
    });
    const line = p.render(120)[0] ?? '';
    expect(strip(line)).toContain('⚠️ 重连中 2/10：限流 (429) · 20s');
    expect(strip(line)).not.toContain('思考中');
    expect(line).toContain(`${sgr(darkColors.warning)}⚠️ 重连中 2/10：限流 (429) · 20s`);
  });

  it('offers Esc on the right while working, and not while Esc would do something else', () => {
    expect(row(pane({ mode: 'working', pulseWave: fakeWave(), state: working(['思考中 · 12s']) }), 80)).toMatch(/Esc 中断$/);
    const taken = pane({ mode: 'working', pulseWave: fakeWave(), state: working(['思考中 · 12s']), escTaken: () => true });
    expect(row(taken, 80)).not.toContain('Esc');
  });

  it('lets Esc give way before the phase on a narrow row', () => {
    const p = pane({ mode: 'working', pulseWave: fakeWave(), state: working(['思考中 · 12s', '思考中']) });
    const withEsc: number[] = [];
    for (let width = 12; width <= 80; width++) {
      const line = row(p, width);
      if (!line.includes('Esc')) continue;
      withEsc.push(width);
      expect(line, `width ${String(width)}`).toContain('思考中 · 12s');
    }
    // Wide rows keep it, narrow ones give it up first.
    expect(withEsc.at(-1)).toBe(80);
    expect(withEsc[0]).toBeGreaterThan(12);
  });

  it('renders the bare wave when there is no state yet', () => {
    expect(row(pane({ mode: 'working', pulseWave: fakeWave() }), 80)).toMatch(/^■······ +Esc 中断$/);
  });

  it('shortens the phase to its label, then drops it, but never the wave', () => {
    const p = pane({ mode: 'working', pulseWave: fakeWave('■'), state: working(['思考中 · 12s', '思考中']) });
    expect(row(p, 16)).toContain('思考中 · 12s');
    expect(row(p, 12)).toContain('思考中');
    expect(row(p, 12)).not.toContain('12s');
    for (let width = 1; width <= 10; width++) expect(row(p, width)).toContain('■');
  });
});

describe('StatusBarPaneComponent — blocked', () => {
  it('names what the session waits for, in the warning colour and bold', () => {
    const p = pane({ mode: 'blocked', state: blocked(['等待批准 · 4m']) });
    const line = p.render(80)[0] ?? '';
    expect(strip(line).trimEnd()).toBe('◆ 等待批准 · 4m');
    expect(line).toContain(sgr(darkColors.warning));
    expect(line).toContain('\u001B[1m');
  });

  it('renders nothing when there is nothing to say', () => {
    expect(pane({ mode: 'blocked', state: () => null }).render(80)).toEqual([]);
  });
});

describe('StatusBarPaneComponent — idle tip', () => {
  const TIP = '输入 / 查看所有命令，输入 @ 引用文件路径';

  it('shows the tip on the left and the close key on the right', () => {
    const line = row(pane({ mode: 'idle', tip: TIP }), 80);
    expect(line.startsWith(`Tips  ${TIP}`)).toBe(true);
    expect(line.trimEnd().endsWith('Ctrl+B 关闭')).toBe(true);
    expect(visibleWidth(line)).toBe(80);
  });

  it('draws the tip in the quietest text token, not a hardcoded grey, and never brighter', () => {
    const line = pane({ mode: 'idle', tip: TIP }).render(80)[0] ?? '';
    expect(line).toContain(sgr(darkColors.textMuted));
    expect(line).not.toContain(sgr(darkColors.textDim));
    expect(line).not.toContain(sgr(darkColors.text));
    expect(line).not.toContain(sgr('#999999'));
  });

  it('gives up the close key before it cuts the tip', () => {
    const wide = row(pane({ mode: 'idle', tip: TIP }), 80);
    const tight = row(pane({ mode: 'idle', tip: TIP }), 52);
    expect(wide).toContain('Ctrl+B');
    expect(tight).not.toContain('Ctrl+B');
    expect(tight).toContain(TIP);
  });

  it('cuts the tip with one ellipsis rather than mid-word into the close key', () => {
    for (let width = 20; width <= 80; width++) {
      const line = row(pane({ mode: 'idle', tip: TIP }), width);
      expect((line.match(/…/g) ?? []).length).toBeLessThanOrEqual(1);
      expect(line).not.toMatch(/Ctrl\+…/);
    }
  });

  it('renders nothing for an idle row with no tip and no cue', () => {
    expect(pane({ mode: 'idle' }).render(80)).toEqual([]);
    expect(pane({ mode: 'idle', tip: '' }).render(80)).toEqual([]);
  });
});

describe('StatusBarPaneComponent — scroll cue', () => {
  const cue = (text: string, color?: string) => () => ({ text, color });

  it('sits on the right of a working row', () => {
    const p = pane({
      mode: 'working',
      pulseWave: fakeWave(),
      state: working(['思考中 · 12s']),
      scrollCue: cue('↓ 2 条新消息 · 向下滚动跟随'),
    });
    expect(row(p, 80).trimEnd().endsWith('↓ 2 条新消息 · 向下滚动跟随')).toBe(true);
  });

  it('takes the close key place on an idle row, and is mounted without a tip', () => {
    const withTip = row(pane({ mode: 'idle', tip: '一条提示', scrollCue: cue('↓ 向下滚动') }), 80);
    expect(withTip).toContain('↓ 向下滚动');
    expect(withTip).not.toContain('Ctrl+B');
    expect(row(pane({ mode: 'idle', scrollCue: cue('↓ 向下滚动') }), 80)).toContain('↓ 向下滚动');
  });

  it('is read live and disappears when it ends', () => {
    let current: { text: string } | null = { text: '↓ 向下滚动' };
    const p = pane({ mode: 'idle', scrollCue: () => current });
    expect(row(p, 80)).toContain('↓ 向下滚动');
    current = null;
    expect(p.render(80)).toEqual([]);
  });

  it('outranks the phase text on a narrow row, and the wave outranks both', () => {
    const p = pane({
      mode: 'working',
      pulseWave: fakeWave(),
      state: working(['思考中 · 12s']),
      scrollCue: cue('↓ 2 条新消息 · 向下滚动跟随'),
    });
    expect(row(p, 80)).toContain('思考中 · 12s');
    expect(row(p, 40)).toContain('↓ 2 条新消息');
    expect(row(p, 40)).not.toContain('思考中');
    // The wave is 7 columns wide: from there up it always survives.
    for (let width = 7; width <= 40; width++) expect(row(p, width)).toContain('■');
  });
});

describe('StatusBarPaneComponent — fit contract', () => {
  it('keeps the row to one line inside the width, at every width', () => {
    const variants: Array<Partial<StatusBarPaneOptions> & Pick<StatusBarPaneOptions, 'mode'>> = [
      { mode: 'working', pulseWave: fakeWave(), state: working(['执行中 · 47s', '执行中']), reconnect: '⚠️ 重连中 2/10：限流' },
      { mode: 'blocked', state: blocked(['等待批准 · 4m']) },
      { mode: 'idle', tip: '输入 / 查看所有命令，输入 @ 引用文件路径', scrollCue: () => ({ text: '↓ 2 条新消息' }) },
    ];
    for (const options of variants) {
      for (let width = 1; width <= 120; width++) {
        const lines = pane(options).render(width);
        expect(lines.length).toBeLessThanOrEqual(1);
        for (const line of lines) expect(visibleWidth(line), `width ${String(width)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('update() replaces the content without leaking old children', () => {
    const p = pane({ mode: 'idle', tip: '甲' });
    p.update({ colors: darkColors, mode: 'idle', tip: '乙' });
    expect(p.children).toHaveLength(1);
    expect(row(p, 40)).toContain('乙');
    expect(row(p, 40)).not.toContain('甲');
  });
});
