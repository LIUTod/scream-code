<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import type { Ref } from 'vue';
import type { ChatMessage } from '../types';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ToolGroup from './ToolGroup.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{
  message: ChatMessage;
  isLatestUser?: boolean;
  idle?: boolean;
  streaming?: boolean;
}>(), { isLatestUser: false, idle: true, streaming: false });
const emit = defineEmits<{ (e: 'edit', content: string): void }>();
const copied = ref(false);
let copyTimer: number | null = null;
const isUser = computed(() => props.message.role === 'user');
const isAssistant = computed(() => props.message.role === 'assistant');
const thinkingTools = computed(() => props.message.tools.filter((tool) => tool.name === 'thinking'));
const realTools = computed(() => props.message.tools.filter((tool) => tool.name !== 'thinking'));
const timestamp = computed(() => props.message.ts ? new Date(props.message.ts).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : '');
const canEdit = computed(() => isUser.value && props.isLatestUser && props.idle);
const showThinking = inject<Ref<boolean>>('showThinking', ref(true));
const showTools = inject<Ref<boolean>>('showTools', ref(true));
async function copyContent() {
  try { await navigator.clipboard.writeText(props.message.content); }
  catch {
    const textarea = document.createElement('textarea');
    textarea.value = props.message.content;
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  copied.value = true;
  if (copyTimer !== null) clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <article :class="['message', message.role, { error: message.isError }]">
    <div v-if="isUser" class="user-wrap">
      <div class="user-bubble">{{ message.content }}</div>
      <div class="message-meta user-meta">
        <span v-if="timestamp">{{ timestamp }}</span>
        <button v-if="canEdit" title="编辑并重新发送" @click="emit('edit', message.content)"><SvgIcon name="edit" :size="14" />编辑重发</button>
      </div>
    </div>

    <div v-else class="assistant-wrap">
      <div v-if="isAssistant" class="assistant-brand">
        <span class="assistant-avatar"><img src="/icon.ico" alt="" draggable="false" @error="(e) => (e.target as HTMLImageElement).style.visibility = 'hidden'" @load="(e) => (e.target as HTMLImageElement).style.visibility = 'visible'" style="visibility:hidden" /></span>
        <div><strong>Scream Code</strong><span><i :class="{ streaming }" />{{ streaming ? '正在生成回复' : 'Agent 回复' }}</span></div>
        <time v-if="timestamp">{{ timestamp }}</time>
      </div>
      <div class="assistant-body">
        <template v-if="showThinking">
          <ThinkingBlock v-for="tool in thinkingTools" :key="tool.toolCallId" :tool="tool" :active="streaming" />
        </template>
        <ToolGroup v-if="realTools.length && showTools" name="工具调用过程" :tools="realTools" />
        <MarkdownRenderer v-if="message.content" class="assistant-content" :content="message.content" />
        <span v-else-if="streaming" class="streaming-cursor" aria-label="正在生成" />
        <div v-if="message.content" class="message-meta">
          <button :title="copied ? '已复制' : '复制内容'" @click="copyContent"><SvgIcon :name="copied ? 'check' : 'copy'" :size="14" />{{ copied ? '已复制' : '复制' }}</button>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.message { width:100%; padding:18px 32px; animation:message-in var(--dur-msg-user) var(--ease-out) both; }
.message.user { display:flex; justify-content:flex-end; padding-top:22px; }
.user-wrap { max-width:min(76%,680px); display:flex; flex-direction:column; align-items:flex-end; }
.user-bubble { padding:13px 17px; border:1px solid var(--color-accent-bd); border-radius:17px 17px 5px 17px; background:var(--color-accent-soft); color:var(--color-text); line-height:1.65; white-space:pre-wrap; word-break:break-word; }
.assistant-wrap { width:100%; }
.assistant-brand { display:flex; align-items:center; gap:10px; margin-bottom:13px; }
.assistant-avatar { width:34px; height:34px; display:grid; place-items:center; border-radius:10px; background:var(--color-accent-soft); }
.assistant-avatar img { width:23px; height:23px; object-fit:contain; transition:visibility 0s; }
.assistant-brand > div { display:flex; flex:1; flex-direction:column; }
.assistant-brand strong { font-size:13px; }
.assistant-brand span { display:flex; align-items:center; gap:5px; margin-top:3px; color:var(--color-text-muted); font-size:10px; }
.assistant-brand i { width:5px; height:5px; border-radius:50%; background:var(--color-success); }
.assistant-brand i.streaming { background:var(--color-accent); animation:pulse 1.1s infinite; }
.assistant-brand time { color:var(--color-text-faint); font-size:10px; }
.assistant-body { padding-left:44px; display:flex; flex-direction:column; gap:13px; min-width:0; color:var(--color-text); line-height:1.75; }
.assistant-content { width:100%; }
.message.error .assistant-body { color:var(--color-danger); }
.streaming-cursor { width:8px; height:18px; border-radius:2px; background:var(--color-accent); animation:pulse 1s steps(2) infinite; }
.message-meta { min-height:20px; display:flex; align-items:center; gap:8px; margin-top:2px; color:var(--color-text-faint); font-size:10px; }
.user-meta { justify-content:flex-end; margin:5px 4px 0; }
.message-meta button { display:inline-flex; align-items:center; gap:4px; border:0; border-radius:5px; padding:3px 5px; background:transparent; color:var(--color-text-faint); font-size:10px; cursor:pointer; opacity:0; }
.message:hover .message-meta button,.message-meta button:focus-visible { opacity:1; }
.message-meta button:hover { color:var(--color-accent); background:var(--color-accent-soft); }
@keyframes message-in { from { opacity:0; transform:translateY(7px); } to { opacity:1; transform:none; } }
@keyframes pulse { 50% { opacity:.3; } }
@media (prefers-reduced-motion:reduce) { .message { animation:none; } }
@media (max-width:640px) { .message { padding:14px; } .user-wrap { max-width:88%; } .assistant-body { padding-left:0; } .message-meta button { opacity:1; } }
</style>
