<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { UseScreamWebClientReturn } from '../composables/useScreamWebClient';
import { useToast } from '../composables/useToast';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{ client: UseScreamWebClientReturn }>();
const { showToast } = useToast();

const mutationPending = ref(false);
const rlmDepth = ref('0');
let interactionGeneration = 0;

const hasSession = computed(() => props.client.sessionId.value !== null);
const isArchived = computed(() => props.client.isArchived.value);
const isBusy = computed(() => props.client.isBusy.value);
const unavailableReason = computed(() => {
  if (!hasSession.value) return '打开会话后可调整控制项';
  if (isArchived.value) return '当前会话已归档，仅可查看记录';
  if (props.client.connectionStatus.value !== 'connected') return '连接恢复后可调整控制项';
  if (isBusy.value) return '当前回合结束后可调整控制项';
  return '';
});
const controlsDisabled = computed(() => Boolean(unavailableReason.value) || mutationPending.value);
const planEnabled = computed(() => props.client.status.value.planMode === true);
const planStrategy = computed(() =>
  props.client.status.value.planStrategy ?? props.client.sessionPlan.value?.strategy ?? 'normal',
);

async function refresh(): Promise<void> {
  if (!hasSession.value || isArchived.value || props.client.connectionStatus.value !== 'connected') return;
  await Promise.all([
    props.client.fetchSessionStatus(),
    props.client.fetchSessionPlan(),
  ]);
  const depth = props.client.status.value.rlmMaxDepth;
  // The core represents an unlimited cap as Infinity; the SDK normalizes that
  // to null at the JSON boundary.  Keep the draft synchronized with the
  // authoritative status so a save cannot silently replace a TUI-set depth
  // with the old placeholder value (0 = unlimited).
  rlmDepth.value = depth === null || depth === undefined ? '0' : String(depth);
}

async function mutate(action: () => Promise<boolean>, after?: () => Promise<void>): Promise<void> {
  if (controlsDisabled.value) return;
  const generation = interactionGeneration;
  mutationPending.value = true;
  try {
    const ok = await action();
    if (ok && generation === interactionGeneration) await after?.();
  } finally {
    if (generation !== interactionGeneration) return;
    // A failed mutation still needs a status reread: an interrupted network
    // request must not leave a native switch showing a stale optimistic state.
    await refresh();
    mutationPending.value = false;
  }
}

function setPlan(enabled: boolean, strategy?: 'normal' | 'fusion'): void {
  void mutate(() => props.client.switchPlanMode(enabled, strategy));
}

function setWolfpack(event: Event): void {
  const enabled = (event.currentTarget as HTMLInputElement).checked;
  void mutate(() => props.client.switchWolfpack(enabled));
}

function parseRlmDepth(): number | null {
  const value = rlmDepth.value.trim();
  if (!/^\d+$/.test(value)) {
    showToast('RLM 深度需为 0 或正整数', 'warning');
    return null;
  }
  return Number(value);
}

function setRlm(event: Event): void {
  const enabled = (event.currentTarget as HTMLInputElement).checked;
  // Toggling the mode and changing its recursion limit are separate actions.
  // Do not send the draft field here: it starts at 0 until the server state is
  // loaded, and sending it on a simple enable/disable would silently reset an
  // existing max depth. The explicit checkmark below is the only depth write.
  void mutate(() => props.client.switchRlm(enabled));
}

function saveRlmDepth(): void {
  const depth = parseRlmDepth();
  if (depth === null) return;
  void mutate(() => props.client.switchRlm(true, depth));
}

function clearPlan(): void {
  void mutate(() => props.client.clearPlan());
}

function undoLastTurn(): void {
  void mutate(
    () => props.client.undoHistory(),
    async () => {
      await props.client.fetchSnapshot();
    },
  );
}

function compact(): void {
  void mutate(() => props.client.compact());
}

onMounted(() => {
  void refresh();
});

watch(
  () => props.client.sessionId.value,
  () => {
    interactionGeneration++;
    mutationPending.value = false;
    rlmDepth.value = '0';
    void refresh();
  },
);
</script>

<template>
  <section class="session-controls" aria-label="会话控制">
    <header class="controls-head">
      <div class="controls-heading">
        <span class="controls-icon"><SvgIcon name="wrench" :size="16" /></span>
        <div>
          <h2>会话控制</h2>
          <p>{{ unavailableReason || '已就绪' }}</p>
        </div>
      </div>
      <button class="icon-button" title="刷新会话状态" aria-label="刷新会话状态" :disabled="mutationPending || !hasSession || isArchived" @click="refresh">
        <SvgIcon name="refresh" :size="15" />
      </button>
    </header>

    <div class="controls-body">
      <section class="control-group" aria-label="计划模式">
        <div class="group-label">
          <span>计划</span>
          <span v-if="planEnabled" class="mode-state">{{ planStrategy === 'fusion' ? '融合' : '标准' }}</span>
        </div>
        <div class="segmented" role="group" aria-label="计划模式">
          <button :class="{ active: !planEnabled }" :aria-pressed="!planEnabled" :disabled="controlsDisabled" @click="setPlan(false)">关闭</button>
          <button :class="{ active: planEnabled && planStrategy === 'normal' }" :aria-pressed="planEnabled && planStrategy === 'normal'" :disabled="controlsDisabled" @click="setPlan(true, 'normal')">计划</button>
          <button :class="{ active: planEnabled && planStrategy === 'fusion' }" :aria-pressed="planEnabled && planStrategy === 'fusion'" :disabled="controlsDisabled" @click="setPlan(true, 'fusion')">融合</button>
        </div>
        <button v-if="props.client.sessionPlan.value" class="text-action" :disabled="controlsDisabled" @click="clearPlan">
          <SvgIcon name="broom" :size="14" />
          清除计划
        </button>
      </section>

      <section class="control-group" aria-label="并行与递归模式">
        <label class="switch-row">
          <span>
            <strong>Wolfpack</strong>
            <small>并行协作</small>
          </span>
          <input
            type="checkbox"
            :checked="props.client.status.value.wolfpackMode === true"
            :disabled="controlsDisabled"
            @change="setWolfpack"
          />
          <i aria-hidden="true" />
        </label>

        <div class="rule" />

        <label class="switch-row">
          <span>
            <strong>RLM</strong>
            <small>持久 Python</small>
          </span>
          <input
            type="checkbox"
            :checked="props.client.status.value.rlmEnabled === true"
            :disabled="controlsDisabled"
            @change="setRlm"
          />
          <i aria-hidden="true" />
        </label>
        <label v-if="props.client.status.value.rlmEnabled" class="depth-field">
          <span>最大深度</span>
          <div>
            <input v-model="rlmDepth" inputmode="numeric" min="0" type="number" :disabled="controlsDisabled" aria-label="RLM 最大深度" />
            <button title="保存 RLM 最大深度" aria-label="保存 RLM 最大深度" :disabled="controlsDisabled" @click="saveRlmDepth">
              <SvgIcon name="check" :size="14" />
            </button>
          </div>
        </label>
      </section>

      <section class="control-group control-group--actions" aria-label="会话操作">
        <button class="command-action" :disabled="controlsDisabled" @click="compact">
          <SvgIcon name="compact" :size="16" />
          <span>压缩上下文</span>
        </button>
        <button class="command-action danger" :disabled="controlsDisabled" @click="undoLastTurn">
          <SvgIcon name="broom" :size="16" />
          <span>撤销上一轮</span>
        </button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.session-controls {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  background: var(--color-surface);
}
.controls-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.controls-heading { display: flex; align-items: center; min-width: 0; gap: var(--space-2); }
.controls-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
  flex-shrink: 0;
}
h2 { margin: 0; color: var(--color-text); font-size: var(--font-size-sm); font-weight: 650; }
.controls-heading p { margin: 2px 0 0; color: var(--color-text-faint); font-size: var(--font-size-xs); }
.icon-button {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  background: transparent;
  cursor: pointer;
}
.icon-button:hover:not(:disabled) { color: var(--color-text); background: var(--color-hover); }
.controls-body { overflow-y: auto; padding: var(--space-3); }
.control-group { padding: var(--space-3) 0; border-bottom: 1px solid var(--color-line); }
.control-group:first-child { padding-top: 0; }
.control-group:last-child { border-bottom: 0; padding-bottom: 0; }
.group-label { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-2); color: var(--color-text); font-size: var(--font-size-sm); font-weight: 600; }
.mode-state { color: var(--color-text-faint); font: 500 var(--font-size-xs) var(--font-mono); }
.segmented { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 3px; gap: 2px; border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface-sunken); }
.segmented button { min-height: 30px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); font: 550 var(--font-size-xs) var(--font-ui); cursor: pointer; }
.segmented button:hover:not(:disabled) { color: var(--color-text); background: var(--color-hover); }
.segmented button.active { color: var(--color-text); background: var(--color-surface-raised); box-shadow: var(--shadow-xs); }
.text-action { display: inline-flex; align-items: center; gap: 5px; margin-top: var(--space-2); padding: 3px 0; border: 0; color: var(--color-text-muted); background: transparent; font: 500 var(--font-size-xs) var(--font-ui); cursor: pointer; }
.text-action:hover:not(:disabled) { color: var(--color-danger); }
.switch-row { display: flex; align-items: center; justify-content: space-between; min-height: 38px; gap: var(--space-3); cursor: pointer; }
.switch-row span { display: grid; gap: 2px; }
.switch-row strong { color: var(--color-text); font-size: var(--font-size-sm); font-weight: 600; }
.switch-row small { color: var(--color-text-faint); font-size: var(--font-size-xs); }
.switch-row input { position: absolute; opacity: 0; pointer-events: none; }
.switch-row i { position: relative; width: 34px; height: 20px; border-radius: var(--radius-full); background: var(--color-line-strong); flex-shrink: 0; transition: background var(--dur-fast) var(--ease-out); }
.switch-row i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--color-surface-raised); box-shadow: var(--shadow-xs); transition: transform var(--dur-fast) var(--ease-out); }
.switch-row input:checked + i { background: var(--color-accent); }
.switch-row input:checked + i::after { transform: translateX(14px); background: var(--color-on-accent); }
.switch-row input:focus-visible + i { outline: 2px solid var(--color-focus-ring, var(--color-accent)); outline-offset: 2px; }
.switch-row input:disabled + i { opacity: 0.45; }
.switch-row:has(input:disabled) { cursor: not-allowed; }
.rule { height: 1px; margin: var(--space-2) 0; background: var(--color-line); }
.depth-field { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-top: var(--space-2); color: var(--color-text-muted); font-size: var(--font-size-xs); }
.depth-field > div { display: flex; align-items: stretch; height: 28px; }
.depth-field input { width: 60px; min-width: 0; padding: 0 var(--space-2); border: 1px solid var(--color-line); border-right: 0; border-radius: var(--radius-sm) 0 0 var(--radius-sm); color: var(--color-text); background: var(--color-surface-sunken); font: 500 var(--font-size-xs) var(--font-mono); outline: none; }
.depth-field input:focus { border-color: var(--color-accent-bd); }
.depth-field button { width: 28px; display: grid; place-items: center; border: 1px solid var(--color-line); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; color: var(--color-text-muted); background: var(--color-surface); cursor: pointer; }
.depth-field button:hover:not(:disabled) { color: var(--color-text); background: var(--color-hover); }
.control-group--actions { display: grid; gap: var(--space-2); }
.command-action { min-height: 36px; display: flex; align-items: center; justify-content: flex-start; gap: var(--space-2); padding: 0 var(--space-3); border: 1px solid var(--color-line); border-radius: var(--radius-md); color: var(--color-text); background: var(--color-surface); font: 550 var(--font-size-sm) var(--font-ui); cursor: pointer; }
.command-action:hover:not(:disabled) { background: var(--color-hover); border-color: var(--color-line-strong); }
.command-action.danger { color: var(--color-danger); }
.command-action:disabled, .segmented button:disabled, .text-action:disabled, .depth-field button:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
