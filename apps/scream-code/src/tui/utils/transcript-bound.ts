import type { TranscriptEntry } from '../types';

/**
 * UI-side bounds for tool output previews stored in the transcript.
 *
 * The model-facing side is already bounded in agent-core (ToolResultBuilder
 * 50k/20k + artifactSink), but a transcript entry kept the full
 * `result.output` for the life of the session. This module bounds only the
 * UI preview: the model-visible output is untouched.
 *
 * The elision marker mirrors `result-builder.ts` (`[…N lines elided…]` /
 * TRUNCATION_MARKER) so a bounded preview reads like a truncated tool result.
 */

/** Max tool-output lines kept from the head of the preview. */
export const UI_OUTPUT_MAX_HEAD_LINES = 40;
/** Max tool-output lines kept from the tail of the preview. */
export const UI_OUTPUT_MAX_TAIL_LINES = 40;
/** Max characters kept across head + tail of the preview combined. */
export const UI_OUTPUT_MAX_CHARS = 8_000;

/** Same marker string as agent-core's `result-builder.ts` TRUNCATION_MARKER. */
const TRUNCATION_MARKER = '[...truncated]';

function elisionMarker(elided: number): string {
  return `[…${String(elided)} lines elided…]`;
}

/**
 * Bounds one tool-output string to a head + tail preview:
 * - at most {@link UI_OUTPUT_MAX_HEAD_LINES} lines from the start and
 *   {@link UI_OUTPUT_MAX_TAIL_LINES} lines from the end (the middle is
 *   replaced with `[…N lines elided…]`);
 * - the kept head + tail text stays within {@link UI_OUTPUT_MAX_CHARS} chars,
 *   dropping whole lines first and hard-slicing a lone oversized line last
 *   (marked `[...truncated]`).
 *
 * Returns the input unchanged when it already fits both budgets.
 */
function boundToolOutput(output: string): string {
  const lines = output.split('\n');
  const totalLines = lines.length;
  const overflowLines = totalLines > UI_OUTPUT_MAX_HEAD_LINES + UI_OUTPUT_MAX_TAIL_LINES;
  const overflowChars = output.length > UI_OUTPUT_MAX_CHARS;
  if (!overflowLines && !overflowChars) return output;

  const head = lines.slice(0, UI_OUTPUT_MAX_HEAD_LINES);
  const tail = overflowLines
    ? lines.slice(totalLines - UI_OUTPUT_MAX_TAIL_LINES)
    : lines.slice(UI_OUTPUT_MAX_HEAD_LINES);
  let elided = totalLines - head.length - tail.length;

  // The assembled preview is `head + \n + marker + \n + tail`; reserving the
  // two joining newlines here keeps the whole string within
  // UI_OUTPUT_MAX_CHARS + marker.length.
  const contentBudget = UI_OUTPUT_MAX_CHARS - 2;
  let headText = head.join('\n');
  let tailText = tail.join('\n');
  // Whole lines first: drop from whichever side holds more text so the two
  // ends shrink toward the shared char budget together.
  while (headText.length + tailText.length > contentBudget) {
    const dropHead = head.length > 1 && (tail.length <= 1 || headText.length >= tailText.length);
    if (dropHead) {
      head.pop();
      headText = head.join('\n');
      elided += 1;
      continue;
    }
    if (tail.length > 1) {
      tail.shift();
      tailText = tail.join('\n');
      elided += 1;
      continue;
    }
    break;
  }

  if (headText.length + tailText.length > contentBudget) {
    // One giant line on each side (or a single giant line total): slice chars.
    const tailKeep = Math.min(tailText.length, Math.floor(contentBudget / 2));
    const headKeep = Math.min(headText.length, contentBudget - tailKeep);
    headText = headText.slice(0, headKeep);
    tailText = tailText.slice(tailText.length - tailKeep);
  }

  const marker = elided > 0 ? elisionMarker(elided) : TRUNCATION_MARKER;
  const parts: string[] = [];
  if (headText.length > 0) parts.push(headText);
  parts.push(marker);
  if (tailText.length > 0) parts.push(tailText);
  return parts.join('\n');
}

/**
 * Returns a transcript entry safe to keep in `state.transcriptEntries`:
 * tool-group entries get their `result.output` replaced with the bounded
 * preview (a copy — message, brief, titles, args and every other field stay
 * as they are). Non-tool entries — and tool entries already within budget —
 * come back untouched (no copy).
 */
export function boundEntryForUi(entry: TranscriptEntry): TranscriptEntry {
  const toolCallData = entry.toolCallData;
  if (toolCallData === undefined) return entry;
  const result = toolCallData.result;
  if (result === undefined) return entry;
  const boundedOutput = boundToolOutput(result.output);
  if (boundedOutput === result.output) return entry;
  return {
    ...entry,
    toolCallData: {
      ...toolCallData,
      result: { ...result, output: boundedOutput },
    },
  };
}
