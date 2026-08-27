import type { McpServerConfig } from '../config/schema';
import type { HookDef } from '../session/hooks/types';

export type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly message: string;
}

export interface PluginAuthor {
  readonly name?: string;
  readonly email?: string;
}

export interface PluginSessionStart {
  readonly skill: string;
}

export interface PluginInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly websiteURL?: string;
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly license?: string;
  readonly skills?: readonly string[]; // resolved absolute paths
  readonly sessionStart?: PluginSessionStart;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly interface?: PluginInterface;
  readonly skillInstructions?: string;
  /**
   * Absolute path to the plugin's JS entry point (bootstrap). When present the
   * plugin is a "code plugin": its module exports `activate(context)` (and
   * optionally `deactivate()`). Lazily activated via the ExtensionRuntime.
   */
  readonly entryPoint?: string;
  /**
   * Shell hooks this plugin declares (the existing external-command HookEngine
   * channel). Injected into the agent's HookEngine on activate and removed on
   * deactivate. Same shape as the session-level `HookDef`.
   */
  readonly hooks?: readonly HookDef[];
  /**
   * Default plugin configuration (plain data). Reserved as the future home of
   * a typed `configSchema` when plugins gain a code entry point — the declared
   * contract mirrors `Config` in code-plugin harnesses so a future adapter can
   * map configs losslessly. Optional; absent = plugin runs with no config.
   */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface PluginMcpServerState {
  readonly enabled: boolean;
}

export interface PluginCapabilityState {
  readonly mcpServers?: Readonly<Record<string, PluginMcpServerState>>;
}

export interface PluginMcpServerInfo {
  readonly name: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export type PluginManifestKind = 'scream-plugin-root' | 'scream-plugin-dir' | 'claude-plugin-dir' | 'bare-skill';
export type PluginSource = 'local-path' | 'zip-url' | 'github';
export type PluginState = 'ok' | 'error';

export interface PluginGithubRef {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export interface PluginGithubMetadata {
  readonly owner: string;
  readonly repo: string;
  readonly ref: PluginGithubRef;
  readonly installedSha?: string;
}

export interface PluginRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly originalSource?: string;
  readonly capabilities?: PluginCapabilityState;
  readonly github?: PluginGithubMetadata;
  readonly skillInstructions?: string;
  readonly skills: readonly PluginSkillSummary[];
  readonly skillCount: number;
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface PluginSkillSummary {
  readonly name: string;
  readonly description: string;
}

export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly skillCount: number;
  readonly skills: readonly PluginSkillSummary[];
  readonly mcpServerCount: number;
  readonly enabledMcpServerCount: number;
  readonly hasErrors: boolean;
  readonly source: PluginSource;
  readonly originalSource?: string;
  readonly github?: PluginGithubMetadata;
}

export interface PluginInfo extends PluginSummary {
  readonly root: string;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly manifest?: PluginManifest;
  readonly mcpServers: readonly PluginMcpServerInfo[];
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface EnabledPluginSessionStart {
  readonly pluginId: string;
  readonly skillName: string;
}

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

export const PLUGIN_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Consecutive failed plugin-owned tool calls (or faulty event-handler hits)
 * that trip the circuit and take the plugin out of service for the session.
 * A single success clears the streak; recovery is explicit (`ManagePlugin
 * reset`), never automatic.
 */
export const PLUGIN_CIRCUIT_TRIP_THRESHOLD = 3;

export function normalizePluginId(name: string): string {
  return name.toLowerCase();
}

/**
 * One sub-action of the hot-apply pass. `plugin.deactivate` and `tools.remove`
 * exist because tearing a plugin out of a running process is more than a data
 * change: its code has to be unwound and its in-process tools dropped.
 */
export type PluginSyncStep =
  | 'mcp.add'
  | 'mcp.remove'
  | 'skills.inject'
  | 'skills.eject'
  | 'tools.remove'
  | 'plugin.deactivate';

/** One change the hot-apply pass actually made to one live session. */
export interface PluginSyncApplied {
  readonly kind: PluginSyncStep;
  readonly name?: string;
  readonly session: string;
}

/**
 * One sub-action that failed. A failure is always contained: the plugin
 * mutation that triggered it already succeeded, so the sync is reported, never
 * rethrown.
 */
export interface PluginSyncFailure {
  readonly step: PluginSyncStep;
  readonly pluginId?: string;
  readonly message: string;
}

/** Outcome of pushing a plugin change into every live session. */
export interface PluginSyncReport {
  readonly ok: boolean;
  readonly sessions: number;
  readonly applied: readonly PluginSyncApplied[];
  readonly failed: readonly PluginSyncFailure[];
}

/** The report field as surfaced by tools: `ok` plus what changed and what broke. */
export interface PluginSyncSummary {
  readonly ok: boolean;
  readonly applied: readonly PluginSyncApplied[];
  readonly failed: readonly PluginSyncFailure[];
}

export function summarizePluginSync(report: PluginSyncReport): PluginSyncSummary {
  return { ok: report.ok, applied: report.applied, failed: report.failed };
}
