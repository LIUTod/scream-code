/**
 * `/model diy` — bind a model alias to each built-in subagent profile.
 *
 * Two-level picker:
 *   1. Profile list (coder / reviewer / writer / explore / oracle / plan / verify)
 *      showing each profile's current binding.
 *   2. Model selector: "跟随主模型" (unbind) + every configured model alias.
 *
 * Bindings persist to `tui.toml` and update live AppState, so mid-session
 * changes take effect on the next subagent spawn without recreating the session.
 */

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { modelDisplayName } from './model-selector';
import {
  getTuiConfigPath,
  loadTuiConfig,
  saveTuiConfig,
  type TuiConfig,
} from '#/tui/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { t } from '@scream-code/config';

const FOLLOW_MAIN = '__follow_main__';

let applying = false;

function getSubagentProfiles(): readonly {
  readonly name: string;
  readonly description: string;
}[] {
  return [
    { name: 'coder', description: t('subagent.desc_coder') },
    { name: 'reviewer', description: t('subagent.desc_reviewer') },
    { name: 'writer', description: t('subagent.desc_writer') },
    { name: 'explore', description: t('subagent.desc_explore') },
    { name: 'oracle', description: t('subagent.desc_oracle') },
    { name: 'plan', description: t('subagent.desc_plan') },
    { name: 'verify', description: t('subagent.desc_verify') },
  ];
}

export function showSubagentModelBinder(host: SlashCommandHost): void {
  mountProfileList(host);
}

function mountProfileList(host: SlashCommandHost): void {
  const { subagentModels: bindings, availableModels } = host.state.appState;
  const options: ChoiceOption[] = getSubagentProfiles().map((profile) => {
    const alias = bindings[profile.name];
    const bindingLabel =
      alias === undefined
        ? t('subagent.follow_main')
        : modelDisplayName(alias, availableModels[alias]);
    return {
      value: profile.name,
      label: `${profile.name}  →  ${bindingLabel}`,
      description: profile.description,
    };
  });

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('subagent.title'),
      hint: t('subagent.hint'),
      options,
      colors: host.state.theme.colors,
      onSelect: (profileName) => {
        mountModelPicker(host, profileName);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function mountModelPicker(host: SlashCommandHost, profileName: string): void {
  const { subagentModels: bindings, availableModels } = host.state.appState;
  const currentBinding = bindings[profileName] ?? FOLLOW_MAIN;

  const options: ChoiceOption[] = [
    {
      value: FOLLOW_MAIN,
      label: t('subagent.follow_main'),
      description: t('subagent.follow_main_desc'),
    },
    ...Object.entries(availableModels).map(([alias, cfg]) => ({
      value: alias,
      label: modelDisplayName(alias, cfg),
    })),
  ];

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('subagent.bind_title', { profile: profileName }),
      hint: t('subagent.model_hint'),
      options,
      currentValue: currentBinding,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: (value) => {
        if (applying) return;
        applying = true;
        void applyBinding(host, profileName, value).finally(() => {
          applying = false;
        });
      },
      onCancel: () => {
        mountProfileList(host);
      },
    }),
  );
}

async function applyBinding(
  host: SlashCommandHost,
  profileName: string,
  value: string,
): Promise<void> {
  const configPath = getTuiConfigPath();
  try {
    const current = await loadTuiConfig(configPath);
    const updated: Record<string, string> = { ...current.subagentModels };
    if (value === FOLLOW_MAIN) {
      delete updated[profileName];
    } else {
      updated[profileName] = value;
    }
    const newConfig: TuiConfig = { ...current, subagentModels: updated };
    await saveTuiConfig(newConfig, configPath);
    host.setAppState({ subagentModels: updated });
    const label =
      value === FOLLOW_MAIN
        ? t('subagent.follow_main')
        : modelDisplayName(value, host.state.appState.availableModels[value]);
    host.showStatus(`${profileName} → ${label}`, host.state.theme.colors.success);
    mountProfileList(host);
  } catch (error) {
    host.showError(t('subagent.save_failed', { msg: error instanceof Error ? error.message : String(error) }));
  }
}
