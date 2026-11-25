/**
 * Keeps the model's view of the files it works on current, so its next Edit
 * matches the file instead of failing and sending it to the shell.
 *
 * - `ChangedFilesInjector`: before each step, a file the model read or
 *   edited that changed since — the user, a formatter, a command it ran —
 *   comes back as the changed lines (numbered like Read), and that becomes
 *   the file's known view.
 * - `RestoredFilesInjector`: right after a full compaction, the files the
 *   model was working on come back as their current text (within a token
 *   budget), since the summary cannot carry the text an old_string must
 *   match.
 *
 * Both read the files the session snapshot store already tracks (Read,
 * Edit and Write record their views there), so nothing outside the files
 * the model itself opened is ever read.
 */

import { isAbsolute, relative, resolve } from 'pathe';

import type { Agent } from '..';
import { computeAnchor, toModelTextView } from '../../tools/builtin/file/line-endings';
import { EDIT_SNAPSHOT_MAX_CONTENT_BYTES } from '../../tools/support/edit-snapshot-store';
import { changedLinesSnippet, numberedLines, viewLines } from '../../tools/support/file-views';
import { estimateTokens } from '../../utils/tokens';
import { DynamicInjector } from './injector';

/** Files checked for outside changes before each step (the most recently used). */
const CHANGED_FILES_CHECKED = 16;
/** Changed lines shown per file. */
const CHANGED_LINES_PER_FILE = 30;

/** Files put back after a full compaction. */
const RESTORED_FILES = 5;
const RESTORED_TOKENS_PER_FILE = 5_000;
const RESTORED_TOKENS_TOTAL = 50_000;
/** Never more than this share of the model's context window. */
const RESTORED_WINDOW_SHARE = 0.15;

function shownPath(agent: Agent, path: string): string {
  const cwd = agent.config.cwd;
  const rel = relative(cwd, path);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

export class ChangedFilesInjector extends DynamicInjector {
  protected readonly injectionVariant = 'changed-files';

  protected async getInjection(): Promise<string | undefined> {
    const store = this.agent.editSnapshots;
    const notes: string[] = [];
    for (const path of store.recentPaths(CHANGED_FILES_CHECKED)) {
      const known = store.peek(path);
      if (known === undefined) continue;
      let stamp: { mtime: number; size: number };
      try {
        const stat = await this.agent.jian.stat(path);
        stamp = { mtime: stat.stMtime, size: stat.stSize };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          store.forget(path);
          notes.push(`${shownPath(this.agent, path)} was deleted.`);
        }
        continue;
      }
      const seen = store.stampOf(path);
      if (seen !== undefined && seen.mtime === stamp.mtime && seen.size === stamp.size) continue;
      if (stamp.size > EDIT_SNAPSHOT_MAX_CONTENT_BYTES) {
        store.confirm(path, stamp);
        continue;
      }
      let view: string;
      try {
        view = toModelTextView(await this.agent.jian.readText(path)).text;
      } catch {
        continue;
      }
      if (view === known.content) {
        store.confirm(path, stamp);
        continue;
      }
      const snippet = changedLinesSnippet(known.content, view, CHANGED_LINES_PER_FILE);
      store.remember(path, { content: view, anchor: computeAnchor(view), recordedAt: 'read' });
      store.confirm(path, stamp);
      const name = shownPath(this.agent, path);
      notes.push(
        snippet === undefined
          ? `${name} changed (too much to show; Read it before editing it).`
          : `${name} changed. The lines around each change now (anchor ${computeAnchor(view)}):\n${snippet}`,
      );
    }
    if (notes.length === 0) return undefined;
    return [
      'Files you read or edited changed since you last saw them — by the user, a formatter, or a command you ran.',
      'Take the changes into account and do not undo them unless asked. Your next edits should match this text.',
      '',
      ...notes,
    ].join('\n');
  }
}

export class RestoredFilesInjector extends DynamicInjector {
  protected readonly injectionVariant = 'restored-files';
  private pending = false;

  override onContextCompacted(compactedCount: number): void {
    super.onContextCompacted(compactedCount);
    this.pending = true;
  }

  override onContextClear(): void {
    super.onContextClear();
    this.pending = false;
  }

  protected async getInjection(): Promise<string | undefined> {
    if (!this.pending) return undefined;
    this.pending = false;
    const store = this.agent.editSnapshots;
    const stillRead = this.pathsReadInHistory();
    const window = this.agent.config.modelCapabilities.max_context_tokens;
    const budget =
      window !== undefined && window > 0
        ? Math.min(RESTORED_TOKENS_TOTAL, Math.floor(window * RESTORED_WINDOW_SHARE))
        : RESTORED_TOKENS_TOTAL;
    let used = 0;
    const blocks: string[] = [];
    for (const path of store.recentPaths()) {
      if (blocks.length >= RESTORED_FILES || used >= budget) break;
      if (stillRead.has(path)) continue;
      let view: string;
      try {
        view = toModelTextView(await this.agent.jian.readText(path)).text;
      } catch {
        continue;
      }
      const lines = viewLines(view);
      const cap = Math.min(RESTORED_TOKENS_PER_FILE, budget - used);
      const shown: string[] = [];
      let tokens = 0;
      for (const row of numberedLines(lines, 1, lines.length)) {
        const cost = estimateTokens(row) + 1;
        if (tokens + cost > cap) break;
        shown.push(row);
        tokens += cost;
      }
      if (shown.length === 0) continue;
      used += tokens;
      const anchor = computeAnchor(view);
      store.remember(path, { content: view, anchor, recordedAt: 'read' });
      const name = shownPath(this.agent, path);
      const range =
        shown.length < lines.length
          ? `lines 1-${String(shown.length)} of ${String(lines.length)}`
          : `${String(lines.length)} line${lines.length === 1 ? '' : 's'}`;
      blocks.push(
        [
          `${name} (${range}, anchor ${anchor}):`,
          ...shown,
          ...(shown.length < lines.length ? [`… (lines ${String(shown.length + 1)}-${String(lines.length)} not shown; Read them when you need them)`] : []),
        ].join('\n'),
      );
    }
    if (blocks.length === 0) return undefined;
    return [
      'Compaction removed the text of the files you were working on from the conversation. Here they are as they are now, numbered like Read:',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  /** Files whose Read survived the compaction (their text is still in view). */
  private pathsReadInHistory(): Set<string> {
    const cwd = this.agent.config.cwd;
    const paths = new Set<string>();
    for (const message of this.agent.context.history) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls) {
        if (call.name !== 'Read' || call.arguments === null) continue;
        try {
          const args = JSON.parse(call.arguments) as Record<string, unknown>;
          const raw = args['path'] ?? args['file_path'];
          if (typeof raw === 'string') paths.add(isAbsolute(raw) ? raw : resolve(cwd, raw));
        } catch {
          // An unparseable call read nothing the model can still see.
        }
      }
    }
    return paths;
  }
}
