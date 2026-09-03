<!-- Full-size image preview: a native modal <dialog> opened from markdown
     images and tool-output screenshots via the shared imageLightbox store.
     Closes on backdrop click or Esc (native `cancel`). -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { closeImageLightbox, imageLightbox } from '../utils/imageLightbox';
import SvgIcon from './ui/SvgIcon.vue';

const dialogRef = ref<HTMLDialogElement | null>(null);
const failed = ref(false);

watch(
  () => imageLightbox.open,
  (open) => {
    const dialog = dialogRef.value;
    if (!dialog) return;
    if (open) {
      failed.value = false;
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  },
);

// Esc inside a modal <dialog> fires `cancel`; swallow the native close and
// go through the store so `open` stays the single source of truth.
function onCancel(event: Event): void {
  event.preventDefault();
  closeImageLightbox();
}

function onClick(event: MouseEvent): void {
  // Only backdrop clicks dismiss; clicks on the image itself stay inert.
  if (event.target === dialogRef.value) closeImageLightbox();
}
</script>

<template>
  <dialog ref="dialogRef" class="image-lightbox" aria-label="图片预览" @cancel="onCancel" @click="onClick">
    <img
      v-if="imageLightbox.open"
      class="lightbox-img"
      :src="imageLightbox.src"
      :alt="imageLightbox.alt || '图片预览'"
      @error="failed = true"
    />
    <p v-if="failed" class="lightbox-note" role="alert">图片加载失败</p>
    <button
      type="button"
      class="lightbox-close"
      aria-label="关闭预览"
      title="关闭（Esc）"
      @click="closeImageLightbox()"
    >
      <SvgIcon name="x" :size="16" />
    </button>
  </dialog>
</template>

<style scoped>
.image-lightbox {
  border: 0;
  padding: 0;
  margin: auto;
  background: transparent;
  color: var(--color-text);
  max-width: calc(100vw - var(--space-5) * 2);
  max-height: calc(100vh - var(--space-5) * 2);
  animation: lightbox-in var(--dur-base) var(--ease-out) both;
}
.image-lightbox::backdrop {
  background: var(--color-lightbox-scrim);
}
.lightbox-img {
  display: block;
  /* Natural size up to the viewport margin — never upscaled beyond fit. */
  max-width: calc(100vw - var(--space-5) * 2);
  max-height: calc(100vh - var(--space-5) * 2);
  object-fit: contain;
  border-radius: var(--radius-md);
}
.lightbox-note {
  margin: 0;
  padding: var(--space-4) var(--space-5);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.lightbox-close {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.lightbox-close:hover {
  color: var(--color-text);
  border-color: var(--color-accent-bd);
  background: var(--color-hover);
}
@keyframes lightbox-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .image-lightbox { animation: none; }
}
</style>
