import type { MemoryMemoStore } from '@scream-cli/memory';
import { rankMemos } from '@scream-cli/memory';

import type { Agent } from '..';
import { DynamicInjector } from './injector';

const DEFAULT_CONFIG = {
  maxMemos: 3,
  maxChars: 2000,
  minScore: 0.3,
};

/**
 * Injects relevant memory memos at the start of each turn.
 *
 * Uses the pure-keyword {@link rankMemos} scorer (no LLM cost) to find
 * memos relevant to the current user query and injects them as a
 * {@code <system-reminder>} block so the model can reference past work.
 */
export class MemoryRecallInjector extends DynamicInjector {
  protected readonly injectionVariant = 'memory_recall';

  private injectedForTurn = false;

  constructor(agent: Agent) {
    super(agent);
  }

  /** Reset per-turn state so the injector fires again next turn. */
  resetForTurn(): void {
    this.injectedForTurn = false;
  }

  protected async getInjection(): Promise<string | undefined> {
    if (this.injectedForTurn) return undefined;
    this.injectedForTurn = true;

    const store = this.agent.memoStore;
    if (!store) return undefined;

    const query = this.getLastUserQuery();
    if (query.length === 0) return undefined;

    const all = await store.list({ limit: 100 });
    if (all.memos.length === 0) return undefined;

    const ranked = rankMemos(all.memos, query, DEFAULT_CONFIG.minScore, DEFAULT_CONFIG.maxMemos);
    if (ranked.length === 0) return undefined;

    return this.formatInjection(ranked);
  }

  /** Walk the context history backwards to find the last user message. */
  private getLastUserQuery(): string {
    const history = this.agent.context.history;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (!msg || msg.role !== 'user') continue;
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(' ');
      if (text.length > 0) return text.slice(0, 500);
    }
    return '';
  }

  private formatInjection(
    ranked: ReturnType<typeof rankMemos>,
  ): string {
    const lines = [
      '以下是与当前任务相关的历史记忆（来自之前的会话）：',
      '',
    ];

    for (const [i, { memo, score }] of ranked.entries()) {
      const level = score >= 0.6 ? '高' : score >= 0.4 ? '中' : '低';
      lines.push(
        `**记忆 ${i + 1}** (相关性: ${level})`,
        `- 需求: ${memo.userRequirement}`,
        `- 方案: ${memo.solution}`,
        memo.completionStatus === 'blocked'
          ? `- ⚠️ 状态: 受阻 — 可能需要关注`
          : `- 状态: ${memo.completionStatus}`,
        '',
      );
    }

    const joined = lines.join('\n');
    return joined.length > DEFAULT_CONFIG.maxChars
      ? joined.slice(0, DEFAULT_CONFIG.maxChars - 3) + '...'
      : joined;
  }
}
