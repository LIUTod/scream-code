import { isRealUserPrompt } from '../context';
import type { ContextMessage } from '../context/types';
import { loadRoleAdditional } from '../../profile/context';
import { DynamicInjector } from './injector';

const USER_PREFS_VARIANT = 'user_prefs';

/**
 * Injects the user's /like preferences as a system-reminder at the start of
 * every turn (i.e. after each new user prompt). The system prompt already
 * carries the preferences via {{ ROLE_ADDITIONAL }}, but that block is far
 * from the model's attention by mid-conversation. This reminder keeps the
 * preferences visible right before each response.
 *
 * Fires when:
 *   - user-prefs.md exists and is non-empty
 *   - at least one real user prompt has arrived since the last injection
 */
export class UserPrefsInjector extends DynamicInjector {
  protected override readonly injectionVariant = USER_PREFS_VARIANT;

  protected override async getInjection(): Promise<string | undefined> {
    if (this.injectedAt !== null && !this.hasNewUserPromptSince(this.injectedAt)) {
      return undefined;
    }
    const prefs = await loadRoleAdditional(this.agent.jian);
    if (prefs === undefined) return undefined;

    return [
      'USER PREFERENCES REMINDER: Before responding, re-read and apply EVERY',
      'user preference below. These are direct user instructions set via /like',
      '— violating them is equivalent to ignoring an explicit user request.',
      '',
      prefs,
    ].join('\n');
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
