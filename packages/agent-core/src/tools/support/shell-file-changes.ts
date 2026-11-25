/**
 * What a shell command did to the files the agent has read or edited.
 *
 * Models that lost track of a file's text (or had Edit refuse them) turn to
 * the shell — a Python one-off, a redirect, `sed -i` — and the change then
 * happened out of sight: no diff in the activity block, no counts, and a
 * known view that no longer matched the file, so the next Edit failed too.
 * Stamping the tracked files around a foreground command catches any of
 * those, whatever the command looked like, at the cost of one stat per file.
 *
 * Only files the session snapshot store tracks are checked (at most
 * {@link SHELL_TRACKED_FILES}, the most recently used): a file the command
 * created, or one the agent never opened, is not seen.
 */

import type { Jian } from '@scream-code/jian';

import { computeAnchor, toModelTextView } from '../builtin/file/line-endings';
import {
  EDIT_SNAPSHOT_MAX_CONTENT_BYTES,
  type DiskStamp,
  type EditSnapshotStore,
} from './edit-snapshot-store';
import { fileDiffDetails, type FileDiffPreviewRow } from './file-diff';

export const SHELL_TRACKED_FILES = 32;
/** Files whose changed lines are kept; the rest of a large change keeps its counts only. */
export const SHELL_PREVIEWED_FILES = 6;

/**
 * Whether a command looks like a hand-written edit — `sed -i`, a Python /
 * Node one-off, a heredoc or redirect into a file — rather than a project
 * tool (git, a formatter, a code generator) whose file changes are the
 * point. Only the former is an edit the agent should have made with Edit.
 */
export function looksLikeHandEdit(command: string): boolean {
  return (
    /\bsed\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i/.test(command) ||
    /\bperl\s+-[a-zA-Z]*i/.test(command) ||
    /\b(?:python3?|node|ruby|deno|bun|php)\b[^|;&]*(?:<<|\s-c\s|\s-e\s|\s-\s)/.test(command) ||
    /\bcat\s*>|\btee\s+(?:-a\s+)?[\w./-]|<<\s*['"]?[A-Za-z_]+/.test(command) ||
    /(?:^|[\s;&|])(?:echo|printf)\b[^|;&]*>{1,2}\s*[\w./-]+\.\w+/.test(command)
  );
}

export interface ShellFileChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly preview?: FileDiffPreviewRow[] | undefined;
  readonly previewTotal?: number | undefined;
}

async function stampOf(jian: Jian, path: string): Promise<DiskStamp | null> {
  try {
    const stat = await jian.stat(path);
    return { mtime: stat.stMtime, size: stat.stSize };
  } catch {
    return null;
  }
}

/** The tracked files' disk stamps before a command runs (null: not there). */
export async function stampTrackedFiles(store: EditSnapshotStore, jian: Jian): Promise<Map<string, DiskStamp | null>> {
  const stamps = new Map<string, DiskStamp | null>();
  await Promise.all(
    store.recentPaths(SHELL_TRACKED_FILES).map(async (path) => {
      stamps.set(path, await stampOf(jian, path));
    }),
  );
  return stamps;
}

/**
 * The tracked files the command changed, measured against the view the agent
 * last had of each. Each changed file's new text becomes its known view (an
 * own change, so a later Edit with an older anchor is not refused over it).
 */
export async function collectShellFileChanges(
  before: ReadonlyMap<string, DiskStamp | null>,
  store: EditSnapshotStore,
  jian: Jian,
): Promise<ShellFileChange[]> {
  const changes: ShellFileChange[] = [];
  for (const [path, was] of before) {
    const now = await stampOf(jian, path);
    if (was !== null && now !== null && was.mtime === now.mtime && was.size === now.size) continue;
    const known = store.peek(path);
    if (known === undefined) continue;
    if (now === null) {
      if (was === null) continue;
      // Deleted by the command.
      const details = fileDiffDetails(known.content, '', { deletedText: true });
      changes.push({ path, added: 0, removed: details?.removed ?? 0, preview: details?.preview, previewTotal: details?.previewTotal });
      store.forget(path);
      continue;
    }
    if (now.size > EDIT_SNAPSHOT_MAX_CONTENT_BYTES) continue;
    let view: string;
    try {
      view = toModelTextView(await jian.readText(path)).text;
    } catch {
      continue;
    }
    if (view === known.content) {
      store.confirm(path, now);
      continue;
    }
    // The old text is the agent's own earlier view and the new text is what
    // its command wrote: both are already the agent's, so both may be shown.
    const details = fileDiffDetails(known.content, view, { deletedText: true, carried: view });
    store.remember(path, { content: view, anchor: computeAnchor(view), recordedAt: 'edit' });
    store.confirm(path, now);
    if (details === undefined) {
      changes.push({ path, added: 0, removed: 0 });
      continue;
    }
    changes.push({
      path,
      added: details.added,
      removed: details.removed,
      preview: details.preview,
      previewTotal: details.previewTotal,
    });
  }
  // A command that rewrote many files (a checkout, a codemod) keeps every
  // count but only the first files' lines: the preview is saved with the
  // session, and nobody reads thirty of them in a row.
  return changes.map((change, index) =>
    index < SHELL_PREVIEWED_FILES ? change : { path: change.path, added: change.added, removed: change.removed },
  );
}
