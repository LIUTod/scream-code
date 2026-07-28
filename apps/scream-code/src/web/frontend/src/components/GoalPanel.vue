<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ConnectionStatus } from '../composables/useScreamWebClient';
import type {
  CreateGoalRequest,
  GoalBudgetInput,
  GoalBudgetUnit,
  GoalSnapshot,
  UpdateGoalRequest,
} from '../types';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{
  goal: GoalSnapshot | null;
  sessionId?: string | null;
  connectionStatus: ConnectionStatus;
  busy?: boolean;
  archived?: boolean;
  pending?: boolean;
  error?: string | null;
  refineGoal: (description: string) => Promise<string | null>;
  createGoal: (request: CreateGoalRequest) => Promise<boolean>;
  updateGoal: (request: UpdateGoalRequest) => Promise<boolean>;
  pauseGoal: () => Promise<boolean>;
  resumeGoal: () => Promise<boolean>;
  cancelGoal: () => Promise<boolean>;
}>(), {
  sessionId: null,
  busy: false,
  archived: false,
  pending: false,
  error: null,
});

const objective = ref('');
const completionCriterion = ref('');
const turnBudget = ref('');
const tokenBudget = ref('');
const timeBudget = ref('');
const timeUnit = ref<Extract<GoalBudgetUnit, 'milliseconds' | 'seconds' | 'minutes' | 'hours'>>('minutes');
const editing = ref(false);
const localError = ref<string | null>(null);
const refinedHint = ref(false);

const connected = computed(() => props.connectionStatus === 'connected');
const baseDisabled = computed(() => !props.sessionId || !connected.value || props.archived || props.pending);
const createDisabled = computed(() => baseDisabled.value || props.busy);
const statusLabel = computed(() => ({
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已完成',
})[props.goal?.status ?? 'active']);
const statusHint = computed(() => {
  if (!props.sessionId) return '选择或新建会话后即可配置';
  if (props.archived) return '归档会话为只读状态';
  if (!connected.value) return '连接恢复后可继续管理';
  if (props.pending) return '正在提交请求…';
  return props.goal ? '状态由核心事件实时同步' : '创建后 Agent 将自动开始执行';
});

watch(() => props.sessionId, () => {
  editing.value = false;
  resetCreateForm();
});

watch(() => props.goal?.goalId, (nextGoalId, previousGoalId) => {
  editing.value = false;
  if (nextGoalId !== previousGoalId) resetCreateForm();
});

function resetCreateForm(): void {
  objective.value = '';
  completionCriterion.value = '';
  turnBudget.value = '';
  tokenBudget.value = '';
  timeBudget.value = '';
  timeUnit.value = 'minutes';
  refinedHint.value = false;
  localError.value = null;
}

function positiveInteger(raw: string, label: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    localError.value = `${label}必须是正整数。`;
    return undefined;
  }
  return value;
}

function collectBudgets(): GoalBudgetInput[] | null {
  localError.value = null;
  const turns = positiveInteger(turnBudget.value, '轮次预算');
  if (turns === undefined) return null;
  const tokens = positiveInteger(tokenBudget.value, 'Token 预算');
  if (tokens === undefined) return null;
  const time = positiveInteger(timeBudget.value, '时间预算');
  if (time === undefined) return null;
  const budgets: GoalBudgetInput[] = [];
  if (turns !== null) budgets.push({ value: turns, unit: 'turns' });
  if (tokens !== null) budgets.push({ value: tokens, unit: 'tokens' });
  if (time !== null) budgets.push({ value: time, unit: timeUnit.value });
  return budgets;
}

async function refine(): Promise<void> {
  const description = objective.value.trim();
  if (!description) {
    localError.value = '请先输入需要优化的目标描述。';
    return;
  }
  localError.value = null;
  refinedHint.value = false;
  const refined = await props.refineGoal(description);
  if (refined !== null) {
    objective.value = refined;
    refinedHint.value = true;
  }
}

async function create(): Promise<void> {
  const nextObjective = objective.value.trim();
  if (!nextObjective) {
    localError.value = '目标内容不能为空。';
    return;
  }
  const budgets = collectBudgets();
  if (budgets === null) return;
  const ok = await props.createGoal({
    objective: nextObjective,
    completionCriterion: completionCriterion.value.trim() || undefined,
    replace: false,
    budgets,
  });
  if (ok) refinedHint.value = false;
}

function representTimeBudget(milliseconds: number | null): void {
  if (milliseconds === null) {
    timeBudget.value = '';
    timeUnit.value = 'minutes';
  } else if (milliseconds % 3_600_000 === 0) {
    timeBudget.value = String(milliseconds / 3_600_000);
    timeUnit.value = 'hours';
  } else if (milliseconds % 60_000 === 0) {
    timeBudget.value = String(milliseconds / 60_000);
    timeUnit.value = 'minutes';
  } else if (milliseconds % 1000 === 0) {
    timeBudget.value = String(milliseconds / 1000);
    timeUnit.value = 'seconds';
  } else {
    timeBudget.value = String(milliseconds);
    timeUnit.value = 'milliseconds';
  }
}

function beginEdit(): void {
  const current = props.goal;
  if (!current) return;
  objective.value = current.objective;
  turnBudget.value = current.budget.turnBudget === null ? '' : String(current.budget.turnBudget);
  tokenBudget.value = current.budget.tokenBudget === null ? '' : String(current.budget.tokenBudget);
  representTimeBudget(current.budget.wallClockBudgetMs);
  localError.value = null;
  editing.value = true;
}

function timeToMilliseconds(value: number, unit: typeof timeUnit.value): number {
  if (unit === 'hours') return value * 3_600_000;
  if (unit === 'minutes') return value * 60_000;
  if (unit === 'seconds') return value * 1000;
  return value;
}

async function saveEdit(): Promise<void> {
  const current = props.goal;
  if (!current) return;
  const nextObjective = objective.value.trim();
  if (!nextObjective) {
    localError.value = '目标内容不能为空。';
    return;
  }
  const budgets = collectBudgets();
  if (budgets === null) return;

  const nextTurns = positiveInteger(turnBudget.value, '轮次预算');
  const nextTokens = positiveInteger(tokenBudget.value, 'Token 预算');
  const nextTime = positiveInteger(timeBudget.value, '时间预算');
  if (nextTurns === undefined || nextTokens === undefined || nextTime === undefined) return;
  if (current.budget.turnBudget !== null && nextTurns === null) {
    localError.value = '当前协议不支持清除已有轮次预算，请填写新的正整数。';
    return;
  }
  if (current.budget.tokenBudget !== null && nextTokens === null) {
    localError.value = '当前协议不支持清除已有 Token 预算，请填写新的正整数。';
    return;
  }
  if (current.budget.wallClockBudgetMs !== null && nextTime === null) {
    localError.value = '当前协议不支持清除已有时间预算，请填写新的正整数。';
    return;
  }

  const changedBudgets = budgets.filter((budget) => {
    if (budget.unit === 'turns') return budget.value !== current.budget.turnBudget;
    if (budget.unit === 'tokens') return budget.value !== current.budget.tokenBudget;
    return timeToMilliseconds(budget.value, budget.unit) !== current.budget.wallClockBudgetMs;
  });
  const changedObjective = nextObjective === current.objective ? undefined : nextObjective;
  if (changedObjective === undefined && changedBudgets.length === 0) {
    localError.value = '目标与预算没有变化。';
    return;
  }
  const ok = await props.updateGoal({ objective: changedObjective, budgets: changedBudgets });
  if (ok) editing.value = false;
}

async function lifecycle(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  localError.value = null;
  if (action === 'cancel' && !window.confirm('确定取消当前 Goal？当前 Goal 状态将被清除。')) return;
  if (action === 'pause') await props.pauseGoal();
  else if (action === 'resume') await props.resumeGoal();
  else await props.cancelGoal();
}

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds} 毫秒`;
  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function metricPercent(used: number, budget: number | null): number {
  if (budget === null || budget <= 0) return 0;
  return Math.min(100, Math.round((used / budget) * 100));
}

function formatNoteTime(time: number): string {
  return new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <section class="goal-panel panel-section">
    <div class="section-heading">
      <div><span>Goal 管理</span><small>{{ statusHint }}</small></div>
      <span v-if="goal" :class="['status-pill', `is-${goal.status}`]">{{ statusLabel }}</span>
      <SvgIcon v-else name="activity" :size="19" />
    </div>

    <div v-if="!sessionId" class="empty-state">暂无会话，Goal 管理暂不可用。</div>

    <form v-else-if="!goal" class="goal-form" @submit.prevent="create">
      <label>
        <span>目标内容</span>
        <textarea v-model="objective" rows="3" maxlength="4000" placeholder="描述希望 Agent 持续完成的目标" :disabled="createDisabled" />
      </label>
      <div class="refine-row">
        <button type="button" class="secondary" :disabled="createDisabled || !objective.trim()" @click="refine">
          <SvgIcon name="sparkles" :size="15" /> AI 优化
        </button>
        <small v-if="refinedHint">已优化，请确认或继续编辑后再创建。</small>
      </div>
      <label>
        <span>完成标准 <small>可选</small></span>
        <textarea v-model="completionCriterion" rows="2" placeholder="例如：聚焦测试、类型检查与 Web 构建全部通过" :disabled="createDisabled" />
      </label>
      <div class="budget-title">执行预算 <small>留空表示不限制</small></div>
      <div class="budget-grid">
        <label><span>轮次</span><input v-model="turnBudget" type="number" min="1" step="1" placeholder="不限" :disabled="createDisabled" /></label>
        <label><span>Token</span><input v-model="tokenBudget" type="number" min="1" step="1" placeholder="不限" :disabled="createDisabled" /></label>
      </div>
      <div class="time-budget">
        <label><span>时间</span><input v-model="timeBudget" type="number" min="1" step="1" placeholder="不限" :disabled="createDisabled" /></label>
        <select v-model="timeUnit" aria-label="时间预算单位" :disabled="createDisabled">
          <option value="minutes">分钟</option><option value="hours">小时</option><option value="seconds">秒</option><option value="milliseconds">毫秒</option>
        </select>
      </div>
      <button class="primary" type="submit" :disabled="createDisabled || !objective.trim()">{{ pending ? '正在创建…' : '创建并开始执行' }}</button>
    </form>

    <template v-else>
      <div v-if="!editing" class="goal-summary">
        <div class="objective"><small>目标</small><p>{{ goal.objective }}</p></div>
        <div class="criterion"><small>完成标准</small><p>{{ goal.completionCriterion ?? '未设置，由 Agent 根据目标判断完成。' }}</p></div>
        <div v-if="goal.terminalReason" class="reason"><strong>状态原因</strong><span>{{ goal.terminalReason }}</span></div>

        <div class="metrics">
          <div class="metric">
            <div><span>轮次</span><strong>{{ goal.turnsUsed }} / {{ goal.budget.turnBudget ?? '不限' }}</strong></div>
            <i v-if="goal.budget.turnBudget !== null"><b :style="{ width: `${metricPercent(goal.turnsUsed, goal.budget.turnBudget)}%` }" /></i>
          </div>
          <div class="metric">
            <div><span>Token</span><strong>{{ formatNumber(goal.tokensUsed) }} / {{ goal.budget.tokenBudget === null ? '不限' : formatNumber(goal.budget.tokenBudget) }}</strong></div>
            <i v-if="goal.budget.tokenBudget !== null"><b :style="{ width: `${metricPercent(goal.tokensUsed, goal.budget.tokenBudget)}%` }" /></i>
          </div>
          <div class="metric">
            <div><span>时间</span><strong>{{ formatDuration(goal.wallClockMs) }} / {{ goal.budget.wallClockBudgetMs === null ? '不限' : formatDuration(goal.budget.wallClockBudgetMs) }}</strong></div>
            <i v-if="goal.budget.wallClockBudgetMs !== null"><b :style="{ width: `${metricPercent(goal.wallClockMs, goal.budget.wallClockBudgetMs)}%` }" /></i>
          </div>
        </div>
        <div v-if="goal.budget.overBudget" class="budget-warning">已达到或超过执行预算。</div>

        <details v-if="goal.notes.length" class="notes">
          <summary>工作记录（{{ goal.notes.length }}）</summary>
          <ol><li v-for="note in goal.notes" :key="`${note.time}-${note.content}`"><time>{{ formatNoteTime(note.time) }}</time><span>{{ note.content }}</span></li></ol>
        </details>

        <div class="actions">
          <button v-if="goal.status !== 'complete'" class="secondary" :disabled="baseDisabled || busy" @click="beginEdit"><SvgIcon name="edit" :size="15" />编辑</button>
          <button v-if="goal.status === 'active'" class="secondary" :disabled="baseDisabled" @click="lifecycle('pause')">暂停</button>
          <button v-if="goal.status === 'paused' || goal.status === 'blocked'" class="primary small" :disabled="baseDisabled || busy" @click="lifecycle('resume')">继续</button>
          <button class="danger" :disabled="baseDisabled" @click="lifecycle('cancel')">取消 Goal</button>
        </div>
      </div>

      <form v-else class="goal-form edit-form" @submit.prevent="saveEdit">
        <label><span>目标内容</span><textarea v-model="objective" rows="3" maxlength="4000" :disabled="baseDisabled || busy" /></label>
        <div class="budget-title">更新预算 <small>仅提交发生变化的预算</small></div>
        <div class="budget-grid">
          <label><span>轮次</span><input v-model="turnBudget" type="number" min="1" step="1" placeholder="不限" :disabled="baseDisabled || busy" /></label>
          <label><span>Token</span><input v-model="tokenBudget" type="number" min="1" step="1" placeholder="不限" :disabled="baseDisabled || busy" /></label>
        </div>
        <div class="time-budget">
          <label><span>时间</span><input v-model="timeBudget" type="number" min="1" step="1" placeholder="不限" :disabled="baseDisabled || busy" /></label>
          <select v-model="timeUnit" aria-label="时间预算单位" :disabled="baseDisabled || busy">
            <option value="minutes">分钟</option><option value="hours">小时</option><option value="seconds">秒</option><option value="milliseconds">毫秒</option>
          </select>
        </div>
        <div class="edit-actions"><button type="button" class="secondary" :disabled="pending" @click="editing = false">返回</button><button class="primary small" type="submit" :disabled="baseDisabled || busy">保存修改</button></div>
      </form>
    </template>

    <p v-if="localError || error" class="form-error">{{ localError ?? error }}</p>
    <p v-else-if="pending" class="pending-copy">请求处理中，状态将在核心事件到达后同步。</p>
  </section>
</template>

<style scoped>
.panel-section { padding:17px; border:1px solid var(--color-line); border-radius:14px; background:var(--color-surface); box-shadow:0 2px 8px rgba(20,35,24,.03); }
.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:14px; color:var(--color-accent); }
.section-heading > div { display:flex; flex-direction:column; min-width:0; }
.section-heading span { color:var(--color-text); font-size:14px; font-weight:700; }
.section-heading small { margin-top:4px; color:var(--color-text-faint); font-size:10px; font-weight:400; }
.status-pill { flex-shrink:0; padding:5px 8px; border-radius:999px; font-size:10px!important; font-weight:700; }
.status-pill.is-active { color:var(--color-success); background:var(--color-success-soft); }
.status-pill.is-paused { color:var(--color-warning); background:var(--color-warning-soft); }
.status-pill.is-blocked { color:var(--color-danger); background:var(--color-danger-soft); }
.status-pill.is-complete { color:var(--color-info); background:var(--color-info-soft); }
.empty-state { padding:16px 10px; border:1px dashed var(--color-line); border-radius:10px; color:var(--color-text-faint); font-size:11px; text-align:center; }
.goal-form { display:grid; gap:11px; }
.goal-form label { display:grid; gap:5px; min-width:0; }
.goal-form label > span,.budget-title { color:var(--color-text-muted); font-size:11px; font-weight:650; }
.goal-form label small,.budget-title small { color:var(--color-text-faint); font-size:9px; font-weight:400; }
textarea,input,select { width:100%; border:1px solid var(--color-line); border-radius:8px; background:var(--color-surface-sunken); color:var(--color-text); font:11px/1.5 var(--font-ui); }
textarea { min-height:58px; padding:9px; resize:vertical; }
input,select { height:34px; padding:0 9px; }
textarea:focus,input:focus,select:focus { border-color:var(--color-accent-bd); outline:none; }
.refine-row { display:flex; align-items:center; gap:8px; }
.refine-row small { color:var(--color-success); font-size:9px; }
.budget-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.time-budget { display:grid; grid-template-columns:minmax(0,1fr) 84px; align-items:end; gap:8px; }
button { border-radius:8px; cursor:pointer; font-size:11px; font-weight:650; }
.primary { min-height:36px; border:1px solid var(--color-accent); background:var(--color-accent); color:var(--color-on-accent); }
.primary.small { min-height:32px; padding:0 11px; }
.secondary { min-height:32px; display:inline-flex; align-items:center; justify-content:center; gap:5px; padding:0 10px; border:1px solid var(--color-line); background:var(--color-surface-sunken); color:var(--color-text-muted); }
.secondary:hover { border-color:var(--color-accent-bd); color:var(--color-accent); }
.danger { min-height:32px; padding:0 10px; border:1px solid transparent; background:var(--color-danger-soft); color:var(--color-danger); }
.objective,.criterion { margin-bottom:11px; }
.objective small,.criterion small { color:var(--color-text-faint); font-size:9px; font-weight:650; text-transform:uppercase; }
.objective p,.criterion p { margin-top:4px; color:var(--color-text); font-size:12px; line-height:1.55; overflow-wrap:anywhere; }
.criterion p { color:var(--color-text-muted); font-size:11px; }
.reason { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; padding:9px; border-radius:8px; background:var(--color-warning-soft); color:var(--color-warning); font-size:10px; }
.metrics { display:grid; gap:10px; padding:11px; border-radius:10px; background:var(--color-surface-sunken); }
.metric > div { display:flex; justify-content:space-between; gap:8px; font-size:10px; }
.metric span { color:var(--color-text-muted); }
.metric strong { color:var(--color-text); font-weight:600; text-align:right; }
.metric > i { display:block; height:4px; margin-top:5px; overflow:hidden; border-radius:4px; background:var(--color-line); }
.metric > i b { display:block; height:100%; border-radius:4px; background:var(--color-accent); }
.budget-warning { margin-top:9px; padding:7px 9px; border-radius:8px; color:var(--color-danger); background:var(--color-danger-soft); font-size:10px; }
.notes { margin-top:11px; color:var(--color-text-muted); font-size:10px; }
.notes summary { cursor:pointer; font-weight:650; }
.notes ol { display:grid; gap:8px; margin-top:9px; padding-left:0; list-style:none; }
.notes li { display:grid; grid-template-columns:68px minmax(0,1fr); gap:7px; line-height:1.45; }
.notes time { color:var(--color-text-faint); font-family:var(--font-mono); font-size:9px; }
.notes span { overflow-wrap:anywhere; }
.actions,.edit-actions { display:flex; flex-wrap:wrap; gap:7px; margin-top:13px; }
.actions .danger { margin-left:auto; }
.edit-actions { justify-content:flex-end; margin-top:1px; }
.form-error { margin-top:10px; color:var(--color-danger); font-size:10px; line-height:1.4; overflow-wrap:anywhere; }
.pending-copy { margin-top:10px; color:var(--color-info); font-size:10px; line-height:1.4; }
@media (max-height:850px) { .panel-section { padding:14px; } }
</style>
