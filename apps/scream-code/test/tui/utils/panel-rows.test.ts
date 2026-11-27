import { describe, expect, it } from 'vitest';

import { panelRowBudget, panelViewportRows, type PanelViewport } from '#/tui/utils/panel-rows';

function rowsOf(count: number): { render: () => string[]; invalidate: () => void } {
  return { render: () => Array.from({ length: count }, () => 'row'), invalidate: () => {} };
}

function viewport(parts: { rows: number; columns: number; todo?: number; error?: number; plan?: number }): PanelViewport {
  return {
    terminal: { rows: parts.rows, columns: parts.columns },
    todoPanelContainer: rowsOf(parts.todo ?? 0),
    errorBannerContainer: rowsOf(parts.error ?? 0),
    planModeBannerContainer: rowsOf(parts.plan ?? 0),
  };
}

describe('panelRowBudget', () => {
  it('has no limit while the height is unknown', () => {
    expect(panelRowBudget(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(panelRowBudget(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
  });

  it('leaves the status row, the footer and one transcript row to the rest of the screen', () => {
    expect(panelRowBudget(40)).toBe(40 - 1 - 1 - 1);
  });

  it('never squeezes below the rows a frame, a title, a choice and a hint need', () => {
    expect(panelRowBudget(5)).toBe(6);
    expect(panelRowBudget(0)).toBe(6);
  });
});

describe('panelViewportRows', () => {
  it('is the whole terminal when nothing sits above the editor', () => {
    expect(panelViewportRows(viewport({ rows: 30, columns: 120 }))).toBe(30);
  });

  it('takes off the todo panel, the error banner and the plan banner, which share the dock with the panel', () => {
    expect(panelViewportRows(viewport({ rows: 30, columns: 120, todo: 6, error: 2, plan: 1 }))).toBe(30 - 6 - 2 - 1);
  });

  it('ignores the todo panel where it is not drawn (narrower than its threshold)', () => {
    expect(panelViewportRows(viewport({ rows: 30, columns: 80, todo: 6, error: 1 }))).toBe(30 - 1);
  });

  it('passes an unknown height through, so the panel stays unlimited', () => {
    const unknown = panelViewportRows(viewport({ rows: Number.NaN, columns: 120, todo: 6 }));
    expect(panelRowBudget(unknown)).toBe(Number.POSITIVE_INFINITY);
  });

  it('never goes below zero', () => {
    expect(panelViewportRows(viewport({ rows: 4, columns: 120, todo: 10 }))).toBe(0);
  });
});
