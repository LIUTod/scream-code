/**
 * Child→parent collaboration requests (`ContactParent`) shown in the main
 * transcript as a two-line notice: a bold title naming the requester, then a
 * dim detail line carrying the request itself.
 *
 * Two producers share this formatter so live and replay never disagree:
 *  - the live path reads the subagent's `tool.call.started` args;
 *  - session replay recovers the same fields from the `<notification>` XML the
 *    kernel injects into the parent's context.
 *
 * Replay cannot recover the subagent's display name (spawn events are not part
 * of the persisted context), so it renders the name-less title variant.
 */

import { t } from '@scream-code/config';

export const CHILD_REQUEST_KINDS = ['info', 'handoff', 'escalate'] as const;
export type ChildRequestKind = (typeof CHILD_REQUEST_KINDS)[number];

export interface ChildRequestFields {
  readonly requestType: ChildRequestKind;
  readonly message: string;
  readonly needs?: string | undefined;
  readonly artifacts?: readonly string[] | undefined;
  readonly evidence?: readonly string[] | undefined;
  readonly missing?: readonly string[] | undefined;
}

export interface ChildRequestNotice {
  readonly title: string;
  readonly detail: string;
}

/** Cap each payload list so a 20-entry artifact array cannot explode the transcript. */
const LIST_PREVIEW = 3;

/**
 * Longest previewed value kept on a transcript row — request text, `needs`, or
 * a payload list. The kernel allows 8192 chars (`contact-parent.ts`), and
 * transcript folding counts components rather than lines, so an uncapped row
 * can never collapse. The full text stays available: it is in the parent's
 * context and in the agent card's sub-tool-call args.
 */
const TEXT_PREVIEW = 200;

/** Collapse the request onto previewable single-paragraph form. */
function previewText(value: string): string {
  const flattened = value.replaceAll(/\s*\n\s*/g, ' ').trim();
  return flattened.length > TEXT_PREVIEW ? `${flattened.slice(0, TEXT_PREVIEW)}…` : flattened;
}

const TYPE_KEY: Record<ChildRequestKind, string> = {
  info: 'transcript.child_request_type_info',
  handoff: 'transcript.child_request_type_handoff',
  escalate: 'transcript.child_request_type_escalate',
};

const LIST_KEY: Record<'artifacts' | 'evidence' | 'missing', string> = {
  artifacts: 'transcript.child_request_artifacts',
  evidence: 'transcript.child_request_evidence',
  missing: 'transcript.child_request_missing',
};

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

function stringifyList(raw: readonly string[]): string {
  // Truncate the names first so the hidden-count suffix survives a long path list.
  const shown = previewText(raw.slice(0, LIST_PREVIEW).join(', '));
  const hidden = raw.length - Math.min(raw.length, LIST_PREVIEW);
  return hidden > 0 ? `${shown} +${hidden}` : shown;
}

function previewedList(
  field: 'artifacts' | 'evidence' | 'missing',
  items: readonly string[] | undefined,
): string | undefined {
  if (items === undefined || items.length === 0) return undefined;
  return t(LIST_KEY[field], { value: stringifyList(items) });
}

/** Live producer: the args the model handed to `ContactParent`. */
export function childRequestFieldsFromArgs(args: Record<string, unknown>): ChildRequestFields | null {
  const message = textOf(args['message']);
  // A call without a request body must not paint an empty notice.
  if (message === undefined) return null;
  const payload =
    typeof args['payload'] === 'object' && args['payload'] !== null && !Array.isArray(args['payload'])
      ? (args['payload'] as Record<string, unknown>)
      : {};
  const listOf = (key: string): readonly string[] | undefined => {
    const raw = payload[key];
    if (!Array.isArray(raw)) return undefined;
    const items = raw.map((item) => textOf(item)).filter((item): item is string => item !== undefined);
    return items.length > 0 ? items : undefined;
  };
  return {
    requestType: kindOf(args['request_type']),
    message,
    needs: textOf(args['needs']),
    artifacts: listOf('artifacts'),
    evidence: listOf('evidence'),
    missing: listOf('missing'),
  };
}

/** Parse `artifacts: [a, b]` back into its items. */
function bracketedListOf(value: string): readonly string[] {
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return inner
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Replay producer: recover the fields from the injected notification. The body
 * shape is owned by `submitChildRequest` in agent-core:
 *   `<type>: <message>` then optional `needs:` / `artifacts:` / `evidence:` /
 *   `missing:` lines. A multi-line message keeps its extra lines attached.
 */
export function childRequestFieldsFromNotification(text: string): ChildRequestFields | null {
  const lines = text.split('\n');
  const open = lines.findIndex(
    (line) => line.startsWith('<notification ') && line.includes('type="child_request"'),
  );
  if (open < 0) return null;

  const body: string[] = [];
  for (let index = open + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line === '</notification>') break;
    if (line.startsWith('Title: ') || line.startsWith('Severity: ')) continue;
    body.push(line);
  }
  const first = body[0];
  if (first === undefined) return null;

  const head = /^(info|handoff|escalate):\s([\s\S]*)$/.exec(first);
  const requestType = head !== null ? kindOf(head[1]) : 'info';
  const messageParts: string[] = [head !== null && head[2] !== undefined ? head[2] : first];

  let needs: string | undefined;
  const lists: Partial<Record<'artifacts' | 'evidence' | 'missing', readonly string[]>> = {};
  for (const line of body.slice(1)) {
    const separator = line.indexOf(': ');
    const key = separator < 0 ? '' : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 2).trim();
    // Only the kernel's own `artifacts: [a, b]` bracket form counts as a field,
    // so a message line that merely starts with `missing: …` stays message text.
    // Residual limit, accepted deliberately: a `needs:` line inside a multi-line
    // request still reads as a field. The kernel only emits `needs:` on its own
    // line, and guessing further would trade a real ambiguity for a worse one.
    const listKey =
      (key === 'artifacts' || key === 'evidence' || key === 'missing') &&
      value.startsWith('[') &&
      value.endsWith(']')
        ? key
        : undefined;
    if (key === 'needs' && value.length > 0) {
      needs = value;
    } else if (listKey !== undefined) {
      lists[listKey] = bracketedListOf(value);
    } else {
      // Unrecognised line: it belongs to the request text, not to a field.
      messageParts.push(line);
    }
  }

  const message = messageParts.join('\n').trim();
  // Mirrors the live path: a request with no text paints nothing.
  if (message.length === 0) return null;

  return {
    requestType,
    message,
    needs,
    artifacts: lists['artifacts'],
    evidence: lists['evidence'],
    missing: lists['missing'],
  };
}

/** Build the transcript notice. `name` is absent on replay. */
export function renderChildRequestNotice(
  fields: ChildRequestFields,
  name?: string | undefined,
): ChildRequestNotice {
  const type = t(TYPE_KEY[fields.requestType]);
  const title =
    name === undefined
      ? t('transcript.child_request_anon', { type })
      : t('transcript.child_request', { name, type });

  const parts: string[] = [previewText(fields.message)];
  if (fields.needs !== undefined) {
    parts.push(t('transcript.child_request_needs', { value: previewText(fields.needs) }));
  }
  for (const entry of [
    ['artifacts', fields.artifacts],
    ['evidence', fields.evidence],
    ['missing', fields.missing],
  ] as const) {
    const preview = previewedList(entry[0], entry[1]);
    if (preview !== undefined) parts.push(preview);
  }
  return { title, detail: parts.join(' · ') };
}
