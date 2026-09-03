<script setup lang="ts">
import { computed, ref } from 'vue';
import { filePanel, toggleFilePanel } from '../utils/fileTabState';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(
  defineProps<{
    title: string | null;
    busy: boolean;
    drawerOpen: boolean;
  }>(),
  { title: null, busy: false, drawerOpen: false },
);

const emit = defineEmits<{
  (e: 'home'): void;
  (e: 'rename', title: string): void;
  (e: 'export'): void;
  (e: 'clear'): void;
  (e: 'toggle-drawer'): void;
}>();

const editing = ref(false);
const draft = ref('');

function startEdit() {
  draft.value = props.title ?? '';
  editing.value = true;
}

function commitEdit() {
  const t = draft.value.trim();
  editing.value = false;
  if (t && t !== props.title) emit('rename', t);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    editing.value = false;
  }
}

const statusText = computed(() => (props.busy ? '运行中' : '就绪'));
</script>

<template>
  <header class="conv-bar">
    <div class="conv-bar-left">
      <button class="ghost-btn back-btn" title="返回工作台" aria-label="返回工作台" @click="emit('home')">
        <SvgIcon name="chevron-left" :size="20" />
      </button>
      <span class="status-dot" :class="{ busy }" :title="statusText" aria-hidden="true" />
      <button
        class="title-btn"
        :title="editing ? '' : '点击重命名'"
        @click="startEdit"
      >
        <template v-if="editing">
          <input
            v-model="draft"
            class="title-input"
            aria-label="会话标题"
            @keydown="onKeydown"
            @blur="commitEdit"
            @click.stop
          />
        </template>
        <template v-else>
          <span class="title-text">{{ title || '新会话' }}</span>
        </template>
      </button>
    </div>
    <div class="conv-bar-right">
      <button class="ghost-btn" title="导出 Markdown" aria-label="导出 Markdown" @click="emit('export')">
        <SvgIcon name="download" :size="18" />
      </button>
      <button class="ghost-btn" title="清空本地消息" aria-label="清空本地消息" @click="emit('clear')">
        <SvgIcon name="broom" :size="18" />
      </button>
      <button
        class="ghost-btn"
        :title="drawerOpen ? '收起详情' : '会话详情'"
        :aria-label="drawerOpen ? '收起详情' : '会话详情'"
        :class="{ active: drawerOpen }"
        @click="emit('toggle-drawer')"
      >
        <SvgIcon name="panel-right" :size="18" />
      </button>
      <button
        class="ghost-btn"
        :title="filePanel.panelOpen ? '收起文件面板' : '打开文件面板'"
        :aria-label="filePanel.panelOpen ? '收起文件面板' : '打开文件面板'"
        :class="{ active: filePanel.panelOpen }"
        @click="toggleFilePanel"
      >
        <SvgIcon name="file" :size="18" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.conv-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-line);
  background: transparent;
  min-height: 56px;
}
.conv-bar-left,
.conv-bar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.ghost-btn {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}
.ghost-btn:hover {
  color: var(--color-text);
  background: var(--color-hover);
}
.ghost-btn.active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-success);
  flex-shrink: 0;
}
.status-dot.busy {
  background: var(--color-accent);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
}

.title-btn {
  min-width: 0;
  max-width: min(480px, 55vw);
  height: 36px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.title-btn:hover {
  background: var(--color-hover);
}
.title-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title-input {
  width: 100%;
  min-width: 160px;
  height: 30px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-weight: 600;
  font-family: inherit;
}
.title-input:focus {
  outline: none;
  box-shadow: var(--glow-focus);
}

@media (max-width: 640px) {
  .conv-bar {
    min-height: 52px;
  }
  .ghost-btn {
    width: 44px;
    height: 44px;
  }
  .title-btn {
    max-width: 40vw;
  }
}
</style>
