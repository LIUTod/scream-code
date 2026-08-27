import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type {
  ExecutableToolErrorResult,
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import { filterMarketplaceEntries, loadPluginMarketplace } from '../../../plugin/marketplace';
import { parseManifest } from '../../../plugin/manifest';
import type { PluginManager } from '../../../plugin/manager';
import type { ExtensionRuntime } from '../../../plugin/runtime/extension';
import type { PluginInfo, PluginRecord, PluginSyncSummary } from '../../../plugin/types';
import { summarizePluginSync } from '../../../plugin/types';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './manage-plugin.md';

/** Every action this tool understands. */
export const MANAGE_PLUGIN_ACTIONS = [
  'list',
  'info',
  'check',
  'marketplace',
  'install',
  'register_generated',
  'enable',
  'disable',
  'set_mcp_enabled',
  'activate',
  'deactivate',
  'remove',
  'reset',
  'reload',
] as const;

/**
 * Actions that only read plugin state. The permission policy auto-approves
 * exactly this set; nothing here may write state or run plugin code.
 */
export const MANAGE_PLUGIN_READ_ONLY_ACTIONS = ['list', 'info', 'check', 'marketplace'] as const;

export type ManagePluginAction = (typeof MANAGE_PLUGIN_ACTIONS)[number];

export const ManagePluginInputSchema = z.object({
  action: z.enum(MANAGE_PLUGIN_ACTIONS).describe('Which plugin operation to run.'),
  id: z
    .string()
    .optional()
    .describe('Plugin id. Required for info, check, enable, disable, set_mcp_enabled, activate, deactivate, remove, reset.'),
  source: z
    .string()
    .optional()
    .describe('install: absolute path / GitHub URL / zip URL. register_generated: the generated plugin directory. marketplace: optional catalog URL or local JSON path.'),
  server: z.string().optional().describe('MCP server name, for set_mcp_enabled.'),
  enabled: z.boolean().optional().describe('Target state, for set_mcp_enabled.'),
  query: z.string().optional().describe('Case-insensitive substring filter, for marketplace.'),
});

export type ManagePluginInput = z.infer<typeof ManagePluginInputSchema>;

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly next: string;
  };
}

/**
 * The two actions that bring third-party code in. Their approval identity
 * includes the source, so a "approve for session" grant cannot be replayed
 * against a different URL later in the same session.
 */
const SOURCE_SCOPED_ACTIONS = new Set<ManagePluginAction>(['install', 'register_generated']);

/**
 * Actions that cannot be answered without naming a plugin. `check` is not here:
 * without an id it reports the health of the whole table.
 */
const NEEDS_ID = new Set<ManagePluginAction>([
  'info',
  'enable',
  'disable',
  'set_mcp_enabled',
  'activate',
  'deactivate',
  'remove',
  'reset',
]);

function isKnownAction(action: string): action is ManagePluginAction {
  return (MANAGE_PLUGIN_ACTIONS as readonly string[]).includes(action);
}

function isReadOnlyAction(action: ManagePluginAction): boolean {
  return (MANAGE_PLUGIN_READ_ONLY_ACTIONS as readonly string[]).includes(action);
}

function isSourceScoped(action: ManagePluginAction): boolean {
  return SOURCE_SCOPED_ACTIONS.has(action);
}

function fail(code: string, message: string, next: string): ErrorEnvelope {
  return { error: { code, message, next } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function result(payload: unknown, isError = false): ExecutableToolResult {
  return isError
    ? { output: JSON.stringify(payload), isError: true }
    : { output: JSON.stringify(payload) };
}

/**
 * Same payload as {@link result} but typed as the error variant, which is what
 * `resolveExecution` may return to reject a call before it reaches approval.
 */
function preflightError(envelope: ErrorEnvelope): ExecutableToolErrorResult {
  return { output: JSON.stringify(envelope), isError: true };
}

export class ManagePluginTool implements BuiltinTool<ManagePluginInput> {
  readonly name = 'ManagePlugin' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ManagePluginInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: ManagePluginInput): ToolExecution {
    // Argument problems are decided here rather than inside `run`, so a
    // malformed call never consumes a user approval prompt.
    if (!isKnownAction(args.action)) {
      return preflightError(
        fail(
          'unknown_action',
          `Unknown ManagePlugin action "${String(args.action)}".`,
          `Pick one of: ${MANAGE_PLUGIN_ACTIONS.join(', ')}.`,
        ),
      );
    }

    const missing = missingRequiredArgs(args);
    if (missing !== undefined) return preflightError(missing);

    const subject = ruleSubject(args);
    return {
      accesses: isReadOnlyAction(args.action) ? ToolAccesses.none() : ToolAccesses.all(),
      description: approvalDescription(args),
      approvalRule: literalRulePattern(this.name, subject),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
      execute: () => this.run(args),
    };
  }

  /**
   * Single funnel for every action. Contract: JSON in `output`, failures as
   * `isError` with `{error:{code,message,next}}`, and no exception ever
   * escapes — a plugin-center bug must not surface as a tool crash.
   */
  private async run(args: ManagePluginInput): Promise<ExecutableToolResult> {
    const manager = this.agent.toolServices?.plugins;
    if (manager === undefined) {
      return result(
        fail(
          'plugin_center_unavailable',
          'The shared plugin manager is not available in this runtime.',
          'Report this so the host can expose its PluginManager, or use the /plugin command.',
        ),
        true,
      );
    }

    try {
      switch (args.action) {
        case 'list':
          return result({
            action: 'list',
            count: manager.list().length,
            plugins: manager.list().map(listView),
            note: 'Enabled plugins contribute skills and MCP servers; a code plugin only runs after a separate activate.',
          });
        case 'info':
          return this.info(manager, args.id!);
        case 'check':
          return this.check(manager, args.id);
        case 'marketplace':
          return await this.marketplace(args.source, args.query);
        case 'install':
          return await this.install(manager, args.source!);
        case 'register_generated':
          return await this.registerGenerated(manager, args.source!);
        case 'enable':
        case 'disable': {
          const record = manager.get(args.id!);
          if (record === undefined) return result(notFound(args.id!, manager), true);
          const enabled = args.action === 'enable';
          await manager.setEnabled(record.id, enabled);
          const sync = await this.sync([record.id]);
          return result({
            action: args.action,
            id: record.id,
            enabled,
            record: listView(manager.get(record.id)!),
            ...(sync !== undefined ? { sync } : {}),
            note: enabled
              ? 'Enabled; skills and MCP servers hot-applied when sync reports them. Code still needs a separate activate.'
              : 'Disabled; its skills, MCP servers, and plugin tools were pulled from live sessions.',
          });
        }
        case 'set_mcp_enabled': {
          const record = manager.get(args.id!);
          if (record === undefined) return result(notFound(args.id!, manager), true);
          await manager.setMcpServerEnabled(record.id, args.server!, args.enabled!);
          const info = manager.info(record.id);
          const sync = await this.sync([record.id]);
          return result({
            action: args.action,
            id: record.id,
            server: args.server,
            enabled: args.enabled,
            mcpServers: info?.mcpServers ?? [],
            ...(sync !== undefined ? { sync } : {}),
            note: 'MCP server state changed; live sessions were reconciled when sync reports mcp.add/mcp.remove.',
          });
        }
        case 'activate':
          return await this.activate(manager, args.id!);
        case 'deactivate':
          return await this.deactivate(manager, args.id!);
        case 'remove':
          return await this.remove(manager, args.id!);
        case 'reset':
          return await this.reset(manager, args.id!);
        case 'reload': {
          const summary = await manager.reload();
          const sync = await this.sync();
          return result({ action: 'reload', ...summary, ...(sync !== undefined ? { sync } : {}) });
        }
        default:
          return result(
            fail(
              'unknown_action',
              `Unknown ManagePlugin action "${String(args.action)}".`,
              `Pick one of: ${MANAGE_PLUGIN_ACTIONS.join(', ')}.`,
            ),
            true,
          );
      }
    } catch (error) {
      return result(fail('plugin_operation_failed', errorMessage(error), nextForError(args, error)), true);
    }
  }

  private info(manager: PluginManager, id: string): ExecutableToolResult {
    const info = manager.info(id);
    if (info === undefined) return result(notFound(id, manager), true);
    return result({
      action: 'info',
      plugin: projectInfo(info),
      active: this.runtime?.isActive(info.id) === true,
    });
  }

  /**
   * Health view built from the diagnostics each record already carries. There
   * is no persistent reload log, so none is invented: `reload` is what returns
   * a fresh summary after re-reading the table from disk.
   */
  private check(manager: PluginManager, id?: string): ExecutableToolResult {
    if (id !== undefined && manager.get(id) === undefined) {
      return result(notFound(id, manager), true);
    }
    const records = id === undefined ? manager.list() : [manager.get(id)!];
    const plugins = records.map((record) => ({
      ...checkView(record, this.runtime?.isActive(record.id) === true),
      circuit: this.circuitView(record.id),
    }));
    const unhealthy = plugins.filter((plugin) => plugin.errors.length > 0 || plugin.state === 'error');
    return result({
      action: 'check',
      checked: plugins.length,
      healthy: unhealthy.length === 0,
      unhealthy: unhealthy.map((plugin) => plugin.id),
      plugins,
      note: 'Diagnostics are the ones stored on each record from the last load or reload. Run action:"reload" to re-read the plugin table from disk and get a fresh summary.',
    });
  }

  private async marketplace(source?: string, query?: string): Promise<ExecutableToolResult> {
    try {
      const catalog = await loadPluginMarketplace({ source, workDir: this.agent.config.cwd });
      const entries = filterMarketplaceEntries(catalog.entries, query);
      return result({
        action: 'marketplace',
        catalog: catalog.source,
        version: catalog.version,
        query: query ?? null,
        count: entries.length,
        entries,
        note: 'Catalog metadata only. "tier" is a display label and never skips the approval prompt; nothing was downloaded or installed here.',
      });
    } catch (error) {
      return result(
        fail(
          'marketplace_unavailable',
          `Could not load the plugin marketplace: ${errorMessage(error)}`,
          'Check the URL or file path, or pass one explicitly: {action:"marketplace", source:"<https url or local json path>"}.',
        ),
        true,
      );
    }
  }

  /**
   * Install only lands files and registers the record. Nothing is imported or
   * run: activation stays a separate, separately-approved action.
   */
  private async install(manager: PluginManager, source: string): Promise<ExecutableToolResult> {
    const record = await manager.install(source);
    const sync = await this.sync([record.id], { skipMcpAdd: true });
    return result({
      action: 'install',
      id: record.id,
      installed: true,
      activated: false,
      codeExecuted: false,
      hasCodeEntryPoint: record.manifest?.entryPoint !== undefined,
      record: listView(record),
      ...(sync !== undefined ? { sync } : {}),
      message:
        'installed, code not executed yet — its skills are live now, MCP servers start after an approved activate/enable; run activate to enable its code tools',
    });
  }

  /**
   * Register a locally generated plugin directory. A manifest with an
   * `entryPoint` is refused: the generated-skill flow is auto-approved, so it
   * must never become a channel for running unapproved code.
   */
  private async registerGenerated(
    manager: PluginManager,
    source: string,
  ): Promise<ExecutableToolResult> {
    const parsed = await parseManifest(source);
    if (parsed.manifest === undefined) {
      const detail =
        parsed.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ??
        'no plugin manifest found';
      return result(
        fail(
          'manifest_invalid',
          `Cannot register "${source}" as a generated plugin: ${detail}`,
          'Write a valid plugin manifest in that directory first (see the MakeSkillPlan / MakeSkillApply flow).',
        ),
        true,
      );
    }
    if (parsed.manifest.entryPoint !== undefined) {
      return result(
        fail(
          'code_entry_point_not_allowed',
          `Refusing to register "${parsed.manifest.name}": its manifest declares an entryPoint, which would run code through a path that is normally auto-approved.`,
          'Install it from its source instead, then activate it as a separate approved step: {action:"install", source:"<path or url>"} followed by {action:"activate", id:"<plugin id>"}.',
        ),
        true,
      );
    }
    const record = await manager.registerGenerated(source);
    const sync = await this.sync([record.id], { skipMcpAdd: true });
    return result({
      action: 'register_generated',
      id: record.id,
      registered: true,
      enabled: record.enabled,
      hasCodeEntryPoint: false,
      record: listView(record),
      ...(sync !== undefined ? { sync } : {}),
      note: 'Registered in place; its skills are hot-applied to this session when sync reports skills.inject.',
    });
  }

  private async activate(manager: PluginManager, id: string): Promise<ExecutableToolResult> {
    const record = manager.get(id);
    if (record === undefined) return result(notFound(id, manager), true);
    const runtime = this.runtime;
    if (runtime === undefined) {
      return result(
        fail(
          'extension_runtime_unavailable',
          'This runtime has no extension manager, so plugin code cannot be activated.',
          'The plugin stays installed; use the /plugin command or report this so the host can expose an ExtensionRuntime.',
        ),
        true,
      );
    }
    if (runtime.isActive(record.id)) {
      return result({
        action: 'activate',
        id: record.id,
        active: true,
        alreadyActive: true,
        note: 'Nothing ran again — the plugin is already live in this process.',
      });
    }
    const [extension] = runtime.discover([record]);
    if (extension === undefined) {
      return result(
        fail(
          'no_code_entry_point',
          `Plugin "${record.id}" has no manifest entryPoint, so there is no code to activate.`,
          `Enable it instead: {action:"enable", id:"${record.id}"}.`,
        ),
        true,
      );
    }
    try {
      await runtime.activate(this.agent, extension);
    } catch (error) {
      // Mirror the RPC path: the reason must be readable on the record, and a
      // failure to write that reason must not mask the activation error.
      await manager.markError(record.id, errorMessage(error)).catch(() => undefined);
      return result(
        fail(
          'activation_failed',
          `Failed to activate "${record.id}": ${errorMessage(error)}`,
          `Inspect {action:"info", id:"${record.id}"} for the stored diagnostics; fix it or {action:"remove", id:"${record.id}"}.`,
        ),
        true,
      );
    }
    const sync = await this.sync([record.id]);
    return result({
      action: 'activate',
      id: record.id,
      active: true,
      entryPoint: extension.entryPoint,
      enabled: record.enabled,
      ...(sync !== undefined ? { sync } : {}),
      ...(record.enabled
        ? {}
        : { warning: 'The plugin record is disabled; enable it so its capabilities survive the next reload.' }),
    });
  }

  private async deactivate(manager: PluginManager, id: string): Promise<ExecutableToolResult> {
    const record = manager.get(id);
    if (record === undefined) return result(notFound(id, manager), true);
    const runtime = this.runtime;
    if (runtime === undefined) {
      return result(
        fail(
          'extension_runtime_unavailable',
          'This runtime has no extension manager to deactivate from.',
          'Use the /plugin command or report this so the host can expose an ExtensionRuntime.',
        ),
        true,
      );
    }
    const wasActive = runtime.isActive(record.id);
    await runtime.deactivate(record.id);
    // The plugin's code just stopped running; its in-process tools must stop
    // being offered too (its own deactivate hook may have unregistered them —
    // that path is idempotent). Skills and MCP servers stay until disable or
    // remove, so no session sync pass is needed here.
    const toolsUnregistered =
      this.agent.services?.tools?.unregisterToolsByOwner?.(record.id) ?? 0;
    return result({
      action: 'deactivate',
      id: record.id,
      active: false,
      wasActive,
      toolsUnregistered,
      ...(wasActive ? {} : { note: 'The plugin was not active; nothing to unwind.' }),
    });
  }

  private async remove(manager: PluginManager, id: string): Promise<ExecutableToolResult> {
    const record = manager.get(id);
    if (record === undefined) return result(notFound(id, manager), true);
    // Unwind the code here so removal is complete even in hosts without the
    // session-sync entry point; the sync pass below repeats the teardown
    // idempotently (deactivate is a no-op once inactive) and additionally
    // drops tools, MCP servers, and skills from every live session.
    const runtime = this.runtime;
    const wasActive = runtime?.isActive(record.id) === true;
    if (wasActive && runtime !== undefined) await runtime.deactivate(record.id);
    await manager.remove(record.id);
    const sync = await this.sync([record.id]);
    return result({
      action: 'remove',
      id: record.id,
      removed: true,
      deactivatedFirst: wasActive,
      ...(sync !== undefined ? { sync } : {}),
      note: 'The plugin record is gone; files on disk were not deleted.',
    });
  }

  private get runtime(): ExtensionRuntime | undefined {
    return this.agent.toolServices?.extensionRuntime;
  }

  /** Live circuit-breaker state for one plugin, read from the agent ledger. */
  private circuitView(id: string): { failures: number; tripped: boolean } {
    const tools = this.agent.services?.tools;
    return {
      failures: tools?.getCircuitFailures?.(id) ?? 0,
      tripped: tools?.isCircuitTripped?.(id) ?? false,
    };
  }

  /**
   * Recover a circuit-tripped (or otherwise disabled) plugin: clear the
   * failure ledger, re-derive the record state from disk, enable it, and hot
   * -apply its capabilities. A code entry point still needs a separate,
   * approved `activate` — reset never runs plugin code.
   */
  private async reset(manager: PluginManager, id: string): Promise<ExecutableToolResult> {
    const record = manager.get(id);
    if (record === undefined) return result(notFound(id, manager), true);
    // Everything downstream keys off the normalized record id: the ledger and
    // the sync pass were keyed that way by the trip that fired.
    const recordId = record.id;
    this.agent.services?.tools?.resetCircuit?.(recordId);
    // reload() re-materializes every record from disk, which recomputes
    // `state` from the manifest: a genuinely broken manifest stays 'error'
    // and says so, instead of being papered over by the reset.
    await manager.reload();
    const after = manager.get(recordId);
    if (after === undefined) {
      return result(
        fail(
          'plugin_not_found',
          `Plugin "${recordId}" disappeared when reset re-read the table.`,
          "call action:'list' to see what is installed now",
        ),
        true,
      );
    }
    await manager.setEnabled(recordId, true);
    const sync = await this.sync([recordId]);
    return result({
      action: 'reset',
      id: recordId,
      enabled: true,
      state: after.state,
      circuit: { cleared: true },
      ...(sync !== undefined ? { sync } : {}),
      note:
        after.state === 'error'
          ? 'Circuit cleared, but the record still reports errors after re-reading the manifest — see {action:"info"}.'
          : 'Circuit cleared and capabilities hot-applied. Code entry points still need a separate approved activate.',
    });
  }

  /**
   * Hot-apply a successful mutation into live sessions through the host-owned
   * sync entry point. Advisory by design: the plugin change is already durable
   * when this runs, so the report is surfaced but never flips the action's
   * outcome, and a missing entry point (older hosts) degrades to `undefined`.
   */
  private async sync(
    changedIds?: readonly string[],
    options?: { skipMcpAdd?: boolean },
  ): Promise<PluginSyncSummary | undefined> {
    const pluginSync = this.agent.toolServices?.pluginSync;
    if (pluginSync === undefined) return undefined;
    try {
      return summarizePluginSync(await pluginSync(changedIds, options));
    } catch (error) {
      return {
        ok: false,
        applied: [],
        failed: [
          {
            step: 'mcp.add',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
}

/**
 * The string that identifies what is being approved. For the source-scoped
 * actions the source is part of the identity, so the recorded session rule
 * reads `ManagePlugin(install <source>)` and only replays for that exact source.
 */
function ruleSubject(args: ManagePluginInput): string {
  if (isSourceScoped(args.action) && args.source !== undefined) {
    return `${args.action} ${args.source}`;
  }
  return args.action;
}

/** Human-readable approval line. Source-scoped actions must show the full source. */
function approvalDescription(args: ManagePluginInput): string {
  switch (args.action) {
    case 'list':
      return 'Listing installed plugins';
    case 'info':
      return `Reading plugin "${args.id}"`;
    case 'check':
      return args.id === undefined ? 'Checking all plugins' : `Checking plugin "${args.id}"`;
    case 'marketplace':
      return `Browsing the plugin marketplace${args.source === undefined ? '' : ` at ${args.source}`}`;
    case 'install':
      return `Install plugin from source: ${args.source} (downloads code; it is not executed until a separate activate)`;
    case 'register_generated':
      return `Register generated plugin from directory: ${args.source}`;
    case 'enable':
      return `Enable plugin "${args.id}"`;
    case 'disable':
      return `Disable plugin "${args.id}"`;
    case 'set_mcp_enabled':
      return `${args.enabled ? 'Enable' : 'Disable'} MCP server "${args.server}" of plugin "${args.id}"`;
    case 'activate':
      return `Activate plugin "${args.id}" — this runs its code entry point in this process`;
    case 'deactivate':
      return `Deactivate plugin "${args.id}"`;
    case 'remove':
      return `Remove plugin "${args.id}" from the plugin center`;
    case 'reset':
      return `Reset plugin "${args.id}" — clear its circuit breaker and re-enable it`;
    case 'reload':
      return 'Reload the plugin table from disk';
    default:
      return `Manage plugin (${String(args.action)})`;
  }
}

function missingRequiredArgs(args: ManagePluginInput): ErrorEnvelope | undefined {
  if (NEEDS_ID.has(args.action) && args.id === undefined) {
    return fail(
      'missing_id',
      `Action "${args.action}" needs a plugin id.`,
      "call action:'list' to see installed plugin ids",
    );
  }
  if (isSourceScoped(args.action) && (args.source === undefined || args.source.trim().length === 0)) {
    return fail(
      'missing_source',
      `Action "${args.action}" needs a source.`,
      'pass source:"<absolute path | GitHub url | zip url>", or browse first with action:"marketplace"',
    );
  }
  if (args.action === 'set_mcp_enabled') {
    if (args.server === undefined) {
      return fail(
        'missing_server',
        'Action "set_mcp_enabled" needs the MCP server name.',
        `call {action:"info", id:"${String(args.id)}"} and read its mcpServers list`,
      );
    }
    if (typeof args.enabled !== 'boolean') {
      return fail(
        'missing_enabled',
        'Action "set_mcp_enabled" needs enabled:true or enabled:false.',
        'pass the desired boolean state',
      );
    }
  }
  return undefined;
}

function notFound(id: string, manager: PluginManager): ErrorEnvelope {
  return fail(
    'plugin_not_found',
    `Plugin "${id}" is not installed.`,
    `call action:'list' to see installed plugin ids (${String(manager.list().length)} installed)`,
  );
}

/** Turn a manager-thrown message into the next step the model can act on. */
function nextForError(args: ManagePluginInput, error: unknown): string {
  const message = errorMessage(error);
  if (/already exists/i.test(message)) {
    return `use {action:"enable", id:"${args.id ?? args.source ?? ''}"} or install under a different name`;
  }
  if (/not installed/i.test(message)) {
    return "call action:'list' to see installed plugin ids";
  }
  if (/does not declare MCP server/i.test(message)) {
    return `call {action:"info", id:"${String(args.id)}"} and pick one of its listed servers`;
  }
  if (/absolute path|does not exist|not a directory/i.test(message)) {
    return 'pass an absolute directory path, a https GitHub url, or a https zip url';
  }
  return 'inspect {action:"list"} and retry; if a record is broken, {action:"remove", id:"<id>"} it';
}

function listView(record: PluginRecord) {
  return {
    id: record.id,
    name: record.manifest?.name ?? record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    state: record.state,
    enabled: record.enabled,
    source: record.source,
    originalSource: record.originalSource,
    path: record.root,
    keywords: record.manifest?.keywords ?? [],
    skillCount: record.skillCount,
    mcpServerCount: Object.keys(record.manifest?.mcpServers ?? {}).length,
    hasCodeEntryPoint: record.manifest?.entryPoint !== undefined,
    hasErrors: record.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  };
}

function checkView(record: PluginRecord, active: boolean) {
  return {
    id: record.id,
    state: record.state,
    enabled: record.enabled,
    active,
    hasCodeEntryPoint: record.manifest?.entryPoint !== undefined,
    errors: record.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.message),
    warnings: record.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'warn')
      .map((diagnostic) => diagnostic.message),
  };
}

/**
 * Full detail for one plugin, minus the raw manifest blob: `mcpServers`,
 * `skillRoots` and `diagnostics` are already projected by the manager.
 */
function projectInfo(info: PluginInfo) {
  return {
    id: info.id,
    name: info.manifest?.name ?? info.displayName,
    displayName: info.displayName,
    version: info.version,
    description: info.manifest?.description,
    state: info.state,
    enabled: info.enabled,
    source: info.source,
    originalSource: info.originalSource,
    path: info.root,
    keywords: info.manifest?.keywords ?? [],
    skillCount: info.skillCount,
    skills: info.skills,
    skillRoots: info.manifest?.skills ?? [],
    skillInstructions: info.manifest?.skillInstructions,
    mcpServerCount: info.mcpServerCount,
    enabledMcpServerCount: info.enabledMcpServerCount,
    mcpServers: info.mcpServers,
    hasCodeEntryPoint: info.manifest?.entryPoint !== undefined,
    entryPoint: info.manifest?.entryPoint,
    hooks: (info.manifest?.hooks ?? []).map((hook) => hook.event),
    hasErrors: info.hasErrors,
    diagnostics: info.diagnostics,
    installedAt: info.installedAt,
    updatedAt: info.updatedAt,
    manifestKind: info.manifestKind,
    manifestPath: info.manifestPath,
    shadowedManifestPath: info.shadowedManifestPath,
    github: info.github,
    homepage: info.manifest?.homepage,
  };
}
