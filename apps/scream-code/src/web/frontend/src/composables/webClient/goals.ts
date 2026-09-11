import type { CreateGoalRequest, UpdateGoalRequest } from '../../types';
import { buildCreateGoalBody, buildUpdateGoalBody, isCurrentSessionRequest } from '../../utils/goalTodoState';
import { API_BASE, type ClientContext } from './state';

export interface GoalsModule {
  refineGoal(description: string): Promise<string | null>;
  createGoal(request: CreateGoalRequest): Promise<boolean>;
  updateGoal(request: UpdateGoalRequest): Promise<boolean>;
  pauseGoal(): Promise<boolean>;
  resumeGoal(): Promise<boolean>;
  cancelGoal(): Promise<boolean>;
}

export function createGoalsModule(ctx: ClientContext): GoalsModule {
  const { s } = ctx;

  function syncGoalRequestPending(): void {
    s.goalRequestPending.value = s.goalRequestInFlight || s.goalAwaitingMutation !== null;
  }

  function resetGoalRequestState(): void {
    s.goalMutationGeneration++;
    s.goalAwaitingMutation = null;
    s.goalRequestInFlight = false;
    s.snapshotRetryGoalGeneration = null;
    s.goalRequestPending.value = false;
    s.goalRequestError.value = null;
  }

  async function requestGoal(
    path: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    waitForState: boolean,
  ): Promise<Record<string, unknown> | null> {
    const targetSessionId = s.sessionId.value;
    if (!targetSessionId) {
      s.goalRequestError.value = '暂无可操作的会话。';
      return null;
    }
    if (s.connectionStatus.value !== 'connected') {
      s.goalRequestError.value = '连接已断开，请等待重连后再试。';
      return null;
    }
    if (s.isArchived.value) {
      s.goalRequestError.value = '当前会话已归档，无法修改 Goal。';
      return null;
    }
    if (s.goalRequestInFlight) {
      s.goalRequestError.value = '正在处理上一个请求，请稍候。';
      return null;
    }
    if (s.goalAwaitingMutation !== null) {
      // Stale guard: if waiting too long, clear and allow retry.
      s.goalAwaitingMutation = null;
      syncGoalRequestPending();
    }

    const targetSessionGeneration = s.sessionGeneration;
    const requestGeneration = ++s.goalMutationGeneration;
    s.goalRequestInFlight = true;
    syncGoalRequestPending();
    s.goalRequestError.value = null;
    try {
      const res = await fetch(`${API_BASE}/sessions/${targetSessionId}/goal${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (
        !isCurrentSessionRequest(
          s.sessionId.value,
          s.sessionGeneration,
          targetSessionId,
          targetSessionGeneration,
        ) || s.goalMutationGeneration !== requestGeneration
      ) return null;
      if (!res.ok) {
        s.goalRequestError.value = typeof data['message'] === 'string'
          ? data['message']
          : `请求失败（HTTP ${res.status}）`;
        return null;
      }
      if (waitForState) {
        s.goalAwaitingMutation = { generation: requestGeneration };
        s.snapshotRetryGoalGeneration = requestGeneration;
      }
      return data;
    } catch (requestError) {
      if (
        isCurrentSessionRequest(
          s.sessionId.value,
          s.sessionGeneration,
          targetSessionId,
          targetSessionGeneration,
        ) && s.goalMutationGeneration === requestGeneration
      ) {
        s.goalRequestError.value = `请求失败：${requestError instanceof Error ? requestError.message : String(requestError)}`;
      }
      return null;
    } finally {
      if (
        isCurrentSessionRequest(
          s.sessionId.value,
          s.sessionGeneration,
          targetSessionId,
          targetSessionGeneration,
        ) && s.goalMutationGeneration === requestGeneration
      ) {
        s.goalRequestInFlight = false;
        syncGoalRequestPending();
      }
    }
  }

  async function refineGoal(description: string): Promise<string | null> {
    const data = await requestGoal('/refine', 'POST', { description }, false);
    return typeof data?.['objective'] === 'string' ? data['objective'] : null;
  }

  async function createGoal(request: CreateGoalRequest): Promise<boolean> {
    const data = await requestGoal('', 'POST', buildCreateGoalBody(request), true);
    if (data === null) return false;
    if (s.goalAwaitingMutation !== null) void ctx.fetchSnapshot(s.goalAwaitingMutation.generation);
    return true;
  }

  async function updateGoal(request: UpdateGoalRequest): Promise<boolean> {
    const data = await requestGoal('', 'PATCH', buildUpdateGoalBody(request), true);
    if (data === null) return false;
    if (s.goalAwaitingMutation !== null) void ctx.fetchSnapshot(s.goalAwaitingMutation.generation);
    return true;
  }

  async function runGoalLifecycle(path: '/pause' | '/resume' | '/cancel'): Promise<boolean> {
    const data = await requestGoal(path, 'POST', {}, true);
    if (data === null) return false;
    if (s.goalAwaitingMutation !== null) void ctx.fetchSnapshot(s.goalAwaitingMutation.generation);
    return true;
  }

  function pauseGoal(): Promise<boolean> {
    return runGoalLifecycle('/pause');
  }

  function resumeGoal(): Promise<boolean> {
    return runGoalLifecycle('/resume');
  }

  function cancelGoal(): Promise<boolean> {
    return runGoalLifecycle('/cancel');
  }

  ctx.resetGoalRequestState = resetGoalRequestState;
  ctx.syncGoalRequestPending = syncGoalRequestPending;

  return { refineGoal, createGoal, updateGoal, pauseGoal, resumeGoal, cancelGoal };
}
