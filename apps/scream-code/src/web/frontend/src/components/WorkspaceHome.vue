<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ModelInfo, SessionStatus } from '../types';
import Composer from './Composer.vue';
import ModeSwitch, { type WorkspaceMode } from './ModeSwitch.vue';
import logoUrl from '../assets/logo-v2.svg';

const props = withDefaults(
  defineProps<{
    models: ModelInfo[];
    status?: SessionStatus;
    busy: boolean;
    /** Owned by the shell so the choice survives the home view being unmounted. */
    mode?: WorkspaceMode;
  }>(),
  { status: undefined, mode: 'chat' },
);

const emit = defineEmits<{
  (e: 'send', text: string, mode: WorkspaceMode): void;
  (e: 'command', name: string, args?: string): void;
  (e: 'switch-model', alias: string): void;
  (e: 'switch-thinking', level: string): void;
  (e: 'update:mode', mode: WorkspaceMode): void;
}>();

const isGoalMode = computed(() => props.mode === 'goal');
const modeHint = computed(() =>
  isGoalMode.value
    ? '任务模式：提交后将创建执行目标（Goal），Agent 持续执行到完成或预算耗尽；抽屉「Goal 管理」可查看与暂停。'
    : '直接对话：提问后 Agent 按需调用工具完成你的请求。',
);
</script>

<template>
  <div class="workspace">
    <section class="workspace-hero">
            <h1 class="workspace-brand">
        <img class="brand-logo" :src="logoUrl" alt="scream" />
      </h1>
      <p class="workspace-tagline">你的智能协作伙伴</p>
      <ModeSwitch
        class="workspace-mode"
        :model-value="props.mode"
        @update:model-value="(v) => emit('update:mode', v)"
      />
      <p class="mode-hint"><span :key="String(isGoalMode)" class="hint-fade">{{ modeHint }}</span></p>
    </section>
    <section class="workspace-composer">
      <Composer
        :busy="busy"
        :status="status"
        :models="models"
        variant="home"
        :placeholder="isGoalMode ? '描述你要完成的目标，Enter 创建并开始执行…' : '输入 @ 引用知识库 / 使用技能 / 或者直接提问...'"
        @send="(t: string) => emit('send', t, props.mode)"
        @command="(n, a) => emit('command', n, a)"
        @switch-model="(a) => emit('switch-model', a)"
        @switch-thinking="(l) => emit('switch-thinking', l)"
      />
    </section>
  </div>
</template>

<style scoped>
.workspace {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-8);
  padding: var(--space-6) var(--space-5);
  overflow-y: auto;
  background: transparent;
}

.workspace-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  text-align: center;
}
.workspace-brand {
  display: flex;
  justify-content: center;
  line-height: 1;
  color: var(--color-text);
}
/* The wordmark's letter band is ~59% of its canvas height, so the image needs
   to run taller than the 56px text it replaces to hold the same visual weight. */
.brand-logo {
  display: block;
  height: 60px;
  width: auto;
}
:root[data-theme='dark'] .brand-logo {
  filter: invert(1) grayscale(1);
}
.workspace-tagline {
  font-size: var(--font-size-lg);
  color: var(--color-text-muted);
}
.workspace-mode {
  margin-top: var(--space-2);
}
.mode-hint {
  margin-top: var(--space-2);
  max-width: 560px;
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  text-align: center;
}
/* The hint text swaps when the mode flips; re-keyed span fades it in. */
.hint-fade {
  animation: hint-in 0.3s var(--ease-out) both;
}
@keyframes hint-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .hint-fade {
    animation: none;
  }
}

.workspace-composer {
  width: min(var(--content-max), 100%);
  animation: rise-in var(--dur-slower) var(--ease-out);
}

@media (max-width: 640px) {
  .workspace {
    justify-content: flex-start;
    padding-top: 12vh;
    gap: var(--space-6);
  }
  .workspace-brand .brand-logo {
    height: 42px;
  }
}
</style>
