// @vitest-environment jsdom
// Pins for MarkdownRenderer's block-level freeze cache
// (src/web/frontend/src/utils/markdownBlockCache.ts):
//   1. Streaming appends reuse vnode arrays for unchanged prefix blocks —
//      the block render function must not run again for them.
//   2. Mid-document edits (non-append) rebuild every block.
//   3. The cache never grows past BLOCK_CACHE_LIMIT.
//   4. Blocks containing component vnodes (CodeBlock) are never cached.
//   5. trimPartialClosingFences semantics are unchanged: an unclosed ```
//      swallows the rest of the document until the fence closes.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { h, defineComponent } from 'vue';
import { marked, type Token } from 'marked';
import MarkdownRenderer from '../../src/web/frontend/src/components/MarkdownRenderer.vue';
import {
  BLOCK_CACHE_LIMIT,
  blockKeyOf,
  createBlockRenderCache,
} from '../../src/web/frontend/src/utils/markdownBlockCache';

/** Flush the rAF-coalesced streaming render plus Vue's microtask queue. */
async function flushStreamingRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await flushPromises();
}

describe('markdownBlockCache (unit)', () => {
  const lex = (source: string): Token[] => marked.lexer(source);
  // Distinct vnode per call so reference equality is observable.
  // `space` tokens render to nothing, mirroring the real renderToken.
  const renderSpy = vi.fn((token: Token) =>
    token.type === 'space' ? [] : [h('div', { class: 'blk' }, (token as { raw?: string }).raw ?? '')],
  );

  it('gives every top-level token a position-independent content key', () => {
    const paragraphs = lex('alpha\n\nbeta').filter((t) => t.type === 'paragraph');
    expect(blockKeyOf(paragraphs[0]!)).not.toBe(blockKeyOf(paragraphs[1]!));
    // Same content -> same key regardless of document position.
    const dupParagraphs = lex('same\n\nmid\n\nsame').filter((t) => t.type === 'paragraph');
    expect(blockKeyOf(dupParagraphs[0]!)).toBe(blockKeyOf(dupParagraphs[2]!));
  });

  it('does not call renderBlock again for prefix blocks on append', () => {
    renderSpy.mockClear();
    const cache = createBlockRenderCache();
    const first = cache.render(lex('head one\n\nhead two'), 'head one\n\nhead two', renderSpy);
    // 3 tokens: paragraph, space, paragraph (the spy sees every token).
    expect(renderSpy).toHaveBeenCalledTimes(3);

    const second = cache.render(
      lex('head one\n\nhead two\n\ntail'),
      'head one\n\nhead two\n\ntail',
      renderSpy,
    );
    // Only the new tail block pays for a real render; the two prefix
    // paragraphs hit the cache (the two space tokens re-render to [] each
    // pass and are not cached, hence 3 spy calls in pass 2).
    expect(renderSpy).toHaveBeenCalledTimes(6);
    expect((renderSpy.mock.calls[5]![0] as { text: string }).text).toBe('tail');
    expect(second.slice(0, 2)).toEqual(first);
  });

  it('rebuilds every block when the edit is not a pure append', () => {
    renderSpy.mockClear();
    const cache = createBlockRenderCache();
    cache.render(lex('aaa\n\nbbb'), 'aaa\n\nbbb', renderSpy);
    expect(renderSpy).toHaveBeenCalledTimes(3);

    // Same length, mid-document change: not a prefix of the previous source.
    cache.render(lex('aaa\n\nxyz'), 'aaa\n\nxyz', renderSpy);
    expect(renderSpy).toHaveBeenCalledTimes(6);

    // Shrinking content is also not an append.
    cache.render(lex('aaa'), 'aaa', renderSpy);
    expect(renderSpy).toHaveBeenCalledTimes(7);
  });

  it('never exceeds BLOCK_CACHE_LIMIT entries', () => {
    renderSpy.mockClear();
    const cache = createBlockRenderCache(4);
    // 10 distinct blocks appended one at a time.
    let doc = '';
    for (let i = 0; i < 10; i++) {
      doc += (i ? '\n\n' : '') + `block-${i}`;
      cache.render(lex(doc), doc, renderSpy);
      expect(cache.size()).toBeLessThanOrEqual(4);
    }
    expect(cache.size()).toBeLessThanOrEqual(4);
    expect(BLOCK_CACHE_LIMIT).toBe(200);
  });

  it('does not cache blocks that contain component vnodes', () => {
    renderSpy.mockClear();
    const Dummy = defineComponent({ setup: () => () => h('span') });
    const spy = vi.fn((token: Token) => {
      if (token.type === 'space') return [];
      return token.type === 'code'
        ? [h(Dummy)]
        : [h('div', (token as { raw?: string }).raw ?? '')];
    });
    const source = 'text\n\n```js\nconst a = 1;\n```';
    const cache = createBlockRenderCache();
    cache.render(lex(source), source, spy);
    expect(cache.size()).toBe(1); // only the paragraph

    const firstPara = cache.render(lex(source), source, spy)[0];
    const secondPara = cache.render(lex(source), source, spy)[0];
    // Paragraph reused (same vnode), code block rebuilt each pass; the
    // space token is never cached, so each pass re-invokes it too:
    // pass1 = paragraph+space+code, pass2/pass3 = space+code.
    expect(secondPara).toBe(firstPara);
    expect(spy).toHaveBeenCalledTimes(7);
    expect(cache.size()).toBe(1);
  });

  it('renders duplicate identical blocks in one pass without vnode reuse', () => {
    renderSpy.mockClear();
    const cache = createBlockRenderCache();
    const vnodes = cache.render(lex('same\n\nsame'), 'same\n\nsame', renderSpy);
    // Two identical paragraphs + one space token; the two paragraphs get
    // two separate render calls with distinct vnodes.
    expect(renderSpy).toHaveBeenCalledTimes(3);
    expect(vnodes[0]).not.toBe(vnodes[1]);
  });
});

describe('MarkdownRenderer block freezing (mounted)', () => {
  it('keeps prefix DOM nodes untouched while streaming appends', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '# Title\n\nfirst paragraph', streaming: true },
    });
    await flushStreamingRender();
    const heading = wrapper.find('h1').element;
    const firstPara = wrapper.find('p').element;

    await wrapper.setProps({ content: '# Title\n\nfirst paragraph\n\nsecond paragraph' });
    await flushStreamingRender();

    expect(wrapper.find('h1').element).toBe(heading);
    expect(wrapper.find('p').element).toBe(firstPara);
    expect(wrapper.text()).toContain('second paragraph');
  });

  it('applies a mid-document edit: the changed block updates in place', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: 'aaa\n\nbbb', streaming: false },
    });
    await flushPromises();

    await wrapper.setProps({ content: 'aaa\n\nxyz' });
    await flushPromises();

    const paras = wrapper.findAll('p');
    expect(paras).toHaveLength(2);
    expect(paras[0]!.text()).toBe('aaa');
    expect(paras[1]!.text()).toBe('xyz');
    // Vue patches same-tag elements in place, so the prefix DOM node stays
    // put; the whole-document rebuild is pinned by the unit tests above,
    // which assert renderBlock is invoked again for every block.
    expect(wrapper.text()).not.toContain('bbb');
  });
});

describe('MarkdownRenderer unclosed-fence behaviour (pinned)', () => {
  it('streaming: an unclosed ``` swallows the rest of the document until closed', async () => {
    const open = '前文说明\n\n```js\nconst a = 1;';
    const wrapper = mount(MarkdownRenderer, {
      props: { content: open, streaming: true },
    });
    await flushStreamingRender();

    expect(wrapper.text()).toContain('前文说明');
    // Everything from the opening fence onwards is trimmed, not rendered.
    expect(wrapper.text()).not.toContain('const a = 1;');

    await wrapper.setProps({ content: `${open}\n\`\`\`\n\n收尾段落` });
    await flushStreamingRender();

    // Fence closed: the code content and the trailing paragraph come back.
    expect(wrapper.text()).toContain('const a = 1;');
    expect(wrapper.text()).toContain('收尾段落');
  });

  it('settled messages get the same trim semantics', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '前文\n\n```\nraw dump', streaming: false },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('前文');
    expect(wrapper.text()).not.toContain('raw dump');
  });
});
