import type { SessionSnapshot } from '../../types';
import { canApplySnapshot } from '../../utils/goalTodoState';
import { API_BASE, generateId, type ClientContext } from './state';

export interface SnapshotsModule {
  fetchSnapshot(goalGeneration?: number): Promise<void>;
}

export function createSnapshotsModule(ctx: ClientContext): SnapshotsModule {
  const { s, showToast } = ctx;

  function scheduleSnapshotRetry(): void {
    if (s.disposed || s.snapshotRetryTimer !== null) return;
    s.snapshotRetryTimer = window.setTimeout(() => {
      s.snapshotRetryTimer = null;
      const goalGeneration = s.snapshotRetryGoalGeneration;
      s.snapshotRetryGoalGeneration = null;
      void fetchSnapshot(goalGeneration ?? undefined);
    }, 250);
  }

  async function fetchSnapshot(goalGeneration?: number): Promise<void> {
    const targetSessionId = s.sessionId.value;
    if (!targetSessionId) return;
    // First paint: request a tail-window snapshot so very long sessions do not
    // ship the whole journal. Reconnects (messages already in memory) keep the
    // full snapshot to avoid dropping history.
    const tail = s.messages.value.length === 0 ? 100 : undefined;
    const targetSessionGeneration = s.sessionGeneration;
    const targetConnectionGeneration = s.connectionGeneration;
    const targetPromptGeneration = s.promptGeneration;
    const targetLiveGeneration = s.liveGeneration;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSessionId}/snapshot${tail ? `?tail=${tail}` : ''}`);
      if (!res.ok) {
        if (goalGeneration !== undefined && s.goalAwaitingMutation?.generation === goalGeneration) {
          s.snapshotRetryGoalGeneration = goalGeneration;
          scheduleSnapshotRetry();
        }
        return;
      }
      const snapshot: SessionSnapshot = await res.json();
      if (!canApplySnapshot({
        snapshot,
        targetSessionId,
        currentSessionId: s.sessionId.value,
        targetSessionGeneration,
        currentSessionGeneration: s.sessionGeneration,
        targetConnectionGeneration,
        currentConnectionGeneration: s.connectionGeneration,
        targetPromptGeneration,
        currentPromptGeneration: s.promptGeneration,
        targetLiveGeneration,
        currentLiveGeneration: s.liveGeneration,
        currentEpoch: s.epoch,
        currentSeq: s.seq,
      })) {
        if (goalGeneration !== undefined) s.snapshotRetryGoalGeneration = goalGeneration;
        scheduleSnapshotRetry();
        return;
      }
      applySnapshot(snapshot, goalGeneration);
    } catch {
      if (goalGeneration !== undefined && s.goalAwaitingMutation?.generation === goalGeneration) {
        s.snapshotRetryGoalGeneration = goalGeneration;
        scheduleSnapshotRetry();
      }
    }
  }

  function applySnapshot(snapshot: SessionSnapshot, goalGeneration?: number): void {
    // The snapshot is authoritative (server journal includes volatile deltas):
    // drop any locally buffered stream chunks so they cannot be re-appended
    // to the new snapshot's last message (background-tab + reconnect case).
    s.pendingAssistantDelta = '';
    s.pendingThinkingDelta = '';
    s.pendingToolProgress.clear();
    // Preserve local-only messages (command results, system notices) that are
    // not in the server journal. Without this, applySnapshot's full replace
    // would drop them - the "闪一下" bug.
    const localMsgs = s.messages.value.filter((m) => m.local);
    const pendingClientId = s.sentMessageIds.keys().next().value;
    const pendingEntry = pendingClientId ? s.sentMessageIds.get(pendingClientId) : undefined;
    const pendingLocal = pendingEntry
      ? s.messages.value.find((m) => m.id === pendingEntry.messageId)
      : undefined;
    const pendingCovered = Boolean(
      pendingClientId && snapshot.messages.some((m) => m.clientMessageId === pendingClientId),
    );
    const pendingLost = Boolean(
      pendingEntry && !pendingCovered && pendingEntry.connectionGeneration < s.connectionGeneration,
    );
    if (pendingLost && pendingLocal) pendingLocal.isError = true;
    const pendingMessages = pendingLocal && !pendingCovered ? [pendingLocal] : [];
    s.messages.value = [
      ...snapshot.messages.map((m) => ({ ...m, id: m.id ?? generateId() })),
      ...localMsgs,
      ...pendingMessages,
    ];
    // Re-anchor the per-turn counter to the latest snapshotted turn so a new
    // session (or restored history) does not keep counting up across sessions.
    for (let i = s.messages.value.length - 1; i >= 0; i--) {
      const stats = s.messages.value[i]?.turnStats;
      if (stats && typeof stats.turn === 'number' && stats.turn > 0) {
        s.turnNumber = stats.turn;
        break;
      }
    }
    s.pendingApprovals.value = snapshot.pendingApprovals;
    s.status.value = { ...snapshot.status, busy: snapshot.busy };
    s.olderAvailable.value = Boolean(snapshot.olderAvailable);
    s.oldestSeq.value = snapshot.oldestSeq;
    s.goal.value = snapshot.goal;
    s.todos.value = snapshot.todos;
    if (
      goalGeneration !== undefined &&
      s.goalAwaitingMutation !== null &&
      s.goalAwaitingMutation.generation === goalGeneration &&
      s.goalMutationGeneration === goalGeneration
    ) {
      s.goalAwaitingMutation = null;
      ctx.syncGoalRequestPending();
    }
    if (pendingCovered || pendingLost) {
      s.promptPending.value = false;
      s.pendingPromptAccepted = false;
      s.sentMessageIds.clear();
      if (pendingLost) showToast('消息未送达，已恢复连接。', 'error');
    }
    s.seq = snapshot.seq;
    s.epoch = snapshot.epoch;
    s.workDir.value = snapshot.workDir;
  }

  ctx.fetchSnapshot = fetchSnapshot;

  return { fetchSnapshot };
}
