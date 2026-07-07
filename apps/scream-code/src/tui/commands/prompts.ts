import {
  catalogModelToAlias,
  inferWireType,
  type Catalog,
  type CatalogModel,
  type ModelAlias,
  type ThinkingEffort,
} from '@scream-code/scream-code-sdk';

import { t } from '@scream-code/config';

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
      title: t('prompts.logout_title'),
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
      host.showError(t('prompts.no_wire_provider'));
      resolve(undefined);
      return;
    }

    const picker = new ChoicePickerComponent({
      title: t('prompts.select_provider'),
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
): Promise<{ model: CatalogModel; thinkingLevel: ThinkingEffort } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${providerId}/${m.id}` === selection.alias);
  return model ? { model, thinkingLevel: selection.thinkingLevel } : undefined;
}

export function runModelSelector(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
): Promise<{ alias: string; thinkingLevel: ThinkingEffort } | undefined> {
  return new Promise((resolve) => {
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinkingLevel: ThinkingEffort = caps.includes('always_thinking') ? 'medium' : 'off';
    const selector = new ModelSelectorComponent({
      models: modelDict,
      currentValue: firstAlias,
      currentThinkingLevel: initialThinkingLevel,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: ({ alias, thinkingLevel }) => {
        host.restoreEditor();
        resolve({ alias, thinkingLevel });
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

function getWireTypeOptions(): ChoiceOption[] {
  return [
    { value: 'openai', label: t('prompts.wire_openai'), description: t('prompts.wire_openai_desc') },
    { value: 'anthropic', label: t('prompts.wire_anthropic'), description: t('prompts.wire_anthropic_desc') },
  ];
}
function getThinkingOptions(): ChoiceOption[] {
  return [
    { value: 'off', label: t('prompts.thinking_off') },
    { value: 'low', label: t('prompts.thinking_low') },
    { value: 'medium', label: t('prompts.thinking_medium') },
    { value: 'high', label: t('prompts.thinking_high') },
  ];
}
function getImageOptions(): ChoiceOption[] {
  return [
    { value: 'off', label: t('prompts.image_off'), description: t('prompts.image_off_desc') },
    { value: 'on', label: t('prompts.image_on'), description: t('prompts.image_on_desc') },
  ];
}
function getVideoOptions(): ChoiceOption[] {
  return [
    { value: 'off', label: t('prompts.video_off'), description: t('prompts.video_off_desc') },
    { value: 'on', label: t('prompts.video_on'), description: t('prompts.video_on_desc') },
  ];
}
function getAudioOptions(): ChoiceOption[] {
  return [
    { value: 'off', label: t('prompts.audio_off'), description: t('prompts.audio_off_desc') },
    { value: 'on', label: t('prompts.audio_on'), description: t('prompts.audio_on_desc') },
  ];
}

export function promptWireType(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('prompts.wire_type_title'),
      hint: t('prompts.wire_type_hint'),
      options: getWireTypeOptions(),
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
export function promptThinkingMode(host: SlashCommandHost): Promise<ThinkingEffort | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('prompts.thinking_title'),
      hint: t('prompts.thinking_hint'),
      options: getThinkingOptions(),
      colors: host.state.theme.colors,
      onSelect: (value) => { host.restoreEditor(); resolve(value as ThinkingEffort); },
      onCancel: () => { host.restoreEditor(); resolve(undefined); },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptImageMode(host: SlashCommandHost): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('prompts.image_title'),
      hint: t('prompts.modal_off_hint'),
      options: getImageOptions(),
      colors: host.state.theme.colors,
      onSelect: (value) => { host.restoreEditor(); resolve(value === 'on'); },
      onCancel: () => { host.restoreEditor(); resolve(undefined); },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptVideoMode(host: SlashCommandHost): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('prompts.video_title'),
      hint: t('prompts.modal_off_hint'),
      options: getVideoOptions(),
      colors: host.state.theme.colors,
      onSelect: (value) => { host.restoreEditor(); resolve(value === 'on'); },
      onCancel: () => { host.restoreEditor(); resolve(undefined); },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptAudioMode(host: SlashCommandHost): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('prompts.audio_title'),
      hint: t('prompts.modal_off_hint'),
      options: getAudioOptions(),
      colors: host.state.theme.colors,
      onSelect: (value) => { host.restoreEditor(); resolve(value === 'on'); },
      onCancel: () => { host.restoreEditor(); resolve(undefined); },
    });
    host.mountEditorReplacement(picker);
  });
}
