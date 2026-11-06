import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Agent, AgentServices } from '../../agent';
import type { EventSubscriptionBus, EventHandler, Unsubscribe } from '../../agent/events';
import type { ToolManager } from '../../agent/tool';
import type { UserToolRegistration } from '../../agent/tool/types';
import { PLUGIN_CIRCUIT_TRIP_THRESHOLD } from '../types';
import { createPluginUi } from './ui';
import type { Logger } from '../../logging/types';
import type { AgentEvent } from '../../rpc';
import type { PluginRecord } from '../types';
import type {
  DiscoveredExtension,
  ExtensionContext,
  ExtensionEventBus,
  ExtensionModule,
} from './types';

/**
 * Loads and activates code-entry plugins inside the agent process.
 *
 * Responsibilities:
 * - `discover()` — pick plugins whose manifest declares an `entryPoint`
 * - `load()` — dynamic-import the entry point (cached per path)
 * - `activate()` — inject declared manifest hooks into the agent's HookEngine,
 *   then call the plugin's `activate(context)`; tools are registered by the
 *   plugin itself via `context.services.tools.registerUserTool`. Hooks and
 *   event subscriptions made during a failed activation are rolled back
 * - `deactivate()` — symmetric removal (hooks + event subscriptions +
 *   deactivate hook + the cached module, so an edited entry point is re-imported
 *   on the next activate), isolated so a failing plugin never breaks the agent
 *
 * Activation is deliberately lazy (a `/plugin activate` command or explicit
 * config opt-in), so merely installing a plugin never executes its code.
 */
/** One live plugin instance inside one session. */
interface ActivationRecord {
  readonly module: ExtensionModule;
  /** Absolute path this activation was imported from; dropped on deactivate. */
  readonly entryPoint: string;
  hooksUnregister?: () => void;
  /** Unsubscribes for every `context.events.subscribe()` this activation made. */
  readonly subscriptions: Unsubscribe[];
  /** Captured so a failing `deactivate()` can still be logged. */
  readonly log: Logger | undefined;
  /** The agent this plugin was activated into (its tools live there). */
  readonly agent: Agent;
}

export class ExtensionRuntime {
  private readonly loaded = new Map<string, ExtensionModule>();
  /**
   * Per-entry module generation. Bumped whenever the cached module must not be
   * reused again — on deactivate, and on a failed load or activation.
   * `load()` appends the current generation to the specifier, so the host's
   * process-wide module cache cannot pin a stale or broken module. An earlier
   * one-shot "stale" flag was consumed by the first load and lost exactly when
   * an activation failed, which made reload re-run the broken code.
   */
  private readonly generations = new Map<string, number>();
  /**
   * Live activations, keyed by session then plugin: two sessions can run the
   * same plugin independently (each with its own hooks, subscriptions and
   * user tools), and stopping it in one must not affect the other.
   */
  private readonly activations = new Map<string, Map<string, ActivationRecord>>();

  /** Plugins that declare a code entry point, in installation order. */
  discover(plugins: readonly PluginRecord[]): DiscoveredExtension[] {
    const result: DiscoveredExtension[] = [];
    for (const plugin of plugins) {
      if (plugin.manifest?.entryPoint === undefined) continue;
      result.push({
        pluginId: plugin.id,
        root: plugin.root,
        entryPoint: plugin.manifest.entryPoint,
        manifest: plugin.manifest,
      });
    }
    return result;
  }

  /** Import (and cache) an entry point module. Rejects for non-conforming modules. */
  async load(entryPoint: string): Promise<ExtensionModule> {
    const cached = this.loaded.get(entryPoint);
    if (cached !== undefined) return cached;
    // Import through a file URL: a Windows absolute path is not a valid module
    // specifier (its drive letter reads as a URL scheme), and the reload query
    // needs the URL form anyway. The cache key stays the plain path.
    const url = pathToFileURL(entryPoint);
    // Every generation past the first gets a distinct specifier, because the
    // bare path stays bound to the module imported before the edit.
    const generation = this.generations.get(entryPoint) ?? 0;
    if (generation > 0) url.search = `scream-reload=${generation}`;
    try {
      const imported: unknown = await import(url.href);
      const module = normalizeExtensionModule(imported);
      this.loaded.set(entryPoint, module);
      return module;
    } catch (error) {
      // A file that fails to import (or does not export activate) must not stay
      // pinned: the next attempt has to read the file again, otherwise fixing
      // the code and reloading would keep replaying the broken import.
      this.invalidate(entryPoint);
      throw error;
    }
  }

  /**
   * Re-check that the entry point still lives inside the plugin directory.
   *
   * Parsing already confined the path, but the record caches the result: a file
   * replaced by a symlink after registration would otherwise import code from
   * outside the directory the docs advertise as a boundary. Node resolves
   * symlinks at import time, so the check has to happen here as well.
   */
  private async assertConfined(extension: DiscoveredExtension): Promise<void> {
    const [rootReal, entryReal] = await Promise.all([
      realpath(extension.root).catch(() => extension.root),
      realpath(extension.entryPoint).catch(() => extension.entryPoint),
    ]);
    if (entryReal !== rootReal && !entryReal.startsWith(`${rootReal}${sep}`)) {
      throw new Error(
        `Entry point ${extension.entryPoint} resolves outside the plugin directory ${extension.root}`,
      );
    }
  }

  /** Drop the cached module and make the next load use a fresh specifier. */
  private invalidate(entryPoint: string): void {
    this.loaded.delete(entryPoint);
    this.generations.set(entryPoint, (this.generations.get(entryPoint) ?? 0) + 1);
  }

  /** Activate a discovered plugin against a live agent. */
  async activate(agent: Agent, extension: DiscoveredExtension): Promise<void> {
    const sessionKey = agent.sessionId ?? '';
    const sessionActivations = this.sessionActivations(sessionKey);
    if (sessionActivations.has(extension.pluginId)) {
      // Re-activating a live plugin would overwrite its hooksUnregister,
      // leaking the first activation's manifest hooks. Fail loudly.
      throw new Error(`Plugin "${extension.pluginId}" is already active`);
    }
    await this.assertConfined(extension);
    const module = await this.load(extension.entryPoint);
    // Declared manifest hooks first; roll back if activation throws.
    let hooksUnregister: (() => void) | undefined;
    if (extension.manifest.hooks !== undefined && extension.manifest.hooks.length > 0) {
      hooksUnregister = agent.hooks?.registerAll(extension.manifest.hooks);
    }
    // Track subscriptions through a per-activation view of the bus: a plugin
    // that throws mid-activate would otherwise leave handlers wired up that no
    // later deactivate() can reach.
    const subscriptions: Unsubscribe[] = [];
    // A faulty event handler counts against the plugin (circuit D4): same
    // trip threshold as tools, one level gentler — the plugin is deactivated
    // in this process, not persistently disabled, because an event bug is
    // noise rather than proof the whole limb is broken.
    let handlerFaults = 0;
    const onHandlerFault = (): void => {
      handlerFaults += 1;
      if (
        handlerFaults >= PLUGIN_CIRCUIT_TRIP_THRESHOLD &&
        this.isActive(extension.pluginId, sessionKey)
      ) {
        // Only this session's copy: another session may be running the same
        // plugin fine, and a faulty handler is not proof its limb is broken.
        void this.deactivate(extension.pluginId, sessionKey);
      }
    };
    // Plugins see a services view that stamps tool registrations with this
    // plugin's id: removing or tripping the plugin can then reclaim exactly
    // its tools from a running agent even if the plugin never declared
    // ownership itself.
    const context: ExtensionContext = {
      services: withPluginToolOwnership(agent.services, extension.pluginId),
      ui: createPluginUi(agent, extension.pluginId),
      events: createTrackedEventBus(agent.eventBus, subscriptions, onHandlerFault),
      config: extension.manifest.config,
      pluginId: extension.pluginId,
    };
    try {
      await module.activate(context);
    } catch (error) {
      hooksUnregister?.();
      releaseSubscriptions(subscriptions);
      // A failed activation must not pin the module: the usual recovery is to
      // fix the plugin and activate again in the same process.
      this.invalidate(extension.entryPoint);
      throw error;
    }
    sessionActivations.set(extension.pluginId, {
      module,
      entryPoint: extension.entryPoint,
      hooksUnregister,
      subscriptions,
      log: agent.log,
      agent,
    });
  }

  /**
   * Deactivate a plugin in one session, or everywhere when no session is given.
   *
   * Hosts that do not know the owning session (a global disable/remove, a
   * capability sync unwind) pass `undefined` and hit every copy; an explicit
   * session id only unwinds that one.
   */
  async deactivate(pluginId: string, sessionId?: string | undefined): Promise<void> {
    const sessionKeys =
      sessionId === undefined
        ? [...this.activations.keys()]
        : sessionId !== '' && this.activations.has(sessionId)
          ? [sessionId]
          : sessionId === ''
            ? [...this.activations.keys()].filter((key) => key === '')
            : [];
    for (const sessionKey of sessionKeys) {
      await this.deactivateInSession(sessionKey, pluginId);
    }
  }

  /** Tear down one activation record; the plugin's own deactivate is isolated. */
  private async deactivateInSession(sessionKey: string, pluginId: string): Promise<void> {
    const sessionActivations = this.activations.get(sessionKey);
    const activation = sessionActivations?.get(pluginId);
    if (sessionActivations === undefined || activation === undefined) return;
    activation.hooksUnregister?.();
    // Release the bus handles as well: the bus outlives the activation, so a
    // handler left behind keeps firing into a plugin that is no longer active.
    releaseSubscriptions(activation.subscriptions);
    sessionActivations.delete(pluginId);
    if (sessionActivations.size === 0) this.activations.delete(sessionKey);
    // Drop the module cached for this entry point so a re-edit followed by a
    // re-activate imports the edited file instead of the stale module.
    this.invalidate(activation.entryPoint);
    // Reclaim the plugin's owned user tools from the agent it was activated
    // into. Doing it inside deactivate() makes every deactivation path —
    // explicit action, sync teardown, or the event-fault circuit — leave no
    // "dead limb" tools offered to the model.
    try {
      activation.agent.services.tools?.unregisterToolsByOwner?.(pluginId);
    } catch {
      // A partial services manifest or a registry bug must not block cleanup.
    }
    // Cleanup is committed before the plugin's own hook runs, and a throwing
    // hook is isolated: the host caller must never see a plugin's bug.
    try {
      await activation.module.deactivate?.();
    } catch (error) {
      activation.log?.warn('plugin deactivate failed', {
        pluginId,
        sessionId: sessionKey === '' ? undefined : sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Tools registered by the plugin via registerUserTool belong to the agent's
    // ToolManager; the plugin itself is responsible for cleaning up state it
    // created. Manifest hooks are removed here because they are runtime-injected.
  }

  /**
   * Deactivate every live plugin. Provided so a host can tear down all code
   * plugins in one call; each plugin's failure is isolated from the others.
   */
  /**
   * Tear down every plugin activated in one session.
   *
   * Called when a session closes: its bucket would otherwise outlive the
   * agent, keeping `isActive(pluginId)` true and making the plugin centre show
   * ● for a session nobody runs.
   */
  async deactivateSession(sessionId: string): Promise<void> {
    const sessionActivations = this.activations.get(sessionId);
    if (sessionActivations === undefined) return;
    for (const pluginId of Array.from(sessionActivations.keys())) {
      await this.deactivateInSession(sessionId, pluginId);
    }
  }

  async deactivateAll(): Promise<void> {
    // Snapshot first: deactivation removes entries (and empty sessions) as it goes.
    for (const [sessionKey, plugins] of Array.from(this.activations.entries())) {
      for (const pluginId of Array.from(plugins.keys())) {
        await this.deactivateInSession(sessionKey, pluginId);
      }
    }
  }

  /** Whether the plugin is live in the given session (or anywhere, when omitted). */
  isActive(pluginId: string, sessionId?: string | undefined): boolean {
    if (sessionId !== undefined) return this.activations.get(sessionId)?.has(pluginId) === true;
    for (const plugins of this.activations.values()) {
      if (plugins.has(pluginId)) return true;
    }
    return false;
  }

  /** Live plugin ids for a session (or across all sessions, when omitted). */
  activePluginIds(sessionId?: string | undefined): readonly string[] {
    if (sessionId !== undefined) {
      return [...(this.activations.get(sessionId)?.keys() ?? [])];
    }
    return [...new Set([...this.activations.values()].flatMap((plugins) => [...plugins.keys()]))];
  }

  /** Get-or-create the per-session bucket. */
  private sessionActivations(sessionKey: string): Map<string, ActivationRecord> {
    let bucket = this.activations.get(sessionKey);
    if (bucket === undefined) {
      bucket = new Map();
      this.activations.set(sessionKey, bucket);
    }
    return bucket;
  }
}

function normalizeExtensionModule(mod: unknown): ExtensionModule {
  const candidate =
    (mod as { default?: ExtensionModule } | undefined)?.default ?? (mod as ExtensionModule);
  if (candidate === undefined || typeof candidate.activate !== 'function') {
    throw new Error('Plugin entry point must export an activate(context) function');
  }
  return candidate;
}

/**
 * Wrap the agent's bus in a per-activation view that records every unsubscribe
 * handle the plugin gets, so the runtime can release them if activation fails.
 */
function createTrackedEventBus(
  bus: EventSubscriptionBus,
  subscriptions: Unsubscribe[],
  onFault?: () => void,
): ExtensionEventBus {
  return {
    subscribe: (type: AgentEvent['type'] | '*', handler: EventHandler): Unsubscribe => {
      // Count handler faults against the owning plugin before the bus's own
      // isolation swallows them (sync throw and async rejection both).
      const guarded: EventHandler = (event) => {
        try {
          const out = handler(event) as unknown;
          if (out !== null && typeof (out as Promise<unknown>).then === 'function') {
            (out as Promise<unknown>).catch(() => {
              onFault?.();
            });
          }
          return out as void;
        } catch (error) {
          onFault?.();
          throw error;
        }
      };
      const unsubscribe = bus.subscribe(type, guarded);
      subscriptions.push(unsubscribe);
      return unsubscribe;
    },
    clear: () => {
      // Scoped to this view: only the subscriptions this plugin made are
      // released. A global bus.clear() here would let one plugin unhook every
      // other plugin and the host itself — isolation forbids it.
      releaseSubscriptions(subscriptions);
    },
  };
}

/** Release every subscription recorded for one activation, isolating failures. */
function releaseSubscriptions(subscriptions: Unsubscribe[]): void {
  while (subscriptions.length > 0) {
    const unsubscribe = subscriptions.pop();
    try {
      unsubscribe?.();
    } catch {
      // Swallow: an unsubscribe bug must not mask the activation error.
    }
  }
}

/**
 * A services view handed to one activated plugin. It forwards everything to
 * the agent's real manifest except `tools.registerUserTool`, where it stamps
 * `ownerPluginId` with this plugin's id (an explicit id from the plugin wins).
 * Ownership is what lets remove/disable/circuit-trip reclaim the plugin's
 * tools from live agents without trusting the plugin to clean up after itself.
 */
function withPluginToolOwnership(services: AgentServices, pluginId: string): AgentServices {
  const tools = services.tools as ToolManager | undefined | null;
  if (typeof tools !== 'object' || tools === null) {
    // A partial services manifest (some hosts and test fakes omit subsystems):
    // there is nothing to stamp, and activation must proceed regardless.
    return services;
  }
  const ownedTools = new Proxy(tools, {
    get(target, prop, receiver) {
      if (prop === 'registerUserTool') {
        return (input: UserToolRegistration): void => {
          target.registerUserTool({ ...input, ownerPluginId: input.ownerPluginId ?? pluginId });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  // `services` is a plain object literal of references (plus an arrow-function
  // `systemPrompt`), so a shallow copy with one overridden member is safe.
  return { ...services, tools: ownedTools };
}
