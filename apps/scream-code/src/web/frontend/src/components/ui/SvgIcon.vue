<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
</script>

<template>
  <svg
    class="svg-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'menu'"><path d="M4 7h16M4 12h16M4 17h16" /></template>
    <template v-else-if="name === 'plus'"><path d="M12 5v14M5 12h14" /></template>
    <template v-else-if="name === 'panel-left'"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></template>
    <template v-else-if="name === 'panel-right'"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></template>
    <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></template>
    <template v-else-if="name === 'filter'"><path d="M4 6h16M7 12h10M10 18h4" /></template>
    <template v-else-if="name === 'download'"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" /></template>
    <template v-else-if="name === 'trash'"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></template>
    <template v-else-if="name === 'activity'"><path d="M3 12h4l2-7 4 14 2-7h6" /></template>
    <template v-else-if="name === 'help'"><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.2 1-1.2 1.7M12 17h.01" /></template>
    <template v-else-if="name === 'chevron-left'"><path d="m15 18-6-6 6-6" /></template>
    <template v-else-if="name === 'chevron-right'"><path d="m9 18 6-6-6-6" /></template>
    <template v-else-if="name === 'chevron-down'"><path d="m6 9 6 6 6-6" /></template>
    <template v-else-if="name === 'bot'"><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" /></template>
    <template v-else-if="name === 'git-branch'"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 10c5 0 3-3 8-3" /></template>
    <template v-else-if="name === 'sun'"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></template>
    <template v-else-if="name === 'moon'"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" /></template>
    <template v-else-if="name === 'monitor'"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></template>
    <template v-else-if="name === 'wifi'"><path d="M5 9a11 11 0 0 1 14 0M8.5 12.5a6 6 0 0 1 7 0M12 17h.01" /></template>
    <template v-else-if="name === 'edit'"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></template>
    <template v-else-if="name === 'upload'"><path d="M12 16V4m0 0-4 4m4-4 4 4M5 20h14" /></template>
    <template v-else-if="name === 'broom'"><path d="m15 4 5 5M17.5 6.5 10 14m-2-2 4 4-3 4H3l1-6Z" /></template>
    <template v-else-if="name === 'command'"><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" /></template>
    <template v-else-if="name === 'at'"><circle cx="12" cy="12" r="4" /><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7" /></template>
    <template v-else-if="name === 'send'"><path d="m22 2-7 20-4-9-9-4ZM22 2 11 13" /></template>
    <template v-else-if="name === 'stop'"><rect x="6" y="6" width="12" height="12" rx="2" /></template>
    <template v-else-if="name === 'compact'"><path d="m8 3 4 4 4-4M8 21l4-4 4 4M12 7v10" /></template>
    <template v-else-if="name === 'brain'"><path d="M9.5 4.5A3 3 0 0 0 5 7a3 3 0 0 0 .5 5.5A3 3 0 0 0 9 17v2a2 2 0 0 0 4 0V5a2.5 2.5 0 0 0-3.5-.5ZM13 6a3 3 0 0 1 5 2 3 3 0 0 1 .5 5.5A3 3 0 0 1 15 18" /></template>
    <template v-else-if="name === 'clipboard'"><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V2h6v2M9 10h6M9 14h6" /></template>
    <template v-else-if="name === 'fork'"><circle cx="6" cy="4" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12M8 10c6 0 4-4 8-4" /></template>
    <template v-else-if="name === 'message-circle'"><path d="M21 12a8 8 0 0 1-9 8 9 9 0 0 1-4-.9L3 21l1.7-4A9 9 0 1 1 21 12Z" /></template>
    <template v-else-if="name === 'tag'"><path d="M20 13 13 20l-9-9V4h7ZM8.5 8.5h.01" /></template>
    <template v-else-if="name === 'sparkles'"><path d="m12 3 1.3 3.7L17 8l-3.7 1.3L12 13l-1.3-3.7L7 8l3.7-1.3ZM5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8ZM19 14l.7 1.8 1.8.7-1.8.7L19 19l-.7-1.8-1.8-.7 1.8-.7Z" /></template>
    <template v-else-if="name === 'terminal'"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m5 0h5" /></template>
    <template v-else-if="name === 'folder'"><path d="M3 6h7l2 2h9v11H3Z" /></template>
    <template v-else-if="name === 'check'"><path d="m5 12 4 4L19 6" /></template>
    <template v-else-if="name === 'speaker'"><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18 6a8.5 8.5 0 0 1 0 12" /></template>
    <template v-else-if="name === 'speaker-off'"><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="m16 9 5 6M21 9l-5 6" /></template>
    <template v-else-if="name === 'copy'"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></template>
    <template v-else-if="name === 'refresh'"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" /></template>
    <template v-else-if="name === 'target'"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></template>
  </svg>
</template>

<style scoped>
.svg-icon { display: block; flex: 0 0 auto; }
</style>
