/**
 * Per-subagent-instance provenance registry + Agents-view row mapping.
 *
 * The slot state machine (utils/subagent-slots.ts) aggregates instances per
 * *type* and only keeps the latest live agentId: it can answer "which type is
 * busy" but not "who spawned this instance". This module keeps the missing
 * half — one in-memory record per spawned subagent instance, captured from
 * `subagent.spawned` and closed by `subagent.completed` / `subagent.failed` —
 * plus the pure mapping from (slot snapshot + registry) to the display rows
 * the /tasks browser renders.
 *
 * Parentage sources, all read straight off the wire event:
 *  - `parentAgentId`: the agent that owns the spawning call. `main` (or
 *    absent) means a top-level spawn; another subagent's id means a nested
 *    (grandchild) spawn. This is what makes "who spawned whom" answerable.
 *  - `parentToolCallId`: the real spawning tool-call id. Unlike
 *    `subagentInfo.parentToolCallId` it is never rewritten to a WolfPack
 *    routing id, so it stays resolvable.
 *  - `description`: spawn description, e.g. `rlm subagent: <name>`.
 *
 * TUI-side only: no persistence, no agent-core contract change.
 */

import type { SubagentSpawnedEvent } from '@scream-code/scream-code-sdk';

import { MAIN_AGENT_ID } from '#/tui/constant/scream-tui';
import type { ToolCallBlockData } from '#/tui/types';
import type { SubagentSlot, SubagentSlotStatus } from '#/tui/utils/subagent-slots';

/**
 * agent-core synthesizes `rlm_<timestamp>_<rand>` parent tool-call ids for
 * rlm() spawns (packages/agent-core/src/agent/tool/index.ts:374), so no
 * tool-call row ever exists for them — the id shape is the only RLM marker
 * available to the TUI. A renamed prefix degrades to the generic "unknown"
 * attribution, never to a wrong one.
 */
const RLM_TOOL_CALL_PREFIX = 'rlm_';

/** Guard against a corrupt or cyclic parent chain hanging the render path. */
const MAX_CHAIN_DEPTH = 16;

/** One spawned subagent instance, as observed by the TUI. */
export interface SubagentInstanceInfo {
  readonly agentId: string;
  /** Subagent profile name (the slot type it belongs to). */
  readonly type: string;
  /** Spawn description (`rlm subagent: <name>`, Agent/WolfPack description…). */
  readonly description: string | undefined;
  /** Owner of the spawning call: `main`/undefined for top-level spawns, another
   *  subagent's id for nested ones. */
  readonly parentAgentId: string | undefined;
  /** The real spawning tool-call id (never a WolfPack routing id). */
  readonly parentToolCallId: string;
  /** Name of the spawning tool call, resolved while it was still in flight. */
  readonly parentToolName: string | undefined;
  /** Description of the spawning tool call, resolved at spawn time. */
  readonly parentToolDescription: string | undefined;
  readonly spawnedAt: number;
  /** Set once the instance reports subagent.completed / subagent.failed. The
   *  field is cleared when the same agentId is resumed (re-spawned). */
  readonly endedAt?: number | undefined;
  readonly outcome?: 'completed' | 'failed' | undefined;
}

function descriptionFromToolCall(call: ToolCallBlockData | undefined): string | undefined {
  const fromArgs = call?.args['description'];
  if (typeof call?.description === 'string' && call.description.length > 0) return call.description;
  return typeof fromArgs === 'string' && fromArgs.length > 0 ? fromArgs : undefined;
}

/** Snapshot a spawn event (+ the spawning tool call, still in flight at that
 *  moment) into a registry record. `spawnedAt` is passed in so a resume keeps
 *  the instance's original start time. */
export function createSubagentInstanceInfo(
  event: SubagentSpawnedEvent,
  parentToolCall: ToolCallBlockData | undefined,
  spawnedAt: number = Date.now(),
): SubagentInstanceInfo {
  return {
    agentId: event.subagentId,
    type: event.subagentName,
    description: event.description,
    parentAgentId: event.parentAgentId,
    parentToolCallId: event.parentToolCallId,
    parentToolName: parentToolCall?.name,
    parentToolDescription: descriptionFromToolCall(parentToolCall),
    spawnedAt,
  };
}

/** Close a registry record on subagent.completed / subagent.failed. */
export function withSubagentInstanceEnded(
  info: SubagentInstanceInfo,
  outcome: 'completed' | 'failed',
  endedAt: number = Date.now(),
): SubagentInstanceInfo {
  return { ...info, endedAt, outcome };
}

/**
 * Row status: the live slot status when the agent is running, otherwise the
 * last instance's terminal outcome. `idle` means "no live instance and no
 * recorded outcome" — the honest gap the slot machine cannot fill (an ended
 * agent type keeps no status of its own).
 */
export type AgentRowStatus = SubagentSlotStatus | 'completed' | 'failed';

/** Which evidence anchored a row's source. */
export type AgentSourceKind =
  /** Spawning tool call resolved (Agent / WolfPack / …). */
  | 'tool'
  /** Synthesized `rlm_…` call — derived from an rlm() host call. */
  | 'rlm'
  /** Spawned by another subagent (parent instance is in the registry). */
  | 'agent'
  /** Spawned by the main agent, spawning call not resolvable. */
  | 'main'
  /** No parent evidence at all (e.g. resumed session). */
  | 'unknown';

export interface AgentSource {
  readonly kind: AgentSourceKind;
  /** Name of the spawning tool call or of the parent agent. */
  readonly name: string | undefined;
  /** Description of the spawning call or of the parent agent. */
  readonly description: string | undefined;
}

/** Display row of the /tasks browser's Agents view (one per slot, plus one
 *  per registry-only type the slot cap pushed out). */
export interface AgentRow {
  /** Slot type — stable across refreshes, used to keep the selection. */
  readonly key: string;
  readonly type: string;
  readonly status: AgentRowStatus;
  readonly live: boolean;
  readonly count: number;
  /** Latest activity hint from the slot (`tool: Bash`, delta preview…). */
  readonly detail: string | undefined;
  readonly lastActivityAt: number;
  /** Spawn description of the row's latest instance. */
  readonly description: string | undefined;
  /** Latest live instance id (slot's agentId), when there is one. */
  readonly instanceId: string | undefined;
  readonly source: AgentSource;
  /** Parent types, nearest first, stopping before the main agent. */
  readonly ancestors: readonly string[];
  /** True when the ancestor walk stopped early (missing link / cycle / cap). */
  readonly chainTruncated: boolean;
}

/** Walk `parentAgentId` upwards, collecting parent types (nearest first). */
export function buildAncestorChain(
  instance: SubagentInstanceInfo,
  instances: ReadonlyMap<string, SubagentInstanceInfo>,
): { readonly names: readonly string[]; readonly truncated: boolean } {
  const names: string[] = [];
  const seen = new Set<string>([instance.agentId]);
  let parentId = instance.parentAgentId;
  while (
    parentId !== undefined &&
    parentId !== MAIN_AGENT_ID &&
    parentId.length > 0
  ) {
    if (seen.has(parentId) || names.length >= MAX_CHAIN_DEPTH) {
      return { names, truncated: true };
    }
    seen.add(parentId);
    const parent = instances.get(parentId);
    if (parent === undefined) return { names, truncated: true };
    names.push(parent.type);
    parentId = parent.parentAgentId;
  }
  return { names, truncated: false };
}

/** Best-effort "who triggered this instance" resolution. */
function resolveSource(
  instance: SubagentInstanceInfo,
  instances: ReadonlyMap<string, SubagentInstanceInfo>,
): AgentSource {
  const parentId = instance.parentAgentId;
  const parentInstance =
    parentId !== undefined && parentId !== MAIN_AGENT_ID ? instances.get(parentId) : undefined;
  const isRlm = instance.parentToolCallId.startsWith(RLM_TOOL_CALL_PREFIX);

  if (parentInstance !== undefined) {
    // Nested spawn: the parent agent's identity beats the tool-call name.
    return {
      kind: isRlm ? 'rlm' : 'agent',
      name: parentInstance.type,
      description: parentInstance.description,
    };
  }
  if (isRlm) {
    // The synthesized id has no tool-call row; an unknown parent keeps `name`
    // empty rather than guessing.
    return { kind: 'rlm', name: undefined, description: instance.description };
  }
  if (instance.parentToolName !== undefined) {
    return {
      kind: 'tool',
      name: instance.parentToolName,
      description: instance.parentToolDescription,
    };
  }
  if (parentId === undefined || parentId === MAIN_AGENT_ID) {
    return { kind: 'main', name: undefined, description: undefined };
  }
  return { kind: 'unknown', name: undefined, description: undefined };
}

/**
 * Map the slot snapshot + instance registry into Agents-view rows.
 *
 * One row per slot that is live or has any instance history in this session
 * (never-used slots stay out), plus one row per *registry-only* type: past
 * `MAX_SUBAGENT_SLOTS` the slot machine returns a detached slot that never
 * reaches `slots`, so the 17th+ type would otherwise spawn and finish
 * invisibly while the registry still records every instance. A synthesized
 * row is never live, takes its status from the type's latest instance
 * (`completed` / `failed`, else `idle` when nothing terminal was recorded),
 * counts every recorded instance of the type and has no `instanceId`; its
 * source and ancestors use the same derivation as slot-backed rows. Live rows
 * sort first (most recent activity on top), then ended ones by their end time.
 */
export function buildAgentRows(
  slots: readonly SubagentSlot[],
  instances: ReadonlyMap<string, SubagentInstanceInfo>,
): AgentRow[] {
  interface TypeAggregate {
    latest: SubagentInstanceInfo;
    count: number;
  }
  const byType = new Map<string, TypeAggregate>();
  for (const info of instances.values()) {
    const aggregate = byType.get(info.type);
    if (aggregate === undefined) {
      byType.set(info.type, { latest: info, count: 1 });
      continue;
    }
    aggregate.count += 1;
    if (info.spawnedAt >= aggregate.latest.spawnedAt) {
      aggregate.latest = info;
    }
  }

  const rows: Array<{ row: AgentRow; sortAt: number }> = [];
  const slottedTypes = new Set<string>();
  for (const slot of slots) {
    slottedTypes.add(slot.type);
    const latest = byType.get(slot.type)?.latest;
    const live = slot.count > 0 || slot.status !== 'idle';
    if (!live && latest === undefined) continue;

    const liveInstance = slot.agentId === undefined ? undefined : instances.get(slot.agentId);
    const current = liveInstance ?? latest;
    const status: AgentRowStatus = live ? slot.status : (latest?.outcome ?? 'idle');
    const chain =
      current === undefined ? { names: [], truncated: false } : buildAncestorChain(current, instances);

    const row: AgentRow = {
      key: slot.type,
      type: slot.type,
      status,
      live,
      count: slot.count,
      detail: slot.detail,
      lastActivityAt: slot.lastActivityAt,
      description: current?.description,
      instanceId: live ? slot.agentId : undefined,
      source: current === undefined ? { kind: 'unknown', name: undefined, description: undefined } : resolveSource(current, instances),
      ancestors: chain.names,
      chainTruncated: chain.truncated,
    };
    const sortAt = live
      ? slot.lastActivityAt
      : (latest?.endedAt ?? latest?.spawnedAt ?? slot.lastActivityAt);
    rows.push({ row, sortAt });
  }

  // Registry-only types (the slot cap pushed them out of `slots`) still get a
  // row: ended-looking like an idle slot with history, but with the count and
  // the last activity read straight off the registry.
  for (const [type, aggregate] of byType) {
    if (slottedTypes.has(type)) continue;
    const { latest } = aggregate;
    const activityAt = latest.endedAt ?? latest.spawnedAt;
    const chain = buildAncestorChain(latest, instances);
    rows.push({
      row: {
        key: type,
        type,
        status: latest.outcome ?? 'idle',
        live: false,
        count: aggregate.count,
        detail: undefined,
        lastActivityAt: activityAt,
        description: latest.description,
        instanceId: undefined,
        source: resolveSource(latest, instances),
        ancestors: chain.names,
        chainTruncated: chain.truncated,
      },
      sortAt: activityAt,
    });
  }

  rows.sort((a, b) => {
    if (a.row.live !== b.row.live) return a.row.live ? -1 : 1;
    return b.sortAt - a.sortAt;
  });
  return rows.map((entry) => entry.row);
}
