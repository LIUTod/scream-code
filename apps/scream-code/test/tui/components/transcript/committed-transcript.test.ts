import { describe, expect, it } from 'vitest';

import {
  CommittedTranscriptComponent,
  MAX_COMMITTED_ENTRIES,
} from '#/tui/components/transcript/committed-transcript';
import { darkColors } from '#/tui/theme/colors';
import { formatCollapsedEntries } from '#/tui/utils/collapse-stub';
import type { TranscriptEntry } from '#/tui/types';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function entry(content: string): TranscriptEntry {
  return { id: `e-${content}`, kind: 'status', renderMode: 'plain', content };
}

function appendRows(component: CommittedTranscriptComponent, count: number, from = 0): void {
  for (let i = from; i < from + count; i += 1) {
    component.appendEntry(entry(`row-${String(i)}`), darkColors);
  }
}

function rendered(component: CommittedTranscriptComponent, width = 80): string {
  return stripAnsi(component.render(width).join('\n'));
}

/** Fold summaries on screen — the fold must never land a second one. */
function collapseLines(component: CommittedTranscriptComponent): string[] {
  return rendered(component)
    .split('\n')
    .filter((line) => line.includes('earlier entries collapsed'));
}

describe('CommittedTranscriptComponent retention cap', () => {
  it('adds no stub while the tree stays within the cap', () => {
    const component = new CommittedTranscriptComponent(darkColors);

    appendRows(component, MAX_COMMITTED_ENTRIES);

    // Header + one child per row, nothing folded.
    expect(component.children.length).toBe(MAX_COMMITTED_ENTRIES + 1);
    expect(component.getCollapsedCount()).toBe(0);
    expect(collapseLines(component)).toHaveLength(0);
    expect(rendered(component)).toContain('row-0');
  });

  it('folds the oldest rows into one stub once the tree passes the cap', () => {
    const component = new CommittedTranscriptComponent(darkColors);
    const total = MAX_COMMITTED_ENTRIES + 100;

    appendRows(component, total);

    // Header + stub + (cap - 1) rows: the cap is the actually retained set.
    expect(component.children.length).toBe(MAX_COMMITTED_ENTRIES + 1);
    const rows = component.children.length - 2;
    // Folded + retained accounts for every appended row — no double count.
    expect(component.getCollapsedCount()).toBe(total - rows);
    expect(rows).toBe(MAX_COMMITTED_ENTRIES - 1);

    const summaries = collapseLines(component);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain(formatCollapsedEntries(component.getCollapsedCount()));
    // The newest rows survive and the folded oldest are gone.
    expect(rendered(component)).toContain(`row-${String(total - 1)}`);
    expect(rendered(component)).not.toContain('row-0');
  });

  it('folds one more row per append once the tree is at its retention point', () => {
    const component = new CommittedTranscriptComponent(darkColors);
    appendRows(component, MAX_COMMITTED_ENTRIES + 1);
    const before = component.getCollapsedCount();

    appendRows(component, 5, 10_000);

    expect(component.children.length).toBe(MAX_COMMITTED_ENTRIES + 1);
    expect(component.getCollapsedCount()).toBe(before + 5);
    expect(collapseLines(component)).toHaveLength(1);
    expect(rendered(component)).toContain('row-10004');
  });

  it('keeps the committed total separate from the retained window', () => {
    const component = new CommittedTranscriptComponent(darkColors);
    const total = MAX_COMMITTED_ENTRIES + 10;
    appendRows(component, total);
    component.setCount(total);

    // Folding changes what is on screen, never what was committed.
    expect(component.getCount()).toBe(total);
    expect(component.getCollapsedCount() + (component.children.length - 2)).toBe(total);
  });
});
