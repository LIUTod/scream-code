import type { AgentServices } from '../../agent';
import type { EventSubscriptionBus } from '../../agent/events';
import type { PluginManifest } from '../types';

/**
 * Read-only, stable handle handed to an activated code plugin. Exposes the
 * agent's subsystem manifest (`services`), the in-process event bus
 * (`events`), the plugin's default config, and its id. Plugins register tools
 * via `services.tools.registerUserTool` and subscribe via `events.subscribe`.
 */
export interface ExtensionContext {
  /** Read-only manifest of the agent's subsystems (stable, documented). */
  readonly services: AgentServices;
  /** In-process event bus mirroring `AgentEvent`s broadcast to the host. */
  readonly events: EventSubscriptionBus;
  /** The plugin's default config (manifest `config` block) or undefined. */
  readonly config: Readonly<Record<string, unknown>> | undefined;
  readonly pluginId: string;
}

/** The shape a code plugin's entry point must export. */
export interface ExtensionModule {
  activate(context: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** A plugin that declares a code entry point, ready to be loaded. */
export interface DiscoveredExtension {
  readonly pluginId: string;
  readonly entryPoint: string;
  readonly manifest: PluginManifest;
}
