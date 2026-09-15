// @vitest-environment jsdom
/**
 * NewSessionModal: the new-session confirm dialog (pick a workspace + pick a model).
 * Contract: opening resets to the defaults; an invalid path disables confirm;
 * confirm emits { workDir, model }; model=null means "follow the server default";
 * clicking a recent entry fills the input.
 */
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

import NewSessionModal from '../../src/web/frontend/src/components/NewSessionModal.vue';
import type { ModelInfo } from '../../src/web/frontend/src/types';

const MODELS: ModelInfo[] = [
  { alias: 'a1', provider: 'p1', model: 'm1', displayName: 'Model One' },
  { alias: 'a2', provider: 'p2', model: 'm2', displayName: 'Model Two' },
];

function mountModal(open = true) {
  return mount(NewSessionModal, {
    props: {
      open,
      models: MODELS,
      recentWorkDirs: ['/home/user/projects', '/home/user/workspace'],
      defaultDir: '/srv/default',
      currentModel: 'a1',
    },
    attachTo: document.body,
    // The dialog content is teleported to body; stubbing teleport renders it
    // inline for easier assertions.
    global: { stubs: { teleport: true } },
  });
}

describe('NewSessionModal', () => {
  it('resets to the default workspace and current model on open; closed renders no dialog content', async () => {
    const wrapper = mountModal(true);
    await flushPromises();
    const input = wrapper.find('.nsm-input').element as HTMLInputElement;
    expect(input.value).toBe('/srv/default');
    expect(wrapper.find('.nsm-model.is-active').text()).toContain('Model One');

    await wrapper.setProps({ open: false });
    await flushPromises();
    expect(wrapper.find('.nsm-input').exists()).toBe(false);
    wrapper.unmount();
  });

  it('discards an unconfirmed draft when reopened', async () => {
    const wrapper = mountModal(true);
    await flushPromises();
    await wrapper.find('.nsm-input').setValue('/tmp/draft');
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect((wrapper.find('.nsm-input').element as HTMLInputElement).value).toBe('/srv/default');
    wrapper.unmount();
  });

  it('a non-absolute path disables the confirm button and states why', async () => {
    const wrapper = mountModal(true);
    await flushPromises();
    await wrapper.find('.nsm-input').setValue('relative/path');
    await flushPromises();
    const confirm = wrapper
      .findAll('button')
      .find((b) => b.text().includes('进入新会话'))!;
    expect(confirm.attributes('disabled')).toBeDefined();
    expect(wrapper.find('.nsm-error').text()).toContain('绝对路径');
    wrapper.unmount();
  });

  it('empty workspace + selected model → confirm emits workDir=null, model=alias', async () => {
    const wrapper = mountModal(true);
    await flushPromises();
    await wrapper.find('.nsm-input').setValue('');
    const rows = wrapper.findAll('.nsm-model');
    await rows[2]!.trigger('click'); // Model Two
    const confirm = wrapper
      .findAll('button')
      .find((b) => b.text().includes('进入新会话'))!;
    await confirm.trigger('click');
    await flushPromises();
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    expect(wrapper.emitted('confirm')![0]).toEqual([{ workDir: null, model: 'a2' }]);
    wrapper.unmount();
  });

  it('the "follow the server default" option emits model=null', async () => {
    const wrapper = mountModal(true);
    await flushPromises();
    const rows = wrapper.findAll('.nsm-model');
    await rows[0]!.trigger('click'); // follow the server default
    const confirm = wrapper
      .findAll('button')
      .find((b) => b.text().includes('进入新会话'))!;
    await confirm.trigger('click');
    await flushPromises();
    expect(wrapper.emitted('confirm')![0]).toEqual([{ workDir: '/srv/default', model: null }]);
    wrapper.unmount();
  });

  it('clicking a recent directory fills the input; cancel only emits close', async () => {
    const wrapper = mountModal(true);
    await flushPromises();
    await wrapper.findAll('.nsm-recent')[1]!.trigger('click');
    expect((wrapper.find('.nsm-input').element as HTMLInputElement).value).toBe(
      '/home/user/workspace',
    );
    const cancel = wrapper.findAll('button').find((b) => b.text().includes('取消'))!;
    await cancel.trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(wrapper.emitted('confirm')).toBeUndefined();
    wrapper.unmount();
  });
});
