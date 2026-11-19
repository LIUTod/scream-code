import { isJobRunSession } from './channel-sessions';
import type { SessionSummary } from '@scream-code/scream-code-sdk';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';

/**
 * An empty shell: a session that never received a user prompt and never got
 * a title (auto-generated or custom). Every launch creates a session, so a
 * launch that was only used for a slash command, or quit right away, leaves
 * one behind. Archived sessions are never shells.
 *
 * The placeholder title 'New Session' (set at creation in agent-core
 * session/index.ts) still counts as untitled; this must mirror agent-core's
 * isUntitled(), or every fresh session would look titled and never go away.
 */
export function isEmptySessionShell(
  summary: Pick<SessionSummary, 'archived' | 'lastPrompt' | 'title'>,
): boolean {
  if (summary.archived) return false;
  if (summary.lastPrompt !== undefined) return false;
  const title = summary.title;
  return !(typeof title === 'string' && title.trim().length > 0 && title !== 'New Session');
}


export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
): SessionRow[] {
  return sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    // Empty shells hold nothing to resume (another terminal's fresh session,
    // or a leftover the startup sweep has not reached yet).
    .filter((session) => session.id === currentSessionId || !isEmptySessionShell(session))
    // A background task's runs are its history in /jobs, not conversations.
    .filter((session) => !isJobRunSession(session.metadata))
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: session.lastPrompt ?? null,
      work_dir: session.workDir,
      session_dir: session.sessionDir ?? '',
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: session.metadata,
    }));
}
