// @vitest-environment jsdom
// Viewport activation, lazy loading and streaming-increment behaviour of code block
// highlighting. Complementary to streaming-render-pin.test.ts (the legacy path without
// an IntersectionObserver): this file injects a MockIntersectionObserver before the
// module loads and covers the new mechanism.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';

const shikiMock = vi.hoisted(() => {
  const calls = {
    createHighlighterCore: 0,
    loadLanguage: [] as string[],
    codeToHtml: [] as Array<{ code: string; lang: string; theme: string }>,
    codeToTokens: [] as Array<{ code: string; lang: string; theme: string; resumed: boolean }>,
  };
  return { calls };
});

vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => {
    shikiMock.calls.createHighlighterCore += 1;
    return {
      loadLanguage: async (grammar: { name?: string }) => {
        shikiMock.calls.loadLanguage.push(grammar?.name ?? 'unknown');
      },
      codeToHtml: (code: string, options: { lang: string; theme: string }) => {
        shikiMock.calls.codeToHtml.push({ code, lang: options.lang, theme: options.theme });
        return (
          `<pre class="shiki ${options.theme}" style="background-color:#f6f8fa;color:#24292e" tabindex="0">` +
          `<code><span class="line"><span class="td" style="color:#d73a49">${code}</span></span></code></pre>`
        );
      },
      // Return fake tokens per line so the caller can observe "which lines this frame
      // handled" and the grammarState carry-over.
      codeToTokens: (code: string, options: { lang: string; theme: string; grammarState?: unknown }) => {
        shikiMock.calls.codeToTokens.push({
          code,
          lang: options.lang,
          theme: options.theme,
          resumed: options.grammarState !== null && options.grammarState !== undefined,
        });
        return {
          tokens: code.split('\n').map((line) => (line === '' ? [] : [{ content: line, color: '#d73a49' }])),
          fg: '#24292e',
          bg: '#f6f8fa',
          grammarState: { resumed: true },
        };
      },
    };
  },
}));

vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }));
vi.mock('shiki/themes/github-dark.mjs', () => ({ default: { name: 'github-dark' } }));
vi.mock('shiki/themes/github-light.mjs', () => ({ default: { name: 'github-light' } }));
// 8 warmed-up languages + 1 lazy-loaded language (rust is not in the warm-up list).
vi.mock('shiki/langs/typescript.mjs', () => ({ default: { name: 'typescript' } }));
vi.mock('shiki/langs/tsx.mjs', () => ({ default: { name: 'tsx' } }));
vi.mock('shiki/langs/javascript.mjs', () => ({ default: { name: 'javascript' } }));
vi.mock('shiki/langs/jsx.mjs', () => ({ default: { name: 'jsx' } }));
vi.mock('shiki/langs/json.mjs', () => ({ default: { name: 'json' } }));
vi.mock('shiki/langs/bash.mjs', () => ({ default: { name: 'bash' } }));
vi.mock('shiki/langs/python.mjs', () => ({ default: { name: 'python' } }));
vi.mock('shiki/langs/yaml.mjs', () => ({ default: { name: 'yaml' } }));
vi.mock('shiki/langs/rust.mjs', () => ({ default: { name: 'rust' } }));

/** A controllable IntersectionObserver: trigger dispatches an intersection result by hand. */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  static disconnectCount = 0;
  readonly callback: IntersectionObserverCallback;
  readonly elements = new Set<Element>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    this.elements.add(el);
  }

  unobserve(el: Element) {
    this.elements.delete(el);
  }

  disconnect() {
    MockIntersectionObserver.disconnectCount += 1;
    this.elements.clear();
  }

  trigger(el: Element, isIntersecting: boolean) {
    this.callback([{ target: el, isIntersecting } as IntersectionObserverEntry], this as never);
  }
}

// Must be injected before CodeBlock (and its codeHighlight module) loads, since the module decides from it whether to warm up.
(globalThis as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;

const CodeBlock = (await import('../../src/web/frontend/src/components/CodeBlock.vue')).default;

function lastObserver(): MockIntersectionObserver {
  const io = MockIntersectionObserver.instances.at(-1);
  if (!io) throw new Error('expected an IntersectionObserver instance');
  return io;
}

const mounted: VueWrapper[] = [];

function mountCodeBlock(props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(CodeBlock, { props });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  shikiMock.calls.createHighlighterCore = 0;
  shikiMock.calls.loadLanguage = [];
  shikiMock.calls.codeToHtml = [];
  shikiMock.calls.codeToTokens = [];
  MockIntersectionObserver.disconnectCount = 0;
  document.documentElement.dataset.theme = 'light';
});

afterEach(() => {
  // Unmount everything so the pending set reaches zero and the shared observer can disconnect.
  while (mounted.length > 0) mounted.pop()!.unmount();
});

describe('viewport activation', () => {
  it('stays inactive and unhighlighted outside the viewport; entering activates it once and permanently', async () => {
    const wrapper = mountCodeBlock({ code: 'const a = 1;', lang: 'ts', streaming: false });
    await flushPromises();

    // Outside the viewport: zero highlight calls, plain-text fallback.
    expect(shikiMock.calls.codeToHtml).toHaveLength(0);
    expect(wrapper.find('.code-content pre.shiki-fallback').exists()).toBe(true);

    // An intersection result of not-visible: still inactive.
    const io = lastObserver();
    io.trigger(wrapper.element, false);
    await flushPromises();
    expect(shikiMock.calls.codeToHtml).toHaveLength(0);

    io.trigger(wrapper.element, true);
    await vi.waitFor(() => {
      expect(shikiMock.calls.codeToHtml).toHaveLength(1);
    });
    expect(wrapper.find('.code-content pre.shiki-fallback').exists()).toBe(false);
    expect(wrapper.find('.code-content pre.shiki').exists()).toBe(true);

    // Permanent: after scrolling out of the viewport, updating the code highlights
    // directly without another intersection.
    io.trigger(wrapper.element, false);
    await wrapper.setProps({ code: 'const a = 2;' });
    await vi.waitFor(() => {
      expect(shikiMock.calls.codeToHtml).toHaveLength(2);
    });
  });

  it('disconnects the shared observer once every pending block has unmounted', async () => {
    const wrapper = mountCodeBlock({ code: 'const a = 1;', lang: 'ts', streaming: false });
    const io = lastObserver();
    expect(io.elements.size).toBe(1);

    wrapper.unmount();
    mounted.pop();
    await flushPromises();
    expect(io.elements.size).toBe(0);
    expect(MockIntersectionObserver.disconnectCount).toBeGreaterThan(0);
  });
});

describe('language lazy loading', () => {
  it('renders plain text while a lazy-loaded language is not ready, then highlights itself once loaded', async () => {
    const wrapper = mountCodeBlock({
      code: 'fn main() {\n    println!("hi");\n}',
      lang: 'rust',
      streaming: true,
    });
    await flushPromises();

    // Entering the viewport while the rust grammar is still loading asynchronously:
    // lightweight plain text, zero tokenize calls.
    const io = lastObserver();
    io.trigger(wrapper.element, true);
    expect(shikiMock.calls.codeToTokens).toHaveLength(0);

    // Highlighting is filled in automatically once loading finishes, tokenizing only
    // the completed lines.
    await vi.waitFor(() => {
      expect(wrapper.find('.code-content pre.shiki').exists()).toBe(true);
    });
    expect(shikiMock.calls.loadLanguage).toContain('rust');
    expect(shikiMock.calls.codeToTokens).toHaveLength(1);
    expect(shikiMock.calls.codeToTokens[0]).toMatchObject({ lang: 'rust', resumed: false });
    // The two completed lines highlight into token spans; there is no current partial
    // line (the code ends with a newline).
    expect(wrapper.findAll('.code-content .shiki-group .line').length).toBe(2);
    expect(wrapper.find('.code-content pre.shiki').text()).toContain('fn main()');
  });
});

describe('streaming incremental highlighting', () => {
  it('tokenizes only the newly completed lines per frame and carries grammar state across frames', async () => {
    const wrapper = mountCodeBlock({ code: '', lang: 'ts', streaming: true });
    await flushPromises();
    lastObserver().trigger(wrapper.element, true);
    await flushPromises();

    // A partial line (no newline): lightweight path, zero tokenize calls.
    await wrapper.setProps({ code: 'const a = 1;' });
    expect(shikiMock.calls.codeToTokens).toHaveLength(0);
    expect(wrapper.find('.code-content pre code').text()).toBe('const a = 1;');

    // The first line completes: only that line is processed.
    await wrapper.setProps({ code: 'const a = 1;\nconst b = 2;' });
    await vi.waitFor(() => {
      expect(shikiMock.calls.codeToTokens).toHaveLength(1);
    });
    expect(shikiMock.calls.codeToTokens[0]).toMatchObject({ code: 'const a = 1;', resumed: false });

    // The second line completes: only the appended line is processed, carrying the
    // previous frame's grammar state.
    await wrapper.setProps({ code: 'const a = 1;\nconst b = 2;\nconst c = 3;' });
    await vi.waitFor(() => {
      expect(shikiMock.calls.codeToTokens).toHaveLength(2);
    });
    expect(shikiMock.calls.codeToTokens[1]).toMatchObject({ code: 'const b = 2;', resumed: true });

    // The two completed lines highlight into token spans while the current partial
    // line stays visible as plain text.
    expect(wrapper.findAll('.code-content pre.shiki .line').length).toBe(3);
    expect(wrapper.find('.code-content pre.shiki').text()).toContain('const c = 3;');
  });

  it('uses one group container per 32 lines and does not rebuild completed groups for appended lines', async () => {
    const wrapper = mountCodeBlock({ code: '', lang: 'ts', streaming: true });
    await flushPromises();
    lastObserver().trigger(wrapper.element, true);
    await flushPromises();

    // 34 source lines = 33 completed lines + 1 current partial line -> two groups (32 + 1).
    const build = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n');
    await wrapper.setProps({ code: build(34) });
    await vi.waitFor(() => {
      expect(wrapper.findAll('.code-content .shiki-group').length).toBe(2);
    });
    const firstGroupEl = wrapper.find('.code-content .shiki-group').element as HTMLElement;

    // Appending line 35: still two groups, and the first group's DOM node is preserved as is.
    await wrapper.setProps({ code: build(35) });
    await vi.waitFor(() => {
      expect(wrapper.findAll('.code-content pre.shiki .line').length).toBe(35);
    });
    const groupsAfter = wrapper.findAll('.code-content .shiki-group');
    expect(groupsAfter.length).toBe(2);
    expect(groupsAfter[0]!.element as HTMLElement).toBe(firstGroupEl);
  });

  it('keeps the streaming DOM when settling with unchanged code, without a full re-render', async () => {
    const wrapper = mountCodeBlock({ code: 'const a = 1;\nconst b = 2;', lang: 'ts', streaming: true });
    await flushPromises();
    lastObserver().trigger(wrapper.element, true);
    await vi.waitFor(() => {
      expect(wrapper.find('.code-content pre.shiki').exists()).toBe(true);
    });

    const streamEl = wrapper.find('.code-content pre.shiki').element;
    await wrapper.setProps({ streaming: false });
    await flushPromises();

    expect(shikiMock.calls.codeToHtml).toHaveLength(0);
    expect(wrapper.find('.code-content pre.shiki').element).toBe(streamEl);
  });

  it('claims the existing DOM when the final delta and settle land in the same flush (production ordering), without a full re-render', async () => {
    const wrapper = mountCodeBlock({ code: 'const a = 1;\nconst b = 2;', lang: 'ts', streaming: true });
    await flushPromises();
    lastObserver().trigger(wrapper.element, true);
    await vi.waitFor(() => {
      expect(wrapper.find('.code-content pre.shiki').exists()).toBe(true);
    });
    const streamEl = wrapper.find('.code-content pre.shiki').element;

    // streaming.ts turn.ended: flushNow() publishes the final delta and busy=false is set
    // in the same tick, so code and streaming land in a single Vue flush (one setProps
    // changing both props is the component-boundary equivalent of that ordering). The code
    // has changed by then, but the incremental DOM already covers the final code: it has to
    // be claimed rather than swapped for a freshly rendered node.
    await wrapper.setProps({ code: 'const a = 1;\nconst b = 2;\nconst c = 3;', streaming: false });
    await flushPromises();

    expect(shikiMock.calls.codeToHtml).toHaveLength(0);
    expect(wrapper.find('.code-content pre.shiki').element).toBe(streamEl);
    expect(wrapper.find('.code-content pre.shiki').text()).toContain('const c = 3;');
  });

  it('falls back to a full render when settling finds the code rewritten without appending, and two watchers in the same frame render once', async () => {
    const wrapper = mountCodeBlock({ code: 'const a = 1;\nconst b = 2;', lang: 'ts', streaming: true });
    await flushPromises();
    lastObserver().trigger(wrapper.element, true);
    await vi.waitFor(() => {
      expect(shikiMock.calls.codeToTokens.length).toBeGreaterThan(0);
    });

    // A retry rewrite or an edit: the new code is not a continuation of the old one, so
    // the streaming line cache cannot claim it -> full render.
    await wrapper.setProps({ code: 'export const other = 42;', streaming: false });
    await vi.waitFor(() => {
      expect(shikiMock.calls.codeToHtml).toHaveLength(1);
    });
    await flushPromises();
    expect(shikiMock.calls.codeToHtml).toHaveLength(1);
    expect(wrapper.find('.code-content pre.shiki').text()).toContain('export const other = 42;');
  });
});

describe('warm-up', () => {
  it('warms up the highlighter singleton with setTimeout(0) after the module loads', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      await import('../../src/web/frontend/src/utils/codeHighlight');
      expect(shikiMock.calls.createHighlighterCore).toBe(0);

      await vi.advanceTimersByTimeAsync(0);
      // Assert with waitFor after returning to real timers, avoiding flakes from an
      // incompletely drained microtask chain under fake timers
      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(shikiMock.calls.createHighlighterCore).toBe(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});