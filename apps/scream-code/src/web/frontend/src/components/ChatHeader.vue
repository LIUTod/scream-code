<script setup lang="ts">
import { inject, nextTick, ref, watch } from 'vue';
import type { Ref } from 'vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{ title?: string | null; busy?: boolean }>(), { title: null, busy: false });
const emit = defineEmits<{
  (e: 'rename', title: string): void;
  (e: 'export'): void;
  (e: 'clear'): void;
  (e: 'toggle-rightbar'): void;
  (e: 'menu'): void;
}>();
const editing = ref(false);
const draft = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
watch(() => props.title, () => { if (!editing.value) draft.value = props.title ?? ''; }, { immediate: true });
function startEdit() {
  draft.value = props.title ?? '';
  editing.value = true;
  nextTick(() => { inputRef.value?.focus(); inputRef.value?.select(); });
}
function commit() {
  editing.value = false;
  const value = draft.value.trim();
  if (value && value !== props.title) emit('rename', value);
  else draft.value = props.title ?? '';
}
function cancel() { editing.value = false; draft.value = props.title ?? ''; }
const showThinking = inject<Ref<boolean>>('showThinking', ref(true));
const showTools = inject<Ref<boolean>>('showTools', ref(true));
</script>

<template>
  <div class="chat-header">
    <button class="mobile-menu" aria-label="打开会话列表" title="打开会话列表" @click="emit('menu')">
      <SvgIcon name="menu" />
    </button>
    <div class="title-area">
      <input v-if="editing" id="session-title-input" ref="inputRef" v-model="draft" name="session-title" class="title-input" maxlength="80" @keydown.enter.prevent="commit" @keydown.esc.prevent="cancel" @blur="commit" />
      <template v-else>
        <div class="title-copy">
          <div class="title-line">
            <h1 :title="title ?? undefined">{{ title || '新会话' }}</h1>
            <button class="icon-action edit" title="重命名会话" aria-label="重命名会话" @click="startEdit"><SvgIcon name="edit" :size="17" /></button>
          </div>
          <div class="status-line"><span :class="['status-dot', { busy }]" />{{ busy ? 'Agent 正在运行并处理工具调用' : 'Agent 已就绪' }}</div>
        </div>
      </template>
    </div>
    <div class="header-actions">
      <button class="text-action" title="导出会话为 Markdown" @click="emit('export')"><SvgIcon name="upload" :size="18" /><span>导出</span></button>
      <button class="text-action" title="清空本地消息列表" @click="emit('clear')"><SvgIcon name="broom" :size="18" /><span>清空</span></button>
      <button :class="['text-action', { dimmed: !showThinking }]" :title="showThinking ? '隐藏思考链' : '显示思考链'" @click="showThinking = !showThinking"><SvgIcon name="brain" :size="18" /><span>思考</span></button>
      <button :class="['text-action', { dimmed: !showTools }]" :title="showTools ? '隐藏工具链' : '显示工具链'" @click="showTools = !showTools"><SvgIcon name="terminal" :size="18" /><span>工具</span></button>
      <button class="icon-action rightbar-action" title="显示或隐藏右侧面板" aria-label="显示或隐藏右侧面板" @click="emit('toggle-rightbar')"><SvgIcon name="panel-right" :size="19" /></button>
    </div>
  </div>
</template>

<style scoped>
.mobile-menu { display:none; width:36px; height:36px; place-items:center; border:1px solid var(--color-line); border-radius:9px; background:var(--color-surface); color:var(--color-text); flex-shrink:0; cursor:pointer; }
.chat-header { min-height:88px; display:flex; align-items:center; gap:18px; padding:17px 24px; background:var(--color-surface); border-bottom:1px solid var(--color-line); flex-shrink:0; }
.title-area { flex:1; min-width:0; }
.title-copy { min-width:0; }
.title-line { display:flex; align-items:center; gap:7px; min-width:0; }
h1 { margin:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--color-text); font-size:20px; line-height:1.3; font-weight:700; letter-spacing:-.02em; }
.status-line { display:flex; align-items:center; gap:7px; margin-top:7px; color:var(--color-text-muted); font-size:12px; }
.status-dot { width:7px; height:7px; border-radius:50%; background:var(--color-success); }
.status-dot.busy { background:var(--color-accent); animation:pulse 1.2s infinite; }
.title-input { width:min(620px,100%); height:40px; padding:0 12px; border:1px solid var(--color-accent-bd); border-radius:9px; background:var(--color-surface-sunken); color:var(--color-text); font:700 18px var(--font-ui); outline:none; box-shadow:0 0 0 3px var(--color-accent-soft); }
.header-actions { display:flex; align-items:center; gap:8px; }
.text-action,.icon-action { display:inline-flex; align-items:center; justify-content:center; gap:7px; height:36px; border:1px solid var(--color-line); border-radius:9px; background:var(--color-surface); color:var(--color-text-muted); font-size:12px; cursor:pointer; }
.text-action { padding:0 12px; }
.icon-action { width:36px; padding:0; }
.icon-action.edit { width:28px; height:28px; border:0; opacity:0; }
.chat-header:hover .icon-action.edit,.icon-action.edit:focus-visible { opacity:1; }
.text-action:hover,.icon-action:hover { color:var(--color-accent); border-color:var(--color-accent-bd); background:var(--color-accent-soft); }
.text-action.dimmed { opacity:0.4; }
.text-action.dimmed:hover { opacity:0.7; }
@keyframes pulse { 50% { opacity:.3; } }
@media (max-width:640px) { .mobile-menu { display:grid; } .rightbar-action { display:none; } .chat-header { min-height:72px; padding:12px 14px; } h1 { font-size:17px; } .status-line { margin-top:4px; } .text-action { width:36px; padding:0; } .text-action span { display:none; } .icon-action.edit { opacity:1; } }
</style>
