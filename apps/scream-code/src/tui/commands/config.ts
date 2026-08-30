import type { PermissionMode, Session, ScreamHarness, ThinkingEffort, ModelAlias } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { ModelSelectorComponent, getThinkingLevels } from '../components/dialogs/model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector';
import { showSubagentModelBinder } from '../components/dialogs/subagent-model-binder';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { loadTuiConfig, saveTuiConfig } from '../config';
import { handleLanguageCommand } from './language';
import { isBusy } from '../utils/app-state';
import { formatTokenCount } from '#/utils/usage/usage-format';
import type { Theme } from '../theme';
import { getNoActiveSessionMessage } from '../constant/scream-tui';
import { isTheme } from '../theme/index';
import { formatErrorMessage } from '../utils/event-payload';
import { showUsage } from './info';
import { refreshProviderBalance } from '../api-balance';
import type { AppState, PlanModeState } from '../types';
import type { SlashCommandHost } from './dispatch';
import type { TUIState } from '../tui-state';

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
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const subcmd = args.trim().toLowerCase();
  if (subcmd === 'clear') {
    await session.clearPlan();
    host.showNotice(t('config.plan_cleared'));
    return;
  }

  let state: PlanModeState;
  if (subcmd.length === 0) state = host.state.appState.planMode === 'off' ? 'plan' : 'off';
  else if (subcmd === 'on') state = 'plan';
  else if (subcmd === 'off') state = 'off';
  else if (subcmd === 'fusion') state = 'fusionplan';
  else {
    host.showError(`Unknown plan subcommand: ${subcmd}`);
    return;
  }

  await applyPlanMode(host, session, state);
}

async function applyPlanMode(host: SlashCommandHost, session: Session, state: PlanModeState): Promise<void> {
  const enabled = state !== 'off';
  const strategy = state === 'fusionplan' ? 'fusion' as const : 'normal' as const;
  try {
    const status = await session.getStatus().catch(() => null);
    const currentAgentPlanMode = status?.planMode ?? false;
    const currentStrategy = status?.planStrategy;
    if (!enabled && currentAgentPlanMode) {
      await session.setPlanMode(false);
    } else if (enabled && !currentAgentPlanMode) {
      await session.setPlanMode(true, strategy);
    } else if (enabled && currentStrategy !== strategy) {
      await session.setPlanStrategy(strategy);
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
    host.showError(getNoActiveSessionMessage());
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
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'yolo') {
      host.showNotice(t('config.yolo_already_on'));
      return;
    }
    await session.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'yolo') {
      host.showNotice(t('config.yolo_already_off'));
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    return;
  }

  // toggle
  if (currentMode === 'yolo') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
  } else {
    await session.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
  }
}

export async function handleAskCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'ask') {
      host.showNotice(t('config.ask_already_on'));
      return;
    }
    await session.setPermission('ask');
    host.setAppState({ permissionMode: 'ask' });
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'ask') {
      host.showNotice(t('config.ask_already_off'));
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    return;
  }

  // toggle
  if (currentMode === 'ask') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
  } else {
    await session.setPermission('ask');
    host.setAppState({ permissionMode: 'ask' });
  }
}

export async function handleRlmCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const subcmd = args.trim().toLowerCase();
  let enabled: boolean;
  if (subcmd.length === 0) enabled = !host.state.appState.rlmEnabled;
  else if (subcmd === 'on') enabled = true;
  else if (subcmd === 'off') enabled = false;
  else {
    host.showError(`Unknown rlm subcommand: ${subcmd}`);
    return;
  }

  try {
    await session.setRlmEnabled(enabled);
    host.setAppState({ rlmEnabled: enabled });
    if (enabled) {
      host.showNotice(t('config.rlm_on'));
      return;
    }
    host.showNotice(t('config.rlm_off'));
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set rlm mode: ${msg}`);
  }
}

/** /rlm-max-depth [N] — query or set the maximum RLM recursion depth.
 * N=0 or no limit means unlimited (the default). */
export async function handleRlmMaxDepthCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }
  const arg = args.trim();
  if (arg.length === 0) {
    host.showStatus('RLM max depth: run /rlm-max-depth <N> (0 or blank = unlimited) to set it.');
    return;
  }
  const parsed = Number(arg);
  if (!Number.isInteger(parsed) || parsed < 0) {
    host.showError(`Invalid rlm-max-depth: ${arg} (expected a non-negative integer, 0 = unlimited).`);
    return;
  }
  try {
    await session.setRlmMaxDepth(parsed);
    if (parsed === 0) {
      host.showStatus('RLM recursion depth set to unlimited.', host.state.theme.colors.success);
    } else {
      host.showStatus(`RLM max depth set to ${parsed}.`, host.state.theme.colors.success);
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set rlm max depth: ${msg}`);
  }
}

export async function handleAutoCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'auto') {
      host.showNotice(t('config.auto_already_on'));
      return;
    }
    await session.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'auto') {
      host.showNotice(t('config.auto_already_off'));
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    return;
  }

  // toggle
  if (currentMode === 'auto') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
  } else {
    await session.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
  }
}

export async function handleWolfpackCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
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
      host.showNotice(t('wolfpack.on'), t('wolfpack.on_desc'));
      return;
    }
    host.showNotice(t('wolfpack.off'));
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set wolfpack mode: ${msg}`);
  }
}

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
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

export async function handleModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const trimmed = args.trim();
  if (trimmed === 'diy') {
    if (isBusy(host.state.appState)) {
      host.showError('Cannot rebind subagents while streaming — press Esc or Ctrl-C first.');
      return;
    }
    showSubagentModelBinder(host);
    return;
  }
  const alias = trimmed;
  if (alias.length === 0) {
    await refreshModelsForPicker(host);
    showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  showModelPicker(host, alias);
}

/**
 * Reload provider/model config before showing the model picker so models
 * added via /config or /config diy since startup are visible without
 * restarting. Times out after 2 seconds and falls back to the existing
 * state if the reload is slow.
 */
async function refreshModelsForPicker(host: SlashCommandHost): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = await Promise.race([
      host.harness.getConfig({ reload: true }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('refresh timeout')), 2_000);
      }),
    ]);
    host.setAppState({
      availableModels: config.models ?? host.state.appState.availableModels,
      availableProviders: config.providers ?? host.state.appState.availableProviders,
    });
  } catch {
    // Refresh failed or timed out - use whatever is already in state.
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
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
      ...(await loadTuiConfig()),
      theme: host.state.appState.theme,
      language: host.state.appState.language,
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
      onChangeThinking: (alias, level) => {
        void changeThinkingLevel(host, alias, level);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

/**
 * Apply a thinking-level change immediately (←/→ keys in the model selector).
 * Decoupled from performModelSwitch so the user can cycle thinking on the
 * currently-selected model without pressing Enter. If the alias is the active
 * model, the running session is updated too; otherwise only the default is
 * persisted.
 */
/** Cycle the thinking effort for a model to the next supported level.
 *  Returns the next level (wrapping around to the first when at the end).
 *  Uses the model's declared thinkingLevels; falls back to the full set
 *  when the model is not found in the catalog. */
export function getModelCycleLevel(
  models: Record<string, ModelAlias>,
  alias: string,
  current: ThinkingEffort,
): ThinkingEffort {
  const model = models[alias];
  // Use getThinkingLevels so models that don't support thinking return
  // ['off'] (single level -> next===current -> no-op), and the fallback
  // set matches DEFAULT_THINKING_LEVELS exactly.
  const levels = model ? getThinkingLevels(model) : (['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const);
  const idx = levels.indexOf(current);
  const nextIdx = idx < 0 ? 0 : (idx + 1) % levels.length;
  return levels[nextIdx] ?? 'off';
}

/** Minimal host interface for {@link changeThinkingLevel}. Both
 *  {@link SlashCommandHost} and {@link EditorKeyboardHost} satisfy it. */
export interface ThinkingLevelHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: ScreamHarness;
  setAppState(patch: Partial<AppState>): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: string): void;
}

/** @public exported for reuse by the editor's empty-Tab thinking cycle. */
export async function changeThinkingLevel(host: ThinkingLevelHost, alias: string, level: ThinkingEffort): Promise<void> {
  if (isBusy(host.state.appState)) {
    host.showError('Cannot change thinking while streaming — press Esc or Ctrl-C first.');
    return;
  }
  const prevLevel = host.state.appState.thinkingLevel;
  const isActiveModel = alias === host.state.appState.model;
  const session = host.session;

  if (isActiveModel && level !== prevLevel) {
    try {
      // No active session: skip the runtime change entirely. The level is
      // persisted as the default below, so the next session starts with it -
      // picking a thinking level must never create a session behind the
      // user's back (the lingering transcript hides the closed session).
      if (session !== undefined) {
        await session.setThinking(level);
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Failed to set thinking: ${msg}`);
      return;
    }
    host.setAppState({ thinkingLevel: level });
  }

  let persisted = false;
  try {
    persisted = await persistThinkingDefault(host, alias, level);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to save thinking default: ${msg}`);
    return;
  }

  const status = isActiveModel && level !== prevLevel
    ? session === undefined
      ? persisted
        ? `No active session - thinking ${level} for ${alias} saved as default.`
        : `No active session - thinking ${level} was NOT saved (${alias} is not the default model, so its level applies only when a new session selects it).`
      : `Thinking set to ${level} for ${alias}.`
    : persisted
      ? `Saved thinking ${level} as default for ${alias}.`
      : `Thinking already ${level} for ${alias}.`;
  host.showStatus(status, host.state.theme.colors.success);
}

async function persistThinkingDefault(host: ThinkingLevelHost, alias: string, level: ThinkingEffort): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  const effectiveThinking = level !== 'off';
  const existingEffort = config.thinking?.effort;
  const newEffort = effectiveThinking ? level : existingEffort;
  // Only persist thinking default when the alias is already the default model.
  // Cycling thinking on a non-default model must NOT silently make it the
  // default — that's Enter's job. The active session's thinking is updated
  // separately via session.setThinking in changeThinkingLevel.
  const isDefaultModel = config.defaultModel === alias;
  if (!isDefaultModel) return false;
  const unchanged =
    config.defaultThinking === effectiveThinking && existingEffort === newEffort;
  if (unchanged) return false;
  await host.harness.setConfig({
    defaultThinking: effectiveThinking,
    thinking: { ...config.thinking, mode: effectiveThinking ? 'on' : 'off', effort: newEffort },
  });
  return true;
}

async function performModelSwitch(host: SlashCommandHost, alias: string, thinkingLevel: ThinkingEffort): Promise<void> {
  if (isBusy(host.state.appState)) {
    host.showError('Cannot switch models while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const prevModel = host.state.appState.model;
  const prevThinkingLevel = host.state.appState.thinkingLevel;
  const modelChanged = alias !== prevModel;
  const thinkingChanged = thinkingLevel !== prevThinkingLevel;
  const session = host.session;

  // Storm Breaker guard: refuse to switch to a model whose context window is
  // smaller than the session's current token count. Switching would either
  // truncate the context silently or force an immediate compaction the user
  // did not ask for. Block early with a friendly advisory so the user can
  // compact first or pick a larger-window model. Only meaningful with a LIVE
  // session - without one the stale contextTokens of the closed session must
  // not veto saving a default (a new session starts from zero anyway).
  const overflow = session !== undefined && alias !== prevModel
    ? contextOverflowForModel(host.state.appState, alias)
    : null;
  if (overflow !== null) {
    host.showNotice(
      'Storm Breaker（风暴守护者）',
      `无法切换到模型「${alias}」：当前会话上下文 ${formatTokenCount(overflow.currentTokens)} 已超出该模型上限 ${formatTokenCount(overflow.maxContextTokens)}。` +
        '建议先执行 /compact 压缩上下文，或选择上下文窗口更大的模型。',
    );
    return;
  }

  let effectiveAlias = alias;
  let effectiveThinking = thinkingLevel;
  try {
    if (session !== undefined) {
      if (modelChanged) {
        await session.setModel(alias);
      }
      if (thinkingChanged) {
        await session.setThinking(thinkingLevel);
      }
      // Confirm the actual model/thinking after switch - the provider may
      // override the requested alias (e.g. routing to a different variant).
      const confirmed = await session.getStatus().catch(() => null);
      if (confirmed?.model !== undefined) effectiveAlias = confirmed.model;
      if (confirmed?.thinkingLevel !== undefined) effectiveThinking = confirmed.thinkingLevel as ThinkingEffort;
    }
    // No active session: NEVER silently create one as a side effect of
    // picking a model. The transcript can linger on screen after the
    // session was closed (deleted / logged out), so "model switch" must
    // degrade to a default-config update plus a visible notice instead of
    // opening a fresh session behind the user's back.
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch model: ${msg}`);
    return;
  }

  host.setAppState({ model: effectiveAlias, thinkingLevel: effectiveThinking, providerBalance: null });
  // Refresh the balance badge for the newly selected provider (async; the
  // null above clears any stale balance from the previous provider).
  refreshProviderBalance(effectiveAlias, (patch) => host.setAppState(patch));

  let persisted = false;

  try {
    persisted = await persistModelSelection(host, alias, thinkingLevel);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(
      `${session === undefined ? 'Selected' : 'Switched to'} ${effectiveAlias}, but failed to save default: ${msg}`,
    );
    return;
  }

  // Warn about prompt-cache invalidation when switching models mid-conversation.
  const hasHistory = host.state.appState.contextTokens > 0;
  const cacheWarning = modelChanged && hasHistory
    ? ' Note: switching models invalidates the existing prompt cache - use /new to avoid extra token costs.'
    : '';

  const status: string = (() => {
    if (session === undefined && (modelChanged || thinkingChanged)) {
      return `No active session - ${effectiveAlias} (thinking ${effectiveThinking}) saved as default. It applies when you start a new session.`;
    }
    if (modelChanged) return `Switched to ${effectiveAlias} with thinking ${effectiveThinking}.${cacheWarning}`;
    if (thinkingChanged) return `Thinking set to ${effectiveThinking} for ${effectiveAlias}.`;
    if (persisted) return `Saved ${effectiveAlias} with thinking ${effectiveThinking} as default.`;
    return `Already using ${effectiveAlias} with thinking ${effectiveThinking}.`;
  })();
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
      ...(await loadTuiConfig()),
      theme,
      language: host.state.appState.language,
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
    case 'language': handleLanguageCommand(host); return;
    case 'permission': showPermissionPicker(host); return;
    case 'theme': showThemePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'usage': void showUsage(host); return;
  }
}
