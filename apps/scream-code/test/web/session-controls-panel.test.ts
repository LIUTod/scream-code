// @vitest-environment jsdom
import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SessionControlsPanel from '../../src/web/frontend/src/components/SessionControlsPanel.vue';

function fakeClient() {
  const status = ref({
    busy: false,
    planMode: false,
    wolfpackMode: false,
    rlmEnabled: false,
    rlmMaxDepth: 0,
  });
  const sessionId = ref<string | null>('session-1');
  const actions = {
    fetchSessionStatus: vi.fn(async () => undefined),
    fetchSessionPlan: vi.fn(async () => undefined),
    switchPlanMode: vi.fn(async () => true),
    switchWolfpack: vi.fn(async () => true),
    switchRlm: vi.fn(async (enabled: boolean) => {
      status.value = { ...status.value, rlmEnabled: enabled };
      return true;
    }),
    clearPlan: vi.fn(async () => true),
    undoHistory: vi.fn(async () => true),
    compact: vi.fn(async () => true),
    fetchSnapshot: vi.fn(async () => undefined),
  };
  return {
    client: {
      status,
      sessionId,
      sessionPlan: ref(null),
      connectionStatus: ref('connected'),
      isArchived: ref(false),
      isBusy: computed(() => status.value.busy),
      ...actions,
    },
    actions,
  };
}

function mountPanel() {
  const fixture = fakeClient();
  const wrapper = mount(SessionControlsPanel, {
    props: { client: fixture.client as never },
    global: { stubs: { SvgIcon: true } },
  });
  return { ...fixture, wrapper };
}

describe('SessionControlsPanel', () => {
  it('routes the fusion-plan control through the existing REST client contract', async () => {
    const { wrapper, actions } = mountPanel();
    const fusion = wrapper.findAll('.segmented button').find((button) => button.text() === '融合');
    expect(fusion).toBeTruthy();
    await fusion!.trigger('click');
    await flushPromises();
    expect(actions.switchPlanMode).toHaveBeenCalledWith(true, 'fusion');
  });

  it('routes binary runtime modes through their dedicated controls', async () => {
    const { wrapper, actions } = mountPanel();
    const toggles = wrapper.findAll<HTMLInputElement>('.switch-row input');
    await toggles[0]!.setValue(true);
    await flushPromises();
    expect(actions.switchWolfpack).toHaveBeenCalledWith(true);

    await toggles[1]!.setValue(true);
    await flushPromises();
    expect(actions.switchRlm).toHaveBeenCalledWith(true);
  });

  it('does not reset an existing RLM depth when toggling the mode', async () => {
    const { wrapper, actions } = mountPanel();
    // The field appears only while RLM is enabled; entering a draft value must
    // still not make a mode toggle send maxDepth implicitly.
    await wrapper.findAll('.switch-row input')[1]!.setValue(true);
    await flushPromises();
    await wrapper.find('input[type="number"]').setValue('7');
    await wrapper.findAll('.switch-row input')[1]!.setValue(false);
    await flushPromises();
    expect(actions.switchRlm).toHaveBeenNthCalledWith(1, true);
    expect(actions.switchRlm).toHaveBeenNthCalledWith(2, false);
    expect(actions.switchRlm).not.toHaveBeenCalledWith(expect.anything(), 7);
  });

  it('hydrates the RLM depth field from the authoritative session status', async () => {
    const fixture = fakeClient();
    fixture.client.status.value = { ...fixture.client.status.value, rlmEnabled: true, rlmMaxDepth: 7 };
    const wrapper = mount(SessionControlsPanel, {
      props: { client: fixture.client as never },
      global: { stubs: { SvgIcon: true } },
    });
    await flushPromises();
    expect(wrapper.find('input[type="number"]').element.value).toBe('7');
  });

  it('refreshes the loaded transcript after undoing the latest turn', async () => {
    const { wrapper, actions } = mountPanel();
    const undo = wrapper.findAll('.command-action').find((button) => button.text().includes('撤销上一轮'));
    expect(undo).toBeTruthy();
    await undo!.trigger('click');
    await flushPromises();
    expect(actions.undoHistory).toHaveBeenCalledWith();
    expect(actions.fetchSnapshot).toHaveBeenCalledOnce();
  });

  it('renders archived sessions read-only and does not refresh or mutate them', async () => {
    const fixture = fakeClient();
    fixture.client.isArchived.value = true;
    const wrapper = mount(SessionControlsPanel, {
      props: { client: fixture.client as never },
      global: { stubs: { SvgIcon: true } },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('当前会话已归档');
    expect(wrapper.find('button[aria-label="刷新会话状态"]').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').filter((button) => button.text().includes('压缩上下文'))[0]?.attributes('disabled')).toBeDefined();
    expect(fixture.actions.fetchSessionStatus).not.toHaveBeenCalled();
    expect(fixture.actions.fetchSessionPlan).not.toHaveBeenCalled();
  });
});
