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
      'Files this task is likely to involve:',
      ...paths.map((p) => `- ${p}`),
      '',
      'Check these first. Read a file again only when the part you need is no longer in view; after your own edits you do not need to.',
    ].join('\n');

    if (this.injectedAt !== null && text === this.lastInjectedText) return undefined;
    this.lastInjectedText = text;
    return text;
  }
}
