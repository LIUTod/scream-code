/**
 * Expected-content computation for the edit benchmark.
 *
 * The harness verifies the workspace file byte-for-byte after the turn
 * (`verifyFileAfterTurn`), so every case needs the exact content a correct
 * repair produces:
 *
 * - non-recovery cases: apply the corruption, then invert it — which yields
 *   the pristine fixture content again.
 * - recovery cases (`external-shift`): the file on disk is additionally
 *   shifted AFTER the corruption, while the prompt quotes pre-shift line
 *   numbers; the expected content is the fix applied to the shifted text.
 */

import {
  applyMutation,
  type ExternalShift,
  type MutationClass,
  type MutationResult,
} from './mutations';

/** The corrupted file content as it is handed to the model on disk. */
export function onDiskContent(originalContent: string, result: MutationResult): string {
  const mutated = applyMutation(originalContent, result);
  if (result.shift === undefined) return mutated;
  return applyExternalShift(mutated, result.shift);
}

/** Applies the fix for a mutation class to (possibly shifted) content. */
export function applyFix(
  content: string,
  mutationClass: MutationClass,
  result: MutationResult,
): string {
  return mutationClass.fix(content, result);
}

/**
 * Applies an external shift: `count` blank lines inserted before `atLine`,
 * or `count` lines deleted from `atLine` (both 1-based).
 */
export function applyExternalShift(content: string, shift: ExternalShift): string {
  const lines = content.split('\n');
  const at = Math.min(Math.max(shift.atLine - 1, 0), lines.length);
  if (shift.mode === 'insert') {
    const blanks = Array.from({ length: shift.count }, () => '');
    lines.splice(at, 0, ...blanks);
  } else {
    lines.splice(at, shift.count);
  }
  return lines.join('\n');
}

/**
 * Full pipeline: original fixture content + a mutation → the expected final
 * file content after the model applies the repair correctly.
 */
export function expectedAfterFix(
  originalContent: string,
  mutationClass: MutationClass,
  result: MutationResult,
): string {
  return applyFix(onDiskContent(originalContent, result), mutationClass, result);
}
