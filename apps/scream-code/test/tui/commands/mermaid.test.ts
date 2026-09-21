/**
 * mermaid.test.ts — /mermaid 命令的行为测试。
 *
 * 偏好读写走真实模块（测试数据目录是临时目录），断言的是真实持久化结果。
 * 面板内容用 render() 的真实输出验（仓库惯例），选择/取消的接线则直接取面板的
 * 回调来驱动 —— 不模拟按键序列，那会让测试跟着终端编码走。
 * 会话上的运行时提示用桩替代。
 */

import { t } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleMermaidCommand } from '#/tui/commands/mermaid';
import { darkColors } from '#/tui/theme/colors';
import { diagramCapabilityPrompt } from '#/tui/utils/terminal-diagram-prompt';
import { getMermaidDisplay, setMermaidDisplay } from '#/tui/utils/ui-preferences';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

/** The picker keeps its callbacks on a private field; this is the seam. */
interface PickerHandle {
  render(width: number): string[];
  opts: { onSelect(value: string): void; onCancel(): void };
}

function makeHost() {
  const setRuntimeSystemPrompt = vi.fn(async () => {});
  const invalidate = vi.fn();
  const mounted: unknown[] = [];
  const host = {
    session: { setRuntimeSystemPrompt },
    state: {
      theme: { colors: darkColors },
      transcriptContainer: { children: [{ invalidate }] },
      ui: { requestRender: vi.fn() },
    },
    showStatus: vi.fn(),
    mountEditorReplacement: (panel: unknown) => {
      mounted.push(panel);
    },
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, setRuntimeSystemPrompt, invalidate, mounted };
}

function pickerOf(mounted: unknown[]): PickerHandle {
  expect(mounted).toHaveLength(1);
  return mounted[0] as PickerHandle;
}

function lastAppend(stub: { setRuntimeSystemPrompt: ReturnType<typeof vi.fn> }): string {
  const call = stub.setRuntimeSystemPrompt.mock.calls.at(-1) as [{ append?: string }] | undefined;
  return call?.[0]?.append ?? '';
}

describe('/mermaid 面板', () => {
  beforeEach(() => {
    setMermaidDisplay('on');
  });

  afterEach(() => {
    setMermaidDisplay('on');
  });

  it('无参数弹出面板，三档都在，且每档有解释', async () => {
    const { host, mounted } = makeHost();
    await handleMermaidCommand(host, '');
    const lines = pickerOf(mounted)
      .render(72)
      .map((line) => line.replaceAll(/\u001B\[[0-9;]*m/g, ''));
    const text = lines.join('\n');
    for (const key of ['mermaid.option.on', 'mermaid.option.ascii', 'mermaid.option.off']) {
      expect(text).toContain(t(key));
    }
    // 没有解释的话，"双宽模式"没人知道是拿来救什么的。
    for (const key of ['mermaid.desc.on', 'mermaid.desc.ascii', 'mermaid.desc.off']) {
      expect(text).toContain(t(key));
    }
    expect(text).toContain(t('mermaid.picker_title'));
  });

  it('面板标出当前档', async () => {
    setMermaidDisplay('ascii');
    const { host, mounted } = makeHost();
    await handleMermaidCommand(host, '');
    const text = pickerOf(mounted)
      .render(72)
      .map((line) => line.replaceAll(/\u001B\[[0-9;]*m/g, ''))
      .join('\n');
    const asciiLine = text.split('\n').find((line) => line.includes(t('mermaid.option.ascii')));
    expect(asciiLine).toBeDefined();
    expect(asciiLine).toContain('current');
  });

  it('选定后写入偏好、收起面板并重画屏上内容', async () => {
    const { host, mounted, invalidate } = makeHost();
    await handleMermaidCommand(host, '');
    pickerOf(mounted).opts.onSelect('ascii');
    expect(getMermaidDisplay()).toBe('ascii');
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
    expect(host.state.ui.requestRender).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenLastCalledWith(
      t('mermaid.applied', { mode: t('mermaid.option.ascii') }),
      darkColors.success,
    );
  });

  it('取消不改任何东西，只说明维持原状', async () => {
    const { host, mounted, invalidate } = makeHost();
    await handleMermaidCommand(host, '');
    pickerOf(mounted).opts.onCancel();
    expect(getMermaidDisplay()).toBe('on');
    expect(invalidate).not.toHaveBeenCalled();
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenLastCalledWith(
      t('mermaid.picker_cancelled', { mode: t('mermaid.option.on') }),
      darkColors.textDim,
    );
  });

  it('认不出的参数只报用法，不弹面板', async () => {
    const { host, mounted } = makeHost();
    await handleMermaidCommand(host, 'nonsense');
    expect(mounted).toHaveLength(0);
    expect(host.showStatus).toHaveBeenCalledWith(t('mermaid.usage'), darkColors.textDim);
    expect(getMermaidDisplay()).toBe('on');
  });
});

describe('/mermaid 直接指定（与面板选定同一条落地路径）', () => {
  beforeEach(() => {
    setMermaidDisplay('on');
  });

  afterEach(() => {
    setMermaidDisplay('on');
  });

  it('off 用弱化色提示，on 用成功色', async () => {
    const { host } = makeHost();
    await handleMermaidCommand(host, 'off');
    expect(getMermaidDisplay()).toBe('off');
    expect(host.showStatus).toHaveBeenLastCalledWith(
      t('mermaid.applied', { mode: t('mermaid.option.off') }),
      darkColors.textDim,
    );
    await handleMermaidCommand(host, 'on');
    expect(getMermaidDisplay()).toBe('on');
    expect(host.showStatus).toHaveBeenLastCalledWith(
      t('mermaid.applied', { mode: t('mermaid.option.on') }),
      darkColors.success,
    );
  });

  it('关掉时收回对模型的承诺，任一开档时重新声明', async () => {
    const { host, setRuntimeSystemPrompt } = makeHost();
    await handleMermaidCommand(host, 'off');
    expect(lastAppend({ setRuntimeSystemPrompt })).toBe('');
    await handleMermaidCommand(host, 'ascii');
    expect(lastAppend({ setRuntimeSystemPrompt })).toBe(diagramCapabilityPrompt());
  });
});
