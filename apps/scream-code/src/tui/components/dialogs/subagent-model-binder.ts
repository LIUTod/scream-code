/**
 * `/model diy` — bind model aliases per purpose, from one menu.
 *
 * Three entries:
 *   1. Models by role — read (explore/plan/verify), task (coder/worker) and
 *      judge (reviewer/oracle) each bind one alias; a profile explicitly bound
 *      in entry 3 still wins over its role.
 *   2. Compaction model — the housekeeping model compaction summaries run on.
 *   3. Models by subagent type — one alias per built-in subagent profile, the
 *      flow this dialog has always provided.
 *
 * Every binding persists to `tui.toml` (`[modelTiers]` for entries 1–2,
 * `[subagentModels]` for entry 3) and updates live AppState, so a mid-session
 * change takes effect on the next subagent spawn or compaction without
 * recreating the session. The engine reads these live bindings first, then the
 * config.toml fallbacks (`loop_control.model_roles` / `housekeeping_model`),
 * then the parent model.
 */

import type { ModelAlias } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { modelDisplayName } from './model-selector';
import {
  getTuiConfigPath,
  loadTuiConfig,
  saveTuiConfig,
  type ModelTierBindings,
  type ModelTierKey,
  type TuiConfig,
} from '#/tui/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { DEFAULT_SUBAGENT_TYPES } from '#/tui/utils/subagent-slots';
import { localizedSubagentDesc } from '#/tui/utils/subagent-display';

const FOLLOW_MAIN = '__follow_main__';

/** Menu entry values; never persisted. */
const MENU_ROLES = '__menu_roles__';
const MENU_HOUSEKEEPING = '__menu_housekeeping__';
const MENU_PROFILES = '__menu_profiles__';

/** Role classes in picker order — the same split the engine routes on. */
const ROLE_KEYS = ['read', 'task', 'judge'] as const;

type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * Where a picked alias is written. The profile kind keeps the original
 * `[subagentModels]` behaviour; the other two fill `[modelTiers]`.
 */
type BindingTarget =
  | { readonly kind: 'role'; readonly role: RoleKey }
  | { readonly kind: 'housekeeping' }
  | { readonly kind: 'profile'; readonly profile: string };

let applying = false;

/**
 * Row order for the profile picker: the order users have always seen here,
 * which is not the sidebar slot order. Membership is still taken from the
 * shared slot list, and any type this order does not mention is appended, so
 * the picker can never drop a profile the rest of the UI knows about.
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
  'designer',
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

/** Human label of a role class, e.g. "探索 · 规划 · 验证". */
export function getRoleLabel(role: RoleKey): string {
  return t(`modeldiy.role_${role}`);
}

export function showSubagentModelBinder(host: SlashCommandHost): void {
  mountMenu(host);
}

function mountMenu(host: SlashCommandHost): void {
  const options: ChoiceOption[] = [
    {
      value: MENU_ROLES,
      label: t('modeldiy.entry_roles'),
      description: t('modeldiy.entry_roles_desc'),
    },
    {
      value: MENU_HOUSEKEEPING,
      label: t('modeldiy.entry_housekeeping'),
      description: t('modeldiy.entry_housekeeping_desc'),
    },
    {
      value: MENU_PROFILES,
      label: t('modeldiy.entry_profiles'),
      description: t('modeldiy.entry_profiles_desc'),
    },
  ];

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('modeldiy.title'),
      hint: t('modeldiy.hint'),
      options,
      colors: host.state.theme.colors,
      onSelect: (entry) => {
        if (entry === MENU_ROLES) {
          mountRoleList(host);
          return;
        }
        if (entry === MENU_HOUSEKEEPING) {
          mountModelPicker(host, { kind: 'housekeeping' });
          return;
        }
        mountProfileList(host);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function mountRoleList(host: SlashCommandHost): void {
  const { modelTiers, availableModels } = host.state.appState;
  const options: ChoiceOption[] = ROLE_KEYS.map((role) => {
    const target: BindingTarget = { kind: 'role', role };
    const current = bindingLabel(target, modelTiers?.[role], availableModels);
    return {
      value: role,
      label: `${getRoleLabel(role)}  →  ${current}`,
      description: t(`modeldiy.role_${role}_desc`),
    };
  });

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('modeldiy.roles_title'),
      hint: t('modeldiy.roles_hint'),
      options,
      colors: host.state.theme.colors,
      onSelect: (role) => {
        // The picker hands back the option value; ROLE_KEYS is the only source
        // of those values, so the narrowing is exact.
        mountModelPicker(host, { kind: 'role', role: role as RoleKey });
      },
      onCancel: () => {
        mountMenu(host);
      },
    }),
  );
}

function mountProfileList(host: SlashCommandHost): void {
  const { subagentModels: bindings, availableModels } = host.state.appState;
  const options: ChoiceOption[] = getSubagentProfiles().map((profile) => {
    const target: BindingTarget = { kind: 'profile', profile: profile.name };
    const current = bindingLabel(target, bindings[profile.name], availableModels);
    return {
      value: profile.name,
      label: `${profile.name}  →  ${current}`,
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
        mountModelPicker(host, { kind: 'profile', profile: profileName });
      },
      onCancel: () => {
        mountMenu(host);
      },
    }),
  );
}

function mountModelPicker(host: SlashCommandHost, target: BindingTarget): void {
  const { availableModels } = host.state.appState;
  const currentBinding = currentBindingOf(host, target) ?? FOLLOW_MAIN;

  const options: ChoiceOption[] = [
    {
      value: FOLLOW_MAIN,
      label: followLabel(target),
      description: followDesc(target),
    },
    ...Object.entries(availableModels).map(([alias, cfg]) => ({
      value: alias,
      label: modelDisplayName(alias, cfg),
    })),
  ];

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: pickerTitle(target),
      hint: target.kind === 'housekeeping' ? t('modeldiy.housekeeping_hint') : t('subagent.model_hint'),
      options,
      currentValue: currentBinding,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: (value) => {
        if (applying) return;
        applying = true;
        void applyBinding(host, target, value).finally(() => {
          applying = false;
        });
      },
      onCancel: () => {
        // One step back: the list this picker was opened from.
        if (target.kind === 'profile') {
          mountProfileList(host);
          return;
        }
        if (target.kind === 'role') {
          mountRoleList(host);
          return;
        }
        mountMenu(host);
      },
    }),
  );
}

function currentBindingOf(host: SlashCommandHost, target: BindingTarget): string | undefined {
  const { modelTiers, subagentModels } = host.state.appState;
  if (target.kind === 'profile') return subagentModels[target.profile];
  if (target.kind === 'role') return modelTiers?.[target.role];
  return modelTiers?.housekeeping;
}

/**
 * Display name of a bound alias, the follow-default label for unset, and
 * "(stale)" for orphans. A role or housekeeping target's unset row cannot say
 * "follow main model": config.toml (`loop_control.model_roles` /
 * `housekeeping_model`) is consulted first, and only a profile row ends on the
 * parent model.
 */
function bindingLabel(
  target: BindingTarget,
  alias: string | undefined,
  availableModels: Record<string, ModelAlias>,
): string {
  if (alias === undefined) return followLabel(target);
  const cfg = availableModels[alias];
  return cfg !== undefined ? modelDisplayName(alias, cfg) : t('subagent.stale_binding', { alias });
}

/** Label of an unset binding — the row and the picker's clear option agree. */
function followLabel(target: BindingTarget): string {
  return target.kind === 'profile' ? t('subagent.follow_main') : t('subagent.follow_default');
}

function followDesc(target: BindingTarget): string {
  return target.kind === 'profile'
    ? t('subagent.follow_main_desc')
    : t('subagent.follow_default_desc');
}

function pickerTitle(target: BindingTarget): string {
  if (target.kind === 'profile') return t('subagent.bind_title', { profile: target.profile });
  if (target.kind === 'role') return t('modeldiy.bind_title', { name: getRoleLabel(target.role) });
  return t('modeldiy.housekeeping_title');
}

/** Row label used in the status line after a successful binding. */
function targetLabel(target: BindingTarget): string {
  if (target.kind === 'profile') return target.profile;
  if (target.kind === 'role') return getRoleLabel(target.role);
  return t('modeldiy.housekeeping_title');
}

async function applyBinding(
  host: SlashCommandHost,
  target: BindingTarget,
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
    if (target.kind === 'profile') {
      const subagentModels = writeProfileBinding(current.subagentModels, target.profile, value);
      const newConfig: TuiConfig = { ...current, subagentModels };
      await saveTuiConfig(newConfig, configPath);
      host.setAppState({ subagentModels });
    } else {
      const key: ModelTierKey = target.kind === 'role' ? target.role : 'housekeeping';
      const modelTiers = writeTierBinding(current.modelTiers ?? {}, key, value);
      const newConfig: TuiConfig = { ...current, modelTiers };
      await saveTuiConfig(newConfig, configPath);
      host.setAppState({ modelTiers });
    }
    const label =
      value === FOLLOW_MAIN
        ? followLabel(target)
        : modelDisplayName(value, host.state.appState.availableModels[value]);
    host.showStatus(`${targetLabel(target)} → ${label}`, host.state.theme.colors.success);
    // Per-profile bindings return to their list (many profiles to review);
    // role and housekeeping bindings are one-shot, so they return to the menu.
    if (target.kind === 'profile') {
      mountProfileList(host);
      return;
    }
    mountMenu(host);
  } catch (error) {
    host.showError(
      t('subagent.save_failed', { msg: error instanceof Error ? error.message : String(error) }),
    );
  }
}

/** Copy-on-write tier write; FOLLOW_MAIN removes the key (= follow main). */
function writeTierBinding(
  tiers: ModelTierBindings,
  key: ModelTierKey,
  value: string,
): ModelTierBindings {
  const updated: ModelTierBindings = { ...tiers };
  if (value === FOLLOW_MAIN) {
    delete updated[key];
  } else {
    updated[key] = value;
  }
  return updated;
}

/** Copy-on-write profile write; FOLLOW_MAIN removes the key (= follow main). */
function writeProfileBinding(
  bindings: Record<string, string>,
  profile: string,
  value: string,
): Record<string, string> {
  const updated: Record<string, string> = { ...bindings };
  if (value === FOLLOW_MAIN) {
    delete updated[profile];
  } else {
    updated[profile] = value;
  }
  return updated;
}
