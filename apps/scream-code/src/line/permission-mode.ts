import type { PermissionMode } from '@scream-code/scream-code-sdk';


/**
 * The engine permission mode a chat session runs under.
 *
 * - `auto` (the default): every call passes the deny rules and runs, with no
 *   interactive prompt, which is what a chat can carry.
 * - `yolo`: the same, but plan reviews still reach the approval handler.
 * - `dontAsk`: bot mode. Reversible work runs; irreversible calls are denied,
 *   reported back to the model and recorded.
 *
 * An unknown value falls back to `auto`, the config's own default.
 */
export function enginePermissionFor(mode: string | undefined): PermissionMode {
  if (mode === 'yolo') return 'yolo';
  if (mode === 'dontAsk') return 'bot';
  return 'auto';
}
