/**
 * Guard: the stop gate may only continue a turn for one of three tagged reasons.
 *
 * `shouldContinueAfterStop` runs *after* the final answer has already streamed
 * to the user, so every `return { continue: true }` it makes buys a whole extra
 * round — thinking plus tool calls appended below an answer the user has already
 * read. Only three categories may pay that price:
 *
 *   - `correction`     — the work itself is wrong or unfinished.
 *   - `external-input` — something outside the model is waiting (steer, Stop hook).
 *   - `quality-floor`  — the final response is too short to be deliverable.
 *
 * Internal state maintenance (checklist bookkeeping, goal progress, summary
 * polish) is deliberately excluded: those reminders belong in `beforeStep`,
 * before the answer is written.
 *
 * This is a source-shape guard, in the style of `prompt-placeholders.test.ts`
 * and `tools/cron/no-date-now.test.ts`: it reads the real source file because
 * the hook is a closure inside `runTurn()` with no injectable seam. The tag is
 * enforced here because it is documentation that must not rot — a new
 * continuation reason cannot land without either reusing one of the three
 * categories or editing this file on purpose.
 */

import { readFileSync } from 'node:fs';

import { join } from 'pathe';

import { describe, expect, it } from 'vitest';

const TURN_SOURCE = join(import.meta.dirname, '..', '..', 'src', 'agent', 'turn', 'index.ts');
const SOURCE_LABEL = TURN_SOURCE.slice(TURN_SOURCE.indexOf('packages/'));

const GATE = 'shouldContinueAfterStop';

/**
 * The complete set of continuation categories. Adding a fourth category is a
 * deliberate product decision, not a convenience: it must be argued for in
 * `docs/turn-pipeline.md` 「续轮输出纪律」 and added here on purpose.
 */
const ALLOWED_CATEGORIES = ['correction', 'external-input', 'quality-floor'] as const;

const ALLOW_TAG_RE = /\/\/\s*allow:\s*([A-Za-z][\w-]*)/;
const CONTINUE_TRUE_RE = /return\s*\{\s*continue:\s*true\s*\}/g;
/** Any spelling of the continuation flag, so a reformatted return cannot hide. */
const CONTINUE_TRUE_LOOSE_RE = /continue:\s*true/g;

/** How many lines above a `return { continue: true }` a tag may sit. */
const TAG_LOOKBACK = 3;

const sourceLines = readFileSync(TURN_SOURCE, 'utf8').split('\n');

interface SlicedProperty {
  /** Property lines, first line included, closing `},` included. */
  readonly lines: readonly string[];
  /** 1-based line number of `lines[0]` in the source file. */
  readonly startLine: number;
  readonly text: string;
}

/**
 * Slice one property out of the host hook object by indentation: from its
 * `name:` line down to the matching `},` that closes it at the same indent —
 * i.e. everything up to the next sibling member.
 */
function sliceProperty(name: string): SlicedProperty {
  const head = new RegExp(`^(\\s*)${name}\\s*:`);
  let start = -1;
  let indent = '';
  for (let i = 0; i < sourceLines.length; i += 1) {
    const match = head.exec(sourceLines[i] ?? '');
    if (match !== null) {
      start = i;
      indent = match[1] ?? '';
      break;
    }
  }
  if (start === -1) throw new Error(`\`${name}\` not found in ${SOURCE_LABEL}`);

  const closer = `${indent}},`;
  let end = -1;
  for (let i = start + 1; i < sourceLines.length; i += 1) {
    if (sourceLines[i] === closer) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`could not find the end of \`${name}\` in ${SOURCE_LABEL}`);

  const lines = sourceLines.slice(start, end + 1);
  return { lines, startLine: start + 1, text: lines.join('\n') };
}

const body = sliceProperty(GATE);

/** A comment line cannot contain a statement, so it is not a continuation site. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/** The body with comment-only lines blanked out, for statement-level scanning. */
const bodyCode = body.lines.map((line) => (isCommentLine(line) ? '' : line));

interface ContinueSite {
  /** 0-based index into `body.lines`. */
  readonly index: number;
  readonly line: string;
}

function findContinueReturns(codeLines: readonly string[]): ContinueSite[] {
  const sites: ContinueSite[] = [];
  for (let i = 0; i < codeLines.length; i += 1) {
    const line = codeLines[i] ?? '';
    CONTINUE_TRUE_RE.lastIndex = 0;
    if (CONTINUE_TRUE_RE.test(line)) sites.push({ index: i, line: line.trim() });
  }
  return sites;
}

/** The tagged return plus the lines above it, numbered — for failure messages. */
function context(lines: readonly string[], index: number): string {
  const from = Math.max(0, index - TAG_LOOKBACK);
  const out: string[] = [];
  for (let i = from; i <= index; i += 1) {
    out.push(`    ${SOURCE_LABEL}:${body.startLine + i}  ${lines[i] ?? ''}`);
  }
  return out.join('\n');
}

describe('stop gate — continuation categories', () => {
  it('extracts the whole stop-gate body from the source', () => {
    expect(
      body.lines.length,
      `sliced \`${GATE}\` down to ${body.lines.length} lines — the extraction went wrong`,
    ).toBeGreaterThan(50);
    expect(
      body.text,
      'the slice must reach the end of the hook (`return { continue: false }`), otherwise ' +
        'a continuation site below that point would escape every assertion here',
    ).toContain('return { continue: false }');
  });

  it('finds every continuation return site the guard can tag-check', () => {
    const tagged = findContinueReturns(bodyCode).length;
    const total = (bodyCode.join('\n').match(CONTINUE_TRUE_LOOSE_RE) ?? []).length;
    expect(
      total,
      `\`${GATE}\` has ${String(total)} \`continue: true\` sites but only ${String(tagged)} are ` +
        'written as `return { continue: true }` on one line. Rewrite the odd one out in that ' +
        'shape so the tag guard below can check it — a continuation site the guard cannot see ' +
        'is exactly what this file exists to prevent.',
    ).toBe(tagged);
  });

  it('tags every `return { continue: true }` with an allowed category', () => {
    const sites = findContinueReturns(bodyCode);
    expect(
      sites.length,
      `no \`return { continue: true }\` found inside \`${GATE}\` — the guard would pass vacuously`,
    ).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const site of sites) {
      const absolute = body.startLine + site.index;
      const candidates: (string | undefined)[] = [];
      for (let back = 1; back <= TAG_LOOKBACK; back += 1) candidates.push(body.lines[site.index - back]);

      const tagLine = candidates.find(
        (candidate) => candidate !== undefined && ALLOW_TAG_RE.test(candidate),
      );
      const category = tagLine === undefined ? undefined : ALLOW_TAG_RE.exec(tagLine)?.[1];

      if (tagLine === undefined) {
        offenders.push(
          `${SOURCE_LABEL}:${String(absolute)}  no \`// allow: <category>\` in the ${String(TAG_LOOKBACK)} lines above\n` +
            context(body.lines, site.index),
        );
        continue;
      }
      if (!(ALLOWED_CATEGORIES as readonly string[]).includes(category ?? '')) {
        offenders.push(
          `${SOURCE_LABEL}:${String(absolute)}  category \`${category ?? ''}\` is not one of ` +
            `${ALLOWED_CATEGORIES.join(' / ')}\n${context(body.lines, site.index)}`,
        );
      }
    }

    expect(
      offenders,
      'Every `return { continue: true }` in the stop gate must carry `// allow: <category>` ' +
        'on one of the 3 lines above it, and the category must be one of ' +
        `${ALLOWED_CATEGORIES.join(' / ')}. The stop gate runs after the final answer has ` +
        'already reached the user, so a continuation reason needs arguing for, not just ' +
        'adding. Offending sites:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('allows exactly three categories, so a fourth is a deliberate edit', () => {
    expect(
      ALLOWED_CATEGORIES.toSorted(),
      'The stop gate allows exactly three continuation categories. Adding a fourth (internal ' +
        'state maintenance, for instance) is a product decision: it must be argued for in ' +
        '`docs/turn-pipeline.md` 「续轮输出纪律」 and added here on purpose.',
    ).toEqual(['correction', 'external-input', 'quality-floor']);

    const used = new Set<string>();
    for (const site of findContinueReturns(bodyCode)) {
      for (let back = 1; back <= TAG_LOOKBACK; back += 1) {
        const category = ALLOW_TAG_RE.exec(body.lines[site.index - back] ?? '')?.[1];
        if (category !== undefined) {
          used.add(category);
          break;
        }
      }
    }
    const unknown = [...used].filter(
      (category) => !(ALLOWED_CATEGORIES as readonly string[]).includes(category),
    );
    expect(
      unknown,
      `\`${GATE}\` uses categories outside the allowed set: ${unknown.join(', ')}. ` +
        'Only `correction` / `external-input` / `quality-floor` may continue a turn.',
    ).toEqual([]);
  });

  it('does not know the checklist tool exists', () => {
    const hits: string[] = [];
    body.lines.forEach((line, i) => {
      if (!/todo/i.test(line)) return;
      hits.push(`${SOURCE_LABEL}:${String(body.startLine + i)}  ${line.trim()}`);
    });

    expect(
      hits,
      `\`${GATE}\` must not mention the checklist tool at all. It only runs after the final ` +
        'answer has streamed, so any checklist-driven continuation is exactly the post-answer ' +
        'extra block this rule exists to prevent — checklist upkeep belongs in `beforeStep`. ' +
        'Matches:\n' +
        hits.join('\n'),
    ).toEqual([]);
  });

  it('does not contain the removed post-answer checklist reasons', () => {
    const removed = [
      'reconcile the TodoList with reality',
      'no TodoList update was made',
    ];
    for (const phrase of removed) {
      const index = body.lines.findIndex((line) => line.includes(phrase));
      const at = index === -1 ? '' : ` (found at ${SOURCE_LABEL}:${String(body.startLine + index)})`;
      expect(
        index,
        `\`${GATE}\` must not carry the removed reason \`${phrase}\`${at}. It was moved to ` +
          '`beforeStep`, so its reappearance here means the post-answer extra round is back.',
      ).toBe(-1);
    }
  });
});
