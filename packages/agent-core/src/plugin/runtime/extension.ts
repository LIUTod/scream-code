import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Agent, AgentServices } from '../../agent';
import type { EventSubscriptionBus, EventHandler, Unsubscribe } from '../../agent/events';
import type { ToolManager } from '../../agent/tool';
import type { UserToolRegistration } from '../../agent/tool/types';
import { PLUGIN_CIRCUIT_TRIP_THRESHOLD } from '../types';
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
  private readonly activations = new Map<
    string,
    {
      module: ExtensionModule;
      /** Absolute path this activation was imported from; dropped on deactivate. */
      entryPoint: string;
      hooksUnregister?: () => void;
      /** Unsubscribes for every `context.events.subscribe()` this activation made. */
      subscriptions: Unsubscribe[];
      /** Captured so a failing `deactivate()` can still be logged. */
      log: Logger | undefined;
      /** The agent this plugin was activated into (its tools live there). */
      agent: Agent;
    }
  >();

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
    if (this.activations.has(extension.pluginId)) {
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
      if (handlerFaults >= PLUGIN_CIRCUIT_TRIP_THRESHOLD && this.isActive(extension.pluginId)) {
        void this.deactivate(extension.pluginId);
      }
    };
    // Plugins see a services view that stamps tool registrations with this
    // plugin's id: removing or tripping the plugin can then reclaim exactly
    // its tools from a running agent even if the plugin never declared
    // ownership itself.
    const context: ExtensionContext = {
      services: withPluginToolOwnership(agent.services, extension.pluginId),
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
    this.activations.set(extension.pluginId, {
      module,
      entryPoint: extension.entryPoint,
      hooksUnregister,
      subscriptions,
      log: agent.log,
      agent,
    });
  }

  /** Deactivate a plugin: drop its hooks/subscriptions, then call its deactivate. */
  async deactivate(pluginId: string): Promise<void> {
    const activation = this.activations.get(pluginId);
    if (activation === undefined) return;
    activation.hooksUnregister?.();
    // Release the bus handles as well: the bus outlives the activation, so a
    // handler left behind keeps firing into a plugin that is no longer active.
    releaseSubscriptions(activation.subscriptions);
    this.activations.delete(pluginId);
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
  async deactivateAll(): Promise<void> {
    // Snapshot the ids first: deactivate() removes each entry as it goes.
    for (const pluginId of Array.from(this.activations.keys())) {
      await this.deactivate(pluginId);
    }
  }

  isActive(pluginId: string): boolean {
    return this.activations.has(pluginId);
  }

  activePluginIds(): readonly string[] {
    return [...this.activations.keys()];
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
