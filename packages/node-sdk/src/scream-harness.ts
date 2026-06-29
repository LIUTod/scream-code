import {
  ensureConfigFile,
  ErrorCodes,
  ScreamError,
  getRootLogger,
  resolveConfigPath,
  resolveScreamHome,
  resolveLoggingConfig,
  type ExperimentalFlagMap,
} from '@scream-code/agent-core';
import { assertScreamHostIdentity } from '@scream-code/config';

import { ScreamAuthFacade } from '#/auth';
import { SDKRpcClient } from '#/rpc';
import { Session } from '#/session';
import type {
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  ForkSessionInput,
  GetConfigOptions,
  ScreamConfig,
  ScreamConfigPatch,
  ScreamHarnessOptions,
  ScreamHostIdentity,
  ListSessionsOptions,
  RenameSessionInput,
  ResumeSessionInput,
  SessionSummary,
} from '#/types';

export class ScreamHarness {
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: ScreamAuthFacade;

  private readonly identity: ScreamHostIdentity | undefined;
  private readonly uiMode: string;
  private readonly activeSessions = new Map<string, Session>();
  private readonly rpc: SDKRpcClient;

  constructor(options: ScreamHarnessOptions) {
    this.identity =
      options.identity === undefined ? undefined : assertScreamHostIdentity(options.identity);
    this.uiMode = options.uiMode ?? DEFAULT_SESSION_STARTED_UI_MODE;
    this.homeDir = resolveScreamHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.configureLogging();
    this.auth = new ScreamAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
    });
    this.rpc = new SDKRpcClient({
      homeDir: options.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      resolveOAuthTokenProvider: this.auth.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
    });
  }

  private configureLogging(): void {
    // Fresh configure completes synchronously on the first-time path; pre-init
    // noop covers any caller that races before this returns.
    void getRootLogger().configure(resolveLoggingConfig({ homeDir: this.homeDir }));
  }

  get sessions(): ReadonlyMap<string, Session> {
    return this.activeSessions;
  }

  get interactiveAgentId(): string {
    return this.rpc.interactiveAgentId;
  }

  set interactiveAgentId(agentId: string) {
    this.rpc.interactiveAgentId = agentId;
  }

  /**
   * Install a live getter that returns the TUI's per-profile model bindings.
   * Read at subagent spawn/resume time so mid-session `/model diy` changes take
   * effect without recreating the session.
   */
  setSubagentModelBindings(getter: (() => Record<string, string | undefined>) | undefined): void {
    this.rpc.core.setSubagentModelBindings(getter);
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    const { planMode, ...coreOptions } = options;
    const summary = await this.rpc.createSession(coreOptions);
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    if (planMode === true) {
      await session.setPlanMode(true);
    }
    return session;
  }

  async resumeSession(input: ResumeSessionInput): Promise<Session> {
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    if (active !== undefined) return active;

    const summary = await this.rpc.resumeSession({ id });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    return session;
  }

  async forkSession(input: ForkSessionInput): Promise<Session> {
    const summary = await this.rpc.forkSession({
      id: normalizeSessionId(input.id),
      forkId: input.forkId,
      title: input.title,
      metadata: input.metadata,
    });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.activeSessions.get(id);
  }

  async closeSession(id: string): Promise<void> {
    await this.activeSessions.get(id)?.close();
  }

  async deleteSession(id: string): Promise<void> {
    await this.rpc.deleteSession({ sessionId: id });
    this.activeSessions.delete(id);
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    await this.rpc.renameSession(input);
    this.activeSessions.get(input.id)?.emitMetaUpdated({ title: input.title });
  }

  async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const result = await this.rpc.exportSession({
      ...input,
      version: input.version ?? this.identity?.version,
    });
    return result;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    return this.rpc.listSessions(options);
  }

  async getConfig(options: GetConfigOptions = {}): Promise<ScreamConfig> {
    return this.rpc.getConfig(options);
  }

  /** Resolved enabled-state of every experimental flag (flag id → enabled). */
  async getExperimentalFlags(): Promise<ExperimentalFlagMap> {
    return this.rpc.getExperimentalFlags();
  }

  /** Validate host environment before starting the UI. */
  async preflight(): Promise<void> {
    await this.rpc.preflight();
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async setConfig(patch: ScreamConfigPatch): Promise<ScreamConfig> {
    return this.rpc.setConfig(patch);
  }

  async removeProvider(providerId: string): Promise<ScreamConfig> {
    return this.rpc.removeProvider(providerId);
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.activeSessions.values(), (session) => session.close()));
    try {
      await getRootLogger().flush();
    } catch {
      // never let logger flush block process exit
    }
  }

}

const DEFAULT_SESSION_STARTED_UI_MODE = 'shell';

function normalizeSessionId(value: string): string {
  if (typeof value !== 'string') {
    throw new ScreamError(ErrorCodes.SESSION_ID_REQUIRED, 'Session id is required.');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ScreamError(ErrorCodes.SESSION_ID_EMPTY, 'Session id cannot be empty.');
  }
  return normalized;
}
