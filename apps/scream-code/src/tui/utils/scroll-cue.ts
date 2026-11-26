/**
 * What to tell a person who has scrolled up while the session goes on below.
 *
 * While the view follows the end there is nothing to say. From the moment it
 * stops following (the person scrolled up) the cue counts the replies that
 * have arrived since — only assistant text: a run of tool calls is not "a new
 * message", and counting it would make the number tick through a whole tool
 * sequence before anything readable arrived.
 *
 * The count is taken against the last entry the person had when they left the
 * end; if that entry has since been folded away (a very long wait), the cue
 * falls back to counting every reply still held.
 */

import type { TranscriptEntry } from '#/tui/types';

export interface ScrollCueState {
  /** Replies that arrived since the view left the end. */
  readonly newReplies: number;
}

function isReply(entry: TranscriptEntry): boolean {
  return entry.kind === 'assistant' && entry.content.trim().length > 0;
}

export class ScrollCue {
  private away = false;
  private baseline: TranscriptEntry | undefined;

  /** The cue for this moment, or null while the view follows the end. */
  read(following: boolean, entries: readonly TranscriptEntry[]): ScrollCueState | null {
    if (following) {
      this.away = false;
      this.baseline = undefined;
      return null;
    }
    if (!this.away) {
      this.away = true;
      this.baseline = entries.at(-1);
    }
    const from = this.baseline === undefined ? 0 : entries.lastIndexOf(this.baseline) + 1;
    return { newReplies: entries.slice(from).filter(isReply).length };
  }
}
