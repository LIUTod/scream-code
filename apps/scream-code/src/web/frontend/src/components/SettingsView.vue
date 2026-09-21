<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Ref } from 'vue';
import SvgIcon from './ui/SvgIcon.vue';
import type { IconName } from './ui/SvgIcon.vue';
import Button from './ui/Button.vue';
import type {
  BackgroundTaskInfo,
  LikePreferences,
  McpServerInfo,
  ModelInfo,
  PluginSummary,
  SkillSummary,
} from '../types';

/**
 * Settings center (G4).
 *
 * Split layout: a left rail of sections (General / Models / Skills / Plugins /
 * MCP / Background tasks) and a right content pane. All data is real — the
 * sections render from the provided `client` harness refs and call its action
 * methods. The General pane keeps the pre-existing theme + like-preference
 * editors.
 */
const props = withDefaults(
  defineProps<{
    like?: LikePreferences;
    client: any;
  }>(),
  { like: () => ({}) },
);

const emit = defineEmits<{
  (e: 'update-like', prefs: LikePreferences): void;
}>();

/** Unwrap a composable-returned Ref when present; pass plain values through. */
function val<T>(r: unknown): T | undefined {
  if (r !== null && typeof r === 'object' && (r as Record<string, unknown>).__v_isRef === true) {
    return (r as unknown as Ref<T>).value;
  }
  return r as T | undefined;
}

/* ── Section rail ───────────────────────────────────────────────────────── */
type SectionId = 'general' | 'models' | 'skills' | 'plugins' | 'mcp' | 'tasks';
const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'models', label: '模型', icon: 'bot' },
  { id: 'skills', label: '技能', icon: 'sparkles' },
  { id: 'plugins', label: '插件', icon: 'layers' },
  { id: 'mcp', label: 'MCP 服务器', icon: 'monitor' },
  { id: 'tasks', label: '后台任务', icon: 'activity' },
];
const activeSection = ref<SectionId>('general');

const client = computed(() => props.client);

/* ── Theme (light / dark / system) ──────────────────────────────────────── */
const theme = inject<Ref<string>>('theme', ref('system'));
const setTheme = inject<(t: string) => void>('setTheme', () => {});
const THEME_OPTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'monitor' },
];

/* ── Like preferences (nickname / tone / other / doNot) ─────────────────── */
const draft = ref<LikePreferences>({ ...props.like });
const saved = ref(false);
watch(
  () => props.like,
  (v) => {
    draft.value = { ...v };
  },
);
const FIELDS: { key: keyof LikePreferences; label: string; hint: string }[] = [
  { key: 'nickname', label: '称呼', hint: 'AI 如何称呼你' },
  { key: 'tone', label: '语气', hint: '回复的语气风格' },
  { key: 'other', label: '偏好', hint: '其他偏好说明' },
  { key: 'doNot', label: '禁止事项', hint: '明确禁止的行为' },
];
function save() {
  emit('update-like', cleanup());
  saved.value = true;
  setTimeout(() => (saved.value = false), 1500);
}
function cleanup(): LikePreferences {
  const out: LikePreferences = {};
  for (const f of FIELDS) {
    const v = draft.value[f.key];
    if (typeof v === 'string' && v.trim()) out[f.key] = v.trim();
  }
  return out;
}

/* ── Models ─────────────────────────────────────────────────────────────── */
const models = computed(() => val<ModelInfo[]>(client.value?.models) ?? []);
const currentModel = computed(() => val<any>(client.value?.status)?.model ?? '');
/** Model list load failure reason; the pane renders a retry row from it (L3: no silent failures). */
const modelsError = computed<string>(() => val<string>(client.value?.modelsError) ?? '');
/**
 * With no active session a model switch has no target: keep the list readable,
 * disable the action and state the reason.
 */
const hasSession = computed<boolean>(() => !!val<string>(client.value?.currentSessionId));
function retryModels() {
  void client.value?.fetchModels?.();
}
function onSwitchModel(alias: string) {
  void client.value?.switchModel?.(alias);
}

/* ── Skills ─────────────────────────────────────────────────────────────── */
const skills = computed(() => val<SkillSummary[]>(client.value?.skills) ?? []);
const skillBusy = ref(false);
async function onActivateSkill(name: string) {
  skillBusy.value = true;
  try {
    const ok = await client.value?.activateSkill?.(name);
    if (ok) await client.value?.fetchSkills?.();
  } finally {
    skillBusy.value = false;
  }
}
async function onRemoveSkill(name: string) {
  if (!window.confirm(`移除技能「${name}」？`)) return;
  const ok = await client.value?.removeSkill?.(name);
  if (ok) await client.value?.fetchSkills?.();
}

/* ── Plugins ────────────────────────────────────────────────────────────── */
const plugins = computed(() => val<PluginSummary[]>(client.value?.plugins) ?? []);
const pluginBusy = ref(false);
async function onTogglePlugin(id: string, enabled: boolean) {
  pluginBusy.value = true;
  try {
    const ok = await client.value?.setPluginEnabled?.(id, enabled);
    if (ok) await client.value?.fetchPlugins?.();
  } finally {
    pluginBusy.value = false;
  }
}
const installSource = ref('');
const installBusy = ref(false);
const installMsg = ref('');
async function onInstallPlugin() {
  const src = installSource.value.trim();
  if (!src) return;
  installBusy.value = true;
  installMsg.value = '';
  try {
    const p = await client.value?.installPlugin?.(src);
    installMsg.value = p ? `已安装 ${p.displayName}` : '安装失败';
    if (p) installSource.value = '';
  } finally {
    installBusy.value = false;
  }
}

/* ── MCP ────────────────────────────────────────────────────────────────── */
const mcpServers = computed(() => val<McpServerInfo[]>(client.value?.mcpServers) ?? []);
const mcpBusy = ref(false);
const mcpMsg = ref('');
async function onMcpAction(fn: string, name: string) {
  mcpBusy.value = true;
  mcpMsg.value = '';
  try {
    const ok = await client.value?.[fn]?.(name);
    mcpMsg.value = ok ? '操作成功' : '操作失败';
    await client.value?.fetchMcpServers?.();
  } finally {
    mcpBusy.value = false;
  }
}

/* ── Background tasks ───────────────────────────────────────────────────── */
const tasks = computed(() => val<BackgroundTaskInfo[]>(client.value?.backgroundTasks) ?? []);
const taskOutput = ref('');
const taskBusy = ref(false);
const taskMsg = ref('');
const selectedTaskId = ref<string | null>(null);
const taskOutputLoading = ref(false);
let taskOutputRequest = 0;
let taskPollTimer: number | null = null;
const selectedTask = computed(() =>
  selectedTaskId.value ? tasks.value.find((task) => task.taskId === selectedTaskId.value) ?? null : null,
);
const hasActiveTasks = computed(() =>
  tasks.value.some((task) => task.status === 'running' || task.status === 'awaiting_approval'),
);

async function refreshTasks(): Promise<void> {
  await client.value?.fetchBackgroundTasks?.();
}

function stopTaskPolling(): void {
  if (taskPollTimer === null) return;
  window.clearInterval(taskPollTimer);
  taskPollTimer = null;
}

function syncTaskPolling(): void {
  if (activeSection.value !== 'tasks' || !hasActiveTasks.value) {
    stopTaskPolling();
    return;
  }
  if (taskPollTimer !== null) return;
  taskPollTimer = window.setInterval(() => {
    void refreshTasks();
    if (selectedTask.value) void onShowOutput(selectedTask.value.taskId, false);
  }, 3000);
}

async function onStopTask(taskId: string) {
  const task = tasks.value.find((item) => item.taskId === taskId);
  if (!window.confirm(`停止后台任务「${task?.command ?? taskId}」？`)) return;
  taskBusy.value = true;
  taskMsg.value = '';
  try {
    const ok = await client.value?.stopBackgroundTask?.(taskId);
    taskMsg.value = ok ? '已停止' : '取消失败';
    await refreshTasks();
    if (selectedTaskId.value === taskId) await onShowOutput(taskId, false);
  } finally {
    taskBusy.value = false;
  }
}
async function onShowOutput(taskId: string, select = true) {
  if (select) {
    selectedTaskId.value = taskId;
    taskOutput.value = '';
  }
  const request = ++taskOutputRequest;
  taskOutputLoading.value = true;
  taskMsg.value = '';
  try {
    await client.value?.fetchBackgroundTaskOutput?.(taskId, 200);
    if (request === taskOutputRequest && selectedTaskId.value === taskId) {
      taskOutput.value = val<string>(client.value?.backgroundTaskOutput) ?? '';
    }
  } finally {
    if (request === taskOutputRequest) taskOutputLoading.value = false;
  }
}

/* ── Load real data on mount ────────────────────────────────────────────── */
onMounted(() => {
  const c = client.value;
  void c?.fetchModels?.();
  void c?.fetchConfig?.();
  void c?.fetchSkills?.();
  void c?.fetchPlugins?.();
  void c?.fetchMcpServers?.();
  void c?.fetchBackgroundTasks?.();
});

onBeforeUnmount(() => {
  stopTaskPolling();
});

watch([activeSection, hasActiveTasks], ([section]) => {
  if (section === 'tasks') void refreshTasks();
  syncTaskPolling();
}, { immediate: true });

function statusColor(status: string): string {
  if (status === 'connected' || status === 'completed') return 'ok';
  if (status === 'failed' || status === 'killed') return 'bad';
  if (status === 'running' || status === 'pending') return 'run';
  return 'muted';
}
</script>

<template>
  <div class="settings">
    <div class="settings-layout">
      <!-- Section rail -->
      <nav class="rail" aria-label="设置分区">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          class="rail-tab"
          :class="{ active: activeSection === s.id }"
          :aria-current="activeSection === s.id ? 'page' : undefined"
          @click="activeSection = s.id"
        >
          <SvgIcon :name="s.icon" :size="16" />
          <span>{{ s.label }}</span>
        </button>
      </nav>

      <!-- Content pane -->
      <div class="pane">
        <!-- General -->
        <section v-if="activeSection === 'general'" class="pane-section">
          <h1 class="settings-title">通用设置</h1>

          <div class="block">
            <h2 class="block-title">外观</h2>
            <div class="theme-grid" role="radiogroup" aria-label="主题">
              <button
                v-for="opt in THEME_OPTIONS"
                :key="opt.id"
                role="radio"
                :aria-checked="theme === opt.id"
                :class="['theme-option', { active: theme === opt.id }]"
                @click="setTheme(opt.id)"
              >
                <SvgIcon :name="opt.icon" :size="20" />
                <span>{{ opt.label }}</span>
              </button>
            </div>
          </div>

          <div class="block">
            <h2 class="block-title">偏好设置</h2>
            <div class="like-fields">
              <label v-for="f in FIELDS" :key="f.key" class="like-field">
                <span class="like-label">{{ f.label }}</span>
                <input
                  v-model="draft[f.key]"
                  class="like-input"
                  :placeholder="f.hint"
                  :aria-label="f.label"
                />
              </label>
              <div class="like-actions">
                <Button variant="primary" @click="save">保存偏好</Button>
                <span v-if="saved" class="saved-hint">已保存</span>
              </div>
            </div>
          </div>
        </section>

        <!-- Models -->
        <section v-else-if="activeSection === 'models'" class="pane-section">
          <h1 class="settings-title">模型</h1>
          <!-- No active session: switching has no target, so show a notice bar
               plus a disabled action instead of a dead button to guess at (L3). -->
          <p v-if="!hasSession" class="notice-bar">打开一个会话后可在此切换模型</p>
          <div v-if="modelsError" class="error-row" role="alert">
            <span class="error-text">{{ modelsError }}</span>
            <button class="row-action" @click="retryModels">重试</button>
          </div>
          <p v-else-if="models.length === 0" class="empty">没有可用的模型</p>
          <ul v-else class="list">
            <li
              v-for="m in models"
              :key="m.alias"
              class="list-row"
              :class="{ selected: m.alias === currentModel }"
            >
              <div class="row-main">
                <span class="row-title">{{ m.displayName || m.model }}</span>
                <span class="row-sub">{{ m.provider }} · {{ m.alias }} · {{ m.maxContextSize }}</span>
              </div>
              <button
                class="row-action"
                :disabled="!hasSession || m.alias === currentModel"
                @click="onSwitchModel(m.alias)"
              >
                {{ m.alias === currentModel ? '使用中' : '切换' }}
              </button>
            </li>
          </ul>
        </section>

        <!-- Skills -->
        <section v-else-if="activeSection === 'skills'" class="pane-section">
          <h1 class="settings-title">技能</h1>
          <p v-if="skills.length === 0" class="empty">当前会话没有可用技能</p>
          <ul v-else class="list">
            <li v-for="s in skills" :key="s.name" class="list-row">
              <div class="row-main">
                <span class="row-title">{{ s.name }}</span>
                <span class="row-sub">{{ s.description || '—' }} <template v-if="s.pluginId">· 来自插件 {{ s.pluginId }}</template></span>
              </div>
              <div class="row-actions">
                <button
                  class="row-action"
                  :disabled="skillBusy"
                  @click="onActivateSkill(s.name)"
                >
                  激活
                </button>
                <button class="row-action danger" :disabled="skillBusy" @click="onRemoveSkill(s.name)">
                  移除
                </button>
              </div>
            </li>
          </ul>
        </section>

        <!-- Plugins -->
        <section v-else-if="activeSection === 'plugins'" class="pane-section">
          <h1 class="settings-title">插件</h1>

          <div class="block">
            <h2 class="block-title">安装插件</h2>
            <div class="inline-form">
              <input
                v-model="installSource"
                class="like-input"
                placeholder="本地路径 / zip URL / GitHub 地址"
                aria-label="插件来源"
                spellcheck="false"
              />
              <Button variant="primary" :disabled="installBusy || !installSource.trim()" @click="onInstallPlugin">
                安装
              </Button>
            </div>
            <p v-if="installMsg" class="hint">{{ installMsg }}</p>
          </div>

          <p v-if="plugins.length === 0" class="empty">还没有安装插件</p>
          <ul v-else class="list">
            <li v-for="p in plugins" :key="p.id" class="list-row">
              <div class="row-main">
                <span class="row-title">{{ p.displayName }} <span v-if="p.version" class="version">v{{ p.version }}</span></span>
                <span class="row-sub">{{ p.skillCount }} 技能 · {{ p.enabledMcpServerCount }}/{{ p.mcpServerCount }} MCP</span>
              </div>
              <button
                class="row-action"
                :disabled="pluginBusy"
                @click="onTogglePlugin(p.id, !p.enabled)"
              >
                {{ p.enabled ? '停用' : '启用' }}
              </button>
            </li>
          </ul>
        </section>

        <!-- MCP -->
        <section v-else-if="activeSection === 'mcp'" class="pane-section">
          <h1 class="settings-title">MCP 服务器</h1>
          <p v-if="mcpMsg" class="hint">{{ mcpMsg }}</p>
          <p v-if="mcpServers.length === 0" class="empty">没有配置 MCP 服务器</p>
          <ul v-else class="list">
            <li v-for="m in mcpServers" :key="m.name" class="list-row">
              <div class="row-main">
                <span class="row-title">{{ m.name }}</span>
                <span class="row-sub">{{ m.transport }} · {{ m.toolCount }} 工具</span>
                <span class="status-pill" :class="statusColor(m.status)">{{ m.status }}</span>
              </div>
              <div class="row-actions">
                <button class="row-action" :disabled="mcpBusy" @click="onMcpAction('reconnectMcpServer', m.name)">重连</button>
                <button class="row-action" :disabled="mcpBusy" @click="onMcpAction('stopMcpServer', m.name)">停止</button>
                <button class="row-action danger" :disabled="mcpBusy" @click="onMcpAction('removeMcpServer', m.name)">移除</button>
              </div>
            </li>
          </ul>
        </section>

        <!-- Background tasks -->
        <section v-else-if="activeSection === 'tasks'" class="pane-section">
          <div class="task-title-row">
            <h1 class="settings-title">后台任务</h1>
            <button class="icon-refresh" title="刷新后台任务" aria-label="刷新后台任务" @click="refreshTasks">
              <SvgIcon name="refresh" :size="16" />
            </button>
          </div>
          <p v-if="taskMsg" class="hint">{{ taskMsg }}</p>
          <p v-if="tasks.length === 0" class="empty">没有后台任务</p>
          <ul v-else class="list">
            <li v-for="t in tasks" :key="t.taskId" class="list-row">
              <div class="row-main">
                <span class="row-title">{{ t.command }}</span>
                <span class="row-sub">{{ t.description }}</span>
                <span class="status-pill" :class="statusColor(t.status)">{{ t.status }}</span>
              </div>
              <div class="row-actions">
                <button class="row-action" :disabled="taskBusy" @click="onShowOutput(t.taskId)">输出</button>
                <button
                  v-if="t.status === 'running' || t.status === 'awaiting_approval'"
                  class="row-action danger"
                  :disabled="taskBusy"
                  @click="onStopTask(t.taskId)"
                >
                  停止
                </button>
              </div>
            </li>
          </ul>
          <section v-if="selectedTask" class="task-inspector" aria-label="任务输出">
            <header class="task-inspector-head">
              <div>
                <span class="task-inspector-label">输出</span>
                <strong :title="selectedTask.command">{{ selectedTask.command }}</strong>
              </div>
              <div class="task-inspector-actions">
                <button title="刷新输出" aria-label="刷新输出" :disabled="taskOutputLoading" @click="onShowOutput(selectedTask.taskId, false)">
                  <SvgIcon name="refresh" :size="14" />
                </button>
                <button title="关闭输出" aria-label="关闭输出" @click="selectedTaskId = null">
                  <SvgIcon name="x" :size="14" />
                </button>
              </div>
            </header>
            <pre v-if="taskOutput" class="task-output">{{ taskOutput }}</pre>
            <p v-else class="task-output-empty">{{ taskOutputLoading ? '正在读取输出…' : '暂时没有输出' }}</p>
            <footer class="task-meta">
              <span>PID {{ selectedTask.pid }}</span>
              <span v-if="selectedTask.exitCode !== null">退出码 {{ selectedTask.exitCode }}</span>
              <span v-else>{{ selectedTask.status }}</span>
            </footer>
          </section>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
}
.settings-layout {
  flex: 1;
  display: flex;
  min-height: 0;
  gap: 0;
}
.rail {
  width: 184px;
  flex-shrink: 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-4) var(--space-2);
  border-right: 1px solid var(--color-line);
}
.rail-tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
  text-align: left;
}
.rail-tab:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.rail-tab.active {
  background: var(--color-selected);
  color: var(--color-text);
  font-weight: 600;
}
.pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-5);
}
.pane-section {
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.task-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.icon-refresh,
.task-inspector-actions button {
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  background: transparent;
  cursor: pointer;
}
.icon-refresh {
  width: 30px;
  height: 30px;
}
.icon-refresh:hover,
.task-inspector-actions button:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-hover);
}
.settings-title {
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--color-text);
  margin: 0;
}
.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.block-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}
.theme-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
  font-size: var(--font-size-xs);
}
.theme-option:hover {
  border-color: var(--color-accent-bd);
  color: var(--color-text);
}
.theme-option.active {
  border-color: var(--color-accent-bd);
  color: var(--color-accent);
  background: var(--color-accent-soft);
}
.like-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.like-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.like-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.like-input {
  height: 32px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: inherit;
  outline: none;
  width: 100%;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.like-input:focus {
  border-color: var(--color-accent-bd);
  box-shadow: var(--glow-focus);
}
.like-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.saved-hint {
  color: var(--color-success);
  font-size: var(--font-size-xs);
}
.inline-form {
  display: flex;
  gap: var(--space-2);
}
.inline-form .like-input {
  flex: 1;
}
.hint {
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  margin: 0;
}
.empty {
  color: var(--color-text-faint);
  font-size: var(--font-size-sm);
  margin: 0;
}
/* Notice bar / error row: lightweight status strip at the top of a pane, reusing
   the hairline border language. */
.notice-bar {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.error-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft, rgba(220, 60, 60, 0.12));
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}
.error-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.list-row.selected {
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.row-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text);
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}
.version {
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--color-text-faint);
}
.row-sub {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}
.row-action {
  height: 26px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-selected);
  color: var(--color-text);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}
.row-action:hover {
  background: var(--color-hover);
}
.row-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.row-action.danger {
  background: var(--color-danger-soft, rgba(220, 60, 60, 0.12));
  color: var(--color-danger);
}
.status-pill {
  align-self: flex-start;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  line-height: 1.6;
}
.status-pill.ok {
  background: var(--color-success-soft, rgba(60, 200, 120, 0.16));
  color: var(--color-success);
}
.status-pill.bad {
  background: var(--color-danger-soft, rgba(220, 60, 60, 0.14));
  color: var(--color-danger);
}
.status-pill.run {
  background: var(--color-warning-soft, rgba(255, 170, 0, 0.16));
  color: var(--color-warning);
}
.status-pill.muted {
  background: var(--color-selected);
  color: var(--color-text-muted);
}
.task-inspector {
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}
.task-inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-line);
  background: var(--color-surface);
}
.task-inspector-head > div:first-child {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.task-inspector-label {
  color: var(--color-text-faint);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}
.task-inspector-head strong {
  overflow: hidden;
  color: var(--color-text);
  font: 550 var(--font-size-xs) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-inspector-actions { display: flex; flex-shrink: 0; gap: 2px; }
.task-inspector-actions button { width: 26px; height: 26px; }
.task-output {
  max-height: 320px;
  min-height: 132px;
  margin: 0;
  overflow: auto;
  padding: var(--space-3);
  color: var(--color-text);
  font: 12px/1.55 var(--font-mono);
  tab-size: 2;
  white-space: pre-wrap;
  word-break: break-word;
}
.task-output-empty {
  min-height: 132px;
  display: grid;
  margin: 0;
  padding: var(--space-3);
  place-items: center;
  color: var(--color-text-faint);
  font-size: var(--font-size-sm);
}
.task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-line);
  color: var(--color-text-faint);
  font: 500 var(--font-size-xs) var(--font-mono);
}
@media (max-width: 760px) {
  .settings-layout {
    flex-direction: column;
  }
  .rail {
    width: 100%;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: none;
    border-bottom: 1px solid var(--color-line);
    padding: var(--space-2);
  }
  .rail-tab {
    flex-shrink: 0;
  }
  .pane {
    padding: var(--space-3) var(--space-3);
  }
}
</style>
