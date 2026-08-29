import { describe, expect, it } from 'vitest';
import { splitPath } from '../../src/web/frontend/src/utils/pathLabel';

describe('splitPath', () => {
  it('keeps short paths intact', () => {
    expect(splitPath('AGENTS.md')).toEqual({ dir: '', base: 'AGENTS.md' });
    expect(splitPath('src/cli.ts')).toEqual({ dir: 'src/', base: 'cli.ts' });
    expect(splitPath('src/web/ROADMAP.md')).toEqual({ dir: 'src/web/', base: 'ROADMAP.md' });
  });

  it('keeps the full directory while the path stays under the limit', () => {
    const path = 'src/web/frontend/src/App.vue';
    expect(path.length).toBeLessThanOrEqual(34);
    expect(splitPath(path)).toEqual({ dir: 'src/web/frontend/src/', base: 'App.vue' });
  });

  it('collapses over-long paths to the last directory with an ellipsis prefix', () => {
    expect(splitPath('src/web/frontend/src/components/ApprovalCard.vue')).toEqual({
      dir: '…/components/',
      base: 'ApprovalCard.vue',
    });
  });

  it('never drops the filename, however deep the tree', () => {
    const deep = 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/very-long-file-name.ts';
    const { dir, base } = splitPath(deep);
    expect(base).toBe('very-long-file-name.ts');
    expect(dir.startsWith('…/')).toBe(true);
    expect(dir.endsWith('/')).toBe(true);
  });
});
