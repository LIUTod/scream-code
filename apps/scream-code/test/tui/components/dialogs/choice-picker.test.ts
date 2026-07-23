import type { ModelAlias, ThinkingEffort } from '@scream-code/scream-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { EditorSelectorComponent } from '#/tui/components/dialogs/editor-selector';
import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import { ThemeSelectorComponent } from '#/tui/components/dialogs/theme-selector';
import { darkColors } from '#/tui/theme/colors';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('ChoicePickerComponent', () => {
  it('renders optional descriptions below choice labels', () => {
    const picker = new ChoicePickerComponent({
      title: 'Select permission mode',
      options: [
        {
          value: 'manual',
          label: 'Manual',
          description: 'Ask before commands, edits, and other risky actions.',
        },
        {
          value: 'auto',
          label: 'Auto',
          description: 'Automatically approve tool actions and plan transitions.',
        },
      ],
      currentValue: 'manual',
      colors: darkColors,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip);

    expect(out).toContain('  ❯ Manual ← current');
    expect(out).toContain('    Ask before commands, edits, and other risky actions.');
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
    expect(editor.render(120).map(strip)).toContain('  ❯ Vim ← current');

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
    expect(modelOutput).toContain('  ❯ Scream K2 (Scream Code) ← current');
    expect(modelOutput).toContain(' Thinking（全局设置）');
    expect(modelOutput).toContain('  off  low  medium  [ high ]  max');
    expect(modelOutput).toContain(' 多模态能力');
    expect(modelOutput).toContain('  识图: ✗ 不支持');
    expect(modelOutput).toContain('  视频: ✗ 不支持');
    expect(modelOutput).toContain('  音频: ✗ 不支持');

    const theme = new ThemeSelectorComponent({
      currentValue: 'light',
      colors: darkColors,
      onSelect,
      onCancel,
    });
    expect(theme.render(120).map(strip)).toContain('  ❯ 浅色 ← current');

    const permission = new PermissionSelectorComponent({
      currentValue: 'manual',
      colors: darkColors,
      onSelect,
      onCancel,
    });
    expect(permission.render(120).map(strip)).toContain('  ❯ 手动 ← current');

    const settings = new SettingsSelectorComponent({
      colors: darkColors,
      onSelect,
      onCancel,
    });
    const settingsOutput = settings.render(120).map(strip);
    expect(settingsOutput).toContain('  ❯ 模型');
    expect(settingsOutput).toContain('    切换当前模型和思考模式。');
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

    expect(onSelect).toHaveBeenCalledWith({ alias: 'scream', thinkingLevel: 'max' });
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

    expect(picker.render(120).map(strip)).toContain('  [ low ]  medium  high  max');
    picker.handleInput('\u001B[C');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinkingLevel: 'medium' });

    picker.handleInput('\u001B[B');
    expect(picker.render(120).map(strip)).toContain('  [ off ] unsupported');
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
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'okapi', thinkingLevel: 'max' });
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

    // Right cycles high -> max -> off, firing onChangeThinking each step.
    picker.handleInput('\u001B[C');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'max');
    picker.handleInput('\u001B[C');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'off');
    // Left cycles off -> max -> high (wraps).
    picker.handleInput('\u001B[D');
    expect(onChangeThinking).toHaveBeenLastCalledWith('scream', 'max');
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

  function makeSelector(models: Record<string, ModelAlias>, currentThinkingLevel: ThinkingEffort = 'high') {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const firstAlias = Object.keys(models)[0] ?? '';
    const selector = new ModelSelectorComponent({
      models,
      currentValue: firstAlias,
      currentThinkingLevel,
      colors: darkColors,
      searchable: true,
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
    expect(out).toContain('beta (p)');
    expect(out).not.toContain('alpha (p)');
    expect(out).not.toContain('gamma (p)');
  });

  it('pages with PageDown/PageUp while Left/Right still toggle thinking', () => {
    const { selector } = makeSelector(buildModels(20));

    expect(rendered(selector)).toContain('Page 1/3');
    expect(rendered(selector)).toContain('model00 (prov)');
    expect(rendered(selector)).not.toContain('model08 (prov)');

    selector.handleInput(PAGE_DOWN);
    expect(rendered(selector)).toContain('Page 2/3');
    expect(rendered(selector)).toContain('model08 (prov)');

    // Right cycles thinking to the next level and must NOT change the page.
    selector.handleInput(RIGHT);
    expect(rendered(selector)).toContain('Page 2/3');
    expect(rendered(selector)).toContain('[ max ]');

    // Left cycles thinking back, page still unchanged.
    selector.handleInput(LEFT);
    expect(rendered(selector)).toContain('Page 2/3');
    expect(rendered(selector)).toContain('[ high ]');
    selector.handleInput(PAGE_UP);
    expect(rendered(selector)).toContain('Page 1/3');
  });
});
