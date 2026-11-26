import type { ModelAlias, ThinkingEffort } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { describe, expect, it, vi } from 'vitest';

import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { EditorSelectorComponent } from '#/tui/components/dialogs/editor-selector';
import { ModelSelectorComponent, type ImageGenerationSummary } from '#/tui/components/dialogs/model-selector';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import { ThemeSelectorComponent } from '#/tui/components/dialogs/theme-selector';
import { darkColors } from '#/tui/theme/colors';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  // The selected row is padded to the full width (its bar); compare the text only.
  return text.replaceAll(ANSI_SGR, '').trimEnd();
}

describe('ChoicePickerComponent', () => {
  it('renders optional descriptions below choice labels', () => {
    const picker = new ChoicePickerComponent({
      title: 'Select permission mode',
      options: [
        {
          value: 'ask',
          label: 'ASK',
          description: 'Answer in conversation without modifying anything.',
        },
        {
          value: 'auto',
          label: 'Auto',
          description: 'Automatically approve tool actions and plan transitions.',
        },
      ],
      currentValue: 'ask',
      colors: darkColors,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip);

    expect(out).toContain(`  ❯ ASK ${t('dialog.current')}`);
    expect(out).toContain('    Answer in conversation without modifying anything.');
    expect(out).toContain('    Automatically approve tool actions and plan transitions.');
  });

  it('renders domain selector wrappers with their configured options', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const editor = new EditorSelectorComponent({
      currentValue: 'vim',
      colors: darkColors,
      onSelect,
      onCancel,
    });
    expect(editor.render(120).map(strip)).toContain(`  ❯ Vim ${t('dialog.current')}`);

    const model = new ModelSelectorComponent({
      models: {
        scream: {
          provider: 'managed:scream-code',
          model: 'scream-k2',
          maxContextSize: 200_000,
          displayName: 'Scream K2',
          capabilities: ['thinking'],
        },
      },
      currentValue: 'scream',
      currentThinkingLevel: 'high',
      colors: darkColors,
      onSelect,
      onCancel,
    });
    const modelOutput = model.render(120).map(strip);
    const row = modelOutput.find((line) => line.includes('❯ Scream K2')) ?? '';
    expect(row).toContain(t('dialog.current'));
    expect(row).toContain('Scream Code');
    expect(row).toContain('200K');
    const thinking = modelOutput.find((line) => line.includes('思考（全局）')) ?? '';
    expect(thinking).toContain('[● high]');
    expect(thinking).toContain('- off');
    const capabilities = modelOutput.find((line) => line.includes('能力')) ?? '';
    expect(capabilities).toContain('识图 ✗');
    expect(capabilities).toContain('视频 ✗');
    expect(capabilities).toContain('音频 ✗');

    const theme = new ThemeSelectorComponent({
      currentValue: 'light',
      colors: darkColors,
      onSelect,
      onCancel,
    });
    expect(theme.render(120).map(strip)).toContain(`  ❯ 浅色 ${t('dialog.current')}`);

    const permission = new PermissionSelectorComponent({
      currentValue: 'yolo',
      colors: darkColors,
      onSelect,
      onCancel,
    });
    expect(permission.render(120).map(strip)).toContain(`  ❯ YES ${t('dialog.current')}`);

    const settings = new SettingsSelectorComponent({
      colors: darkColors,
      onSelect,
      onCancel,
    });
    const settingsOutput = settings.render(120).map(strip);
    expect(settingsOutput).toContain('  ❯ 模型');
    expect(settingsOutput).toContain('    切换当前模型和思考模式。');
  });

  it('lists exactly the four surviving permission modes', () => {
    const picker = new PermissionSelectorComponent({
      currentValue: 'yolo',
      colors: darkColors,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip);

    for (const label of ['自动', 'YES', 'BOT', 'ASK']) {
      expect(out.some((line) => line.includes(label))).toBe(true);
    }
    // The removed posture must not come back as a row or a label.
    expect(out.some((line) => line.includes('手动'))).toBe(false);
  });

  it('submits the selected model and inline thinking state', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        scream: {
          provider: 'managed:scream-code',
          model: 'scream-k2',
          maxContextSize: 200_000,
          displayName: 'Scream K2',
          capabilities: ['thinking'],
        },
      },
      currentValue: 'scream',
      currentThinkingLevel: 'high',
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput('\u001B[C');
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith({ alias: 'scream', thinkingLevel: 'xhigh' });
  });

  it('forces always-thinking models on and unsupported models off', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        always: {
          provider: 'managed:scream-code',
          model: 'scream-thinking',
          maxContextSize: 200_000,
          displayName: 'Scream Thinking',
          capabilities: ['always_thinking'],
        },
        plain: {
          provider: 'managed:scream-code',
          model: 'scream-plain',
          maxContextSize: 200_000,
          displayName: 'Scream Plain',
          capabilities: ['tool_use'],
        },
      },
      currentValue: 'always',
      currentThinkingLevel: 'off',
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    const always = picker.render(120).map(strip).find((line) => line.includes('思考（全局）')) ?? '';
    expect(always).toContain('[○ low]');
    expect(always).not.toContain('off');
    picker.handleInput('\u001B[C');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinkingLevel: 'medium' });

    picker.handleInput('\u001B[B');
    expect(picker.render(120).map(strip).find((line) => line.includes('思考（全局）')) ?? '').toContain('此模型不支持');
    picker.handleInput('\u001B[D');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'plain', thinkingLevel: 'off' });
  });

  it('treats adaptiveThinking models as thinking-capable without a thinking capability', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        okapi: {
          provider: 'anthropic',
          model: 'coding-model-okapi-0527-vibe',
          maxContextSize: 200_000,
          adaptiveThinking: true,
        },
      },
      currentValue: 'okapi',
      currentThinkingLevel: 'high',
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    // adaptiveThinking makes the alias togglable (not 'unsupported'): the current
    // thinking state is preserved on select instead of being forced off.
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'okapi', thinkingLevel: 'high' });

    // Right (ESC[C) cycles to the next thinking level, proving it is an interactive control.
    picker.handleInput('\u001B[C');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'okapi', thinkingLevel: 'xhigh' });
  });
  it('fires onChangeThinking immediately when cycling thinking with arrows', () => {
    const onChangeThinking = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        scream: {
          provider: 'managed:scream-code',
          model: 'scream-k2',
          maxContextSize: 200_000,
          displayName: 'Scream K2',
          capabilities: ['thinking'],
        },
      },
      currentValue: 'scream',
      currentThinkingLevel: 'high',
      colors: darkColors,
      onSelect: vi.fn(),
      onChangeThinking,
      onCancel: vi.fn(),
    });

    // Right cycles high -> xhigh -> max -> off, firing onChangeThinking each step.
    picker.handleInput('\u001B[C');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'xhigh');
    picker.handleInput('\u001B[C');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'max');
    picker.handleInput('\u001B[C');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'off');
    // Left cycles off -> max -> xhigh -> high (wraps).
    picker.handleInput('\u001B[D');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'max');
    picker.handleInput('\u001B[D');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'xhigh');
    picker.handleInput('\u001B[D');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'high');
  });

  it('keeps the thinking draft when moving across models', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        plain: {
          provider: 'managed:scream-code',
          model: 'scream-plain',
          maxContextSize: 200_000,
          displayName: 'Scream Plain',
          capabilities: ['tool_use'],
        },
        thinking: {
          provider: 'managed:scream-code',
          model: 'scream-thinking',
          maxContextSize: 200_000,
          displayName: 'Scream Thinking',
          capabilities: ['thinking'],
        },
      },
      currentValue: 'plain',
      currentThinkingLevel: 'off',
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput('\u001B[B');
    picker.handleInput('\u001B[D');
    picker.handleInput('\u001B[A');
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith({ alias: 'thinking', thinkingLevel: 'max' });
  });
});

const ESC = String.fromCodePoint(27);
const BACKSPACE = String.fromCodePoint(127);
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;
const ENTER = String.fromCodePoint(13);

function rendered(component: { render: (w: number) => string[] }, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

describe('ChoicePickerComponent search and pagination', () => {
  function makePicker(over: { options?: { value: string; label: string }[]; searchable?: boolean }) {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Select a provider',
      options:
        over.options ??
        ['openai', 'openrouter', 'anthropic', 'google', 'mistral', 'cohere'].map((label) => ({
          value: label,
          label,
        })),
      colors: darkColors,
      searchable: over.searchable ?? true,
      onSelect,
      onCancel,
    });
    return { picker, onSelect, onCancel };
  }

  function type(picker: ChoicePickerComponent, query: string): void {
    for (const ch of query) picker.handleInput(ch);
  }

  it('filters the list as the user types and echoes the query', () => {
    const { picker } = makePicker({});
    type(picker, 'open');
    const out = rendered(picker);
    expect(out).toContain('Search: open');
    expect(out).toContain('openai');
    expect(out).toContain('openrouter');
    expect(out).not.toContain('anthropic');
    expect(out).not.toContain('google');
  });

  it('trims the query on Backspace and clears it on Esc before cancelling', () => {
    const { picker, onCancel } = makePicker({});
    type(picker, 'open');
    expect(rendered(picker)).toContain('Search: open');

    picker.handleInput(BACKSPACE);
    expect(rendered(picker)).toContain('Search: ope');

    picker.handleInput(ESC); // non-empty query → clear, do not cancel
    expect(onCancel).not.toHaveBeenCalled();
    expect(rendered(picker)).not.toContain('Search:');
    expect(rendered(picker)).toContain('anthropic'); // full list restored

    picker.handleInput(ESC); // empty query → cancel
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Enter selects the highlighted item from the filtered list', () => {
    const { picker, onSelect } = makePicker({});
    type(picker, 'router'); // only openrouter matches
    picker.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith('openrouter');
  });

  it('shows "No matches" and selects nothing when the query matches nothing', () => {
    const { picker, onSelect } = makePicker({});
    type(picker, 'zzzz');
    expect(rendered(picker)).toContain('No matches');
    picker.handleInput(ENTER);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('splits a long list into pages and pages with PageDown and Right', () => {
    const options = Array.from({ length: 20 }, (_, i) => {
      const label = `item${String(i).padStart(2, '0')}`;
      return { value: label, label };
    });
    const { picker } = makePicker({ options, searchable: false });

    expect(rendered(picker)).toContain('Page 1/3');
    expect(rendered(picker)).toContain('item00');
    expect(rendered(picker)).not.toContain('item08');

    picker.handleInput(PAGE_DOWN);
    expect(rendered(picker)).toContain('Page 2/3');
    expect(rendered(picker)).toContain('item08');
    expect(rendered(picker)).not.toContain('item00');

    picker.handleInput(RIGHT);
    expect(rendered(picker)).toContain('Page 3/3');
    expect(rendered(picker)).toContain('item19');
  });

  it('omits the page footer for a short list', () => {
    const { picker } = makePicker({ searchable: false });
    expect(rendered(picker)).not.toContain('Page ');
  });
});

describe('ChoicePickerComponent action keys', () => {
  it('invokes the action key handler for the selected option when the query is empty', () => {
    const onAction = vi.fn();
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Action keys',
      options: [
        { value: 'a', label: 'Alpha', actionKeys: { d: onAction } },
        { value: 'b', label: 'Beta' },
      ],
      colors: darkColors,
      searchable: true,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput('d');
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not invoke action keys while a search query is active', () => {
    const onAction = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Action keys',
      options: [
        { value: 'a', label: 'Alpha', actionKeys: { d: onAction } },
        { value: 'b', label: 'Beta' },
      ],
      colors: darkColors,
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    // Type a query first so the action key is treated as search input.
    picker.handleInput('a');
    picker.handleInput('l');
    picker.handleInput('d');
    expect(rendered(picker)).toContain('Search: ald');
    expect(onAction).not.toHaveBeenCalled();
  });
  it('ignores action keys on options that do not define them', () => {
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Action keys',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      colors: darkColors,
      searchable: true,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput('d');
    expect(rendered(picker)).toContain('Search: d');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('ModelSelectorComponent search and pagination', () => {
  function buildModels(count: number): Record<string, ModelAlias> {
    const models: Record<string, ModelAlias> = {};
    for (let i = 0; i < count; i++) {
      const id = `model${String(i).padStart(2, '0')}`;
      models[`prov/${id}`] = {
        provider: 'prov',
        model: id,
        maxContextSize: 1000,
        capabilities: ['thinking'],
      };
    }
    return models;
  }

  function makeSelector(
    models: Record<string, ModelAlias>,
    currentThinkingLevel: ThinkingEffort = 'high',
    imageGeneration?: ImageGenerationSummary,
  ) {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const firstAlias = Object.keys(models)[0] ?? '';
    const selector = new ModelSelectorComponent({
      models,
      currentValue: firstAlias,
      currentThinkingLevel,
      colors: darkColors,
      searchable: true,
      ...(imageGeneration !== undefined ? { imageGeneration } : {}),
      onSelect,
      onCancel,
    });
    return { selector, onSelect, onCancel };
  }

  it('filters models as the user types', () => {
    const { selector } = makeSelector({
      'p/alpha': { provider: 'p', model: 'alpha', maxContextSize: 1000 },
      'p/beta': { provider: 'p', model: 'beta', maxContextSize: 1000 },
      'p/gamma': { provider: 'p', model: 'gamma', maxContextSize: 1000 },
    });
    for (const ch of 'beta') selector.handleInput(ch);
    const out = rendered(selector);
    expect(out).toContain('搜索：beta');
    expect(out).toContain('beta');
    expect(out).not.toContain('alpha');
    expect(out).not.toContain('gamma');
  });

  it('pages with PageDown/PageUp while Left/Right still toggle thinking', () => {
    const { selector } = makeSelector(buildModels(20));

    expect(rendered(selector)).toContain('第 1/3 页');
    expect(rendered(selector)).toContain('model00');
    expect(rendered(selector)).not.toContain('model08');

    selector.handleInput(PAGE_DOWN);
    expect(rendered(selector)).toContain('第 2/3 页');
    expect(rendered(selector)).toContain('model08');

    // Right cycles thinking to the next level and must NOT change the page.
    selector.handleInput(RIGHT);
    expect(rendered(selector)).toContain('第 2/3 页');
    expect(rendered(selector)).toContain('[⦿ xhigh]');

    // Left cycles thinking back, page still unchanged.
    selector.handleInput(LEFT);
    expect(rendered(selector)).toContain('第 2/3 页');
    expect(rendered(selector)).toContain('[● high]');
    selector.handleInput(PAGE_UP);
    expect(rendered(selector)).toContain('第 1/3 页');
  });

  it('surfaces the image-generation status under the multimodal block', () => {
    const models = { 'p/alpha': { provider: 'p', model: 'alpha', maxContextSize: 1000 } };
    const { selector } = makeSelector(models, 'high', { configured: true, model: 'gpt-image-2' });
    const out = rendered(selector);
    expect(out).toContain('生图模型：gpt-image-2 · 已配置');
    expect(out).toContain('/config image');
  });

  it('renders the not-configured hint, and nothing when the host omits the status', () => {
    const models = { 'p/alpha': { provider: 'p', model: 'alpha', maxContextSize: 1000 } };
    const missing = makeSelector(models, 'high', { configured: false }).selector;
    expect(rendered(missing)).toContain('生图模型：未配置');
    expect(rendered(missing)).toContain('/config image');

    const absent = makeSelector(models).selector;
    expect(rendered(absent)).not.toContain('生图模型');
  });

  it('names the menu it came from, starts on the entry left, and pages only with several pages', () => {
    const picker = new ChoicePickerComponent({
      title: 'Theme',
      breadcrumb: 'Settings',
      initialValue: 'b',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
      colors: darkColors,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = picker.render(80).map(strip);
    expect(out).toContain(' Settings › Theme');
    expect(out).toContain('  ❯ B');
    expect(out.some((line) => line.includes(t('dialog.back')))).toBe(true);
    // One page: Right must not jump to the last entry.
    picker.handleInput('\u001B[C');
    expect(picker.render(80).map(strip)).toContain('  ❯ B');
  });
});
