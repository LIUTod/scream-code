import type { ScreamHarness, Session, ThinkingEffort } from '@scream-code/scream-code-sdk';
import type { ScreamConfig } from '@scream-code/agent-core';
import type { SkillListSession } from '../commands';

import type { SessionEventHandler } from './session-event-handler';
import type { AppState, ScreamTUIOptions } from '../types';
import type { TUIState } from '../tui-state';

export interface AuthFlowHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: ScreamHarness;
  readonly options: ScreamTUIOptions;

  setAppState(patch: Partial<AppState>): void;
  setStartupReady(): void;
  resetSessionRuntime(): void;
  setSession(session: Session): Promise<void>;
  syncRuntimeState(session?: Session): Promise<void>;
  closeSession(reason: string): Promise<void>;
  appendStartupNotice(extra: string): void;
  readonly sessionEventHandler: SessionEventHandler;
  fetchSessions(): Promise<void>;
  refreshSessionTitle(): void;
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
}

export class AuthFlowController {
  constructor(private readonly host: AuthFlowHost) {}

  async refreshAvailableModels(): Promise<void> {
    const config = await this.host.harness.getConfig({ reload: true });
    this.host.setAppState({
      availableModels: config.models ?? {},
      availableProviders: config.providers ?? {},
    });
  }

  async activateModelAfterLogin(model: string, thinkingLevel?: ThinkingEffort): Promise<void> {
    const { host } = this;
    const level = thinkingLevel === undefined ? undefined : thinkingLevel === 'off' ? 'off' : thinkingLevel;
    if (host.session !== undefined) {
      await host.session.setModel(model);
      if (level !== undefined) {
        await host.session.setThinking(level);
      }
      return;
    }

    const session = await host.harness.createSession({
      workDir: host.state.appState.workDir,
      model,
      thinking: level,
      permission: host.options.startup.auto
        ? 'auto'
        : host.options.startup.yolo
          ? 'yolo'
          : undefined,
      planMode: host.state.appState.planMode !== 'off' ? true : undefined,
    });
    await host.setSession(session);
    host.setAppState({
      sessionId: session.id,
      sessionTitle: session.summary?.title ?? null,
    });
    await host.syncRuntimeState(session);
    host.sessionEventHandler.startSubscription();
    void host.fetchSessions();
    host.refreshSessionTitle();
    void host.refreshSkillCommands(host.session);
  }

  async clearActiveSessionAfterLogout(): Promise<void> {
    await this.host.closeSession('logged out');
    this.host.resetSessionRuntime();
    this.host.setAppState({
      sessionId: '',
      model: '',
      sessionTitle: null,
    });
    await this.host.refreshSkillCommands();
  }

  async refreshConfigAfterLogin(): Promise<void> {
    const { host } = this;
    const config = await host.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};
    const defaultModel = host.options.startup.model ?? config.defaultModel;
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;

    if (defaultModel === undefined || selected === undefined) {
      host.setAppState({ availableModels, availableProviders });
      return;
    }

    await this.activateModelAfterLogin(defaultModel, resolveDefaultThinkingLevel(config));
    const appStatePatch: Partial<AppState> = {
      availableModels,
      availableProviders,
      model: defaultModel,
      maxContextTokens: selected.maxContextSize,
      thinkingLevel: resolveDefaultThinkingLevel(config),
    };
    host.setAppState(appStatePatch);
  }

  async refreshConfigAfterLogout(): Promise<void> {
    const config = await this.host.harness.getConfig({ reload: true });
    this.host.setAppState({
      availableModels: config.models ?? {},
      availableProviders: config.providers ?? {},
      model: '',
      thinkingLevel: 'off',
      maxContextTokens: 0,
      contextUsage: 0,
      contextTokens: 0,
    });
  }
}

function resolveDefaultThinkingLevel(config: ScreamConfig): ThinkingEffort {
  if (config.thinking?.mode === 'off' || config.defaultThinking === false) return 'off';
  const effort = config.thinking?.effort;
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') {
    return effort;
  }
  return config.defaultThinking === true ? 'medium' : 'off';
}
