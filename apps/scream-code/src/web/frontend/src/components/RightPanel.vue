<script setup lang="ts">
import { computed } from 'vue';
import type { GitStatus, SessionStatus, TokenUsage } from '../types';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{
  status: SessionStatus;
  busy?: boolean;
  sessionId?: string | null;
  workDir?: string | null;
  gitStatus?: GitStatus | null;
  messageCount?: number;
}>(), { busy: false, sessionId: null, workDir: null, gitStatus: null, messageCount: 0 });
const emit = defineEmits<{
  (e: 'quick-command', name: string): void;
  (e: 'insert', text: string): void;
  (e: 'show-info', mode: 'status' | 'usage'): void;
}>();
interface QuickTool { icon: string; label: string; hint: string; command?: string; insert?: string }
const primaryTools: readonly QuickTool[] = [
  { icon: 'compact', label: '压缩上下文', hint: '/compact', command: 'compact' },
  { icon: 'brain', label: '切换模型', hint: '/model', command: 'model' },
  { icon: 'clipboard', label: '计划模式', hint: '/plan', command: 'plan' },
  { icon: 'fork', label: '会话分支', hint: '/fork', command: 'fork' },
];
const moreTools: readonly QuickTool[] = [
  { icon: 'message-circle', label: '快速侧问', hint: '/btw', insert: '/btw ' },
  { icon: 'tag', label: '重命名', hint: '/title', insert: '/title ' },
  { icon: 'broom', label: '清空', hint: '/clear', command: 'clear' },
  { icon: 'plus', label: '新会话', hint: '/new', command: 'new' },
];
function activate(tool: QuickTool) { if (tool.command) emit('quick-command', tool.command); else if (tool.insert) emit('insert', tool.insert); }
const permissionLabel = computed(() => props.status.permission === 'auto' ? '自动' : props.status.permission === 'yolo' ? 'YOLO' : props.status.permission === 'manual' ? '手动' : props.status.permission ?? '-');
const thinkingLabel = computed(() => ({ off:'关闭', low:'低', medium:'中', high:'高', xhigh:'超高', max:'最大' })[props.status.thinkingLevel ?? ''] ?? (props.status.thinkingLevel === 'none' ? '-' : props.status.thinkingLevel ?? '-'));
const usagePercent = computed(() => { const value = props.status.contextUsage; return value === undefined ? null : Math.round((value > 1 ? value / 100 : value) * 100); });
function sumTokens(usage?: TokenUsage) { return usage ? usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation : 0; }
const totalTokens = computed(() => sumTokens(props.status.usage?.total));
const shortId = computed(() => props.sessionId ? props.sessionId.replace(/^session_/, '').slice(0, 8) : '-');
const dirName = computed(() => props.workDir?.split('/').filter(Boolean).at(-1) ?? '-');
const capabilities = [
  { icon:'folder', title:'项目文件', text:'读取、检索与编辑工作区文件' },
  { icon:'terminal', title:'命令执行', text:'运行构建、测试与开发命令' },
  { icon:'git-branch', title:'Git 感知', text:'读取分支与工作区变更状态' },
  { icon:'message-circle', title:'会话管理', text:'新建、分支、导出与恢复会话' },
] as const;
</script>

<template>
  <aside class="rightbar">
    <section class="panel-section quick-section">
      <div class="section-heading"><div><span>快捷工具</span><small>真实命令入口</small></div><SvgIcon name="command" :size="19" /></div>
      <div class="tool-grid">
        <button v-for="tool in primaryTools" :key="tool.label" class="tool-card" :title="`${tool.label} ${tool.hint}`" @click="activate(tool)">
          <span><SvgIcon :name="tool.icon" :size="22" /></span><strong>{{ tool.label }}</strong><small>{{ tool.hint }}</small>
        </button>
      </div>
      <div class="more-tools">
        <button v-for="tool in moreTools" :key="tool.label" :title="`${tool.label} ${tool.hint}`" @click="activate(tool)"><SvgIcon :name="tool.icon" :size="17" /><span>{{ tool.label }}</span></button>
      </div>
    </section>

    <section class="panel-section">
      <div class="section-heading"><div><span>核心能力</span><small>当前 Web Agent 已支持</small></div><SvgIcon name="sparkles" :size="19" /></div>
      <div class="capability-list">
        <div v-for="item in capabilities" :key="item.title" class="capability"><span><SvgIcon :name="item.icon" :size="19" /></span><div><strong>{{ item.title }}</strong><small>{{ item.text }}</small></div></div>
      </div>
    </section>

    <section class="panel-section status-section">
      <div class="section-heading"><div><span>Agent 状态</span><small>来自当前会话</small></div><span :class="['state-pill', { busy }]"><i />{{ busy ? '运行中' : '空闲' }}</span></div>
      <dl>
        <div><dt>模型</dt><dd :title="status.model">{{ status.model ?? '-' }}</dd></div>
        <div><dt>思考级别</dt><dd>{{ thinkingLabel }}</dd></div>
        <div><dt>权限模式</dt><dd>{{ permissionLabel }}</dd></div>
        <div><dt>计划模式</dt><dd>{{ status.planMode ? '开启' : '关闭' }}</dd></div>
        <div v-if="status.wolfpackMode"><dt>WolfPack</dt><dd>开启</dd></div>
      </dl>
      <div v-if="usagePercent !== null" class="usage"><div><span>上下文窗口</span><strong>{{ usagePercent }}%</strong></div><div class="track"><i :style="{ width: `${usagePercent}%` }" /></div></div>
    </section>

    <section class="panel-section session-section">
      <div class="section-heading"><div><span>当前会话</span><small>实时快照信息</small></div><SvgIcon name="activity" :size="19" /></div>
      <dl>
        <div><dt>会话 ID</dt><dd class="mono">{{ shortId }}</dd></div>
        <div><dt>消息数</dt><dd>{{ messageCount }}</dd></div>
        <div><dt>Token 消耗</dt><dd>{{ totalTokens ? totalTokens.toLocaleString() : '-' }}</dd></div>
        <div><dt>工作目录</dt><dd class="mono" :title="workDir ?? undefined">{{ dirName }}</dd></div>
        <div v-if="gitStatus"><dt>Git 分支</dt><dd class="mono" :title="gitStatus.branch">{{ gitStatus.branch ?? 'detached' }}</dd></div>
      </dl>
      <button class="detail" @click="emit('show-info', 'status')">查看详细状态 <SvgIcon name="chevron-right" :size="16" /></button>
    </section>
  </aside>
</template>

<style scoped>
.rightbar { width:var(--rightbar-width); height:100%; overflow-y:auto; display:flex; flex-direction:column; gap:14px; padding:14px 14px 20px; background:var(--color-bg); border-left:1px solid var(--color-line); }
.panel-section { padding:17px; border:1px solid var(--color-line); border-radius:14px; background:var(--color-surface); box-shadow:0 2px 8px rgba(20,35,24,.03); }
.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:14px; color:var(--color-accent); }
.section-heading > div { display:flex; flex-direction:column; }
.section-heading span { color:var(--color-text); font-size:14px; font-weight:700; }
.section-heading small { margin-top:4px; color:var(--color-text-faint); font-size:10px; font-weight:400; }
.tool-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
.tool-card { min-height:92px; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:6px; padding:13px; border:1px solid var(--color-line); border-radius:11px; background:var(--color-surface-sunken); color:var(--color-text); cursor:pointer; text-align:left; }
.tool-card > span { width:34px; height:34px; display:grid; place-items:center; border-radius:9px; color:var(--color-accent); background:var(--color-accent-soft); }
.tool-card strong { font-size:12px; }
.tool-card small { color:var(--color-text-faint); font:10px var(--font-mono); }
.tool-card:hover { border-color:var(--color-accent-bd); background:var(--color-accent-soft); transform:translateY(-1px); }
.more-tools { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; margin-top:9px; }
.more-tools button { height:34px; display:flex; align-items:center; gap:7px; padding:0 9px; border:0; border-radius:8px; background:transparent; color:var(--color-text-muted); font-size:11px; cursor:pointer; }
.more-tools button:hover { color:var(--color-accent); background:var(--color-accent-soft); }
.capability-list { display:grid; gap:12px; }
.capability { display:flex; align-items:center; gap:10px; }
.capability > span { width:34px; height:34px; display:grid; place-items:center; flex-shrink:0; border-radius:9px; color:var(--color-accent); background:var(--color-accent-soft); }
.capability > div { min-width:0; display:flex; flex-direction:column; }
.capability strong { font-size:12px; }
.capability small { margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--color-text-muted); font-size:10px; }
dl { display:grid; gap:9px; margin:0; }
dl div { display:flex; justify-content:space-between; gap:12px; font-size:11px; }
dt { flex-shrink:0; color:var(--color-text-muted); } dd { min-width:0; max-width:190px; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--color-text); font-weight:550; }
.mono { font-family:var(--font-mono); }
.state-pill { display:flex; align-items:center; gap:5px; height:25px; padding:0 8px; border-radius:12px; color:var(--color-success)!important; background:var(--color-success-soft); font-size:10px!important; }
.state-pill i { width:6px; height:6px; border-radius:50%; background:currentColor; }
.state-pill.busy i { animation:pulse 1.2s infinite; }
.usage { margin-top:12px; }
.usage > div:first-child { display:flex; justify-content:space-between; color:var(--color-text-muted); font-size:11px; }
.usage strong { color:var(--color-text); }
.track { height:5px; margin-top:7px; overflow:hidden; border-radius:5px; background:var(--color-line); }
.track i { display:block; height:100%; background:var(--color-accent); }
.detail { width:100%; height:36px; display:flex; align-items:center; justify-content:center; gap:4px; margin-top:13px; border:1px solid var(--color-line); border-radius:9px; background:var(--color-surface-sunken); color:var(--color-text-muted); font-size:11px; cursor:pointer; }
.detail:hover { color:var(--color-accent); border-color:var(--color-accent-bd); }
@keyframes pulse { 50% { opacity:.3; } }
@media (max-height:850px) { .capability-list { grid-template-columns:1fr 1fr; gap:9px; } .capability small { display:none; } .panel-section { padding:14px; } }
</style>
