// @vitest-environment jsdom
// Regression pins for two streaming-render performance behaviours:
//   1. CodeBlock.vue skips shiki highlighting entirely while `streaming` is on
//      (lightweight escaped plain text), and highlights once when it settles.
//   2. MarkdownRenderer.vue collapses settled messages longer than
//      MAX_INLINE_MARKDOWN_CHARS (40 000) behind a "展开全文" button.
// Both shiki entry points are stubbed, so the pins observe *whether the
// highlighter is reached at all* instead of paying for real wasm grammars.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CodeBlock from '../../src/web/frontend/src/components/CodeBlock.vue';
import MarkdownRenderer from '../../src/web/frontend/src/components/MarkdownRenderer.vue';

const shiki = vi.hoisted(() => {
  const calls: Array<Record<string, string>> = [];
  const escape = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return {
    calls,
    reset: () => {
      calls.length = 0;
    },
    countOf: (kind: string) => calls.filter((call) => call.kind === kind).length,
    firstOf: (kind: string) => calls.find((call) => call.kind === kind),
    // Mimics the markup shiki really emits: `pre.shiki.<theme>` with token
    // spans carrying inline colours. Nothing like the streaming fallback.
    fakeHtml: (code: string, theme: string) =>
      `<pre class="shiki ${theme}" style="background-color:#f6f8fa;color:#24292e" tabindex="0">` +
      `<code><span class="line"><span class="td" style="color:#d73a49">${escape(code)}</span></span></code></pre>`,
  };
});

vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => {
    shiki.calls.push({ kind: 'createHighlighterCore' });
    return {
      loadLanguage: async () => {
        shiki.calls.push({ kind: 'loadLanguage' });
      },
      codeToHtml: (code: string, options: { lang: string; theme: string }) => {
        shiki.calls.push({ kind: 'codeToHtml', code, lang: options.lang, theme: options.theme });
        return shiki.fakeHtml(code, options.theme);
      },
    };
  },
}));

vi.mock('shiki/engine/oniguruma', () => ({
  createOnigurumaEngine: () => ({}),
}));

vi.mock('shiki/themes/github-dark.mjs', () => ({ default: { name: 'github-dark' } }));
vi.mock('shiki/themes/github-light.mjs', () => ({ default: { name: 'github-light' } }));
vi.mock('shiki/langs/typescript.mjs', () => ({ default: { name: 'typescript' } }));

beforeEach(() => {
  shiki.reset();
});

const TS_CODE = 'const isSmall = (n: number) => n < 10 && n > 0;\nconsole.log(isSmall(3));';

describe('CodeBlock: shiki highlight is skipped while streaming', () => {
  it('touches neither the highlighter factory nor codeToHtml mid-stream, then highlights once on settle', async () => {
    // Declared first on purpose: CodeBlock caches the highlighter in a
    // module-level singleton, so "the factory was never called" can only be
    // asserted while that cache is still cold.
    const wrapper = mount(CodeBlock, { props: { code: TS_CODE, lang: 'ts', streaming: true } });
    await flushPromises();

    expect(shiki.countOf('createHighlighterCore')).toBe(0);
    expect(shiki.countOf('loadLanguage')).toBe(0);
    expect(shiki.countOf('codeToHtml')).toBe(0);

    const pre = wrapper.find('.code-content pre');
    expect(pre.exists()).toBe(true);
    expect(pre.classes()).toContain('shiki-fallback');
    expect(pre.classes()).not.toContain('shiki');
    // No highlight artefacts of any kind: token spans / inline colours.
    expect(wrapper.findAll('.code-content span')).toHaveLength(0);
    expect(pre.find('[style]').exists()).toBe(false);
    // Escaped plain text: byte-identical source, no live elements.
    expect(pre.find('code').element.textContent).toBe(TS_CODE);
    expect(pre.element.querySelector('img')).toBeNull();

    await wrapper.setProps({ streaming: false });
    await vi.waitFor(() => {
      expect(shiki.countOf('codeToHtml')).toBeGreaterThan(0);
    });

    expect(shiki.countOf('createHighlighterCore')).toBe(1);
    expect(shiki.firstOf('codeToHtml')).toMatchObject({ lang: 'typescript', theme: 'github-light' });
    const highlighted = wrapper.find('.code-content pre.shiki');
    expect(highlighted.exists()).toBe(true);
    expect(highlighted.classes()).toContain('github-light');
    expect(wrapper.findAll('.code-content span.td').length).toBeGreaterThan(0);
    expect(wrapper.find('.code-content pre.shiki-fallback').exists()).toBe(false);
  });

  it('keeps every streamed chunk on the escaped fallback and only pays for highlighting once', async () => {
    const wrapper = mount(CodeBlock, { props: { code: 'const a = 1 < 2;', lang: 'ts', streaming: true } });
    await flushPromises();

    for (const chunk of ['const a = 1 < 2;\nconst b = a + 1;', 'const a = 1 < 2;\nconst b = a + 1;\nexport { b };']) {
      await wrapper.setProps({ code: chunk });
      await flushPromises();
      expect(shiki.countOf('codeToHtml')).toBe(0);
      expect(wrapper.find('.code-content pre').classes()).toContain('shiki-fallback');
      expect(wrapper.find('.code-content pre code').element.textContent).toBe(chunk);
      expect(wrapper.findAll('.code-content span')).toHaveLength(0);
    }

    await wrapper.setProps({ streaming: false });
    await vi.waitFor(() => {
      expect(shiki.countOf('codeToHtml')).toBe(1);
    });
    expect(wrapper.find('.code-content pre.shiki').exists()).toBe(true);
  });

  it('stays highlighted for a settled mount (guards the mock from going stale)', async () => {
    const wrapper = mount(CodeBlock, { props: { code: TS_CODE, lang: 'ts', streaming: false } });
    await vi.waitFor(() => {
      expect(shiki.countOf('codeToHtml')).toBe(1);
    });
    expect(wrapper.find('.code-content pre.shiki').exists()).toBe(true);
    expect(wrapper.find('.code-content pre.shiki-fallback').exists()).toBe(false);
  });
});

describe('MarkdownRenderer: forwards the streaming flag to CodeBlock', () => {
  it('renders a mid-stream ```ts fence unhighlighted and highlights it after settle', async () => {
    const content = '看这个：\n\n```ts\nconst a = 1 < 2;\n```\n';
    const wrapper = mount(MarkdownRenderer, { props: { content, streaming: true } });
    await flushPromises();

    expect(shiki.countOf('codeToHtml')).toBe(0);
    expect(wrapper.find('.code-content pre.shiki-fallback').exists()).toBe(true);
    expect(wrapper.find('.code-content pre.shiki').exists()).toBe(false);

    await wrapper.setProps({ streaming: false });
    await vi.waitFor(() => {
      expect(shiki.countOf('codeToHtml')).toBeGreaterThan(0);
    });
    expect(wrapper.find('.code-content pre.shiki').exists()).toBe(true);
  });
});

const HEAD = '开头标记 HEAD-MARKER';
const TAIL = '结尾标记 TAIL-MARKER';
const MAX_INLINE_MARKDOWN_CHARS = 40_000;

/** Builds a prose document whose length is exactly `totalChars`. */
function docOfLength(totalChars: number): string {
  const head = `${HEAD}\n\n`;
  const tail = `\n\n${TAIL}`;
  const line = '填充正文：这是一行用于把消息撑到阈值的普通文本。\n';
  let body = head;
  while (body.length + line.length + tail.length <= totalChars) body += line;
  const pad = totalChars - body.length - tail.length;
  if (pad > 0) body += 'x'.repeat(pad);
  return body + tail;
}

describe('MarkdownRenderer: 40k size guard collapses giant settled messages', () => {
  it('does not render the tail of a 40 001-char settled message, but offers 展开全文', async () => {
    const content = docOfLength(MAX_INLINE_MARKDOWN_CHARS + 1);
    expect(content).toHaveLength(40_001);
    const wrapper = mount(MarkdownRenderer, { props: { content, streaming: false } });
    await flushPromises();

    const button = wrapper.find('button.md-expand');
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain('展开全文');
    expect(button.text()).toContain((40_001).toLocaleString());
    expect(button.text()).toContain((6_000).toLocaleString());

    const text = wrapper.text();
    expect(text).toContain(HEAD);
    expect(text).not.toContain(TAIL);
    // Only the preview window is patched into the DOM, not the whole body.
    expect(text.length).toBeLessThan(7_000);
    expect(text).toContain('…');
  });

  it('renders the whole message once 展开全文 is clicked and drops the button', async () => {
    const content = docOfLength(MAX_INLINE_MARKDOWN_CHARS + 1);
    expect(content).toHaveLength(40_001);
    const wrapper = mount(MarkdownRenderer, { props: { content, streaming: false } });
    expect(wrapper.text()).not.toContain(TAIL);

    await wrapper.find('button.md-expand').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain(HEAD);
    expect(wrapper.text()).toContain(TAIL);
    expect(wrapper.text().length).toBeGreaterThan(MAX_INLINE_MARKDOWN_CHARS - 1_000);
    expect(wrapper.find('button.md-expand').exists()).toBe(false);
  });

  it('renders a 39 999-char settled message straight through', async () => {
    const content = docOfLength(MAX_INLINE_MARKDOWN_CHARS - 1);
    const wrapper = mount(MarkdownRenderer, { props: { content, streaming: false } });
    await flushPromises();

    expect(wrapper.find('button.md-expand').exists()).toBe(false);
    expect(wrapper.text()).toContain(HEAD);
    expect(wrapper.text()).toContain(TAIL);
  });

  it('treats exactly 40 000 chars as inline (the guard is strictly greater than)', async () => {
    const content = docOfLength(MAX_INLINE_MARKDOWN_CHARS);
    const wrapper = mount(MarkdownRenderer, { props: { content, streaming: false } });
    await flushPromises();

    expect(wrapper.find('button.md-expand').exists()).toBe(false);
    expect(wrapper.text()).toContain(TAIL);
  });

  it('exempts a streaming 40 001-char message, then collapses it the moment it settles', async () => {
    const content = docOfLength(MAX_INLINE_MARKDOWN_CHARS + 1);
    const wrapper = mount(MarkdownRenderer, { props: { content, streaming: true } });
    await flushPromises();

    expect(wrapper.find('button.md-expand').exists()).toBe(false);
    expect(wrapper.text()).toContain(TAIL);

    await wrapper.setProps({ streaming: false });
    await flushPromises();

    expect(wrapper.find('button.md-expand').exists()).toBe(true);
    expect(wrapper.text()).not.toContain(TAIL);
  });
});
