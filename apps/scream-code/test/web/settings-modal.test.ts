// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import SettingsModal from '../../src/web/frontend/src/components/SettingsModal.vue';
import {
  isSettingsModalMounted,
  tryOpenSettingsModal,
  useSettingsModal,
} from '../../src/web/frontend/src/composables/useSettingsModal';
import {
  registerActiveWebClient,
  unregisterActiveWebClient,
} from '../../src/web/frontend/src/composables/webClient/activeClient';

/**
 * Settings modal: self-contained (teleport + the shared ui/Dialog style
 * language), opened through tryOpenSettingsModal; while the host is not mounted
 * the entry point must keep its previous route-based navigation fallback (false).
 */

function fakeClient() {
  return {
    like: ref({}),
    status: ref({ model: 'm1' }),
    models: ref([]),
    modelsError: ref(null),
    skills: ref([]),
    skillsError: ref(null),
    plugins: ref([]),
    pluginInfo: ref(null),
    mcpServers: ref([]),
    backgroundTasks: ref([]),
    backgroundTaskOutput: ref(''),
    currentSessionId: ref<string | null>(null),
    config: ref(null),
    fetchModels: vi.fn(async () => undefined),
    fetchConfig: vi.fn(async () => undefined),
    fetchSkills: vi.fn(async () => undefined),
    fetchPlugins: vi.fn(async () => undefined),
    fetchMcpServers: vi.fn(async () => undefined),
    fetchBackgroundTasks: vi.fn(async () => undefined),
    updateLike: vi.fn(async () => true),
  } as never;
}

afterEach(() => {
  const { closeSettingsModal } = useSettingsModal();
  closeSettingsModal();
});

describe('SettingsModal / useSettingsModal', () => {
  it('tryOpenSettingsModal returns false while the host is not mounted (the entry point keeps its navigation fallback)', () => {
    if (isSettingsModalMounted()) {
      throw new Error('test precondition: no modal host should be mounted here');
    }
    expect(tryOpenSettingsModal()).toBe(false);
  });

  it('with the host mounted it opens the centred modal: role=dialog + title + section rail, Esc closes', async () => {
    const client = fakeClient();
    registerActiveWebClient(client as never);
    const wrapper = mount(SettingsModal, {
      global: {
        provide: { theme: ref('system'), setTheme: () => {} },
        stubs: { SvgIcon: true },
      },
      attachTo: document.body,
    });
    expect(isSettingsModalMounted()).toBe(true);
    expect(tryOpenSettingsModal()).toBe(true);
    await flushPromises();

    const dialog = document.querySelector('.ui-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute('role')).toBe('dialog');
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('.ui-dialog-title')?.textContent).toBe('设置');
    // The content reuses SettingsView: the left rail sections are all present.
    const railTexts = Array.from(document.querySelectorAll('.rail-tab')).map((n) =>
      (n.textContent ?? '').trim(),
    );
    expect(railTexts.some((t) => t.includes('通用'))).toBe(true);
    expect(railTexts.some((t) => t.includes('模型'))).toBe(true);

    // Esc closes it (the Dialog global keydown).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick2();
    const { open } = useSettingsModal();
    expect(open.value).toBe(false);

    wrapper.unmount();
    unregisterActiveWebClient(client as never);
    expect(isSettingsModalMounted()).toBe(false);
  });

  it('disables model switching and shows a notice bar when there is no active session', async () => {
    const client = fakeClient();
    (client as never as { models: { value: unknown[] } }).models.value = [
      { alias: 'm1', provider: 'p1', model: 'm1/x', displayName: 'Model One', maxContextSize: 1000 },
    ];
    registerActiveWebClient(client as never);
    const wrapper = mount(SettingsModal, {
      global: {
        provide: { theme: ref('system'), setTheme: () => {} },
        stubs: { SvgIcon: true },
      },
      attachTo: document.body,
    });
    tryOpenSettingsModal();
    await flushPromises();
    // Switch to the models section.
    const tabs = Array.from(document.querySelectorAll('.rail-tab')) as HTMLButtonElement[];
    tabs[1]!.click();
    await flushPromises();
    expect(document.querySelector('.notice-bar')?.textContent).toContain(
      '打开一个会话后可在此切换模型',
    );
    const switchBtn = document.querySelector('.list-row .row-action') as HTMLButtonElement;
    expect(switchBtn.disabled).toBe(true);
    wrapper.unmount();
    unregisterActiveWebClient(client as never);
  });
});

async function nextTick2(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}
