// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import ImageLightbox from '../../src/web/frontend/src/components/ImageLightbox.vue';
import {
  closeImageLightbox,
  imageLightbox,
  openImageLightbox,
} from '../../src/web/frontend/src/utils/imageLightbox';

describe('ImageLightbox', () => {
  it('opens the modal dialog with the requested src and closes on demand', async () => {
    closeImageLightbox();
    const wrapper = mount(ImageLightbox);
    const dialog = wrapper.find('dialog.image-lightbox');
    expect(dialog.exists()).toBe(true);

    // jsdom has no modal-dialog implementation; provide one and track state.
    const el = dialog.element as HTMLDialogElement;
    let dialogOpen = false;
    const showModal = vi.fn(() => { dialogOpen = true; });
    const close = vi.fn(() => { dialogOpen = false; });
    el.showModal = showModal;
    el.close = close;
    Object.defineProperty(el, 'open', { configurable: true, get: () => dialogOpen });

    openImageLightbox('/api/v1/files/raw?path=shot.png', 'screenshot');
    await nextTick();
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(wrapper.find('img.lightbox-img').attributes('src')).toBe('/api/v1/files/raw?path=shot.png');

    await wrapper.find('.lightbox-close').trigger('click');
    await nextTick();
    expect(imageLightbox.open).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('shows a failure note when the image cannot load', async () => {
    closeImageLightbox();
    const wrapper = mount(ImageLightbox);
    const el = wrapper.find('dialog.image-lightbox').element as HTMLDialogElement;
    el.showModal = () => {};
    el.close = () => {};

    openImageLightbox('/broken.png');
    await nextTick();
    expect(wrapper.find('.lightbox-note').exists()).toBe(false);
    await wrapper.find('img.lightbox-img').trigger('error');
    await nextTick();
    expect(wrapper.find('.lightbox-note').text()).toBe('图片加载失败');
    closeImageLightbox();
  });
});
