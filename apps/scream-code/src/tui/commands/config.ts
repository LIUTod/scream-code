import type { PermissionMode, Session, ThinkingEffort } from '@scream-code/scream-code-sdk';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector';
import { showSubagentModelBinder } from '../components/dialogs/subagent-model-binder';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { saveTuiConfig } from '../config';
import { isBusy } from '../utils/app-state';
import { formatTokenCount } from '#/utils/usage/usage-format';
import type { Theme } from '../theme';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/scream-tui';
import { isTheme } from '../theme/index';
import { formatErrorMessage } from '../utils/event-payload';
import { showUsage } from './info';
import type { PlanModeState } from '../types';
import type { SlashCommandHost } from './dispatch';

/**
 * Storm Breaker guard for model switches. Returns the (currentTokens,
 * maxContextTokens) pair when switching to `alias` would overflow its
 * context window, or `null` when the switch is safe / unknown.
 *
 * Exported (and kept pure) so the guard is unit-testable without spinning
 * up a full ScreamTUI + session mock.
 */
export function contextOverflowForModel(
  state: { contextTokens: number; availableModels: Record<string, { maxContextSize: number }> },
  alias: string,
): { currentTokens: number; maxContextTokens: number } | null {
  const targetModel = state.availableModels[alias];
  if (targetModel === undefined) return null;
  const currentTokens = state.contextTokens;
  if (currentTokens <= 0) return null;
  if (currentTokens <= targetModel.maxContextSize) return null;
  return { currentTokens, maxContextTokens: targetModel.maxContextSize };
}

/**
 * Storm Breaker guard for /compact. Returns the (currentTokens,
 * maxContextTokens, ratio) triple when context usage is below 5% — compressing
 * at this point yields no benefit and discards useful history. Returns `null`
 * when compression is legitimate or when the window size is unknown.
 *
 * Exported (and kept pure) so the guard is unit-testable without a session.
 */
export function shouldGuardCompaction(
  state: { contextTokens: number; maxContextTokens: number },
): { currentTokens: number; maxContextTokens: number; ratio: number } | null {
  const max = state.maxContextTokens;
  if (max <= 0) return null;
  const currentTokens = state.contextTokens;
  if (currentTokens <= 0) return null;
  const ratio = currentTokens / max;
  if (ratio >= 0.05) return null;
  return { currentTokens, maxContextTokens: max, ratio };
}

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

export async function handlePlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  if (subcmd === 'clear') {
    await session.clearPlan();
    host.showNotice('计划已清除');
    return;
  }

  let state: PlanModeState;
  if (subcmd.length === 0) state = host.state.appState.planMode === 'off' ? 'plan' : 'off';
  else if (subcmd === 'on') state = 'plan';
  else if (subcmd === 'off') state = 'off';
  else {
    host.showError(`Unknown plan subcommand: ${subcmd}`);
    return;
  }

  await applyPlanMode(host, session, state);
}

async function applyPlanMode(host: SlashCommandHost, session: Session, state: PlanModeState): Promise<void> {
  const enabled = state !== 'off';
  try {
    const status = await session.getStatus().catch(() => null);
    const currentAgentPlanMode = status?.planMode ?? false;
    if (currentAgentPlanMode !== enabled) {
      await session.setPlanMode(enabled);
    }
    let planPath: string | undefined;
    if (enabled) {
      const plan = await session.getPlan().catch(() => null);
      planPath = plan?.path;
    }
    host.setAppState({ planMode: state });
    host.setPlanModeBanner(state, planPath);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set plan mode: ${msg}`);
  }
}

export async function handleFusionPlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  let state: PlanModeState;
  if (subcmd.length === 0) state = host.state.appState.planMode === 'fusionplan' ? 'off' : 'fusionplan';
  else if (subcmd === 'on') state = 'fusionplan';
  else if (subcmd === 'off') state = 'off';
  else {
    host.showError(`Unknown fusionplan subcommand: ${subcmd}`);
    return;
  }

  await applyPlanMode(host, session, state);
}

export async function handleYoloCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'yolo') {
      host.showNotice('YES 模式已开启');
      return;
    }
    await session.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    host.showNotice('YES 模式：开启', '工作区工具自动批准。');
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'yolo') {
      host.showNotice('YES 模式已关闭');
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice('YES 模式：关闭');
    return;
  }

  // toggle
  if (currentMode === 'yolo') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice('YES 模式：关闭');
  } else {
    await session.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    host.showNotice('YES 模式：开启', '工作区工具已自动批准。');
  }
}

export async function handleAutoCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'auto') {
      host.showNotice('自动模式已开启');
      return;
    }
    await session.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showNotice('自动模式：开启', '工具自动批准。代理不会提问。');
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'auto') {
      host.showNotice('自动模式已关闭');
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice('自动模式：关闭');
    return;
  }

  // toggle
  if (currentMode === 'auto') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice('自动模式：关闭');
  } else {
    await session.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showNotice('自动模式：开启', '工具自动批准。代理不会提问。');
  }
}

export async function handleWolfpackCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  let enabled: boolean;
  if (subcmd.length === 0) enabled = !host.state.appState.wolfpackMode;
  else if (subcmd === 'on') enabled = true;
  else if (subcmd === 'off') enabled = false;
  else {
    host.showError(`Unknown wolfpack subcommand: ${subcmd}`);
    return;
  }

  await applyWolfpackMode(host, session, enabled);
}

async function applyWolfpackMode(host: SlashCommandHost, session: Session, enabled: boolean): Promise<void> {
  try {
    await session.setWolfpackMode(enabled);
    host.setAppState({ wolfpackMode: enabled });
    if (enabled) {
      host.showNotice('WolfPack 模式：开启', '批量并发代理已激活。');
      return;
    }
    host.showNotice('WolfPack 模式：关闭');
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set wolfpack mode: ${msg}`);
  }
}

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const customInstruction = args.trim() || undefined;

  const guard = shouldGuardCompaction(host.state.appState);
  if (guard !== null) {
    const pct = (guard.ratio * 100).toFixed(1);
    host.showNotice(
      'Storm Breaker（风暴守护者）',
      `当前上下文仅 ${formatTokenCount(guard.currentTokens)} / ${formatTokenCount(guard.maxContextTokens)}（${pct}%），压缩无收益。` +
        '建议继续对话，待上下文增长至 5% 以上再执行 /compact。',
    );
    return;
  }

  await session.compact({ instruction: customInstruction });
}

export async function handleEditorCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = args.trim();
  if (command.length === 0) {
    showEditorPicker(host);
    return;
  }
  await applyEditorChoice(host, command);
}

export async function handleThemeCommand(host: SlashCommandHost, args: string): Promise<void> {
  const theme = args.trim();
  if (theme.length === 0) {
    showThemePicker(host);
    return;
  }
  if (!isTheme(theme)) {
    host.showError(`Unknown theme: ${theme}`);
    return;
  }
  await applyThemeChoice(host, theme);
}

export function handleModelCommand(host: SlashCommandHost, args: string): void {
  const trimmed = args.trim();
  if (trimmed === 'diy') {
    showSubagentModelBinder(host);
    return;
  }
  const alias = trimmed;
  if (alias.length === 0) {
    showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  showModelPicker(host, alias);
}

// ---------------------------------------------------------------------------
// Pickers & config apply
// ---------------------------------------------------------------------------

function showEditorPicker(host: SlashCommandHost): void {
  const currentValue = host.state.appState.editorCommand ?? '';
  host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyEditorChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyEditorChoice(host: SlashCommandHost, value: string): Promise<void> {
  const previous = host.state.appState.editorCommand ?? '';
  if (value === previous && value.length > 0) {
    host.showStatus(`Editor unchanged: ${value.length > 0 ? value : 'auto-detect'}`);
    return;
  }

  const editorCommand = value.length > 0 ? value : null;
  try {
    await saveTuiConfig({
      theme: host.state.appState.theme,
      editorCommand,
      notifications: host.state.appState.notifications,
      like: host.state.appState.like,
      fusionPlan: host.state.appState.fusionPlan,
      subagentModels: host.state.appState.subagentModels,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save editor: ${formatErrorMessage(error)}`,
      host.state.theme.colors.error,
    );
    return;
  }

  host.setAppState({ editorCommand });
  host.showStatus(
    value.length > 0
      ? `Editor set to "${value}".`
      : '编辑器设置为自动检测 ($VISUAL / $EDITOR)。',
  );
}

export function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): void {
  const entries = Object.entries(host.state.appState.availableModels);
  if (entries.length === 0) {
    host.showNotice(
      '未配置模型',
      '运行 /config 自定义模型配置。',
    );
    return;
  }
  host.mountEditorReplacement(
    new ModelSelectorComponent({
      models: host.state.appState.availableModels,
      currentValue: host.state.appState.model,
      selectedValue,
      currentThinkingLevel: host.state.appState.thinkingLevel,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: ({ alias, thinkingLevel }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinkingLevel);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performModelSwitch(host: SlashCommandHost, alias: string, thinkingLevel: ThinkingEffort): Promise<void> {
  if (isBusy(host.state.appState)) {
    host.showError('Cannot switch models while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const prevModel = host.state.appState.model;
  const prevThinkingLevel = host.state.appState.thinkingLevel;
  const runtimeChanged = alias !== prevModel || thinkingLevel !== prevThinkingLevel;

  // Storm Breaker guard: refuse to switch to a model whose context window is
  // smaller than the session's current token count. Switching would either
  // truncate the context silently or force an immediate compaction the user
  // did not ask for. Block early with a friendly advisory so the user can
  // compact first or pick a larger-window model.
  const overflow = alias !== prevModel ? contextOverflowForModel(host.state.appState, alias) : null;
  if (overflow !== null) {
    host.showNotice(
      'Storm Breaker（风暴守护者）',
      `无法切换到模型「${alias}」：当前会话上下文 ${formatTokenCount(overflow.currentTokens)} 已超出该模型上限 ${formatTokenCount(overflow.maxContextTokens)}。` +
        '建议先执行 /compact 压缩上下文，或选择上下文窗口更大的模型。',
    );
    return;
  }

  const session = host.session;
  try {
    if (session === undefined && runtimeChanged) {
      await host.authFlow.activateModelAfterLogin(alias, thinkingLevel);
    } else if (session !== undefined) {
      if (alias !== prevModel) {
        await session.setModel(alias);
      }
      if (thinkingLevel !== prevThinkingLevel) {
        await session.setThinking(thinkingLevel);
      }
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch model: ${msg}`);
    return;
  }

  host.setAppState({ model: alias, thinkingLevel });

  let persisted = false;

  try {
    persisted = await persistModelSelection(host, alias, thinkingLevel);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Switched to ${alias}, but failed to save default: ${msg}`);
    return;
  }

  const status = runtimeChanged
    ? `Switched to ${alias} with thinking ${thinkingLevel}.`
    : persisted
      ? `Saved ${alias} with thinking ${thinkingLevel} as default.`
      : `Already using ${alias} with thinking ${thinkingLevel}.`;
  host.showStatus(status, host.state.theme.colors.success);
}

async function persistModelSelection(host: SlashCommandHost, alias: string, thinkingLevel: ThinkingEffort): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  const effectiveThinking = thinkingLevel !== 'off';
  const existingEffort = config.thinking?.effort;
  const newEffort = effectiveThinking ? thinkingLevel : existingEffort;
  const unchanged =
    config.defaultModel === alias &&
    config.defaultThinking === effectiveThinking &&
    existingEffort === newEffort;
  if (unchanged) return false;
  await host.harness.setConfig({
    defaultModel: alias,
    defaultThinking: effectiveThinking,
    thinking: { ...config.thinking, mode: effectiveThinking ? 'on' : 'off', effort: newEffort },
  });
  return true;
}

function showThemePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyThemeChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyThemeChoice(host: SlashCommandHost, theme: Theme): Promise<void> {
  if (theme === host.state.appState.theme) {
    if (theme === 'auto') host.refreshTerminalThemeTracking();
    host.showStatus(`Theme unchanged: "${theme}".`);
    return;
  }
  try {
    await saveTuiConfig({
      theme,
      editorCommand: host.state.appState.editorCommand,
      notifications: host.state.appState.notifications,
      like: host.state.appState.like,
      fusionPlan: host.state.appState.fusionPlan,
      subagentModels: host.state.appState.subagentModels,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save theme: ${formatErrorMessage(error)}`,
      host.state.theme.colors.error,
    );
    return;
  }

  const resolved = theme === 'auto' ? host.state.theme.resolvedTheme : theme;
  host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  const detail = theme === 'auto' ? ` (tracking terminal; current: ${resolved})` : '';
  host.showStatus(`Theme set to "${theme}"${detail}.`);
}

export function showPermissionPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyPermissionChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(`Permission mode unchanged: ${mode}.`);
    return;
  }

  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set permission mode: ${msg}`);
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(`Permission mode: ${mode}`);
}

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
      colors: host.state.theme.colors,
      onSelect: (value) => {
        handleSettingsSelection(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function handleSettingsSelection(host: SlashCommandHost, value: SettingsSelection): void {
  host.restoreEditor();
  switch (value) {
    case 'model': showModelPicker(host); return;
    case 'permission': showPermissionPicker(host); return;
    case 'theme': showThemePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'usage': void showUsage(host); return;
  }
}
