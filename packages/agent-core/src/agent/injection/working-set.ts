import { DynamicInjector } from './injector';

/**
 * Injects the file list the turn has touched as a "Working Set" reminder.
 *
 * Injects when the set actually changed since the last injection, or when the
 * previous copy left the context (compaction/undo/clear → `injectedAt` null).
 * The old rule was "every 3 assistant turns" — it re-sent an identical
 * ~1.4 KB block on a timer, accumulating duplicates in history.
 */
export class WorkingSetInjector extends DynamicInjector {
  protected readonly injectionVariant = 'working-set';
  private lastInjectedText: string | null = null;

  protected getInjection(): string | undefined {
    const paths = this.agent.workingSet.getPaths();
    if (paths.length === 0) return undefined;

    const text = [
      '## Working Set',
      '',
      '当前任务可能涉及以下文件：',
      ...paths.map((p) => `- ${p}`),
      '',
      '优先检查这些文件，避免重复读取未修改文件。',
    ].join('\n');

    if (this.injectedAt !== null && text === this.lastInjectedText) return undefined;
    this.lastInjectedText = text;
    return text;
  }
}
