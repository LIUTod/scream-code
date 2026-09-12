/**
 * Subagent slot state machine for the sidebar Agents panel.
 *
 * The sidebar shows a fixed row per default subagent type (coder/explore/
 * plan/verify/reviewer/oracle/worker/writer — mirroring the default profile),
 * each in one of six states: idle (resting), working (tool call in flight),
 * outputting (streaming assistant output), messaging (main agent sending a
 * steer/queue message) and reworking (resumed by the main agent). Asking the
 * parent for help adds a transient requesting overlay. Types
 * outside the default eight are appended in spawn order (capped at
 * {@link MAX_SUBAGENT_SLOTS}).
 *
 * This is a pure TUI-side aggregator: it consumes agent-core wire events
 * (subagent lifecycle + routed activity + main-side SendSubagentMessage tool
 * calls) and never touches agent-core itself.
 */

export type SubagentSlotStatus =
  | 'idle'
  | 'working'
  | 'outputting'
  | 'messaging'
  | 'reworking'
  | 'requesting';

export interface SubagentSlot {
  readonly type: string;
  status: SubagentSlotStatus;
  /** Latest live instance agentId for this slot (undefined when idle). */
  agentId: string | undefined;
  /** Short human-readable hint about the latest activity (tool name, delta
   *  preview, message operation). Kept for future panels; the Agents panel
   *  renders type + status + count only, no live output preview. */
  detail: string | undefined;
  /** Number of live (spawned, not yet terminated) instances of this type
   *  sharing the slot. 0 when idle. */
  readonly count: number;
  /** Epoch ms of the last state change (drives e.g. "outputting for 3s"). */
  lastActivityAt: number;
}

/** Default subagent types, in the fixed display order of the slots. */
export const DEFAULT_SUBAGENT_TYPES: readonly string[] = [
  'coder',
  'explore',
  'plan',
  'verify',
  'reviewer',
  'oracle',
  'worker',
  'writer',
];

/** Hard cap so an exotic custom-profile spawn storm cannot overflow the panel. */
export const MAX_SUBAGENT_SLOTS = 16;

/** How long a `requesting` overlay stays visible after a subagent asks the
 *  parent for help. The request itself returns at once and the agent keeps
 *  working, so this is a display window, not a blocked state. */
export const REQUESTING_WINDOW_MS = 5000;

interface Instance {
  readonly type: string;
  generation: number;
}

export class SubagentSlots {
  private readonly slots = new Map<string, SubagentSlot>();
  private readonly instances = new Map<string, Instance>();
  /** Live instance count per type: a slot only returns to idle when the LAST
   * instance of that type terminates (WolfPack spawns several coders at once
   * and they share one visual slot). */
  private readonly runningByType = new Map<string, number>();
  /** main-side SendSubagentMessage tool callId → target subagent agentId. */
  private readonly messagingByCall = new Map<string, string>();
  /** Status to restore per TYPE when a messaging window closes, captured from
   * the first open window; concurrent windows on the same type keep counting
   * and the slot only exits messaging when the last window closes. */
  private readonly messagingPrev = new Map<string, SubagentSlotStatus>();
  /** Slot type → open `requesting` overlay. Keyed by type so several live
   *  instances of one type share a single marker; the real activity state stays
   *  untouched in the slot and shows back up once the overlay expires. */
  private readonly requesting = new Map<string, { until: number; agentId: string }>();
  /** Count of open messaging windows per type (handles same-type siblings). */
  private readonly messagingCount = new Map<string, number>();

  reset(): void {
    this.slots.clear();
    this.instances.clear();
    this.runningByType.clear();
    this.messagingByCall.clear();
    this.messagingPrev.clear();
    this.messagingCount.clear();
    this.requesting.clear();
  }

  /**
   * subagent.spawned. A first spawn starts the slot as working; a second
   * spawn of the SAME agentId means the main agent resumed it (返工中),
   * tracked via an instance generation counter.
   */
  onSpawned(agentId: string, subagentType: string, description?: string): void {
    const instance = this.instances.get(agentId);
    if (instance !== undefined) {
      instance.generation += 1;
      // A resumed run is a new live cycle: keep the per-type live count in
      // balance (this run will be terminated once more before going idle).
      this.runningByType.set(instance.type, (this.runningByType.get(instance.type) ?? 0) + 1);
      this.setState(
        instance.type,
        'reworking',
        agentId,
        description === undefined ? undefined : `resume: ${description}`,
      );
      return;
    }
    this.instances.set(agentId, { type: subagentType, generation: 1 });
    this.runningByType.set(subagentType, (this.runningByType.get(subagentType) ?? 0) + 1);
    this.setState(subagentType, 'working', agentId, description);
  }

  /** subagent.started. Keeps the current state (spawned already set it); only
   *  used to materialize a slot if lifecycle events raced past us. */
  onStarted(agentId: string): void {
    const instance = this.instances.get(agentId);
    if (instance === undefined) return;
    const slot = this.ensureSlot(instance.type);
    if (slot.status === 'idle') {
      slot.status = 'working';
      slot.agentId = agentId;
      slot.lastActivityAt = Date.now();
    }
  }

  /** subagent.completed / subagent.failed: the slot goes back to resting only
   *  when the LAST live instance of that type terminates (siblings spawned by
   *  the same tool call keep the slot busy). */
  onTerminated(agentId: string): void {
    const instance = this.instances.get(agentId);
    if (instance === undefined) return;
    // A terminated agent can no longer be waiting on help — drop its overlay.
    if (this.requesting.get(instance.type)?.agentId === agentId) {
      this.requesting.delete(instance.type);
    }
    const remaining = (this.runningByType.get(instance.type) ?? 1) - 1;
    if (remaining > 0) {
      this.runningByType.set(instance.type, remaining);
      const slot = this.ensureSlot(instance.type);
      slot.detail = undefined;
      slot.lastActivityAt = Date.now();
      return;
    }
    this.runningByType.delete(instance.type);
    this.setState(instance.type, 'idle', undefined, undefined);
  }

  /**
   * Routed subagent activity (agentId !== main):
   * - kind 'tool'      → working (tool call in flight)
   * - kind 'output'    → outputting (assistant/thinking delta)
   * - kind 'toolResult'→ detail only (the agent may keep working/outputting)
   */
  onActivity(
    agentId: string,
    kind: 'tool' | 'output' | 'toolResult',
    detail?: string,
  ): void {
    const instance = this.instances.get(agentId);
    if (instance === undefined) return;
    if (kind === 'toolResult') {
      const slot = this.ensureSlot(instance.type);
      slot.detail = detail;
      slot.lastActivityAt = Date.now();
      return;
    }
    this.setState(instance.type, kind === 'tool' ? 'working' : 'outputting', agentId, detail);
  }

  /** A subagent asked the parent for help. The request returns immediately and
   *  the agent keeps working, so this only raises a transient overlay — the real
   *  activity state stays in the slot and shows back up when it expires. While
   *  `messaging` is on screen the overlay loses (see visibleSlot). */
  onRequesting(agentId: string, at = Date.now()): void {
    const instance = this.instances.get(agentId);
    if (instance === undefined) return;
    this.requesting.set(instance.type, { until: at + REQUESTING_WINDOW_MS, agentId });
    const slot = this.ensureSlot(instance.type);
    slot.agentId = agentId;
    slot.lastActivityAt = at;
  }

  /**
   * Main-side SendSubagentMessage tool call started: the target subagent's
   * slot shows messaging until the tool call returns.
   */
  onMessagingStart(toolCallId: string, targetAgentId: string | undefined, operation?: string): void {
    if (targetAgentId === undefined) return;
    const instance = this.instances.get(targetAgentId);
    if (instance === undefined) return;
    this.messagingByCall.set(toolCallId, targetAgentId);
    // The parent is answering — a help request from this agent is served, so drop
    // its marker here instead of letting it resurface once the chat window ends.
    this.requesting.delete(instance.type);
    // Remember the slot's pre-chat status on the FIRST window; a second
    // concurrent window must not overwrite it with 'messaging'.
    const slot = this.ensureSlot(instance.type);
    if (slot.status !== 'messaging') {
      this.messagingPrev.set(instance.type, slot.status);
    }
    this.messagingCount.set(instance.type, (this.messagingCount.get(instance.type) ?? 0) + 1);
    this.setState(
      instance.type,
      'messaging',
      targetAgentId,
      operation === undefined ? undefined : `message (${operation})`,
    );
  }

  /** Tool call finished: the messaging window closes; restore the state the
   *  slot had before the chat (working/outputting), else idle. */
  onMessagingEnd(toolCallId: string): void {
    const target = this.messagingByCall.get(toolCallId);
    if (target === undefined) return;
    this.messagingByCall.delete(toolCallId);
    const instance = this.instances.get(target);
    if (instance === undefined) return;
    const slot = this.ensureSlot(instance.type);
    if (slot.status !== 'messaging') return;
    const remaining = (this.messagingCount.get(instance.type) ?? 1) - 1;
    if (remaining > 0) {
      this.messagingCount.set(instance.type, remaining);
      return; // other concurrent message window(s) still open
    }
    this.messagingCount.delete(instance.type);
    const prev = this.messagingPrev.get(instance.type);
    this.messagingPrev.delete(instance.type);
    const restore =
      prev === 'working' || prev === 'outputting' || prev === 'reworking' ? prev : 'idle';
    slot.status = restore;
    slot.detail = undefined;
    slot.lastActivityAt = Date.now();
  }

  /**
   * All slots in fixed display order: the eight default types first (always
   * present, idle when never used), then extra types in spawn order.
   */
  getSlots(at = Date.now()): readonly SubagentSlot[] {
    this.dropExpiredOverlays(at);
    const ordered: SubagentSlot[] = [];
    for (const type of DEFAULT_SUBAGENT_TYPES) {
      ordered.push(this.visibleSlot(type));
    }
    for (const slot of this.slots.values()) {
      if (DEFAULT_SUBAGENT_TYPES.includes(slot.type)) continue;
      ordered.push(this.visibleSlot(slot.type));
    }
    return ordered;
  }

  /** Display view of one slot: the real state with an unexpired `requesting`
   *  overlay on top. Read-path only — it never mutates. Callers must run
   *  {@link dropExpiredOverlays} first, and messaging clears the overlay in
   *  {@link onMessagingStart}; the `messaging` guard only covers same-tick ordering. */
  private visibleSlot(type: string): SubagentSlot {
    const slot = this.ensureSlot(type);
    const copy = { ...slot, count: this.runningByType.get(type) ?? 0 };
    if (this.requesting.has(type) && copy.status !== 'messaging') {
      copy.status = 'requesting';
    }
    return copy;
  }

  private dropExpiredOverlays(at: number): void {
    for (const [type, overlay] of this.requesting) {
      if (at >= overlay.until) this.requesting.delete(type);
    }
  }

  private ensureSlot(type: string): SubagentSlot {
    let slot = this.slots.get(type);
    if (slot === undefined) {
      // Cap: never grow beyond MAX_SUBAGENT_SLOTS (defaults occupy 8).
      if (this.slots.size >= MAX_SUBAGENT_SLOTS) {
        // Reuse the least-recently-active extra slot? No — keep it simple and
        // deterministic: treat it as a no-op by returning a detached slot.
        slot = {
          type,
          status: 'idle',
          agentId: undefined,
          detail: undefined,
          count: 0,
          lastActivityAt: 0,
        };
        return slot;
      }
      slot = {
        type,
        status: 'idle',
        agentId: undefined,
        detail: undefined,
        count: 0,
        lastActivityAt: Date.now(),
      };
      this.slots.set(type, slot);
    }
    return slot;
  }

  private setState(
    type: string,
    status: SubagentSlotStatus,
    agentId: string | undefined,
    detail: string | undefined,
  ): void {
    const slot = this.ensureSlot(type);
    slot.status = status;
    slot.agentId = agentId;
    slot.detail = detail;
    slot.lastActivityAt = Date.now();
  }
}
