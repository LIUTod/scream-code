<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionListItem, SessionStatus, TokenUsage } from '../types';
import Dialog from './ui/Dialog.vue';
import Button from './ui/Button.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(defineProps<{
  sessions: SessionListItem[];
  currentSessionId: string | null;
  status?: SessionStatus;
  busy?: boolean;
  collapsed?: boolean;
  mobileOpen?: boolean;
}>(), { status: undefined, busy: false, collapsed: false, mobileOpen: false });
const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'switch', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'export', id: string): void;
  (e: 'toggle'): void;
  (e: 'open-search'): void;
  (e: 'show-info', mode: 'status' | 'usage'): void;
  (e: 'help'): void;
}>();
const deleteConfirmId = ref<string | null>(null);
interface SessionGroup { label: string; items: SessionListItem[] }
const groups = computed<SessionGroup[]>(() => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const map = new Map<string, SessionListItem[]>();
  for (const session of props.sessions) {
    const date = new Date(session.createdAt);
    const label = session.createdAt >= today ? '今天' : session.createdAt >= yesterday ? '昨天' : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    map.set(label, [...(map.get(label) ?? []), session]);
  }
  return [...map].map(([label, items]) => ({ label, items }));
});
function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
const usagePercent = computed(() => {
  const value = props.status?.contextUsage;
  return value === undefined ? null : Math.round((value > 1 ? value / 100 : value) * 100);
});
function sumTokens(usage?: TokenUsage) { return usage ? usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation : 0; }
const totalTokens = computed(() => sumTokens(props.status?.usage?.total));
function compactNumber(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value); }
const contextDetail = computed(() => props.status?.contextTokens !== undefined && props.status.maxContextTokens !== undefined ? `${compactNumber(props.status.contextTokens)} / ${compactNumber(props.status.maxContextTokens)}` : '');
function confirmDelete() {
  if (!deleteConfirmId.value) return;
  emit('delete', deleteConfirmId.value);
  deleteConfirmId.value = null;
}
</script>

<template>
  <aside :class="['sidebar', { collapsed, 'mobile-open': mobileOpen }]">
    <div class="brand-head">
      <div class="brand-symbol"><img src="/icon.ico" alt="" /></div>
      <div class="brand-copy"><strong>Scream Code</strong><span>智能开发工作台</span></div>
      <button class="collapse-btn" :title="collapsed ? '展开侧栏' : '收起侧栏'" :aria-label="collapsed ? '展开侧栏' : '收起侧栏'" @click="emit('toggle')"><SvgIcon :name="collapsed ? 'panel-right' : 'panel-left'" :size="collapsed ? 18 : 16" /></button>
    </div>

    <div class="primary-actions">
      <button class="new-session" title="新建会话" @click="emit('create')"><SvgIcon name="plus" :size="21" /><span>新建会话</span></button>
      <button class="square-action" title="搜索会话" aria-label="搜索会话" @click="emit('open-search')"><SvgIcon name="search" /></button>
    </div>

    <div class="search-row">
      <button class="search-box" title="搜索会话 (⌘K)" @click="emit('open-search')"><SvgIcon name="search" :size="18" /><span>搜索会话</span><kbd>⌘K</kbd></button>
      <button class="filter-btn" title="筛选和搜索会话" aria-label="筛选和搜索会话" @click="emit('open-search')"><SvgIcon name="filter" :size="18" /></button>
    </div>

    <div class="list-heading"><span>最近会话</span><span>{{ sessions.length }}</span></div>
    <div class="session-list">
      <template v-for="group in groups" :key="group.label">
        <div class="group-label">{{ group.label }}</div>
        <article v-for="session in group.items" :key="session.sessionId" :class="['session-item', { active: session.sessionId === currentSessionId }]" :title="session.title || '新会话'" @click="emit('switch', session.sessionId)">
          <span class="session-icon"><SvgIcon name="message-circle" :size="18" /></span>
          <div class="session-info">
            <div class="session-title-row"><strong>{{ session.title || '新会话' }}</strong><time>{{ formatTime(session.createdAt) }}</time></div>
            <div class="session-meta"><span>{{ session.messageCount }} 条消息</span><span v-if="session.active" class="live"><i />活跃</span></div>
          </div>
          <div class="session-actions" @click.stop>
            <button title="导出 Markdown" aria-label="导出 Markdown" @click="emit('export', session.sessionId)"><SvgIcon name="download" :size="16" /></button>
            <button class="danger" title="删除会话" aria-label="删除会话" @click="deleteConfirmId = session.sessionId"><SvgIcon name="trash" :size="16" /></button>
          </div>
        </article>
      </template>
      <div v-if="sessions.length === 0" class="empty"><SvgIcon name="message-circle" :size="28" /><strong>暂无会话</strong><span>新建会话后将在这里显示</span></div>
      <button v-if="sessions.length" class="view-all" @click="emit('open-search')">查看全部会话 <SvgIcon name="chevron-right" :size="16" /></button>
    </div>

    <section class="agent-card">
      <div class="agent-card-head"><span class="agent-avatar"><SvgIcon name="bot" :size="20" /></span><div><strong>Scream Agent</strong><span><i :class="{ busy }" />{{ busy ? '正在运行' : '当前空闲' }}</span></div></div>
      <dl>
        <div v-if="status?.model"><dt>当前模型</dt><dd :title="status.model">{{ status.model }}</dd></div>
        <div v-if="usagePercent !== null"><dt>上下文</dt><dd :title="contextDetail || undefined">{{ usagePercent }}%</dd></div>
        <div><dt>Token 消耗</dt><dd>{{ totalTokens ? compactNumber(totalTokens) : '-' }}</dd></div>
      </dl>
      <div v-if="usagePercent !== null" class="usage-track"><i :style="{ width: `${usagePercent}%` }" /></div>
      <button @click="emit('show-info', 'status')"><SvgIcon name="activity" :size="17" />查看详细状态</button>
    </section>

    <nav class="sidebar-footer" aria-label="辅助导航">
      <button @click="emit('show-info', 'usage')"><SvgIcon name="activity" :size="19" /><span>用量</span></button>
      <button @click="emit('help')"><SvgIcon name="help" :size="19" /><span>帮助</span></button>
    </nav>

    <Dialog :open="deleteConfirmId !== null" title="删除会话" @close="deleteConfirmId = null">
      <p class="dialog-copy">确定删除这个会话吗？此操作不可恢复。</p>
      <template #footer><Button variant="ghost" size="sm" @click="deleteConfirmId = null">取消</Button><Button variant="danger" size="sm" @click="confirmDelete">删除</Button></template>
    </Dialog>
  </aside>
</template>

<style scoped>
.sidebar { grid-area:sidebar; width:var(--sidebar-width); height:100%; min-height:0; display:flex; flex-direction:column; background:var(--color-surface); border-right:1px solid var(--color-line); overflow:hidden; transition:width var(--dur-slow) var(--ease-out); z-index:calc(var(--z-dock) + 1); }
.brand-head { height:var(--topbar-height); display:flex; align-items:center; gap:12px; padding:0 20px; border-bottom:1px solid var(--color-line); flex-shrink:0; }
.brand-symbol { width:38px; height:38px; display:grid; place-items:center; border-radius:11px; background:var(--color-accent-soft); }
.brand-symbol img { width:26px; height:26px; object-fit:contain; }
.brand-copy { flex:1; display:flex; min-width:0; flex-direction:column; }
.brand-copy strong { font-size:16px; }
.brand-copy span { margin-top:3px; color:var(--color-text-muted); font-size:11px; }
.collapse-btn,.square-action,.filter-btn,.session-actions button { display:grid; place-items:center; border:1px solid var(--color-line); background:var(--color-surface); color:var(--color-text-muted); cursor:pointer; }
.collapse-btn { width:34px; height:34px; border-radius:9px; }
.sidebar.collapsed .collapse-btn { width:36px; height:36px; border-radius:10px; color:var(--color-text-muted); }
.sidebar.collapsed .collapse-btn:hover { color:var(--color-accent); background:var(--color-accent-soft); }
.primary-actions { display:flex; gap:9px; padding:20px 18px 12px; }
.new-session { flex:1; height:48px; display:flex; align-items:center; justify-content:center; gap:9px; border:0; border-radius:11px; background:var(--color-accent); color:var(--color-on-accent); font-weight:650; cursor:pointer; box-shadow:0 5px 14px var(--color-accent-glow); }
.new-session:hover { background:var(--color-accent-hover); }
.square-action { width:48px; border-radius:11px; }
.search-row { display:flex; gap:8px; padding:0 18px 17px; border-bottom:1px solid var(--color-line); }
.search-box { flex:1; min-width:0; height:42px; display:flex; align-items:center; gap:9px; padding:0 11px; border:1px solid var(--color-line); border-radius:10px; background:var(--color-surface-sunken); color:var(--color-text-muted); cursor:pointer; text-align:left; }
.search-box span { flex:1; }
kbd { padding:2px 6px; border:1px solid var(--color-line); border-radius:5px; background:var(--color-surface); color:var(--color-text-faint); font:10px var(--font-mono); }
.filter-btn { width:42px; border-radius:10px; }
.list-heading { display:flex; justify-content:space-between; padding:17px 20px 8px; color:var(--color-text-muted); font-size:12px; font-weight:650; }
.session-list { flex:1; min-height:100px; overflow:auto; padding:0 12px 14px; }
.group-label { padding:10px 8px 6px; color:var(--color-text-faint); font-size:11px; font-weight:600; }
.session-item { position:relative; display:flex; align-items:center; gap:10px; min-height:66px; margin:3px 0; padding:10px 11px; border:1px solid transparent; border-radius:11px; cursor:pointer; }
.session-item:hover { background:var(--color-hover); }
.session-item.active { border-color:var(--color-accent-bd); background:var(--color-accent-soft); box-shadow:0 2px 8px rgba(11,143,63,.06); }
.session-icon { width:32px; height:32px; display:grid; place-items:center; flex-shrink:0; border-radius:9px; color:var(--color-text-muted); background:var(--color-surface-sunken); }
.session-item.active .session-icon { color:var(--color-accent); background:var(--color-surface); }
.session-info { flex:1; min-width:0; }
.session-title-row { display:flex; align-items:center; gap:8px; }
.session-title-row strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
time { color:var(--color-text-faint); font-size:10px; white-space:nowrap; }
.session-meta { display:flex; align-items:center; justify-content:space-between; margin-top:6px; color:var(--color-text-faint); font-size:11px; }
.live { display:flex; align-items:center; gap:4px; color:var(--color-accent); }
.live i { width:5px; height:5px; border-radius:50%; background:var(--color-accent); }
.session-actions { position:absolute; right:8px; top:7px; display:flex; gap:3px; opacity:0; padding:2px; border-radius:7px; background:var(--color-surface); box-shadow:var(--shadow-sm); }
.session-item:hover .session-actions { opacity:1; }
.session-actions button { width:25px; height:25px; border:0; border-radius:6px; }
.session-actions button:hover { color:var(--color-accent); background:var(--color-accent-soft); }
.session-actions button.danger:hover { color:var(--color-danger); background:var(--color-danger-soft); }
.view-all { width:100%; height:37px; display:flex; align-items:center; justify-content:center; gap:4px; border:0; background:transparent; color:var(--color-accent); font-size:12px; font-weight:600; cursor:pointer; }
.empty { display:flex; flex-direction:column; align-items:center; gap:7px; padding:36px 12px; color:var(--color-text-faint); }
.empty strong { color:var(--color-text-muted); font-size:13px; }
.empty span { font-size:11px; }
.agent-card { margin:0 18px 14px; padding:14px; border:1px solid var(--color-line); border-radius:13px; background:var(--color-surface-sunken); flex-shrink:0; }
.agent-card-head { display:flex; align-items:center; gap:10px; }
.agent-avatar { width:34px; height:34px; display:grid; place-items:center; border-radius:9px; color:var(--color-accent); background:var(--color-accent-soft); }
.agent-card-head > div { display:flex; flex-direction:column; min-width:0; }
.agent-card-head strong { font-size:13px; }
.agent-card-head span { display:flex; align-items:center; gap:5px; margin-top:3px; color:var(--color-text-muted); font-size:11px; }
.agent-card-head i { width:6px; height:6px; border-radius:50%; background:var(--color-success); }
.agent-card-head i.busy { background:var(--color-accent); animation:pulse 1.2s infinite; }
dl { display:grid; gap:7px; margin:13px 0 9px; }
dl div { display:flex; justify-content:space-between; gap:10px; font-size:11px; }
dt { color:var(--color-text-muted); } dd { max-width:165px; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--color-text); font-weight:550; }
.usage-track { height:4px; overflow:hidden; border-radius:4px; background:var(--color-line); }
.usage-track i { display:block; height:100%; border-radius:4px; background:var(--color-accent); }
.agent-card > button { width:100%; height:34px; display:flex; align-items:center; justify-content:center; gap:7px; margin-top:10px; border:1px solid var(--color-line); border-radius:8px; background:var(--color-surface); color:var(--color-text-muted); font-size:11px; cursor:pointer; }
.agent-card > button:hover { color:var(--color-accent); border-color:var(--color-accent-bd); }
.sidebar-footer { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:12px 18px 16px; border-top:1px solid var(--color-line); flex-shrink:0; }
.sidebar-footer button { height:38px; display:flex; align-items:center; justify-content:center; gap:7px; border:0; border-radius:9px; background:transparent; color:var(--color-text-muted); cursor:pointer; }
.sidebar-footer button:hover { color:var(--color-accent); background:var(--color-accent-soft); }
.dialog-copy { margin:0; color:var(--color-text-muted); font-size:13px; }
@keyframes pulse { 50% { opacity:.3; } }
@media (min-width:641px) { .sidebar.collapsed { width:var(--sidebar-width-collapsed); } .sidebar.collapsed .brand-head { justify-content:center; padding:18px 10px 0; height:auto; border-bottom:none; } .sidebar.collapsed .brand-copy,.sidebar.collapsed .brand-symbol,.sidebar.collapsed .new-session span,.sidebar.collapsed .square-action,.sidebar.collapsed .search-row,.sidebar.collapsed .list-heading,.sidebar.collapsed .group-label,.sidebar.collapsed .session-info,.sidebar.collapsed .session-actions,.sidebar.collapsed .view-all,.sidebar.collapsed .agent-card,.sidebar.collapsed .sidebar-footer span { display:none; } .sidebar.collapsed .primary-actions { padding:16px 10px; } .sidebar.collapsed .new-session { width:44px; flex:none; } .sidebar.collapsed .session-list { padding:0 9px; } .sidebar.collapsed .session-item { justify-content:center; min-height:48px; padding:7px; } .sidebar.collapsed .sidebar-footer { grid-template-columns:1fr; padding:10px; } }
@media (max-height:820px) { .agent-card dl div:nth-child(3),.agent-card .usage-track { display:none; } .agent-card { padding:11px 13px; } }
@media (max-width:640px) { .sidebar { position:fixed; inset:0 auto 0 0; width:min(340px,88vw); transform:translateX(-100%); transition:transform var(--dur-slow) var(--ease-out); box-shadow:none; } .sidebar.mobile-open { transform:translateX(0); box-shadow:var(--shadow-xl); } .collapse-btn { display:none; } }
</style>
