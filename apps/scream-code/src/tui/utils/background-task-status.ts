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

import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@scream-code/scream-code-sdk';

import { t } from '@scream-code/config';

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
  return taskId.startsWith('agent-') ? t('bgtask.agent_task') : t('bgtask.bash_task');
}

function headlineFor(info: BackgroundTaskInfo): string {
  const subject = subjectFor(info.taskId);
  switch (info.status) {
    case 'running':
      return t('bgtask.started_bg', { subject });
    case 'awaiting_approval':
      return t('bgtask.awaiting_approval', { subject });
    case 'completed':
      return t('bgtask.completed_bg', { subject });
    case 'failed':
      return t('bgtask.failed_bg', { subject });
    case 'killed':
      return t('bgtask.killed', { subject });
    case 'lost':
      return t('bgtask.lost', { subject });
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
    parts.push(reason !== undefined ? t('bgtask.stopped_reason', { reason }) : t('bgtask.stopped'));
  }
  if (info.status === 'awaiting_approval') {
    const reason = truncate(info.approvalReason);
    if (reason !== undefined) parts.push(t('bgtask.waiting', { reason }));
  }
  if (info.status === 'lost') {
    parts.push(t('bgtask.session_restarted'));
  }
  if (info.timedOut === true) parts.push(t('bgtask.timed_out'));

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
