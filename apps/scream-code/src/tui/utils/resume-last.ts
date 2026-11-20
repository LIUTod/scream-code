import type { RecentSession } from '#/tui/types';
import type { TUIState } from '#/tui/tui-state';
import { lastSessionToResume } from '#/tui/components/chrome/welcome';

/**
 * The session Ctrl+R would resume right now, or undefined. Only at the very
 * start of this run: no input yet (the first keystroke closes it for good,
 * even if the text is deleted again, and so does anything that needed typing,
 * like `/new`), and nothing in the transcript (a session resumed with `-C`).
 * Mid-chat the key does nothing. The welcome hint and the key share this,
 * so the hint never offers a key that does nothing.
 */
export function sessionToResume(
  state: Pick<TUIState, 'transcriptEntries' | 'appState'> & {
    readonly editor: { getText(): string; hasFirstInputFired(): boolean };
  },
): RecentSession | undefined {
  if (state.editor.hasFirstInputFired()) return undefined;
  if (state.transcriptEntries.length > 0) return undefined;
  if (state.editor.getText().trim() !== '') return undefined;
  return lastSessionToResume(state.appState);
}
