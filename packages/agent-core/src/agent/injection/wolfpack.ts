import { DynamicInjector } from './injector';

const WOLFPACK_MODE_ENTER_REMINDER = [
  'WolfPack mode is active. Prefer using the WolfPack tool for batch parallel execution.',
  '',
  'When to use: When the user\'s task involves performing the same operation across',
  'multiple independent items (files, directories, data entries, searches).',
  '',
  'How to use:',
  '  WolfPack(',
  '    description="Short task description (3-5 words)",',
  '    subagent_type="coder",',
  '    prompt_template="Review {{item}} for security issues",',
  '    items=["src/auth.ts", "src/api.ts", "src/config.ts"]',
  '  )',
  '',
  'This spawns one subagent per item in parallel. Results are batched and returned together.',
  'Items must be independent — do not use WolfPack when one item depends on another\'s output.',
  'Max 20 items per call.',
].join('\n');

const WOLFPACK_MODE_EXIT_REMINDER =
  'WolfPack mode is no longer active. The WolfPack tool for batch parallel execution is no longer available.';

export class WolfPackModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'wolfpack';
  private wasActive = false;

  getInjection(): string | undefined {
    const isActive = this.agent.wolfpackMode.isActive;

    if (!isActive) {
      if (this.wasActive) {
        this.wasActive = false;
        this.injectedAt = null;
        return WOLFPACK_MODE_EXIT_REMINDER;
      }
      return undefined;
    }

    if (!this.wasActive) {
      this.injectedAt = null;
      this.wasActive = true;
      return WOLFPACK_MODE_ENTER_REMINDER;
    }

    return undefined;
  }
}
