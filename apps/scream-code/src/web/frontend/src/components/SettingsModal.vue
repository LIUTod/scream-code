<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import Dialog from './ui/Dialog.vue';
import SettingsView from './SettingsView.vue';
import { getActiveWebClient } from '../composables/webClient/activeClient';
import {
  closeSettingsModal,
  markSettingsModalMounted,
  markSettingsModalUnmounted,
  useSettingsModal,
} from '../composables/useSettingsModal';
import type { LikePreferences } from '../types';

/**
 * Centred settings modal (L3).
 *
 * The shell reuses ui/Dialog.vue's existing modal styling language: hairline
 * elevation stroke, overlay, Esc to close, focus trap, rise-in entrance. The
 * content embeds SettingsView directly — pane grouping and internal behaviour are
 * untouched — and the routed entry point (WebShell view==='settings') is kept as
 * is, so both paths share one implementation and a second set of settings logic
 * never appears.
 */
const { open } = useSettingsModal();

const client = computed(() => getActiveWebClient());
const like = computed<LikePreferences>(() => client.value?.like.value ?? {});

function onUpdateLike(prefs: LikePreferences) {
  void client.value?.updateLike(prefs);
}

onMounted(markSettingsModalMounted);
onBeforeUnmount(() => {
  markSettingsModalUnmounted();
  closeSettingsModal();
});
</script>

<template>
  <Dialog
    :open="open"
    title="设置"
    max-width="920px"
    @close="closeSettingsModal"
  >
    <div class="settings-modal-body">
      <SettingsView
        v-if="client"
        :client="client"
        :like="like"
        @update-like="onUpdateLike"
      />
    </div>
  </Dialog>
</template>

<style scoped>
.settings-modal-body {
  /* SettingsView relies on a flex parent giving it a definite height (rail + pane scroll independently). */
  height: min(64vh, 580px);
  display: flex;
  min-width: 0;
}
.settings-modal-body :deep(.settings) {
  border: none;
}
@media (max-width: 640px) {
  .settings-modal-body {
    height: 72vh;
  }
}
@media (prefers-reduced-motion: reduce) {
  /* The entrance animation's escape hatch is handled uniformly inside the Dialog shell and is not redeclared here. */
}
</style>
