import { describe, expect, it } from 'vitest';
import { fileBreadcrumbs } from '../../../src/bot/ui/components/shell/drawer-state';

describe('Files drawer breadcrumbs', () => {
  it('builds ancestor links for a nested server workspace without exposing parents', () => {
    expect(fileBreadcrumbs('/fixed/thread/', '/fixed/thread/src/nested')).toEqual([
      { path: '/fixed/thread', label: '/fixed/thread' },
      { path: '/fixed/thread/src', label: 'src' },
      { path: '/fixed/thread/src/nested', label: 'nested' },
    ]);
    expect(fileBreadcrumbs('/', '/src')).toEqual([{ path: '/', label: '/' }, { path: '/src', label: 'src' }]);
  });
  it('never turns a sibling prefix or traversal path into a breadcrumb target', () => {
    const root = [{ path: '/fixed/thread', label: '/fixed/thread' }];
    expect(fileBreadcrumbs('/fixed/thread', '/fixed/thread-other/secret')).toEqual(root);
    expect(fileBreadcrumbs('/fixed/thread', '/fixed/thread/../secret')).toEqual(root);
  });
});
