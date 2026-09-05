// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import FileTree from '../../src/web/frontend/src/components/FileTree.vue';
import { _resetFileTreeForTests } from '../../src/web/frontend/src/composables/useFileTreeState';
import { _clearDirCacheForTests } from '../../src/web/frontend/src/utils/fileDirCache';
import type { GitStatus } from '../../src/web/frontend/src/types';

/**
 * FileTree reads through useFileTreeState + fileDirCache (both module-level
 * singletons). Every test uses a UNIQUE workdir AND a beforeEach reset so the
 * shared query / children cache can never bleed across tests.
 */
let nextDir = 0;
function freshWorkDir(): string {
  nextDir += 1;
  return `/tmp/wd-test-${Date.now()}-${nextDir}`;
}

beforeEach(() => {
  _resetFileTreeForTests();
  _clearDirCacheForTests();
});

function entry(name: string, type: 'file' | 'dir'): unknown {
  return { name, path: `/ignored/${name}`, type, size: 0, mtime: 0 };
}

function stubFetch(map: Record<string, unknown[]>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string) => {
    const u = new URL(url, 'http://x');
    const path = u.searchParams.get('path') ?? '';
    const entries = map[path];
    if (!entries) return { ok: false, status: 404 } as Response;
    return { ok: true, status: 200, json: async () => ({ path, entries }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function gitStatusOf(files: Array<{ displayPath: string; status: string }>): GitStatus {
  return { isRepo: true, branch: 'main', files: files.map((f) => ({ path: f.displayPath, ...f })) };
}

describe('FileTree', () => {
  it('lists the root directory with file and folder rows', async () => {
    const wd = freshWorkDir();
    const fetchMock = stubFetch({
      [wd]: [entry('src', 'dir'), entry('package.json', 'file')],
    });
    const wrapper = mount(FileTree, { props: { workDir: wd, gitStatus: null } });
    // The root fetch resolves async; wait for the DOM to settle.
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent(wd)));
    const labels = wrapper.findAll('.row-label').map((n) => n.text());
    expect(labels).toContain('src');
    expect(labels).toContain('package.json');
  });

  it('shows the empty state when the root listing is empty', async () => {
    const wd = freshWorkDir();
    stubFetch({ [wd]: [] });
    const wrapper = mount(FileTree, { props: { workDir: wd, gitStatus: null } });
    await flushPromises();
    expect(wrapper.text()).toContain('工作目录为空');
  });

  it('lazily fetches a directory when expanded and adds its children', async () => {
    const wd = freshWorkDir();
    const src = `${wd}/src`;
    const fetchMock = stubFetch({
      [wd]: [entry('src', 'dir')],
      [src]: [entry('index.ts', 'file')],
    });
    const wrapper = mount(FileTree, { props: { workDir: wd, gitStatus: null } });
    await flushPromises();

    // Click the directory row to expand it.
    const dirRow = wrapper.findAll('.tree-row.is-dir')[0];
    expect(dirRow).toBeTruthy();
    await dirRow?.trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent(src)));
    expect(wrapper.text()).toContain('index.ts');
  });

  it('stamps git badges (M/A/?) from the git status', async () => {
    const wd = freshWorkDir();
    stubFetch({
      [wd]: [entry('a.ts', 'file'), entry('b.ts', 'file'), entry('c.ts', 'file')],
    });
    const git = gitStatusOf([
      { displayPath: 'a.ts', status: 'M' },
      { displayPath: 'b.ts', status: 'A' },
      { displayPath: 'c.ts', status: '??' },
    ]);
    const wrapper = mount(FileTree, { props: { workDir: wd, gitStatus: git } });
    await flushPromises();

    const badges = wrapper.findAll('.row-git').map((n) => n.text());
    expect(badges).toContain('M');
    expect(badges).toContain('A');
    expect(badges).toContain('?');
    // No badge on unlisted files.
    expect(badges.length).toBe(3);
  });

  it('filters loaded nodes when a query is typed', async () => {
    const wd = freshWorkDir();
    stubFetch({
      [wd]: [entry('index.ts', 'file'), entry('README.md', 'file'), entry('src', 'dir')],
    });
    const wrapper = mount(FileTree, { props: { workDir: wd, gitStatus: null } });
    await flushPromises();

    await wrapper.find('.tree-search input').setValue('index');
    await flushPromises();
    const labels = wrapper.findAll('.row-label').map((n) => n.text());
    expect(labels).toContain('index.ts');
    expect(labels).not.toContain('README.md');
  });

  it('opens the clicked file in the right panel', async () => {
    const wd = freshWorkDir();
    stubFetch({ [wd]: [entry('package.json', 'file')] });
    const fileTabState = await import('../../src/web/frontend/src/utils/fileTabState');
    const spy = vi.spyOn(fileTabState, 'openFileInPanel').mockImplementation(() => 'tab');
    const wrapper = mount(FileTree, { props: { workDir: wd, gitStatus: null } });
    await flushPromises();

    const fileRow = wrapper.find('.tree-row:not(.is-dir)');
    await fileRow.trigger('click');
    expect(spy).toHaveBeenCalledWith(`${wd}/package.json`);
    spy.mockRestore();
  });

  it('shows the no-workdir empty state', () => {
    const wrapper = mount(FileTree, { props: { workDir: null, gitStatus: null } });
    expect(wrapper.text()).toContain('当前会话没有工作目录');
  });
});
