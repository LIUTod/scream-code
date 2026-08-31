import type { Agent } from '..';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  isNewerWireVersion,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from './migration';
import { SNAPSHOT_FOLDED_CONTEXT_TYPES } from './persistence';
import type { AgentRecord, AgentRecordPersistence } from './types';
import { recoverMemosFromCompactionSummary } from '../compaction/full';

export * from './types';
export { AGENT_WIRE_PROTOCOL_VERSION } from './migration';
export {
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
} from './persistence';
export type { FileSystemAgentRecordPersistenceOptions } from './persistence';
export { BlobStore, isBlobRef } from './blobref';
export type { BlobStoreOptions } from './blobref';

// Contract: restore MUST NOT emit UI events, call the LLM, execute tools, or
// touch the filesystem in a way that triggers external side effects. Each case
// should reproduce the in-memory state the live handler left behind, nothing more.

/**
 * Record types whose state is fully captured by a `context.snapshot` record.
 * When a snapshot exists, every one of these that predates it is skipped during
 * replay because the snapshot already holds the folded context memory. Note
 * `micro_compaction.apply` is written with an `as never` cast (it is not part of
 * the AgentRecord union), so it is matched here by its literal type string.
 *
 * `full_compaction.complete` is included because its only lasting effect is
 * pushing onto `compactedHistory` — a debug trail rendered from the pre-fold
 * history. Snapshot replay skips that pre-fold history, so the trail would be
 * re-rendered as empty; the snapshot carries the trail itself instead.
 *
 * The canonical definition lives in persistence.ts (it also drives the
 * parse-skipping fast path during read); imported from there.
 */
function isSnapshotFoldedContextRecord(type: string): boolean {
  return SNAPSHOT_FOLDED_CONTEXT_TYPES.has(type);
}

function restoreAgentRecord(agent: Agent, input: AgentRecord): void {
  switch (input.type) {
    case 'metadata':
      return;
    case 'turn.prompt':
      agent.turn.restorePrompt();
      return;
    case 'turn.steer':
      agent.turn.restoreSteer(input.input, input.origin);
      return;
    case 'turn.cancel':
      agent.turn.cancel(input.turnId);
      return;
    case 'background.stop':
      return;
    case 'config.update':
      agent.config.update(input);
      return;
    case 'permission.set_mode':
      agent.permission.setMode(input.mode);
      return;
    case 'permission.record_approval_result':
      agent.permission.recordApprovalResult(input);
      return;
    case 'usage.record':
      // Preserve the original scope so the recorder's turn-scoped total
      // (turnTotal) is restored correctly on resume; hardcoding 'session'
      // here would zero it out. skipCurrentTurn keeps a resumed agent's
      // currentTurn undefined — there is no live turn during restore.
      agent.usage.record(input.model, input.usage, input.usageScope ?? 'session', {
        skipCurrentTurn: true,
      });
      return;
    case 'full_compaction.begin':
      agent.fullCompaction.begin(input);
      return;
    case 'full_compaction.cancel':
      agent.fullCompaction.cancel();
      return;
    case 'full_compaction.complete':
      agent.fullCompaction.markCompleted();
      return;
    case 'plan_mode.enter':
      agent.planMode.restoreEnter({ id: input.id, strategy: input.strategy });
      return;
    case 'plan_mode.cancel':
      agent.planMode.cancel(input.id);
      return;
    case 'plan_mode.exit':
      agent.planMode.exit(input.id);
      return;
    case 'wolfpack.enter':
      agent.wolfpackMode.restoreEnter();
      return;
    case 'wolfpack.exit':
      agent.wolfpackMode.exit();
      return;
    case 'rlm.enter':
      agent.restoreRlm(true);
      return;
    case 'rlm.exit':
      agent.restoreRlm(false);
      return;
    case 'goal.create':
      agent.goal.restoreCreate(input);
      return;
    case 'goal.update':
      agent.goal.restoreUpdate(input);
      return;
    case 'goal.clear':
      agent.goal.restoreClear(input);
      return;
    case 'context.append_message':
      agent.context.appendMessage(input.message);
      return;
    case 'context.append_loop_event':
      agent.context.appendLoopEvent(input.event);
      return;
    case 'context.clear':
      agent.context.clear();
      return;
    case 'context.undo':
      agent.context.undo(input.count);
      return;
    case 'context.apply_compaction':
      agent.context.applyCompaction(input);
      // Recovery: the compaction record hits the wire before the memo
      // extraction step; a crash in that window loses memos. Re-parse the
      // persisted summary and re-store whatever the extraction never wrote.
      // Intentionally fire-and-forget with a symmetric design: the recovery
      // is idempotent (skips already-stored memos), so an interrupted
      // attempt simply runs again on the next resume.
      void recoverMemosFromCompactionSummary(agent, input.summary);
      return;
    case 'context.snapshot':
      agent.context.restoreJSONSnapshot(input.snapshot);
      agent.fullCompaction.restoreCompactedHistory(input.compactedHistory);
      // The folded context records were skipped, so `appendMessage`'s
      // pushHistory side effects never ran for them. Re-run the two observable
      // ones (replay log for RPC playback, background notification marking) so
      // snapshot replay matches a full replay exactly.
      for (const message of agent.context.history) {
        if (message.origin?.kind === 'background_task') {
          agent.background.markDeliveredNotification(message.origin);
        }
        agent.replayBuilder.push({ type: 'message', message });
      }
      return;
    case 'tools.register_user_tool':
      agent.tools.registerUserTool(input);
      return;
    case 'tools.unregister_user_tool':
      agent.tools.unregisterUserTool(input.name);
      return;
    case 'tools.set_active_tools':
      agent.tools.setActiveTools(input.names);
      return;
    case 'tools.update_store':
      agent.tools.updateStore(input.key, input.value);
      return;
  }
}

export class AgentRecords {
  private _restoring = false;
  private metadataInitialized = false;

  constructor(
    private readonly agent: Agent,
    private readonly persistence?: AgentRecordPersistence,
  ) {}

  get restoring() {
    return this._restoring;
  }

  logRecord(record: AgentRecord): void {
    if (this._restoring) return;
    const stamped: AgentRecord =
      record.time !== undefined ? record : { ...record, time: Date.now() };
    if (
      this.persistence !== undefined &&
      !this.metadataInitialized &&
      stamped.type !== 'metadata'
    ) {
      this.persistence.append({
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: Date.now(),
      });
      this.metadataInitialized = true;
    }
    if (stamped.type === 'metadata') {
      this.metadataInitialized = true;
    }
    this.persistence?.append(stamped);
  }

  restore(record: AgentRecord): void {
    this._restoring = true;
    try {
      restoreAgentRecord(this.agent, record);
    } finally {
      this._restoring = false;
    }
  }

  async replay(): Promise<{ warning?: string }> {
    if (!this.persistence) throw new Error('No persistence provided for AgentRecords');
    let migrations: readonly WireMigration[] = [];
    let hasMetadata = false;
    let shouldRewrite = false;
    let warning: string | undefined;
    const replayedRecords: AgentRecord[] = [];
    for await (const record of this.persistence.read()) {
      if (!hasMetadata) {
        if (record.type !== 'metadata') {
          throw new Error('AgentRecords replay expected metadata as the first record');
        }
        hasMetadata = true;
        this.metadataInitialized = true;
        const readVersion = record.protocol_version;
        if (isNewerWireVersion(readVersion)) {
          warning = `Session wire protocol version ${readVersion} is newer than the current version ${AGENT_WIRE_PROTOCOL_VERSION}. Records will be replayed without migration.`;
          shouldRewrite = false;
        } else {
          migrations = resolveWireMigrations(readVersion);
          shouldRewrite = readVersion !== AGENT_WIRE_PROTOCOL_VERSION;
        }
      }
      let migratedRecord = migrateWireRecord(
        record as WireMigrationRecord,
        migrations,
      ) as AgentRecord;
      if (migratedRecord.type === 'metadata') {
        migratedRecord = {
          ...migratedRecord,
          protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        };
      }
      replayedRecords.push(migratedRecord);
    }

    // Snapshot fast-path: when a `context.snapshot` record exists, restore it and
    // skip every context-content record that predates it. Those appends/compactions
    // were already folded into the snapshot, so re-applying them is redundant work
    // that dominates resume time on long sessions (hundreds of thousands of records
    // collapsing into a handful of live messages). Metadata and other subsystem
    // records are still applied in order, both before and after the snapshot.
    let snapshotIndex = -1;
    for (let i = replayedRecords.length - 1; i >= 0; i--) {
      if (replayedRecords[i]?.type === 'context.snapshot') {
        snapshotIndex = i;
        break;
      }
    }
    // Captured from the last folded apply_compaction record when a snapshot
    // fast-path skips it: the live extraction step runs after the compaction
    // record hits the wire, so a crash in that window loses the memos. The
    // skipped record is not replayed, so recover from the remembered summary
    // at the snapshot point (idempotent - skips already-stored memos).
    let foldedCompactionSummary: string | undefined;
    for (let i = 0; i < replayedRecords.length; i++) {
      const record = replayedRecords[i];
      if (!record) continue;
      if (i < snapshotIndex && isSnapshotFoldedContextRecord(record.type)) {
        if (record.type === 'context.apply_compaction') {
          foldedCompactionSummary = record.summary;
        }
        continue;
      }
      this.restore(record);
      if (record.type === 'context.snapshot' && foldedCompactionSummary !== undefined) {
        void recoverMemosFromCompactionSummary(this.agent, foldedCompactionSummary);
        foldedCompactionSummary = undefined;
      }
    }

    // A turn that ended mid-step leaves an open assistant message in the wire
    // (step.begin is persisted, step.end is not). The live path drops such
    // vacuous messages at turn end; mirror that here so a resumed session's
    // history matches what the interrupted live session actually retained.
    this.agent.context.dropVacuousOpenMessages();

    if (shouldRewrite) {
      this.persistence.rewrite(replayedRecords);
      await this.persistence.flush();
    }
    if (this.agent.blobStore !== undefined) {
      for (const msg of this.agent.context.history) {
        await this.agent.blobStore.rehydrateParts(msg.content);
      }
    }
    return { warning };
  }

  async flush(): Promise<void> {
    await this.persistence?.flush();
  }
}
