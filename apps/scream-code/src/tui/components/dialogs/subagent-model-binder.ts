/**
 * `/model diy` — bind a model alias to each built-in subagent profile.
 *
 * Two-level picker:
 *   1. Profile list (one row per built-in subagent profile, in the picker's own
 *      stable order, with membership taken from the shared slot list) showing
 *      each profile's current binding.
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
import { DEFAULT_SUBAGENT_TYPES } from '#/tui/utils/subagent-slots';
import { localizedSubagentDesc } from '#/tui/utils/subagent-display';
import { t } from '@scream-code/config';

const FOLLOW_MAIN = '__follow_main__';

let applying = false;

/**
 * Row order for the picker: the order users have always seen here, which is not
 * the sidebar slot order. Membership is still taken from the shared slot list,
 * and any type this order does not mention is appended, so the picker can never
 * drop a profile the rest of the UI knows about.
 */
const PICKER_ORDER: readonly string[] = [
  'coder',
  'reviewer',
  'writer',
  'explore',
  'oracle',
  'plan',
  'verify',
  'worker',
];

export function getSubagentProfiles(): readonly {
  readonly name: string;
  readonly description: string;
}[] {
  const ordered = [
    ...PICKER_ORDER.filter((name) => DEFAULT_SUBAGENT_TYPES.includes(name)),
    ...DEFAULT_SUBAGENT_TYPES.filter((name) => !PICKER_ORDER.includes(name)),
  ];
  return ordered.map((name) => ({
    name,
    description: localizedSubagentDesc(name),
  }));
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
        : availableModels[alias] !== undefined
          ? modelDisplayName(alias, availableModels[alias])
          : t('subagent.stale_binding', { alias });
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
    // Reject writes of an alias that is no longer configured (orphan
    // bindings silently fell back to the parent model before this guard).
    if (value !== FOLLOW_MAIN && host.state.appState.availableModels[value] === undefined) {
      host.showError(t('subagent.invalid_alias', { alias: value }));
      return;
    }
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
