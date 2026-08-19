import type { Agent } from '../../agent';
import type { PluginRecord } from '../types';
import type { DiscoveredExtension, ExtensionContext, ExtensionModule } from './types';

/**
 * Loads and activates code-entry plugins inside the agent process.
 *
 * Responsibilities:
 * - `discover()` — pick plugins whose manifest declares an `entryPoint`
 * - `load()` — dynamic-import the entry point (cached per path)
 * - `activate()` — inject declared manifest hooks into the agent's HookEngine,
 *   then call the plugin's `activate(context)`; tools are registered by the
 *   plugin itself via `context.services.tools.registerUserTool`
 * - `deactivate()` — symmetric removal (hooks + deactivate hook), isolated so
 *   a failing plugin never breaks the agent
 *
 * Activation is deliberately lazy (a `/plugin activate` command or explicit
 * config opt-in), so merely installing a plugin never executes its code.
 */
export class ExtensionRuntime {
  private readonly loaded = new Map<string, ExtensionModule>();
  private readonly activations = new Map<
    string,
    { module: ExtensionModule; hooksUnregister?: () => void }
  >();

  /** Plugins that declare a code entry point, in installation order. */
  discover(plugins: readonly PluginRecord[]): DiscoveredExtension[] {
    const result: DiscoveredExtension[] = [];
    for (const plugin of plugins) {
      if (plugin.manifest?.entryPoint === undefined) continue;
      result.push({
        pluginId: plugin.id,
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
    const imported: unknown = await import(entryPoint);
    const module = normalizeExtensionModule(imported);
    this.loaded.set(entryPoint, module);
    return module;
  }

  /** Activate a discovered plugin against a live agent. */
  async activate(agent: Agent, extension: DiscoveredExtension): Promise<void> {
    if (this.activations.has(extension.pluginId)) {
      // Re-activating a live plugin would overwrite its hooksUnregister,
      // leaking the first activation's manifest hooks. Fail loudly.
      throw new Error(`Plugin "${extension.pluginId}" is already active`);
    }
    const module = await this.load(extension.entryPoint);
    // Declared manifest hooks first; roll back if activation throws.
    let hooksUnregister: (() => void) | undefined;
    if (extension.manifest.hooks !== undefined && extension.manifest.hooks.length > 0) {
      hooksUnregister = agent.hooks?.registerAll(extension.manifest.hooks);
    }
    const context: ExtensionContext = {
      services: agent.services,
      events: agent.eventBus,
      config: extension.manifest.config,
      pluginId: extension.pluginId,
    };
    try {
      await module.activate(context);
    } catch (error) {
      hooksUnregister?.();
      throw error;
    }
    this.activations.set(extension.pluginId, { module, hooksUnregister });
  }

  /** Deactivate a plugin: remove its hooks and call its deactivate hook. */
  async deactivate(pluginId: string): Promise<void> {
    const activation = this.activations.get(pluginId);
    if (activation === undefined) return;
    activation.hooksUnregister?.();
    this.activations.delete(pluginId);
    await activation.module.deactivate?.();
    // Tools registered by the plugin via registerUserTool belong to the agent's
    // ToolManager; the plugin itself is responsible for cleaning up state it
    // created. Manifest hooks are removed here because they are runtime-injected.
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
