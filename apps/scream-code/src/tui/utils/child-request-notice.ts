/**
 * Child→parent collaboration requests (`ContactParent`): field parsing only.
 *
 * Requests are no longer rendered into the transcript — the body (needs /
 * evidence / artifacts) is long and used to push the conversation off screen.
 * The TUI surfaces them as a one-line ticker above the editor instead
 * (`LifecycleController.showCollabActivity`), while the full text stays in the
 * parent's context and in the agent card's `ContactParent` arguments.
 *
 * `previewText` is shared with that ticker so a multi-line request collapses
 * onto a single paragraph.
 */

import type { SubagentChildRequestEvent } from '@scream-code/scream-code-sdk';

import { sanitizeShellOutput } from './sanitize';

export const CHILD_REQUEST_KINDS = ['info', 'handoff', 'escalate'] as const;
export type ChildRequestKind = (typeof CHILD_REQUEST_KINDS)[number];

export interface ChildRequestFields {
  readonly requestType: ChildRequestKind;
  readonly message: string;
  readonly needs?: string | undefined;
  readonly expecting?: string | undefined;
  readonly artifacts?: readonly string[] | undefined;
  readonly evidence?: readonly string[] | undefined;
  readonly missing?: readonly string[] | undefined;
}

/**
 * Longest previewed value kept on one row. The kernel allows 8192 chars
 * (`contact-parent.ts`); the ticker is one terminal line, so anything longer is
 * cut here and the full text remains reachable via the agent card.
 */
const TEXT_PREVIEW = 200;

/**
 * Collapse the request onto previewable single-paragraph form.
 *
 * The text comes from a child agent's model output, i.e. untrusted input that
 * is about to be written into a terminal row: control sequences (CSI/OSC/DCS —
 * screen clears, cursor moves, OSC 52 clipboard writes) are stripped first, the
 * same way shell output is sanitized elsewhere. The cap counts code points, not
 * UTF-16 units, so a surrogate pair is never split into a replacement glyph.
 */
export function previewText(value: string): string {
  const flattened = sanitizeShellOutput(value).replaceAll(/\s*\n\s*/g, ' ').trim();
  const codePoints = Array.from(flattened);
  return codePoints.length > TEXT_PREVIEW
    ? `${codePoints.slice(0, TEXT_PREVIEW).join('')}…`
    : flattened;
}

function kindOf(raw: unknown): ChildRequestKind {
  return typeof raw === 'string' && (CHILD_REQUEST_KINDS as readonly string[]).includes(raw)
    ? (raw as ChildRequestKind)
    : 'info';
}

function textOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Live producer: the delivery event the kernel emits once a request landed in
 * the parent's turn. Events cross the wire as untyped JSON, so every field is
 * re-checked here rather than trusted from the declared type.
 */
export function childRequestFieldsFromEvent(
  event: SubagentChildRequestEvent,
): ChildRequestFields | null {
  const record = event as unknown as Record<string, unknown>;
  const message = textOf(record['message']);
  // A request with no text carries nothing to show.
  if (message === undefined) return null;
  const listOf = (key: string): readonly string[] | undefined => {
    const raw = record[key];
    if (!Array.isArray(raw)) return undefined;
    const items = raw.map((item) => textOf(item)).filter((item): item is string => item !== undefined);
    return items.length > 0 ? items : undefined;
  };
  return {
    requestType: kindOf(record['requestType']),
    message,
    needs: textOf(record['needs']),
    expecting: textOf(record['expecting']),
    artifacts: listOf('artifacts'),
    evidence: listOf('evidence'),
    missing: listOf('missing'),
  };
}
