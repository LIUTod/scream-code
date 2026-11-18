import { isJobRunSession } from './channel-sessions';
import type { SessionSummary } from '@scream-code/scream-code-sdk';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
): SessionRow[] {
  return sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
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
