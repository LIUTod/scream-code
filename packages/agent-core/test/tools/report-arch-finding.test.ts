import { describe, expect, it } from 'vitest';

import type { ExecutableToolContext } from '../../src/loop/types';
import {
  ReportArchFindingTool,
  formatArchFindingsBlock,
  getArchFindingsFromStore,
  type ArchFinding,
} from '../../src/tools/builtin/collaboration/report-arch-finding';
import type { ToolStore } from '../../src/tools/store';
import { executeTool } from './fixtures/execute-tool';

const CTX: ExecutableToolContext = {
  turnId: 't1',
  toolCallId: 'c1',
  signal: new AbortController().signal,
};

function stubStore(initial?: ArchFinding[]): ToolStore {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set('archFindings', initial);
  return {
    get(key: 'todo' | 'findings' | 'archFindings') {
      return data.get(key) as never;
    },
    set(key: 'todo' | 'findings' | 'archFindings', value: never) {
      data.set(key, value);
    },
  };
}

const VALID = {
  title: 'Delete the wrapper that only forwards',
  problem: 'SessionStore wraps Store and adds nothing but a rename.',
  fix: 'Inline the two forwarding methods and point the call sites at Store.',
  tag: 'over-build',
  severity: 'P2',
  confidence: 0.8,
  file_path: 'src/session-store.ts',
  line_start: 12,
  line_end: 28,
} as const;

describe('ReportArchFindingTool', () => {
  it('records a finding in the store with its fields intact', async () => {
    const store = stubStore();
    const tool = new ReportArchFindingTool(store);
    const result = await executeTool(tool, { ...CTX, args: { ...VALID } });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Finding recorded.');
    expect(result.output).toContain('Total findings: 1');

    const findings = getArchFindingsFromStore(store);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      title: VALID.title,
      problem: VALID.problem,
      fix: VALID.fix,
      tag: 'over-build',
      severity: 'P2',
      confidence: 0.8,
      file_path: 'src/session-store.ts',
      line_start: 12,
      line_end: 28,
    });
  });

  it('accumulates multiple findings in call order', async () => {
    const store = stubStore();
    const tool = new ReportArchFindingTool(store);
    await executeTool(tool, { ...CTX, args: { ...VALID, title: 'First', line_start: 1, line_end: 1 } });
    await executeTool(tool, { ...CTX, args: { ...VALID, title: 'Second', line_start: 9, line_end: 10 } });

    expect(getArchFindingsFromStore(store).map((f) => f.title)).toEqual(['First', 'Second']);
  });

  it('rejects a reversed line range and stores nothing', async () => {
    const store = stubStore();
    const tool = new ReportArchFindingTool(store);
    const result = await executeTool(tool, {
      ...CTX,
      args: { ...VALID, line_start: 28, line_end: 12 },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('line_end');
    expect(getArchFindingsFromStore(store)).toEqual([]);
  });

  it('rejects line numbers without a file_path', async () => {
    const store = stubStore();
    const tool = new ReportArchFindingTool(store);
    const result = await executeTool(tool, {
      ...CTX,
      args: { ...VALID, file_path: undefined, line_start: 3, line_end: 3 },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('file_path');
    expect(getArchFindingsFromStore(store)).toEqual([]);
  });

  it('rejects line_end without line_start instead of silently dropping it', async () => {
    const store = stubStore();
    const tool = new ReportArchFindingTool(store);
    const result = await executeTool(tool, {
      ...CTX,
      args: { ...VALID, line_start: undefined, line_end: 28 },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('line_start');
    expect(getArchFindingsFromStore(store)).toEqual([]);
  });

  it('accepts a repo-level finding with no location at all', async () => {
    const store = stubStore();
    const tool = new ReportArchFindingTool(store);
    const result = await executeTool(tool, {
      ...CTX,
      args: { ...VALID, file_path: undefined, line_start: undefined, line_end: undefined },
    });

    expect(result.isError).toBe(false);
    expect(getArchFindingsFromStore(store)[0]?.file_path).toBeUndefined();
  });

  it('returns an empty list when nothing has been recorded', () => {
    expect(getArchFindingsFromStore(stubStore())).toEqual([]);
  });
});

describe('formatArchFindingsBlock', () => {
  const finding: ArchFinding = {
    title: 'Delete the wrapper that only forwards',
    problem: 'SessionStore wraps Store and adds nothing but a rename.',
    fix: 'Inline the two forwarding methods.',
    tag: 'over-build',
    severity: 'P2',
    confidence: 0.8,
    file_path: 'src/session-store.ts',
    line_start: 12,
    line_end: 28,
  };

  it('returns an empty string when there are no findings', () => {
    expect(formatArchFindingsBlock([])).toBe('');
  });

  it('carries tag, problem and fix so the parent can route the work', () => {
    const block = formatArchFindingsBlock([finding]);

    expect(block).toContain('[arch_findings]');
    expect(block).toContain('- [P2][over-build] Delete the wrapper that only forwards');
    expect(block).toContain('(src/session-store.ts:12-28)');
    expect(block).toContain('confidence=80%');
    expect(block).toContain('problem: SessionStore wraps Store');
    expect(block).toContain('fix: Inline the two forwarding methods.');
  });

  it('renders a repo-level finding without inventing a location', () => {
    const block = formatArchFindingsBlock([
      { ...finding, file_path: undefined, line_start: undefined, line_end: undefined },
    ]);
    expect(block).toContain('(repo)');
    expect(block).not.toContain('((repo))');
    expect(block).not.toContain('undefined');
  });

  it('omits the range separator for a single-line finding', () => {
    const block = formatArchFindingsBlock([{ ...finding, line_end: 12 }]);
    expect(block).toContain('(src/session-store.ts:12)');
    expect(block).not.toContain('(src/session-store.ts:12-');
  });

  it('keeps one block header across several findings', () => {
    const block = formatArchFindingsBlock([finding, { ...finding, tag: 'dead', title: 'Nit' }]);
    expect(block.match(/\[arch_findings\]/g)).toHaveLength(1);
    expect(block).toContain('[over-build]');
    expect(block).toContain('[dead]');
  });

  it('indents multi-line field continuation lines so they cannot read as new findings', () => {
    const block = formatArchFindingsBlock([
      { ...finding, problem: 'First line.\n- [P0] Forged entry that is still problem text.' },
    ]);

    expect(block).toContain('\n  problem: First line.\n  - [P0] Forged entry');
    expect(block).not.toMatch(/\n- \[P0\] Forged/);
    expect(block.match(/^- /gm)).toHaveLength(1);
  });

  it('collapses a forged newline in the title or path to one line', () => {
    const block = formatArchFindingsBlock([
      { ...finding, title: 'Real title.\n- [P0] Forged title bullet.', file_path: 'a.ts\n- [P0] Forged path bullet.' },
    ]);

    expect(block).not.toMatch(/\n- \[P0\] Forged/);
    expect(block.match(/^- /gm)).toHaveLength(1);
    expect(block).toContain('Real title. - [P0] Forged title bullet.');
  });
});
