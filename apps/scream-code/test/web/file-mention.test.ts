import { describe, expect, it, vi } from 'vitest';

import {
  buildAtInsertText,
  extractAtQuery,
  filterFileEntries,
  type FileEntryLite,
} from '../../src/web/frontend/src/utils/fileFuzzy';

describe('extractAtQuery', () => {
  it('triggers at start of text and after whitespace only', () => {
    expect(extractAtQuery('@src/ma')).toEqual({ start: 0, query: 'src/ma', quoted: false });
    expect(extractAtQuery('看 @comp')).toEqual({ start: 2, query: 'comp', quoted: false });
    // Emails must never trigger.
    expect(extractAtQuery('mail me at foo@bar')).toBeNull();
  });

  it('detects the in-progress quoted form and reports the @ offset', () => {
    const text = 'ref @"my dir/hi';
    const match = extractAtQuery(text);
    expect(match).toEqual({ start: 4, query: 'my dir/hi', quoted: true });
    expect(text.slice(match!.start)).toBe('@"my dir/hi');
  });

  it('treats a lone @ as an empty query (show the index)', () => {
    expect(extractAtQuery('@')).toEqual({ start: 0, query: '', quoted: false });
    expect(extractAtQuery('hi @')).toEqual({ start: 3, query: '', quoted: false });
  });

  it('returns null once whitespace closes the token', () => {
    expect(extractAtQuery('@src/main.ts ')).toBeNull();
  });
});

describe('filterFileEntries', () => {
  const entries: FileEntryLite[] = [
    { path: 'components/ChatInput.tsx', isDir: false },
    { path: 'components/InputBar.tsx', isDir: false },
    { path: 'lib/image.ts', isDir: false },
    { path: 'input.txt', isDir: false },
    { path: 'components', isDir: true },
  ];

  it('ranks basename exact/prefix above substring and boosts directories', () => {
    const paths = filterFileEntries(entries, 'input').map((e) => e.path);
    expect(paths[0]).toBe('input.txt');
    expect(paths).toContain('components/InputBar.tsx');
  });

  it('scores directories ahead on ties', () => {
    const paths = filterFileEntries(entries, 'comp').map((e) => e.path);
    expect(paths[0]).toBe('components');
  });

  it('matches against the full path for drill-down queries', () => {
    const paths = filterFileEntries(entries, 'components/').map((e) => e.path);
    expect(paths).toContain('components/ChatInput.tsx');
    expect(paths).toContain('components/InputBar.tsx');
    expect(paths).not.toContain('lib/image.ts');
  });

  it('finds deep files with fuzzy subsequences', () => {
    const paths = filterFileEntries(entries, 'cinp').map((e) => e.path);
    expect(paths).toContain('components/ChatInput.tsx');
  });

  it('respects the result limit', () => {
    expect(filterFileEntries(entries, '', 2)).toHaveLength(2);
  });
});

describe('buildAtInsertText', () => {
  it('closes files with a trailing space and keeps directories open', () => {
    expect(buildAtInsertText('src/main.ts', false)).toEqual({ text: '@src/main.ts ', cursorOffset: 13 });
    expect(buildAtInsertText('src', true)).toEqual({ text: '@src/', cursorOffset: 5 });
  });

  it('quotes paths containing spaces', () => {
    expect(buildAtInsertText('my dir/file.txt', false)).toEqual({
      text: '@"my dir/file.txt" ',
      cursorOffset: 19,
    });
    const dir = buildAtInsertText('my dir', true);
    expect(dir.text).toBe('@"my dir/"');
    // Caret sits BEFORE the closing quote so drill-down stays well-formed.
    expect(dir.text.slice(0, dir.cursorOffset)).toBe('@"my dir/');
  });
});

describe('useFileAtMention (composable logic)', () => {
  // confirm() re-derives the menu on the next animation frame (browser DOM
  // patch timing); provide a microtask stand-in for the node test env.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    void Promise.resolve().then(() => cb(Date.now()));
    return 0;
  });

  function makeHarness(filesByDir: Record<string, Array<{ name: string; type: 'file' | 'dir' }>>) {
    const fetchMock = vi.fn(async (url: string) => {
      const match = /\/list\?path=([^&]+)/.exec(url);
      const dir = match ? decodeURIComponent(match[1]) : '';
      const entries = filesByDir[dir] ?? [];
      return { ok: true, json: async () => ({ entries }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function makeTextarea() {
    const text = ref2();
    const caret = ref2(0);
    // Mirrors a real textarea: the DOM value lags the v-model ref until the
    // harness flushes it.
    let domValue = '';
    const el = {
      get value() {
        return domValue;
      },
      get selectionStart() {
        return caret.value;
      },
      focus: () => {},
      setSelectionRange: (pos: number) => {
        caret.value = pos;
      },
    } as unknown as HTMLTextAreaElement;
    const flushDom = () => {
      domValue = text.value;
    };
    return { text, caret, el, flushDom };
  }

  async function importComposable() {
    const vue = await import('vue');
    const { useFileAtMention } = await import('../../src/web/frontend/src/composables/useFileAtMention');
    return { ref: vue.ref, nextTick: vue.nextTick, useFileAtMention };
  }

  function ref2(initial = '') {
    return { value: initial };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('walks the drill-down path and never escapes the work dir', async () => {
    const { ref, useFileAtMention } = await importComposable();
    makeHarness({
      '/proj': [
        { name: 'src', type: 'dir' },
        { name: 'README.md', type: 'file' },
      ],
      '/proj/src': [{ name: 'main.ts', type: 'file' }],
    });

    const { text, caret, el, flushDom } = makeTextarea();
    const m = useFileAtMention(text as never, ref(el) as never, ref('/proj') as never);

    async function type(token: string) {
      text.value = token;
      caret.value = token.length;
      flushDom();
      m.refresh();
      await settle();
    }

    await type('@src/m');
    expect(m.visible.value).toBe(true);
    expect(m.suggestions.value.map((e: FileEntryLite) => e.path)).toEqual(['src/main.ts']);

    // Escape above the work dir yields an empty, non-escaping menu.
    await type('@../../etc');
    expect(m.suggestions.value).toEqual([]);

    // Confirm inserts the token and restores the caret after the closing space.
    await type('@src/ma');
    expect(m.confirm()).toBe(true);
    expect(text.value).toBe('@src/main.ts ');
    await settle(); // caret restore happens on the rAF stand-in
    expect(caret.value).toBe('@src/main.ts '.length);
  });

  it('directory picks keep the menu open for drill-down', async () => {
    const { ref, useFileAtMention } = await importComposable();
    makeHarness({
      '/proj': [{ name: 'src', type: 'dir' }],
      '/proj/src': [{ name: 'main.ts', type: 'file' }],
    });

    const { text, caret, el, flushDom } = makeTextarea();
    const m = useFileAtMention(text as never, ref(el) as never, ref('/proj') as never);

    text.value = '@src';
    caret.value = 4;
    flushDom();
    m.refresh();
    await settle();

    const dirEntry = m.suggestions.value.find((e: FileEntryLite) => e.path === 'src' && e.isDir);
    expect(dirEntry).toBeDefined();
    expect(m.confirm(dirEntry)).toBe(true);
    await settle(); // caret restore
    expect(text.value).toBe('@src/');
    expect(caret.value).toBe(5);

    // After the DOM catches up, the menu re-derives against /proj/src.
    flushDom();
    m.refresh();
    await settle();
    expect(m.visible.value).toBe(true);
    expect(m.suggestions.value.map((e: FileEntryLite) => e.path)).toEqual(['src/main.ts']);
  });

  it('typing without a mention keeps the menu hidden', async () => {
    const { ref, useFileAtMention } = await importComposable();
    makeHarness({ '/proj': [{ name: 'a.ts', type: 'file' }] });

    const { text, caret, el, flushDom } = makeTextarea();
    const m = useFileAtMention(text as never, ref(el) as never, ref('/proj') as never);

    text.value = 'foo@bar.com';
    caret.value = text.value.length;
    flushDom();
    m.refresh();
    await settle();
    expect(m.visible.value).toBe(false);
  });
});
