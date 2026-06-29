import type { Component, Focusable } from '@earendil-works/pi-tui';

import type { ScreamHarness, Session } from '@scream-code/scream-code-sdk';

import type { Theme } from '../theme';
import type { ResolvedTheme } from '../theme/colors';
import {
  LLM_NOT_SET_MESSAGE,
} from '../constant/scream-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { parseSlashInput } from './parse';
import {
  resolveSlashCommandInput,
  slashBusyMessage,
} from './resolve';
import type { BuiltinSlashCommandName } from './registry';
import type { AuthFlowController } from '../controllers/auth-flow';
import type { StreamingUIController } from '../controllers/streaming-ui';
import type { TasksBrowserController } from '../controllers/tasks-browser';
import type { AppState, LoginProgressSpinnerHandle, PlanModeState, QueuedMessage } from '../types';
import type { TUIState } from '../tui-state';

import { handleConnectCommand, handleLogoutCommand } from './auth';
import {
  handleAutoCommand,
  handleCompactCommand,
  handleEditorCommand,
  handleFusionPlanCommand,
  handleModelCommand,
  handlePlanCommand,
  handleWolfpackCommand,
  handleThemeCommand,
  handleYoloCommand,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
import { showMcpServers, showStatusReport, showUsage } from './info';
import {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
import { handleGoalCommand } from './goal';
import { handleRevokeCommand } from './revoke';
import { handleCcCommand } from './cc';
import { handleUpdateCommand } from './update';
import { handleMcpCommand } from './mcp';
import { handleChannelCommand } from './cc-connect';
import { handleMemoryCommand } from './memory';
import { handleMakeSkillCommand } from './make-skill';
import { handleSkillCommand } from './skill-center';
import { handleBtwCommand } from './btw';
import { handleLoopCommand } from './loop';
import { handleLikeCommand } from './like';

// ---------------------------------------------------------------------------
// Re-exports — keep existing consumers working
// ---------------------------------------------------------------------------

export {
  handleConnectCommand,
  handleLogoutCommand,
} from './auth';
export {
  handleAutoCommand,
  handleCompactCommand,
  handleEditorCommand,
  handleFusionPlanCommand,
  handleModelCommand,
  handlePlanCommand,
  handleWolfpackCommand,
  handleThemeCommand,
  handleYoloCommand,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
export {
  showMcpServers,
  showStatusReport,
  showUsage,
} from './info';
export {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
export { handleLoopCommand, disableLoopMode, describeLoopStatus } from './loop';
export { handleRevokeCommand } from './revoke';
export { handleCcCommand } from './cc';
export { handleUpdateCommand } from './update';
export { handleMcpCommand } from './mcp';
export { handleChannelCommand } from './cc-connect';
export { handleMemoryCommand } from './memory';
export { handleSkillCommand } from './skill-center';
// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

export interface SlashCommandHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: ScreamHarness;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages: boolean;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: string): void;
  showNotice(title: string, detail?: string): void;
  setPlanModeBanner(mode: PlanModeState, planPath?: string): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;

  // Session
  requireSession(): Session;
  switchToSession(session: Session, message: string): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;

  // UI
  showProgressSpinner(label: string): LoginProgressSpinnerHandle;

  // Theme
  applyTheme(theme: Theme, resolved?: ResolvedTheme): void;
  refreshTerminalThemeTracking(): void;

  // Dispatch
  stop(exitCode?: number): Promise<void>;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(): Promise<void>;
  showMemoryPicker(): void;
  sendNormalUserInput(text: string): void;
  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void;
  readonly skillCommandMap: Map<string, string>;

  /** Trigger an immediate cc-connect liveness poll (bypasses the 30 s interval). */
  refreshCcStatus(): void;

  // Controller refs
  readonly streamingUI: StreamingUIController;
  readonly tasksBrowserController: TasksBrowserController;
  readonly authFlow: AuthFlowController;
}

// ---------------------------------------------------------------------------
// Dispatch — entry point from handleUserInput
// ---------------------------------------------------------------------------

export function dispatchInput(host: SlashCommandHost, text: string): void {
  if (parseSlashInput(text) !== null) {
    void executeSlashCommand(host, text);
    return;
  }
  host.sendNormalUserInput(text);
}

async function executeSlashCommand(host: SlashCommandHost, input: string): Promise<void> {
  const parsedCommand = parseSlashInput(input);
  const intent = resolveSlashCommandInput({
    input,
    skillCommandMap: host.skillCommandMap,
    isStreaming: host.state.appState.streamingPhase !== 'idle',
    isCompacting: host.state.appState.isCompacting,
  });

  switch (intent.kind) {
    case 'not-command':
      return;
    case 'blocked':
      host.showError(slashBusyMessage(intent.commandName, intent.reason));
      return;
    case 'skill': {
      const session = host.session;
      if (host.state.appState.model.trim().length === 0 || session === undefined) {
        host.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      host.sendSkillActivation(session, intent.skillName, intent.args);
      return;
    }
    case 'message':
      host.sendNormalUserInput(intent.input);
      return;
    case 'builtin':
      try {
        const args = intent.name === 'goal' && parsedCommand?.name === 'goaloff' ? 'off' : intent.args;
        await handleBuiltInSlashCommand(host, intent.name, args);
      } catch (error) {
        host.showError(formatErrorMessage(error));
      }
      return;
  }
}

async function handleBuiltInSlashCommand(
  host: SlashCommandHost,
  name: BuiltinSlashCommandName,
  args: string,
): Promise<void> {
  switch (name) {
    case 'exit':
      host.stop().catch(() => {
        // stop() kills the process; if it fails, force-exit to avoid a hung TUI.
        process.exit(1);
      });
      return;
    case 'help':
      host.showHelpPanel();
      return;
    case 'version':
      host.showStatus(`Scream Code v${host.state.appState.version}`);
      return;
    case 'new':
      await host.createNewSession();
      host.state.ui.requestRender();
      return;
    case 'sessions':
      host.showSessionPicker().catch((error: unknown) => {
        host.showError(`打开会话选择器失败：${formatErrorMessage(error)}`);
      });
      return;
    case 'tasks':
      host.tasksBrowserController.show().catch((error: unknown) => {
        host.showError(`打开任务浏览器失败：${formatErrorMessage(error)}`);
      });
      return;
    case 'btw':
      await handleBtwCommand(host, args);
      return;
    case 'mcp':
      await handleMcpCommand(host, args);
      return;
    case 'editor':
      await handleEditorCommand(host, args);
      return;
    case 'theme':
      await handleThemeCommand(host, args);
      return;
    case 'model':
      handleModelCommand(host, args);
      return;
    case 'permission':
      showPermissionPicker(host);
      return;
    case 'settings':
      showSettingsSelector(host);
      return;
    case 'like':
      await handleLikeCommand(host);
      return;
    case 'usage':
      showUsage(host).catch((error: unknown) => {
        host.showError(`显示使用情况失败：${formatErrorMessage(error)}`);
      });
      return;
    case 'status':
      showStatusReport(host).catch((error: unknown) => {
        host.showError(`显示状态报告失败：${formatErrorMessage(error)}`);
      });
      return;
    case 'title':
      await handleTitleCommand(host, args);
      return;
    case 'yes':
      await handleYoloCommand(host, args);
      return;
    case 'auto':
      await handleAutoCommand(host, args);
      return;
    case 'plan':
      await handlePlanCommand(host, args);
      return;
    case 'fusionplan':
      await handleFusionPlanCommand(host, args);
      return;
    case 'wolfpack':
      await handleWolfpackCommand(host, args);
      return;
    case 'loop':
      await handleLoopCommand(host, args);
      return;
    case 'revoke':
      await handleRevokeCommand(host, args);
      return;
    case 'goal':
      await handleGoalCommand(host, args);
      return;
    case 'update':
      await handleUpdateCommand(host);
      return;
    case 'cc':
      await handleCcCommand(host);
      return;
    case 'cc-connect':
      await handleChannelCommand(host, args);
      return;
    case 'compact':
      await handleCompactCommand(host, args);
      return;
    case 'init':
      await handleInitCommand(host);
      return;
    case 'fork':
      await handleForkCommand(host, args);
      return;
    case 'export-md':
      await handleExportMdCommand(host, args);
      return;
    case 'export-debug-zip':
      await handleExportDebugZipCommand(host);
      return;
    case 'config':
      await handleConnectCommand(host, args);
      return;
    case 'logout':
      await handleLogoutCommand(host);
      return;
    case 'memory':
      await handleMemoryCommand(host, args);
      return;
    case 'make-skill':
      await handleMakeSkillCommand(host, args);
      return;
    case 'skill':
      await handleSkillCommand(host, args);
      return;
    default:
      host.showError(`Unknown slash command: /${String(name)}`);
      return;
  }
}
