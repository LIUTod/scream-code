import {
  catalogModelToAlias,
  inferWireType,
  type Catalog,
  type CatalogModel,
  type ModelAlias,
} from '@scream-cli/scream-code-sdk';

import { ApiKeyInputDialogComponent, type ApiKeyInputResult } from '../components/dialogs/api-key-input-dialog';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import { TextInputDialogComponent, type TextInputResult } from '../components/dialogs/text-input-dialog';
import type { SlashCommandHost } from './dispatch';

export function promptLogoutProviderSelection(
  host: SlashCommandHost,
  options: readonly ChoiceOption[],
  currentValue: string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: '选择要登出的提供商',
      options,
      currentValue,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptApiKey(host: SlashCommandHost, platformName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      host.state.theme.colors,
    );
    host.mountEditorReplacement(dialog);
  });
}

export function promptCatalogProviderSelection(host: SlashCommandHost, catalog: Catalog): Promise<string | undefined> {
  return new Promise((resolve) => {
    const options: ChoiceOption[] = Object.entries(catalog)
      .filter(([, entry]) => inferWireType(entry) !== undefined)
      .map(([id, entry]) => ({
        value: id,
        label: entry.name ?? id,
        description:
          typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    if (options.length === 0) {
      host.showError('目录中没有支持该 wire 类型的提供商。');
      resolve(undefined);
      return;
    }

    const picker = new ChoicePickerComponent({
      title: '选择提供商',
      options,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export async function promptModelSelectionForCatalog(
  host: SlashCommandHost,
  providerId: string,
  models: CatalogModel[],
): Promise<{ model: CatalogModel; thinking: boolean } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${providerId}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export function runModelSelector(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
): Promise<{ alias: string; thinking: boolean } | undefined> {
  return new Promise((resolve) => {
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
    const selector = new ModelSelectorComponent({
      models: modelDict,
      currentValue: firstAlias,
      currentThinking: initialThinking,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        resolve({ alias, thinking });
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector);
  });
}

// ── /config diy prompts ────────────────────────────────────────────────

const WIRE_TYPE_OPTIONS: ChoiceOption[] = [
  { value: 'openai', label: 'OpenAI 兼容协议', description: '适用于 DeepSeek、OpenAI、Groq 等' },
  { value: 'anthropic', label: 'Anthropic 协议', description: '适用于 Claude 系列模型' },
];

const THINKING_OPTIONS: ChoiceOption[] = [
  { value: 'true', label: '开启思考模式' },
  { value: 'false', label: '关闭思考模式' },
];

export function promptWireType(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: '选择兼容协议',
      hint: '选择模型服务商的 API 协议类型',
      options: WIRE_TYPE_OPTIONS,
      colors: host.state.theme.colors,
      onSelect: (value) => { host.restoreEditor(); resolve(value); },
      onCancel: () => { host.restoreEditor(); resolve(undefined); },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptTextInput(
  host: SlashCommandHost,
  title: string,
  opts?: { subtitle?: string; masked?: boolean; placeholder?: string },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new TextInputDialogComponent(
      (result: TextInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title,
        subtitle: opts?.subtitle,
        masked: opts?.masked,
        placeholder: opts?.placeholder,
        colors: host.state.theme.colors,
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

export function promptThinkingMode(host: SlashCommandHost): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: '思考模式',
      hint: '启用后模型会先思考再回答（需要模型支持）',
      options: THINKING_OPTIONS,
      colors: host.state.theme.colors,
      onSelect: (value) => { host.restoreEditor(); resolve(value === 'true'); },
      onCancel: () => { host.restoreEditor(); resolve(undefined); },
    });
    host.mountEditorReplacement(picker);
  });
}
