import { isSameProjectDir } from '@scream-code/memory';

import { pendingUserPrompt } from './memory-recall';
import { DynamicInjector } from './injector';

export const MEMORY_OVERVIEW_VARIANT = 'memory_overview';
const TOP_TOPICS = 8;

/**
 * Tells the model what it remembers, once per conversation: how many
 * experiences, and their most frequent topics.
 *
 * Automatic recall (memory-recall.ts) only fires when one memo clearly
 * matches the request, which a broad question ("what should I watch out for
 * building an agent CLI?") never does — its similarity to any one task memo
 * sits in the unrelated range. Without knowing it has experience on the
 * topic, the model answers from general knowledge and never looks. This
 * short note (about a hundred tokens) is what makes it call `MemoryLookup`
 * on its own; the memos themselves stay out until it asks.
 *
 * Injected with the first user prompt, kept once per conversation (found in
 * history again after a resume), and restored after a compaction or a clear
 * drops it.
 */
export class MemoryOverviewInjector extends DynamicInjector {
  protected override readonly injectionVariant = MEMORY_OVERVIEW_VARIANT;
  /** undefined: not built yet; null: nothing to say (no memories). */
  private text: string | null | undefined;

  protected override async getInjection(): Promise<string | undefined> {
    if (this.agent.type !== 'main' || this.injectedAt !== null) return undefined;
    const store = this.agent.memoStore;
    if (store === undefined) return undefined;
    const history = this.agent.context.history;
    const existing = history.findIndex(
      (message) => message.origin?.kind === 'injection' && message.origin.variant === MEMORY_OVERVIEW_VARIANT,
    );
    if (existing !== -1) {
      this.injectedAt = existing;
      return undefined;
    }
    if (pendingUserPrompt(history) === undefined) return undefined;
    if (this.text === undefined) {
      try {
        this.text = await this.build();
      } catch (error: unknown) {
        this.agent.log.warn('memory overview failed', { error });
        this.text = null;
      }
    }
    return this.text ?? undefined;
  }

  private async build(): Promise<string | null> {
    const store = this.agent.memoStore!;
    await this.agent.memoStoreReady;
    const projectDir = this.agent.config.cwd;
    let total = 0;
    let here = 0;
    const projectTags = new Map<string, number>();
    const allTags = new Map<string, number>();
    for await (const memo of store.read()) {
      total += 1;
      const same = isSameProjectDir(memo.projectDir, projectDir);
      if (same) here += 1;
      for (const tag of memo.tags ?? []) {
        const key = tag.trim().toLowerCase();
        if (key === '' || key === 'compaction-fallback') continue;
        allTags.set(key, (allTags.get(key) ?? 0) + 1);
        if (same) projectTags.set(key, (projectTags.get(key) ?? 0) + 1);
      }
    }
    if (total === 0) return null;
    return renderOverview(total, here, projectTags.size > 0 ? projectTags : allTags);
  }
}

/** Model-facing, so English; tags stay in the language they were written in. */
export function renderOverview(total: number, here: number, tags: ReadonlyMap<string, number>): string {
  const topics = [...tags.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TOPICS)
    .map(([tag, count]) => `${tag} (${String(count)})`);
  return [
    '<memory-overview>',
    `You remember ${String(total)} experiences from earlier sessions (${String(here)} from this project).` +
      (topics.length === 0 ? '' : ` Frequent topics: ${topics.join(', ')}.`),
    'When a request touches one of them — advice and design questions included — call MemoryLookup before answering from general knowledge, and say what you found.',
    '</memory-overview>',
  ].join('\n');
}
