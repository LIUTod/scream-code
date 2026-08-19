import type { AgentEvent } from '#/rpc';

export type EventHandler = (event: AgentEvent) => void;
export type Unsubscribe = () => void;

/**
 * In-process subscription bus for {@link AgentEvent}s.
 *
 * Mirrors the events the agent already broadcasts to the host via
 * `rpc.emitEvent`, so third-party extensions running inside the agent process
 * can subscribe without round-tripping through the host. This is the
 * read-side companion to {@link import('./index').Agent.emitEvent}.
 *
 * Lifecycle: extensions call `subscribe()` when activated and must call
 * `clear()` (or the returned unsubscribe) when deactivated to avoid leaking
 * handlers across sessions/restarts.
 */
export class EventSubscriptionBus {
  private readonly byType = new Map<AgentEvent['type'], Set<EventHandler>>();
  private readonly wildcard = new Set<EventHandler>();

  /**
   * Subscribe to a specific event type (or `'*'` for all events).
   * Returns an unsubscribe function.
   */
  subscribe(type: AgentEvent['type'] | '*', handler: EventHandler): Unsubscribe {
    if (type === '*') {
      this.wildcard.add(handler);
      return () => {
        this.wildcard.delete(handler);
      };
    }
    let set = this.byType.get(type);
    if (set === undefined) {
      set = new Set<EventHandler>();
      this.byType.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** Drop every subscriber (used on deactivate / session switch). */
  clear(): void {
    this.byType.clear();
    this.wildcard.clear();
  }

  /**
   * Deliver an event to matching handlers. A handler that throws is isolated
   * so a subscriber bug can never break the agent's event loop.
   */
  dispatch(event: AgentEvent): void {
    const typed = this.byType.get(event.type);
    if (typed !== undefined) {
      for (const handler of typed) {
        try {
          handler(event);
        } catch {
          // Swallow: a subscriber must not break the loop.
        }
      }
    }
    if (this.wildcard.size > 0) {
      for (const handler of this.wildcard) {
        try {
          handler(event);
        } catch {
          // Swallow.
        }
      }
    }
  }
}
