// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MarkdownRenderer from '../../src/web/frontend/src/components/MarkdownRenderer.vue';

describe('MarkdownRenderer XSS hygiene', () => {
  it('renders raw HTML tokens as escaped text, never as live DOM', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '<img src=x onerror="window.__xss=1">', streaming: false },
    });
    // No <img> element may be created from the raw HTML token.
    expect(wrapper.element.querySelector('img')).toBeNull();
    // The payload is still visible to the user, in escaped text form.
    expect(wrapper.text()).toContain('<img src=x onerror="window.__xss=1">');
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('escapes inline HTML as well', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: 'hello <script>alert(1)</script> world', streaming: false },
    });
    expect(wrapper.element.querySelector('script')).toBeNull();
    expect(wrapper.text()).toContain('<script>alert(1)</script>');
  });

  it('still renders ordinary markdown normally', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '**bold** and `code`', streaming: false },
    });
    expect(wrapper.element.querySelector('strong')).not.toBeNull();
    expect(wrapper.element.querySelector('code')).not.toBeNull();
  });
});
