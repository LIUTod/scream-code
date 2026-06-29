// Loop substate machine — derives the implicit loop-mode phase from
// AppState fields. The loop has its own state machine layered on top of
// the streaming phase:
//
//   idle      — loop disabled (loopModeEnabled === false)
//   paused    — loop enabled but prompt cleared (user pressed Esc)
//   running   — loop enabled with a prompt; model is working or about to
//                start the next iteration
//   verifying — loop enabled, verifier command running between iterations
//
// The `verifying` substate is the only one that needs an explicit field
// (`loopVerifying`); the others are derivable from existing fields.

import type { AppState } from '#/tui/types';

export type LoopSubstate = 'idle' | 'paused' | 'running' | 'verifying';

export function resolveLoopSubstate(state: AppState): LoopSubstate {
  if (!state.loopModeEnabled) return 'idle';
  if (state.loopVerifying) return 'verifying';
  if (state.loopPrompt === undefined) return 'paused';
  return 'running';
}
