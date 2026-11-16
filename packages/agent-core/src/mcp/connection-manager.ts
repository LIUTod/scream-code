import { ErrorCodes, ScreamError } from '#/errors';
import type { McpServerConfig } from '#/config/schema';
import { log as defaultLog } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { Tool, ToolAnnotations } from '@scream-code/ltod';

import { abortable } from '../utils/abort';
import { resolveServerCapabilities } from './capabilities';
import { HttpMcpClient } from './client-http';
import type { McpRootsProvider, UnexpectedCloseReason } from './client-shared';
import { StdioMcpClient } from './client-stdio';
import { AlreadyAuthorizedError, type McpOAuthService } from './oauth';
import { assertMcpInputSchema, type MCPClient } from './types';

export type { McpRootsProvider } from './client-shared';

export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';

/**
 * How long a UI-started browser authorization may take. Matches the model-side
 * synthetic tool (15 min): long enough for a password manager + SSO detour,
 * short enough that an abandoned flow releases its loopback listener.
 */
const UI_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Narrow an MCP `annotations` block to the four boolean hints we consume.
 * The block also carries display-only fields (`title`) and the values are
 * author-declared by the server, so anything non-boolean is dropped rather
 * than coerced.
 */
export function mapMcpAnnotations(raw: Record<string, unknown>): ToolAnnotations | undefined {
  const result: { -readonly [K in keyof ToolAnnotations]: boolean | undefined } = {};
  let kept = 0;
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    const value = raw[key];
    if (typeof value === 'boolean') {
      result[key] = value;
      kept += 1;
    }
  }
  // A block that only carried `title` / non-boolean hints narrows to nothing;
  // returning an empty object would let `annotations: {}` masquerade as
  // "the server declared something" for any future `in`/hasOwn check.
  return kept === 0 ? undefined : result;
}

export interface McpServerEntry {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly error?: string;
  /**
   * `serverInfo.version` the server reported in the initialize handshake.
   * Absent when the server reports none or the connection never completed;
   * `/mcp` shows it so `@latest` args can be told apart from the version that
   * actually resolved.
   */
  readonly serverVersion?: string;
  /**
   * Effective capabilities (explicit declaration > built-in fingerprints).
   * Resolved once per public view in {@link toPublicEntry} — the single
   * chokepoint every entry leaves the manager through.
   */
  readonly capabilities: readonly string[];
  /**
   * Effective tool-declaration policy: `'always'` declares every tool of the
   * server in each request; `'on-demand'` (the default) withholds the schemas
   * until the model enables specific tools via `DiscoverMcpTools`. Resolved
   * in {@link toPublicEntry} next to `capabilities`.
   */
  readonly exposure: 'always' | 'on-demand';
}

/**
 * Outcome of a UI-driven OAuth start ({@link McpConnectionManager.authenticate}).
 *
 * Exactly one field is meaningful: `authorizationUrl` when a browser flow
 * started, `alreadyAuthorized` when valid tokens were already on disk.
 */
export interface McpAuthenticateResult {
  readonly authorizationUrl?: string;
  readonly alreadyAuthorized: boolean;
}

interface InternalEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  attemptId: number;
  status: McpServerStatus;
  tools?: readonly Tool[];
  enabledNames?: ReadonlySet<string>;
  error?: string;
  client?: RuntimeMcpClient;
  /** `serverInfo.version` from the initialize handshake, when reported. */
  serverVersion?: string;
}

/** A browser authorization that has been started but not finished. */
interface PendingAuth {
  /** Resolves with the URL to open, or `''` when discovery failed. */
  ready: Promise<string>;
  cancel?: () => Promise<void>;
}

export type McpStatusListener = (entry: McpServerEntry) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

/**
 * Budget for one MCP tool call when `toolTimeoutMs` is not configured. The
 * value equals the SDK's own request timeout (its `DEFAULT_REQUEST_TIMEOUT_MSEC`,
 * measured at 60 000 ms against the installed SDK), so resolving it here makes
 * the budget explicit without changing behavior.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** Effective tool-call budget for a server: configured value or the default. */
export function resolveToolCallTimeoutMs(config: McpServerConfig): number {
  return config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
}

type RuntimeMcpClient = StdioMcpClient | HttpMcpClient;

export interface McpConnectionManagerOptions {
  readonly envLookup?: (name: string) => string | undefined;
  /**
   * Optional OAuth orchestrator. When provided, HTTP servers without a
   * static bearer token participate in the OAuth-via-synthetic-tool flow:
   *  - If `oauthService.hasTokens(name, url)` is true, the provider is
   *    attached to the transport so the SDK can refresh tokens on 401.
   *  - Connection failures that look like 401 / `UnauthorizedError` flip
   *    the entry into `needs-auth` instead of `failed`; `/mcp`
   *    drives the browser flow through the synthetic auth tool.
   */
  readonly oauthService?: McpOAuthService;
  /**
   * Workspace roots advertised to every server through the MCP `roots`
   * capability. Session injects `[cwd, tmpdir()]` so roots-aware servers can
   * write into the workspace (see {@link McpRootsProvider}); servers that
   * ignore roots behave exactly as before.
   */
  readonly rootsProvider?: McpRootsProvider;
  /**
   * Parent logger. Defaults to the global `log`; Session passes its own
   * `session.log` so MCP events land in the session log too.
   */
  readonly log?: Logger;
}

/**
 * Owns the lifecycle of every configured MCP server for a Session.
 *
 * Servers are connected in parallel; per-server failures are isolated so a
 * crashed or misconfigured entry never blocks Session startup. State
 * transitions are surfaced through {@link onStatusChange} so callers (the
 * Session) can react — registering tools onto the main agent, emitting
 * wire events, or updating the TUI.
 */
export class McpConnectionManager {
  private readonly entries = new Map<string, InternalEntry>();
  /** One in-flight browser authorization per server (see `authenticate`). */
  private readonly pendingAuth = new Map<string, PendingAuth>();
  private readonly listeners = new Set<McpStatusListener>();
  private initialLoad: Promise<void> = Promise.resolve();
  private initialLoadAttemptId = 0;
  private initialLoadStartedAt: number | undefined;
  private initialLoadFinishedAt: number | undefined;

  /**
   * OAuth orchestrator injected at construction time. Consumed by the
   * {@link ToolManager} `needs-auth` branch to build the synthetic
   * `authenticate` tool.
   */
  readonly oauthService: McpOAuthService | undefined;
  private readonly log: Logger;

  constructor(private readonly options: McpConnectionManagerOptions = {}) {
    this.oauthService = options.oauthService;
    this.log = options.log ?? defaultLog;
    // Last-resort cleanup: whatever way the host process dies (clean exit,
    // external SIGTERM/SIGKILL, closed terminal), stdio children must not
    // survive as zombie processes. `process.exit` runs handlers synchronously,
    // so this is the one path that still executes — `close()` is async and
    // cannot run here. Multiple managers register multiple handlers; each
    // kills only its own children and `killSync` is idempotent.
    process.on('exit', () => this.killAllSync());
  }

  /**
   * Returns the URL of an HTTP MCP server by name, or `undefined` for
   * unknown / non-HTTP / disabled entries. Used by the synthetic auth tool
   * to drive OAuth discovery against the right base URL.
   */
  getHttpServerUrl(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (entry.config.transport !== 'http') return undefined;
    return entry.config.url;
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): readonly McpServerEntry[] {
    return Array.from(this.entries.values(), toPublicEntry);
  }

  get(name: string): McpServerEntry | undefined {
    const entry = this.entries.get(name);
    return entry !== undefined ? toPublicEntry(entry) : undefined;
  }

  /**
   * Returns the MCP client, the discovered tools, and the allow-list of tool
   * names for a given connected server, or `undefined` if the server is not
   * currently connected. The allow-list combines the server's `enabledTools`
   * and `disabledTools` filters; callers should only register names in the
   * set.
   */
  resolved(
    name: string,
  ):
    | { client: MCPClient; tools: readonly Tool[]; enabledNames: ReadonlySet<string> }
    | undefined {
    const entry = this.entries.get(name);
    if (
      entry?.status !== 'connected' ||
      entry.tools === undefined ||
      entry.client === undefined
    ) {
      return undefined;
    }
    return {
      client: entry.client,
      tools: entry.tools,
      enabledNames: entry.enabledNames ?? new Set(entry.tools.map((t) => t.name)),
    };
  }

  connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const attemptId = ++this.initialLoadAttemptId;
    this.initialLoadStartedAt = Date.now();
    this.initialLoadFinishedAt = undefined;
    const initialLoad = this.connectAllNow(configs).finally(() => {
      if (this.initialLoadAttemptId === attemptId) {
        this.initialLoadFinishedAt = Date.now();
      }
    });
    this.initialLoad = initialLoad;
    return initialLoad;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (signal === undefined) return this.initialLoad;
    return abortable(this.initialLoad, signal);
  }

  initialLoadDurationMs(): number {
    if (this.initialLoadStartedAt === undefined) return 0;
    const endedAt = this.initialLoadFinishedAt ?? Date.now();
    return Math.max(0, endedAt - this.initialLoadStartedAt);
  }

  private async connectAllNow(configs: Record<string, McpServerConfig>): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const [name, config] of Object.entries(configs)) {
      const disabled = config.enabled === false;
      const entry: InternalEntry = {
        name,
        config,
        attemptId: 0,
        status: disabled ? 'disabled' : 'pending',
      };
      this.entries.set(name, entry);
      this.emit(entry);
      if (!disabled) {
        tasks.push(this.connectOne(entry, this.beginConnectAttempt(entry)));
      }
    }
    await Promise.allSettled(tasks);
  }

  async reconnect(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ScreamError(ErrorCodes.MCP_SERVER_NOT_FOUND, `Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new ScreamError(ErrorCodes.MCP_SERVER_DISABLED, `MCP server is disabled: ${name}`);
    }
    const attemptId = this.beginConnectAttempt(entry);
    await this.closeClient(entry);
    if (!this.isCurrent(entry, attemptId)) return;
    entry.status = 'pending';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.serverVersion = undefined;
    entry.error = undefined;
    this.emit(entry);
    await this.connectOne(entry, attemptId);
  }

  /** Runtime add and connect a new MCP server. Reconnects if already present. */
  async addServer(name: string, config: McpServerConfig): Promise<void> {
    const existing = this.entries.get(name);
    if (existing !== undefined) {
      // Update config and reconnect — the user may have changed args.
      (existing as { config: McpServerConfig }).config = config;
      await this.reconnect(name);
      return;
    }
    const entry: InternalEntry = {
      name,
      config,
      attemptId: 0,
      status: 'pending',
    };
    this.entries.set(name, entry);
    this.emit(entry);
    await this.connectOne(entry, this.beginConnectAttempt(entry));
  }

  /** Disconnect the client but keep the entry so it can be reconnected later. */
  async stopServer(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) return;
    // A pending browser flow would otherwise keep its loopback listener open and
    // write tokens for a server the user just stopped.
    await this.cancelPendingAuth(name);
    await this.closeClient(entry);
    entry.status = 'disabled';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.serverVersion = undefined;
    entry.error = undefined;
    this.emit(entry);
  }

  /** Runtime disconnect and remove an MCP server. No-op if not found. */
  async removeServer(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) return;
    await this.cancelPendingAuth(name);
    await this.closeClient(entry);
    this.entries.delete(name);
    // Emit a synthetic 'disabled' status so listeners (ToolManager) clean up
    // registered tools.
    const view = toPublicEntry(entry);
    view satisfies McpServerEntry;
    const disabledView: McpServerEntry = { ...view, status: 'disabled', error: undefined };
    for (const listener of this.listeners) {
      try { listener(disabledView); } catch { /* noop */ }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.pendingAuth.keys()].map((name) => this.cancelPendingAuth(name)));
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    const tasks = entries.map((entry) => this.closeClient(entry));
    await Promise.allSettled(tasks);
  }

  /**
   * Start an OAuth flow for one HTTP server on behalf of the **UI**.
   *
   * The model already had a path (the synthetic `…__authenticate` tool), but
   * `/mcp` did not, so a `needs-auth` row was a dead end unless the user
   * happened to ask the agent about it.
   *
   * Returns as soon as there is a URL to open: the callback waits for a human
   * (up to the flow timeout), and holding the caller open for minutes would
   * block the TUI's request queue. Completion is reported the normal way —
   * a reconnect on success, {@link reportAuthFailure} when the browser step
   * fails — so `/mcp` and the transcript both refresh from the status event.
   */
  async authenticate(name: string): Promise<McpAuthenticateResult> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ScreamError(ErrorCodes.MCP_SERVER_NOT_FOUND, `Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new ScreamError(
        ErrorCodes.MCP_SERVER_DISABLED,
        `"${name}" is disabled in mcp.json — enable it before authenticating`,
      );
    }
    const oauthService = this.oauthService;
    if (oauthService === undefined) {
      throw new ScreamError(ErrorCodes.MCP_AUTH_UNSUPPORTED, 'OAuth is not configured for this session');
    }
    // One flow per server. `beginAuthorization` resets the provider's pending
    // flow and starts a fresh loopback listener, so a second concurrent call
    // would orphan the first URL the user may already have open — and the first
    // flow's late failure would then clobber the second one's state.
    //
    // The slot is registered *before* awaiting discovery: two calls in the same
    // tick must not both start a flow.
    const existing = this.pendingAuth.get(name);
    if (existing !== undefined) {
      const url = await existing.ready;
      if (url.length > 0) return { authorizationUrl: url, alreadyAuthorized: false };
      // Discovery failed while we waited and the slot is already gone; the retry
      // either starts a fresh flow or surfaces the real error.
      return this.authenticate(name);
    }
    const { config } = entry;
    if (config.transport !== 'http') {
      throw new ScreamError(
        ErrorCodes.MCP_AUTH_UNSUPPORTED,
        `"${name}" is a stdio server: it authenticates through its own command or env, not OAuth`,
      );
    }

    let resolveReady: (url: string) => void = () => undefined;
    const slot: PendingAuth = {
      ready: new Promise<string>((resolve) => {
        resolveReady = resolve;
      }),
    };
    this.pendingAuth.set(name, slot);

    let flow: Awaited<ReturnType<McpOAuthService['beginAuthorization']>>;
    try {
      flow = await oauthService.beginAuthorization(name, config.url);
    } catch (error) {
      if (this.pendingAuth.get(name) === slot) this.pendingAuth.delete(name);
      resolveReady('');
      if (error instanceof AlreadyAuthorizedError) {
        // Tokens are valid; the 401 was something else (or stale). A reconnect
        // is the whole action, and the caller shows "reconnected".
        await this.reconnect(name);
        return { alreadyAuthorized: true };
      }
      throw error;
    }

    const authorizationUrl = flow.authorizationUrl.toString();
    // The generation this flow belongs to: a reconnect or an explicit stop bumps
    // `attemptId`, which makes a late async failure from this flow stale.
    const attemptId = entry.attemptId;
    slot.cancel = () => flow.cancel();
    resolveReady(authorizationUrl);

    // Release only our own slot: a stop/remove cancels this flow and a fresh
    // `authenticate` may have registered a new slot before this flow's
    // settlement arrives — deleting by name would orphan that newer flow.
    const releaseSlot = (): void => {
      if (this.pendingAuth.get(name) === slot) this.pendingAuth.delete(name);
    };
    void flow.complete({ timeoutMs: UI_AUTH_TIMEOUT_MS }).then(
      () => {
        releaseSlot();
        void this.reconnect(name).catch((error: unknown) => {
          this.reportAuthFailure(name, error, attemptId);
        });
      },
      (error: unknown) => {
        releaseSlot();
        this.reportAuthFailure(name, error, attemptId);
      },
    );
    return { authorizationUrl, alreadyAuthorized: false };
  }

  /**
   * Record a background auth failure (callback timeout, user denial) so the
   * entry keeps saying "needs auth" *with a reason* instead of silently
   * returning to its previous error.
   */
  reportAuthFailure(name: string, error: unknown, attemptId?: number): void {
    const entry = this.entries.get(name);
    if (entry === undefined) return;
    // A flow that lost its generation is stale: the server reconnected (or was
    // stopped / disabled) while the browser step was still pending, and an
    // "authorization failed" event would overwrite the newer truth.
    if (attemptId !== undefined && !this.isCurrent(entry, attemptId)) return;
    if (entry.status === 'connected' || entry.status === 'disabled') return;
    entry.status = 'needs-auth';
    entry.error = error instanceof Error ? error.message : String(error);
    this.emit(entry);
  }

  private async connectOne(entry: InternalEntry, attemptId: number): Promise<void> {
    const timeoutMs = entry.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    let client: RuntimeMcpClient | undefined;
    try {
      const startupClient = this.createClient(entry.config, entry.name);
      client = startupClient;
      entry.client = startupClient;
      const tools = await withTimeout(
        this.connectAndDiscoverTools(startupClient),
        timeoutMs,
        () => {
          // Best-effort cleanup if the startup promise is still racing.
          void this.closeRuntimeClient(startupClient);
        },
      );
      if (!this.isCurrent(entry, attemptId)) {
        await this.closeRuntimeClient(startupClient);
        return;
      }
      entry.tools = tools;
      entry.enabledNames = computeEnabledNames(entry.config, tools);
      entry.serverVersion = startupClient.getServerVersion?.()?.version;
      entry.status = 'connected';
      this.watchForUnexpectedClose(entry, startupClient, attemptId);
    } catch (error) {
      if (!this.isCurrent(entry, attemptId)) {
        if (client !== undefined) {
          await this.closeRuntimeClient(client);
        }
        return;
      }
      if (this.shouldMarkNeedsAuth(entry, error)) {
        entry.status = 'needs-auth';
        entry.error = `${entry.name} needs OAuth authorization — open /mcp and press a to sign in`;
      } else {
        entry.status = 'failed';
        entry.error = formatStartupError(error, client);
      }
      entry.tools = undefined;
      entry.enabledNames = undefined;
      entry.serverVersion = undefined;
      // Drop the client reference so a later reconnect builds a fresh one.
      await this.closeClient(entry);
    }
    if (!this.isCurrent(entry, attemptId)) return;
    this.emit(entry);
  }

  private watchForUnexpectedClose(
    entry: InternalEntry,
    client: RuntimeMcpClient,
    attemptId: number,
  ): void {
    client.onUnexpectedClose((reason) => {
      // The client may have outlived its entry (shutdown / reconnect already
      // moved on). Drop the event if so — the new attempt owns the state.
      if (!this.isCurrent(entry, attemptId)) return;
      if (entry.client !== client) return;
      entry.status = 'failed';
      entry.error = formatUnexpectedCloseError(entry.name, reason);
      entry.tools = undefined;
      entry.enabledNames = undefined;
      entry.serverVersion = undefined;
      entry.client = undefined;
      // Best-effort close; the transport is already gone, but this lets the
      // SDK release timers and pending request handlers.
      void this.closeRuntimeClient(client);
      this.emit(entry);
    });
  }

  private beginConnectAttempt(entry: InternalEntry): number {
    entry.attemptId += 1;
    return entry.attemptId;
  }

  private createClient(config: McpServerConfig, name: string): RuntimeMcpClient {
    const toolCallTimeoutMs = resolveToolCallTimeoutMs(config);
    if (config.transport === 'stdio') {
      return new StdioMcpClient(config, {
        toolCallTimeoutMs,
        rootsProvider: this.options.rootsProvider,
      });
    }
    return new HttpMcpClient(config, {
      toolCallTimeoutMs,
      rootsProvider: this.options.rootsProvider,
      envLookup: this.options.envLookup,
      oauthProvider: this.resolveOAuthProvider(config, name),
    });
  }

  private resolveOAuthProvider(
    config: McpServerConfig,
    name: string,
  ): ReturnType<McpOAuthService['getProvider']> | undefined {
    const oauthService = this.oauthService;
    if (oauthService === undefined) return undefined;
    if (config.transport !== 'http') return undefined;
    if (config.bearerTokenEnvVar !== undefined) return undefined;
    // Only attach the provider once tokens have been minted; before that,
    // the transport should propagate a clean 401 so we can flip the entry
    // into `needs-auth` rather than getting tangled in the SDK's auth()
    // flow (which would try DCR before we have an active redirect URL).
    if (!oauthService.hasTokens(name, config.url)) return undefined;
    return oauthService.getProvider(name, config.url);
  }

  private shouldMarkNeedsAuth(entry: InternalEntry, error: unknown): boolean {
    if (this.oauthService === undefined) return false;
    if (entry.config.transport !== 'http') return false;
    if (entry.config.bearerTokenEnvVar !== undefined) return false;
    // If the user pinned a static `headers` block, treat 401s as a bad header
    // rather than hijacking them into the OAuth flow — the real error is more
    // actionable than "/mcp" for a server that doesn't speak
    // OAuth.
    if (entry.config.headers !== undefined) return false;
    return isUnauthorizedLikeError(error);
  }

  private async connectAndDiscoverTools(client: RuntimeMcpClient): Promise<Tool[]> {
    await client.connect();
    const mcpTools = await client.listTools();
    return mcpTools.map((mcpTool) => {
      const annotationHints =
        mcpTool.annotations === undefined ? undefined : mapMcpAnnotations(mcpTool.annotations);
      return {
        name: mcpTool.name,
        description: mcpTool.description,
        parameters: assertMcpInputSchema(mcpTool.name, mcpTool.inputSchema),
        // Pass the server's native annotations through as author-declared
        // hints: ask mode approves read-only declarations, `destructiveHint`
        // forces an approval everywhere else. Attached only when a boolean
        // hint survived narrowing.
        ...(annotationHints === undefined ? {} : { annotations: annotationHints }),
      };
    });
  }

  private async closeClient(entry: InternalEntry): Promise<void> {
    if (entry.client === undefined) return;
    const client = entry.client;
    entry.client = undefined;
    await this.closeRuntimeClient(client);
  }

  private async closeRuntimeClient(client: RuntimeMcpClient): Promise<void> {
    try {
      await client.close();
    } catch {
      // Suppress close errors — the server is going away regardless and we
      // don't want them masking the original startup failure.
    }
  }

  /**
   * Synchronously signal every still-running stdio child process. Registered
   * as a `process.on('exit')` fallback so MCP children never survive the host
   * — whether the app exits cleanly, is killed, or the terminal is closed.
   * `close()` (async) remains the graceful path; this only runs when the
   * event loop is already unwinding.
   */
  killAllSync(): void {
    for (const entry of this.entries.values()) {
      const client = entry.client;
      if (client instanceof StdioMcpClient) {
        client.killSync();
      }
    }
  }

  /** Tear down a pending browser flow (listener + provider state) if any. */
  private async cancelPendingAuth(name: string): Promise<void> {
    const pending = this.pendingAuth.get(name);
    if (pending === undefined) return;
    this.pendingAuth.delete(name);
    try {
      await pending.cancel?.();
    } catch {
      // Cancelling is best-effort: the flow may already have finished.
    }
  }

  private isCurrent(entry: InternalEntry, attemptId: number): boolean {
    return this.entries.get(entry.name) === entry && entry.attemptId === attemptId;
  }

  private emit(entry: InternalEntry): void {
    const view = toPublicEntry(entry);
    if (view.status === 'failed' || view.status === 'needs-auth') {
      this.log.error('mcp server unavailable', {
        server: view.name,
        transport: view.transport,
        status: view.status,
        reason: view.error,
      });
    }
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // Listener faults must not break the connection manager.
      }
    }
  }
}

function toPublicEntry(entry: InternalEntry): McpServerEntry {
  return {
    name: entry.name,
    transport: entry.config.transport,
    status: entry.status,
    toolCount:
      entry.status === 'connected' && entry.enabledNames !== undefined
        ? entry.enabledNames.size
        : 0,
    error: entry.error,
    ...(entry.serverVersion === undefined ? {} : { serverVersion: entry.serverVersion }),
    capabilities: resolveServerCapabilities(entry.name, entry.config),
    exposure: entry.config.exposure ?? 'on-demand',
  };
}

function computeEnabledNames(config: McpServerConfig, tools: readonly Tool[]): Set<string> {
  const all = tools.map((t) => t.name);
  const enabledFilter =
    config.enabledTools !== undefined ? new Set(config.enabledTools) : undefined;
  const disabledFilter =
    config.disabledTools !== undefined ? new Set(config.disabledTools) : undefined;
  const allowed = new Set<string>();
  for (const name of all) {
    if (enabledFilter !== undefined && !enabledFilter.has(name)) continue;
    if (disabledFilter !== undefined && disabledFilter.has(name)) continue;
    allowed.add(name);
  }
  return allowed;
}

function isUnauthorizedLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'UnauthorizedError') return true;
  // SDK transport errors typically expose the HTTP status as `.code`.
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && code === 401) return true;
  if (typeof code === 'string' && code === '401') return true;
  // Fall back to a message sniff so server-specific error shapes still flip
  // us into needs-auth instead of failed.
  return /\b401\b/.test(error.message) || /unauthorized/i.test(error.message);
}

function formatStartupError(error: unknown, client: RuntimeMcpClient | undefined): string {
  const base = error instanceof Error ? error.message : String(error);
  const tail = stderrTail(client);
  if (tail === undefined) return base;
  return `${base}\nstderr: ${tail}`;
}

function formatUnexpectedCloseError(name: string, reason: UnexpectedCloseReason): string {
  const parts = [`MCP server "${name}" closed unexpectedly`];
  if (reason.error !== undefined) {
    parts.push(reason.error.message);
  }
  if (reason.stderr !== undefined && reason.stderr.length > 0) {
    parts.push(`stderr: ${reason.stderr.trimEnd()}`);
  }
  return parts.join('\n');
}

function stderrTail(client: RuntimeMcpClient | undefined): string | undefined {
  if (client === undefined) return undefined;
  if (!(client instanceof StdioMcpClient)) return undefined;
  const snapshot = client.stderrSnapshot();
  if (snapshot.length === 0) return undefined;
  return snapshot.trimEnd();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
