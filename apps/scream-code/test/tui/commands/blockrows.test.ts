/**
 * blockrows.test.ts — /blockrows 命令的行为测试。
 *
 * 打桩面：
 * - 对话框组件（ChoicePicker）：用轻量 class 捕获构造选项，测试内直接触发回调；
 * - ui-preferences：内存记录写入，不落盘（读走真实模块会读临时数据目录，这里一并打桩）。
 */

import { t } from '@scream-code/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleBlockRowsCommand } from '#/tui/commands/blockrows';
import { darkColors } from '#/tui/theme/colors';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

interface PickerOptions {
  title?: string;
  currentValue?: string;
  options: Array<{ value: string; label: string; description?: string }>;
  onSelect: (value: string) => void;
  onCancel: () => void;
}

const dialogs = vi.hoisted(() => ({ pickers: [] as PickerOptions[] }));
vi.mock('#/tui/components/dialogs/choice-picker', () => ({
  ChoicePickerComponent: class {
    constructor(options: PickerOptions) {
      dialogs.pickers.push(options);
    }
  },
}));

interface StoredLines {
  activityCollapsedLines?: number;
  activityExpandedToolLines?: number;
  activityExpandedThinkingLines?: number;
}

const prefs = vi.hoisted(() => ({ stored: {} as StoredLines }));
vi.mock('#/tui/utils/ui-preferences', () => ({
  readActivityLinePrefs: (): StoredLines => ({ ...prefs.stored }),
  writeActivityLinePref: (key: keyof StoredLines, value: number): void => {
    prefs.stored[key] = value;
  },
}));

function makeHost(): { host: SlashCommandHost; invalidate: ReturnType<typeof vi.fn> } {
  const invalidate = vi.fn();
  const host = {
    state: {
      theme: { colors: darkColors },
      transcriptContainer: { children: [{ invalidate }] },
      ui: { requestRender: vi.fn() },
    },
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, invalidate };
}

/** 当前挂载的 picker（最后一个）。 */
function lastPicker(): PickerOptions {
  const picker = dialogs.pickers.at(-1);
  if (picker === undefined) throw new Error('no picker mounted');
  return picker;
}

describe('handleBlockRowsCommand', () => {
  beforeEach(() => {
    dialogs.pickers.length = 0;
    delete prefs.stored.activityCollapsedLines;
    delete prefs.stored.activityExpandedToolLines;
    delete prefs.stored.activityExpandedThinkingLines;
  });

  it('opens the budget picker listing the three settings with their current values', async () => {
    const { host } = makeHost();

    await handleBlockRowsCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const picker = lastPicker();
    expect(picker.options.map((option) => option.value)).toEqual([
      'activityCollapsedLines',
      'activityExpandedToolLines',
      'activityExpandedThinkingLines',
    ]);
    expect(picker.options[0]?.label).toBe(t('blockrows.item_collapsed'));
    expect(picker.options[0]?.description).toBe(t('blockrows.current', { value: '3' }));
  });

  it('opens the value list for the chosen budget and applies the choice', async () => {
    const { host, invalidate } = makeHost();
    await handleBlockRowsCommand(host, '');

    lastPicker().onSelect('activityExpandedToolLines');

    const valuePicker = lastPicker();
    expect(valuePicker.currentValue).toBe('15');
    expect(valuePicker.options.map((option) => option.value)).toEqual([
      '5',
      '10',
      '15',
      '20',
      '30',
    ]);

    valuePicker.onSelect('5');

    expect(prefs.stored.activityExpandedToolLines).toBe(5);
    expect(host.restoreEditor).toHaveBeenCalledTimes(1);
    expect(host.showStatus).toHaveBeenCalledTimes(1);
    // Blocks already on screen cache their rows, so they are repainted.
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('steps back to the budget list when the value list is cancelled', async () => {
    const { host } = makeHost();
    await handleBlockRowsCommand(host, '');

    lastPicker().onSelect('activityCollapsedLines');
    expect(dialogs.pickers).toHaveLength(2);

    lastPicker().onCancel();

    // Back at step one, and nothing was written.
    expect(dialogs.pickers).toHaveLength(3);
    expect(lastPicker().options).toHaveLength(3);
    expect(Object.keys(prefs.stored)).toHaveLength(0);
    expect(host.restoreEditor).not.toHaveBeenCalled();
  });

  it('leaves the editor in place when the budget list is cancelled', async () => {
    const { host } = makeHost();
    await handleBlockRowsCommand(host, '');

    lastPicker().onCancel();

    expect(host.restoreEditor).toHaveBeenCalledTimes(1);
    expect(Object.keys(prefs.stored)).toHaveLength(0);
  });
});
