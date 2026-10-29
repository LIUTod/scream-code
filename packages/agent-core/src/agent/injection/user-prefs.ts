import { isRealUserPrompt } from '../context';
import type { ContextMessage } from '../context/types';
import { loadRoleAdditional } from '../../profile/context';
import { DynamicInjector } from './injector';

const USER_PREFS_VARIANT = 'user_prefs';

/**
 * Injects the user's /like preferences as a system-reminder. The system prompt
 * already carries the preferences via {{ ROLE_ADDITIONAL }}; this reminder
 * exists so mid-conversation turns do not lose them.
 *
 * Fires when:
 *   - user-prefs.md exists and is non-empty, and
 *   - the previous reminder left the context (compaction/undo/clear), or
 *   - the preferences changed since the last injection.
 *
 * An identical copy is NOT re-sent every turn: repeating the same 1.6 KB
 * block after every user message was pure token cost — history accumulated
 * one duplicate per prompt while the content never changed.
 */
export class UserPrefsInjector extends DynamicInjector {
  protected override readonly injectionVariant = USER_PREFS_VARIANT;
  private lastInjectedText: string | null = null;

  protected override async getInjection(): Promise<string | undefined> {
    if (this.injectedAt !== null && !this.hasNewUserPromptSince(this.injectedAt)) {
      return undefined;
    }
    const prefs = await loadRoleAdditional(this.agent.jian);
    if (prefs === undefined) return undefined;

    const text = [
      'USER PREFERENCES REMINDER: Before responding, re-read and apply EVERY',
      'user preference below. These are direct user instructions set via /like',
      '— violating them is equivalent to ignoring an explicit user request.',
      '',
      prefs,
    ].join('\n');

    if (this.injectedAt !== null && text === this.lastInjectedText) return undefined;

    // The system prompt carries the preferences too (Agent.useProfile passes
    // roleAdditional). While that copy is current, do not send the same block
    // again as a reminder — a fresh session would otherwise carry it twice.
    // Marking injectedAt keeps later passes cheap; a context reset re-checks,
    // and a genuine prefs change changes the text so the reminder still fires.
    const systemPrompt = this.agent.config?.systemPrompt ?? '';
    if (this.injectedAt === null && systemPrompt.includes(prefs)) {
      this.lastInjectedText = text;
      this.injectedAt = this.agent.context.history.length;
      return undefined;
    }

    this.lastInjectedText = text;
    return text;
  }

  private hasNewUserPromptSince(from: number): boolean {
    const history: readonly ContextMessage[] = this.agent.context.history;
    for (let i = from; i < history.length; i++) {
      const message = history[i];
      if (message !== undefined && isRealUserPrompt(message)) return true;
    }
    return false;
  }
}
