/**
 * Format a `BackgroundTaskInfo` snapshot into the transcript card data
 * consumed by `BackgroundAgentStatusComponent`.
 *
 * Background tasks have six statuses (running / awaiting_approval /
 * completed / failed / killed / lost) but the transcript card only
 * renders three visual phases (started / completed / failed). The
 * mapping packs the extra nuance — exit code, kill reason, lost-reason
 * — into the dim detail line so the user still sees it.
 */

import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@scream-cli/scream-code-sdk';

import type { BackgroundAgentStatusData, BackgroundAgentStatusPhase } from '@/tui/types';

const MAX_DETAIL_LENGTH = 240;

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.trim().replaceAll(/\s+/g, ' ');
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_DETAIL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DETAIL_LENGTH - 3)}...`;
}

export type BackgroundTaskTranscriptPhase = 'started' | 'updated' | 'terminal';

function phaseFromStatus(status: BackgroundTaskStatus): BackgroundAgentStatusPhase {
  switch (status) {
    case 'running':
    case 'awaiting_approval':
      return 'started';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'killed':
    case 'lost':
      return 'failed';
  }
}

function subjectFor(taskId: string): string {
  return taskId.startsWith('agent-') ? '代理任务' : 'bash 任务';
}

function headlineFor(info: BackgroundTaskInfo): string {
  const subject = subjectFor(info.taskId);
  switch (info.status) {
    case 'running':
      return `${subject} 已在后台启动`;
    case 'awaiting_approval':
      return `${subject} 等待审批`;
    case 'completed':
      return `${subject} 已在后台完成`;
    case 'failed':
      return `${subject} 在后台失败`;
    case 'killed':
      return `${subject} 已停止`;
    case 'lost':
      return `${subject} 已丢失`;
  }
}

function detailFor(info: BackgroundTaskInfo): string | undefined {
  const parts: string[] = [];
  const description = truncate(info.description);
  if (description !== undefined) parts.push(description);

  if (info.status === 'completed' || info.status === 'failed') {
    if (info.exitCode !== null && info.exitCode !== undefined) {
      parts.push(`exit ${info.exitCode}`);
    }
  }
  if (info.status === 'killed') {
    const reason = truncate(info.stopReason);
    parts.push(reason !== undefined ? `已停止 — ${reason}` : '已停止');
  }
  if (info.status === 'awaiting_approval') {
    const reason = truncate(info.approvalReason);
    if (reason !== undefined) parts.push(`等待中: ${reason}`);
  }
  if (info.status === 'lost') {
    parts.push('会话在完成前已重启');
  }
  if (info.timedOut === true) parts.push('已超时');

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Build a transcript card payload for a background task lifecycle
 * snapshot. The returned phase drives bullet color in the renderer
 * (`BackgroundAgentStatusComponent`); the detail line carries the extra
 * status nuance (exit code, kill reason, etc.).
 */
export function formatBackgroundTaskTranscript(
  info: BackgroundTaskInfo,
): BackgroundAgentStatusData {
  return {
    phase: phaseFromStatus(info.status),
    headline: headlineFor(info),
    detail: detailFor(info),
  };
}
