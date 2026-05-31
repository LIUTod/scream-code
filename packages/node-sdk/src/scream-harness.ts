import {
  ensureConfigFile,
  ErrorCodes,
  ScreamError,
  getRootLogger,
  noopTelemetryClient,
  resolveConfigPath,
  resolveScreamHome,
  resolveLoggingConfig,
  withTelemetryContext,
  type ExperimentalFlagMap,
  type TelemetryClient,
  type TelemetryContextPatch,
  type TelemetryProperties,
} from '@scream-cli/agent-core';
import { assertScreamHostIdentity } from '@scream-cli/scream-code-oauth';

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
  private readonly telemetry: TelemetryClient;
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
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new ScreamAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });
    this.rpc = new SDKRpcClient({
      homeDir: options.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      resolveOAuthTokenProvider: this.auth.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
      telemetry: this.telemetry,
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

  track(event: string, properties?: TelemetryProperties): void {
    this.telemetry.track(event, properties);
  }

  setTelemetryContext(patch: TelemetryContextPatch): void {
    this.telemetry.setContext?.(patch);
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
    this.trackSessionStarted(summary.id, false);
    this.trackSessionEvent(session.id, 'session_new');
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
    this.trackSessionStarted(summary.id, true);
    this.trackSessionEvent(session.id, 'session_resume');
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
    this.trackSessionStarted(summary.id, true);
    this.trackSessionEvent(session.id, 'session_fork');
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
    this.trackSessionEvent(input.id, 'export');
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

  private trackSessionEvent(eventSessionId: string, event: string): void {
    withTelemetryContext(this.telemetry, { sessionId: eventSessionId }).track(event);
  }

  private trackSessionStarted(eventSessionId: string, resumed: boolean): void {
    withTelemetryContext(this.telemetry, { sessionId: eventSessionId }).track('session_started', {
      client_name: this.identity?.userAgentProduct ?? null,
      client_version: this.identity?.version ?? null,
      ui_mode: this.uiMode,
      resumed,
    });
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
