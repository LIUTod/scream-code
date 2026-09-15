import { ref } from 'vue';

/**
 * Settings modal toggle (L3).
 *
 * Module-level singleton: any surface (Sidebar entry, command palette, future deep links)
 * can call openSettingsModal(); SettingsModal.vue is self-contained (Teleport to body) and
 * the host only needs to mount it once. The hostMounted count lets entries fail tryOpen when
 * the modal is not mounted and fall back to the old route-based navigation
 * (emit navigate('settings')), keeping the current behavior intact.
 */

const settingsModalOpen = ref(false);
let mountedHosts = 0;

export function markSettingsModalMounted(): void {
  mountedHosts++;
}

export function markSettingsModalUnmounted(): void {
  mountedHosts = Math.max(0, mountedHosts - 1);
}

export function isSettingsModalMounted(): boolean {
  return mountedHosts > 0;
}

/** Opens the modal; returns false when the modal host is not mounted so the caller can fall back to the old navigation. */
export function tryOpenSettingsModal(): boolean {
  if (!isSettingsModalMounted()) return false;
  settingsModalOpen.value = true;
  return true;
}

export function openSettingsModal(): void {
  settingsModalOpen.value = true;
}

export function closeSettingsModal(): void {
  settingsModalOpen.value = false;
}

export function useSettingsModal() {
  return {
    open: settingsModalOpen,
    openSettingsModal,
    closeSettingsModal,
    tryOpenSettingsModal,
  };
}
