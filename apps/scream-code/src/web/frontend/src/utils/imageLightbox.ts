import { reactive } from 'vue';

/**
 * Module-level lightbox state so independent render sites (markdown images,
 * tool-output screenshots) can open the one shared preview without any prop
 * drilling. Mirrors the fileTabState singleton pattern.
 */
export const imageLightbox = reactive({
  open: false,
  src: '',
  alt: '',
});

export function openImageLightbox(src: string, alt = ''): void {
  if (!src) return;
  imageLightbox.src = src;
  imageLightbox.alt = alt;
  imageLightbox.open = true;
}

export function closeImageLightbox(): void {
  imageLightbox.open = false;
}
