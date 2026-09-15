// @vitest-environment jsdom
/**
 * Wiring close-out for the skill centre "try" action → the insertDraft exposed by
 * Composer.
 *
 * A small host reproduces WebShell's wiring shape (SkillsView.injectDraft →
 * ConversationView.insertDraft → Composer.insertDraft); what these cases verify is
 * the contract at both ends of that chain, not the rest of WebShell's assembly
 * (that part is covered by dock-tabs).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { useToast } from '../../src/web/frontend/src/composables/useToast';

import Composer from '../../src/web/frontend/src/components/Composer.vue';
import SkillsView from '../../src/web/frontend/src/components/SkillsView.vue';
import type { SkillSummary } from '../../src/web/frontend/src/types';

const SKILLS: SkillSummary[] = [
  { name: 'web-clone', description: '网站复刻工作流', source: 'extra' } as SkillSummary,
];

function fakeClient() {
  return {
    skills: ref(SKILLS),
    mcpServers: ref([]),
    plugins: ref([]),
    loadSkills: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
    loadPlugins: vi.fn(async () => undefined),
  };
}

/** Mini host: the smallest shape equivalent to WebShell's "chat view + skill centre view". */
const Harness = defineComponent({
  setup() {
    const composer = ref<InstanceType<typeof Composer> | null>(null);
    const view = ref<'chat' | 'skills'>('chat');
    async function injectDraft(text: string): Promise<boolean> {
      if (!composer.value) return false;
      composer.value.insertDraft(text, { activate: true });
      return true;
    }
    return { composer, view, injectDraft };
  },
  render() {
    return h('div', [
      h(Composer, {
        ref: 'composer',
        busy: false,
        status: { connectionStatus: 'connected', model: 'm' },
        sessionId: 'sess-1',
        models: [],
        workDir: '/tmp/p',
        connectionStatus: 'connected',
        vShow: this.view === 'chat',
        style: { display: this.view === 'chat' ? 'block' : 'none' },
      }),
      h(SkillsView, {
        client: fakeClient(),
        injectDraft: this.injectDraft,
        style: { display: this.view === 'skills' ? 'block' : 'none' },
      }),
    ]);
  },
});

function tryButton(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll('button')
    .filter((b) => b.text().includes('试用'))
    .at(-1)!;
}

beforeEach(() => localStorage.clear());

describe('SkillsView try → Composer input', () => {
  it('after clicking try the text lands in the composer, without falling back to clipboard/draft', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const wrapper = mount(Harness, { attachTo: document.body });
    await flushPromises();

    await tryButton(wrapper).trigger('click');
    await flushPromises();

    const input = wrapper.find('.composer-input').element as HTMLTextAreaElement;
    expect(input.value).toBe('/web-clone ');
    // With the primary path working the fallback is skipped: no clipboard write
    // and no pre-written scream-draft.
    expect(writeText).not.toHaveBeenCalled();
    expect(localStorage.getItem('scream-draft:sess-1')).toBeNull();
    wrapper.unmount();
  });

  it('input box absent (not mounted) → returns false and the caller falls back to clipboard + create navigation', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = mount(
      defineComponent({
        setup() {
          return { seen: [] as string[] };
        },
        render() {
          // Only SkillsView is mounted: with no composer present, injectDraft must
          // fail.
          return h(SkillsView, {
            client: fakeClient(),
            injectDraft: async () => false,
          });
        },
      }),
      { attachTo: document.body },
    );
    await flushPromises();
    await host
      .findAll('button')
      .filter((b) => b.text().includes('试用'))
      .at(-1)!
      .trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('/web-clone ');
    expect(toastState().join('|')).toContain('已复制');
    host.unmount();
  });
});

function toastState(): string[] {
  // The toast state is a module-level singleton, read it directly instead of
  // scraping the DOM (same convention as skills-view.test).
  return useToast().toasts.value.map((t) => t.message);
}
