import type { AgentServices } from '../../agent';
import type { EventHandler, Unsubscribe } from '../../agent/events';
import type { AgentEvent } from '../../rpc';
import type { PluginManifest } from '../types';

/**
 * The event-bus view handed to a single activation. It is the public surface of
 * `EventSubscriptionBus` an extension uses; the runtime wraps the real bus so
 * every subscription made during `activate()` can be released if activation
 * fails (otherwise a half-activated plugin would keep receiving events forever).
 */
export interface ExtensionEventBus {
  subscribe(type: AgentEvent['type'] | '*', handler: EventHandler): Unsubscribe;
  /** Drop every subscription made through this (per-plugin) view. */
  clear(): void;
}

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
  readonly events: ExtensionEventBus;
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
