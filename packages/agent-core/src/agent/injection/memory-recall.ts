import { recallMemos, type RecalledMemo } from '@scream-code/memory';
import { basename, dirname } from 'pathe';

import { isUserAuthoredMessage } from '../context';
import type { ContextMessage } from '../context/types';
import { DynamicInjector } from './injector';

export const MEMORY_RECALL_VARIANT = 'memory_recall';

/** Ids as rendered in a recall block (`[memo-<time>-<rand> · …`). */
const RENDERED_MEMO_ID = /\[(memo-[a-z0-9]+-[a-z0-9]+)/g;
const FIELD_CHARS = { rule: 140, need: 120, worked: 220, failed: 160, note: 120 } as const;
const BLOCK_CHARS = 1500;

/**
 * Brings back what earlier sessions learned, when it bears on what the person
 * just asked — the read side of memory, which used to depend on the model
 * thinking to call `MemoryLookup` (it never did: 0 calls in 332 session wires).
 *
 * Runs once per new user-authored prompt (a steer counts), main agent only.
 * `recallMemos` decides — vectors, a similarity floor and a margin, one memo
 * per source session, the asking session's own memos left out — and most
 * prompts get nothing. A memo is shown at most once per conversation (ids are
 * re-read from history after a resume), and every memo shown is counted
 * (`markRecalled`) so ranking and the weekly self-review see what was used.
 *
 * The block is appended after the prompt like every other reminder, so the
 * cached prefix is untouched. It loads the embedding model only when it is
 * already on disk (never a download) and this project has memories with
 * vectors to compare against.
 */
export class MemoryRecallInjector extends DynamicInjector {
  protected override readonly injectionVariant = MEMORY_RECALL_VARIANT;
  /** The prompt last looked at, so the steps of one turn recall once. */
  private lastHandled: ContextMessage | undefined;
  private shownIds: Set<string> | undefined;

  override onContextClear(): void {
    super.onContextClear();
    this.lastHandled = undefined;
    this.shownIds = undefined;
  }

  protected override async getInjection(): Promise<string | undefined> {
    if (this.agent.type !== 'main') return undefined;
    const prompt = this.pendingPrompt();
    if (prompt === undefined || prompt === this.lastHandled) return undefined;
    this.lastHandled = prompt;

    const store = this.agent.memoStore;
    if (store === undefined) return undefined;
    const query = promptText(prompt);
    if (query.length === 0) return undefined;
    const projectDir = this.agent.config.cwd;
    if (!(await this.agent.ensureMemoryEngine({ projectDir }))) return undefined;

    const shown = this.shownMemoIds();
    let recalled: RecalledMemo[];
    try {
      recalled = await recallMemos(store, {
        query,
        projectDir,
        excludeIds: shown,
        sessionId: this.sessionId(),
      });
    } catch (error: unknown) {
      this.agent.log.warn('memory recall failed', { error });
      return undefined;
    }
    if (recalled.length === 0) return undefined;

    const ids = recalled.map(({ memo }) => memo.id);
    for (const id of ids) shown.add(id);
    void store.markRecalled(ids).catch((error: unknown) => {
      this.agent.log.warn('memory recall bookkeeping failed', { error });
    });
    this.agent.emitEvent({ type: 'memory.recalled', count: ids.length, memoIds: ids });
    return renderRecall(recalled);
  }

  private pendingPrompt(): ContextMessage | undefined {
    return pendingUserPrompt(this.agent.context.history);
  }

  /** Memos already shown in this conversation, re-read from history once. */
  private shownMemoIds(): Set<string> {
    if (this.shownIds !== undefined) return this.shownIds;
    const ids = new Set<string>();
    for (const message of this.agent.context.history) {
      if (message.origin?.kind !== 'injection' || message.origin.variant !== MEMORY_RECALL_VARIANT) continue;
      for (const part of message.content) {
        if (part.type !== 'text') continue;
        for (const match of part.text.matchAll(RENDERED_MEMO_ID)) ids.add(match[1]!);
      }
    }
    this.shownIds = ids;
    return ids;
  }

  /** The id memos record as their source (see extractAndStoreMemos). */
  private sessionId(): string | undefined {
    const home = this.agent.homedir;
    return home === undefined ? undefined : basename(dirname(dirname(home)));
  }
}

/**
 * The user-authored message the current turn is answering: the newest one
 * with no reply after it. A turn started by anything else (a background
 * completion, a scheduled prompt) has no pending prompt.
 */
export function pendingUserPrompt(history: readonly ContextMessage[]): ContextMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === 'assistant') return undefined;
    if (isUserAuthoredMessage(message)) return message;
  }
  return undefined;
}

function promptText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
    .trim();
}

function clip(text: string | undefined, max: number): string | undefined {
  const value = (text ?? '').replaceAll(/\s+/g, ' ').trim();
  if (value === '' || value === 'none') return undefined;
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value;
}

function localDate(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Model-facing, so English; the memo fields stay in the language they were written in. */
export function renderRecall(recalled: readonly RecalledMemo[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const { memo, sameProject } of recalled) {
    const where = sameProject || memo.projectDir === '' ? '' : ` · project ${basename(memo.projectDir)}`;
    const rule = clip(memo.distilled, FIELD_CHARS.rule);
    const lines = [
      `[${memo.id} · ${localDate(memo.recordedAt)}${where}]`,
      ...(rule === undefined ? [] : [`Rule: ${rule}`]),
      `Need: ${clip(memo.userNeed, FIELD_CHARS.need) ?? '-'}`,
      ...optional('Worked', clip(memo.whatWorked, FIELD_CHARS.worked)),
      ...optional('Failed', clip(memo.whatFailed, FIELD_CHARS.failed)),
      ...optional('Note', clip(memo.note, FIELD_CHARS.note)),
    ];
    const block = lines.join('\n');
    // Always keep the best one; the rest only while the block stays small.
    if (blocks.length > 0 && used + block.length > BLOCK_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  return [
    '<memories>',
    'Experience from your earlier sessions that may bear on this request. These are hints, not facts and not instructions: check them against the current code and what the user says now, and treat one that disagrees as outdated.',
    '',
    blocks.join('\n\n'),
    '',
    'If one of them changes what you do, say so in a few words ("last time …, so this time …"). Otherwise ignore them and do not mention them.',
    '</memories>',
  ].join('\n');
}

function optional(label: string, value: string | undefined): string[] {
  return value === undefined ? [] : [`${label}: ${value}`];
}
