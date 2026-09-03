<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from 'vue';
import type { Ref } from 'vue';
import type { ChatMessage } from '../types';
import { formatMessageTime } from '../utils/timeFormat';
import { extractTurnWrittenFiles } from '../utils/turnWrittenFiles';
import { openFileInPanel } from '../utils/fileTabState';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ToolGroup from './ToolGroup.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import TurnStats from './TurnStats.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{
  message: ChatMessage;
  isLatestUser?: boolean;
  idle?: boolean;
  streaming?: boolean;
  /** Show the fork action (latest assistant message, session idle). */
  canFork?: boolean;
  /** Timestamp visibility follows grouping: only the last message of a run of
   *  consecutive assistant messages shows it. */
  showTimestamp?: boolean;
  /** Session context for on-demand thinking loading. */
  sessionId?: string;
  /** Session working dir — resolves relative written/mentioned file paths. */
  workDir?: string;
}>(), { isLatestUser: false, idle: true, streaming: false, canFork: false, showTimestamp: true, sessionId: '', workDir: '' });
const emit = defineEmits<{
  (e: 'edit', content: string): void;
  (e: 'retry'): void;
  (e: 'fork'): void;
}>();
const copied = ref(false);
let copyTimer: number | null = null;
const isUser = computed(() => props.message.role === 'user');
const isAssistant = computed(() => props.message.role === 'assistant');
const thinkingTools = computed(() => props.message.tools.filter((tool) => tool.name === 'thinking'));
const realTools = computed(() => props.message.tools.filter((tool) => tool.name !== 'thinking'));
const timestamp = computed(() => props.message.ts !== undefined ? formatMessageTime(props.message.ts) : '');
const canEdit = computed(() => isUser.value && props.isLatestUser && props.idle);

/** Files this assistant turn actually wrote (settled write/edit tool calls
 *  only, see utils/turnWrittenFiles); hidden while the turn streams. */
const writtenFiles = computed(() =>
  isAssistant.value && !props.streaming
    ? extractTurnWrittenFiles(props.message, props.workDir || undefined)
    : [],
);

function baseName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function openWrittenFile(filePath: string): void {
  openFileInPanel(filePath, { sessionId: props.sessionId || undefined });
}

/**
 * User-bubble @ file mentions: the composer inserts `@relative/path ` for
 * files (quoted `@"spaced path" ` when the path has spaces) — see
 * utils/fileFuzzy buildAtInsertText. Only those @ segments become links;
 * plain prose is never path-scanned (no false positives).
 */
interface UserSegment { text: string; path: string | null }

const AT_MENTION_RE = /(^|\s)@("[^"\n]+"|[^\s"]+)/g;

function resolveMentionPath(raw: string): string {
  if (!raw || raw.startsWith('/') || raw.startsWith('~')) return raw;
  const wd = props.workDir.trim();
  // No workDir in scope (shouldn't happen in a live session): the raw token
  // is the best path we have, so pass it through.
  if (!wd) return raw;
  let rel = raw;
  while (rel.startsWith('./')) rel = rel.slice(2);
  return `${wd.replace(/\/+$/, '')}/${rel}`;
}

const userSegments = computed<UserSegment[]>(() => {
  const content = props.message.content;
  if (!isUser.value || !content || !content.includes('@')) return [];
  const segs: UserSegment[] = [];
  let last = 0;
  AT_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AT_MENTION_RE.exec(content)) !== null) {
    const at = m.index + m[1].length;
    if (at > last) segs.push({ text: content.slice(last, at), path: null });
    const token = m[2];
    const raw = token.startsWith('"') ? token.slice(1, -1) : token;
    segs.push({ text: content.slice(at, at + 1 + token.length), path: resolveMentionPath(raw) });
    last = at + 1 + token.length;
  }
  if (last < content.length) segs.push({ text: content.slice(last), path: null });
  return segs;
});

function openAtFile(path: string): void {
  openFileInPanel(path, { sessionId: props.sessionId || undefined });
}
const showThinking = inject<Ref<boolean>>('showThinking', ref(true));
const showTools = inject<Ref<boolean>>('showTools', ref(true));

/** Text-to-speech playback state for the read-aloud button. */
const speaking = ref(false);
let speakOnEnd: ((() => void) | null) = null;

function toggleSpeak(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  if (speaking.value) {
    window.speechSynthesis.cancel();
    speaking.value = false;
    speakOnEnd = null;
    return;
  }
  const text = props.message.content;
  if (!text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  const handler = () => {
    // Guard: only this utterance's end/error may reset the speaking state.
    // A stale handler from a previously cancelled utterance must not clear a
    // newer read's state.
    if (speakOnEnd !== handler) return;
    speaking.value = false;
    speakOnEnd = null;
  };
  speakOnEnd = handler;
  utterance.addEventListener('end', handler);
  utterance.addEventListener('error', handler);
  // cancel() then speak() in the same tick can drop the new utterance in
  // Chrome; defer the speak by one frame.
  window.speechSynthesis.cancel(); // Clear any stale queue.
  requestAnimationFrame(() => {
    window.speechSynthesis.speak(utterance);
  });
  speaking.value = true;
}

onBeforeUnmount(() => {
  if (speaking.value && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
});
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
      <div class="user-head">
        <span v-if="timestamp" class="meta-time">{{ timestamp }}</span>
        <span class="head-name">你</span>
        <span class="user-avatar" aria-hidden="true"><SvgIcon name="user" :size="12" /></span>
      </div>
      <div class="user-bubble">
        <template v-if="userSegments.length">
          <template v-for="(seg, i) in userSegments" :key="i">
            <button
              v-if="seg.path !== null"
              class="at-link"
              :title="`在文件面板中打开 ${seg.path}`"
              @click="openAtFile(seg.path ?? '')"
            >{{ seg.text }}</button>
            <template v-else>{{ seg.text }}</template>
          </template>
        </template>
        <template v-else>{{ message.content }}</template>
      </div>
      <div v-if="canEdit" class="message-meta user-meta">
        <button title="编辑并重新发送" @click="emit('edit', message.content)"><SvgIcon name="edit" :size="12" />编辑重发</button>
      </div>
    </div>

    <div v-else class="assistant-wrap">
      <div
        v-if="isAssistant && (message.model || streaming || (showTimestamp && timestamp))"
        class="assistant-brand"
      >
        <span v-if="message.model" class="brand-model">{{ message.model }}</span>
        <span v-if="streaming" class="brand-streaming"><i aria-hidden="true" />生成中</span>
        <time v-if="showTimestamp && timestamp" class="brand-time">{{ timestamp }}</time>
      </div>
      <div class="assistant-body">
        <p v-if="message.degraded" class="degraded-note">该回合早于持久化快照：正文与思考在服务重启后无法恢复（工具记录与消息结构已保留）。</p>
        <template v-if="showThinking">
          <ThinkingBlock v-for="tool in thinkingTools" :key="tool.toolCallId" :tool="tool" :active="streaming" :session-id="sessionId" :msg-seq="message.seq" />
        </template>
        <ToolGroup v-if="realTools.length && showTools" name="工具调用过程" :tools="realTools" :live="streaming" :work-dir="workDir" :session-id="sessionId" />
        <MarkdownRenderer v-if="message.content" class="assistant-content" :content="message.content" :streaming="streaming" />
        <span v-else-if="streaming" class="streaming-cursor" aria-label="正在生成" />
        <TurnStats v-if="message.turnStats" :stats="message.turnStats" />
        <div v-if="writtenFiles.length" class="written-files" role="group" aria-label="本回合写入的文件">
          <button
            v-for="wf in writtenFiles"
            :key="wf.filePath"
            type="button"
            class="written-file"
            :title="`在文件面板中打开 ${wf.filePath}`"
            @click="openWrittenFile(wf.filePath)"
          ><SvgIcon name="file" :size="12" /><span class="written-file-name">{{ baseName(wf.filePath) }}</span></button>
        </div>
        <!-- One action row, rendered only when it has something to show:
             three stacked meta rows were three dead bands under every turn. -->
        <div v-if="message.content || (message.isError && !streaming) || canFork" class="message-meta">
          <button v-if="message.content" :title="copied ? '已复制' : '复制内容'" @click="copyContent"><SvgIcon :name="copied ? 'check' : 'copy'" :size="12" />{{ copied ? '已复制' : '复制' }}</button>
          <button v-if="message.content" :title="speaking ? '停止朗读' : '朗读'" @click="toggleSpeak"><SvgIcon :name="speaking ? 'speaker-off' : 'speaker'" :size="12" />{{ speaking ? '停止' : '朗读' }}</button>
          <button v-if="message.isError && !streaming" class="retry-btn" title="重发最后一条消息" @click="emit('retry')"><SvgIcon name="refresh" :size="12" />重试</button>
          <button v-if="isAssistant && canFork && !streaming" title="以当前对话为起点创建一个新会话" @click="emit('fork')"><SvgIcon name="fork" :size="12" />Fork</button>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* Gutter matches the composer dock (--space-5) so the text column, the bubble
   and the input card all share one left/right edge. */
.message { width:100%; padding:14px var(--space-5); }
.message.user { display:flex; justify-content:flex-end; padding-top:18px; animation:rise-in var(--dur-msg-user) var(--ease-out) both; }
.message.assistant { animation:rise-in var(--dur-msg-assistant) var(--ease-out) both; }
.user-wrap { max-width:85%; display:flex; flex-direction:column; align-items:flex-end; }
.user-bubble { padding:8px 12px; border:1px solid var(--color-line-strong); border-radius:var(--radius-lg); background:var(--color-accent-soft); color:var(--color-text); line-height:1.65; white-space:pre-wrap; word-break:break-word; }
.assistant-wrap { width:100%; }
.assistant-brand { display:flex; align-items:center; gap:8px; margin-bottom:6px; min-height:14px; }
.brand-model { font-size:11px; color:var(--color-text-faint); letter-spacing:0.01em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.brand-streaming { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--color-text-muted); }
.brand-streaming i { width:5px; height:5px; border-radius:50%; background:var(--color-accent); box-shadow:0 0 6px var(--color-accent-glow); animation:breathe var(--dur-breathe) ease-in-out infinite; }
.degraded-note {
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}
.message-meta .retry-btn {
  color: var(--color-danger);
}
.message-meta .retry-btn:hover {
  border-color: var(--color-danger);
}
.assistant-body { padding-left:0; display:flex; flex-direction:column; gap:var(--space-2); min-width:0; color:var(--color-text); line-height:1.75; }
.assistant-content { width:100%; }
.message.error .assistant-body { color:var(--color-danger); }
.streaming-cursor { width:8px; height:18px; border-radius:var(--radius-xs); background:var(--gradient-accent); animation:breathe var(--dur-breathe) ease-in-out infinite; }
.message-meta { min-height:24px; display:flex; align-items:center; gap:4px; margin-top:2px; color:var(--color-text-faint); font-size:11px; }
.meta-time { margin-left:auto; padding-left:var(--space-2); font-size:10px; color:var(--color-text-faint); flex-shrink:0; }
.user-meta { justify-content:flex-end; margin:4px 2px 0; }
/* Role header rows: name + time sit above the content, mirroring the
   reference layout; the meta row below keeps only actions. */
.user-head { display:flex; align-items:center; justify-content:flex-end; gap:6px; margin-bottom:6px; min-height:14px; }
.user-head .meta-time { margin-left:0; padding-left:0; }
.head-name { font-size:11px; color:var(--color-text-faint); }
.user-avatar { width:18px; height:18px; border-radius:var(--radius-full); background:var(--color-accent-soft); color:var(--color-text-muted); display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }
.brand-time { margin-left:auto; font-size:10px; color:var(--color-text-faint); flex-shrink:0; }
.at-link { display:inline; padding:0; border:0; background:none; font:inherit; color:inherit; text-decoration:underline; text-decoration-color:var(--color-accent-bd); text-underline-offset:2px; cursor:pointer; word-break:break-all; }
.at-link:hover { color:var(--color-accent); text-decoration-color:var(--color-accent); }
.written-files { display:flex; flex-wrap:wrap; gap:6px; }
.written-file { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border:1px solid var(--color-line-strong); border-radius:var(--radius-full); background:var(--color-surface); color:var(--color-text-muted); font-family:var(--font-mono); font-size:var(--font-size-xs); cursor:pointer; transition:border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out); }
.written-file:hover { border-color:var(--color-accent-bd); color:var(--color-text); background:var(--color-hover); }
.written-file:active { background:var(--color-selected); }
.written-file-name { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.message-meta button { display:inline-flex; align-items:center; gap:4px; height:24px; border:0; border-radius:var(--radius-sm); padding:0 6px; background:transparent; color:var(--color-text-faint); font-size:11px; cursor:pointer; opacity:0; transition:opacity var(--dur-base) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.message:hover .message-meta button,.message-meta button:focus-visible { opacity:1; }
.message-meta button:hover { color:var(--color-accent); background:var(--color-hover); }
.message-meta button:active { transform:scale(0.94); background:var(--color-selected); }
@media (prefers-reduced-motion:reduce) { .message.user,.message.assistant { animation:none; } .assistant-brand i,.streaming-cursor { animation:none; } }
@media (max-width:640px) { .message { padding:12px var(--space-4); } .user-wrap { max-width:92%; } .message-meta button { opacity:1; min-height:32px; } }
</style>
