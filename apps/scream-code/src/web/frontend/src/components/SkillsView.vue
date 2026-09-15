<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Ref } from 'vue';
import SvgIcon from './ui/SvgIcon.vue';
import Button from './ui/Button.vue';
import type { SkillSummary } from '../types';
import { useActiveWebClient } from '../composables/webClient/activeClient';
import { useToast } from '../composables/useToast';

/**
 * 技能中心（L3 重做）。
 *
 * 此前这里渲染的是 SLASH_COMMANDS 硬编码清单——「技能中心」名不副实，且与
 * 斜杠菜单形成第二份能力目录。现在数据源换成 client.skills（真实技能，
 * SkillSummary），斜杠命令速查回归 /help 单一入口。
 *
 * WebShell 名下不传 client prop，故经 activeClient 注册表取宿主 client；
 * 保留可选 props.client 供未来注入 / 测试直连。
 */
const props = withDefaults(
  defineProps<{
    client?: any;
    /**
     * 草稿注入口（L2 接线）：由宿主（WebShell）提供，内部落到 Composer 暴露的
     * insertDraft。返回 true 表示文本已经进输入框（或已排到即将挂载的输入框）。
     * 缺省 / 返回 false 时「试用」退回剪贴板兜底。
     */
    injectDraft?: (text: string) => boolean | Promise<boolean>;
  }>(),
  { client: undefined, injectDraft: undefined },
);

const emit = defineEmits<{ (e: 'create'): void }>();

const { showToast } = useToast();
const { activeClient } = useActiveWebClient();
const client = computed(() => props.client ?? activeClient.value);

/** Unwrap a composable-returned Ref when present; pass plain values through. */
function val<T>(r: unknown): T | undefined {
  if (r !== null && typeof r === 'object' && (r as Record<string, unknown>).__v_isRef === true) {
    return (r as unknown as Ref<T>).value;
  }
  return r as T | undefined;
}

const skills = computed<SkillSummary[]>(() => val<SkillSummary[]>(client.value?.skills) ?? []);
const skillsError = computed<string>(() => val<string>(client.value?.skillsError) ?? '');
const hasSession = computed<boolean>(() => !!val<string>(client.value?.currentSessionId ?? client.value?.sessionId));

const loading = ref(false);
async function load() {
  const c = client.value;
  if (!c?.fetchSkills) return;
  loading.value = true;
  try {
    await c.fetchSkills();
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const SOURCE_LABEL: Record<string, string> = {
  builtin: '内置',
  user: '用户',
  extra: '扩展',
  project: '项目',
};
function sourceLabel(s: SkillSummary): string {
  if (s.pluginId) return `插件 ${s.pluginId}`;
  return SOURCE_LABEL[s.source] || s.source || '本地';
}

/** 兜底通道才用剪贴板；主路径（宿主 insertDraft）成功时不碰剪贴板。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 「试用」的通道分层（L2 收口）：
 * 1. 主路径 — 宿主的 injectDraft（内部走 Composer.insertDraft）把 `/技能名 ` 送进
 *    输入框；输入框尚未挂载时宿主会先导航/建会话再投递，因此「已有会话」和
 *    「新建会话」两种场景都覆盖。投递成功由宿主负责提示。
 * 2. 兜底 — 宿主没接线（旧挂载点 / 测试环境）或投递失败：复制剪贴板 + 既有
 *    @create 导航 + toast 指引。旧实现里那段猜 Composer 私有 draft key 的预写
 *    逻辑已经删掉。
 */
async function onTry(skill: SkillSummary) {
  const snippet = `/${skill.name} `;
  let injected = false;
  try {
    injected = !!(await props.injectDraft?.(snippet));
  } catch {
    injected = false;
  }
  if (injected) return;
  const copied = await copyText(snippet);
  emit('create');
  showToast(
    copied
      ? `已复制 ${snippet.trim()}，在输入框粘贴后回车即可使用`
      : `在输入框输入 ${snippet.trim()} 并回车即可使用该技能`,
    'info',
  );
}
</script>

<template>
  <div class="skills">
    <div class="skills-head">
      <div>
        <h1 class="skills-title">技能中心</h1>
        <p class="skills-sub">
          当前会话的可用技能；在输入框输入 <code>/</code> 可从菜单调用，命令帮助见 <code>/help</code>
        </p>
      </div>
      <div class="skills-head-actions">
        <Button variant="ghost" :disabled="loading || !hasSession" @click="load">
          <SvgIcon name="refresh" :size="16" />
          重新加载
        </Button>
        <Button variant="primary" @click="emit('create')">
          <SvgIcon name="plus" :size="16" />
          新建会话
        </Button>
      </div>
    </div>

    <!-- Load failure: show the error explicitly with a retry row; never mix it
         into the "no skills" empty state. -->
    <p v-if="skillsError" class="skills-error" role="alert">
      {{ skillsError }}
      <button class="skills-retry" @click="load">重试</button>
    </p>

    <!-- Loading skeleton -->
    <div v-if="loading && skills.length === 0" class="skills-grid" aria-hidden="true">
      <div v-for="i in 6" :key="i" class="skill-card skeleton">
        <span class="skeleton-line skeleton-line-title" />
        <span class="skeleton-line" />
        <span class="skeleton-line skeleton-line-short" />
      </div>
    </div>

    <!-- Empty state -->
    <div v-else-if="skills.length === 0 && !skillsError" class="skills-empty">
      <SvgIcon name="sparkles" :size="28" />
      <p class="skills-empty-title">{{ hasSession ? '这个会话还没有可用技能' : '打开会话后可查看技能' }}</p>
      <p class="skills-empty-hint">
        技能可以放在技能目录（用户 / 额外目录），或随插件安装进来；装好后点「重新加载」。
      </p>
      <Button variant="primary" @click="emit('create')">
        <SvgIcon name="plus" :size="16" />
        新建会话
      </Button>
    </div>

    <div v-else class="skills-grid">
      <article v-for="s in skills" :key="s.name" class="skill-card">
        <div class="skill-card-head">
          <span class="skill-cmd">/{{ s.name }}</span>
          <span class="skill-source">{{ sourceLabel(s) }}</span>
        </div>
        <p class="skill-desc">{{ s.description || '暂无描述' }}</p>
        <div class="skill-card-foot">
          <Button variant="secondary" @click="onTry(s)">
            <SvgIcon name="send" :size="14" />
            试用
          </Button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.skills {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-8);
  background: transparent;
}
.skills-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  max-width: var(--content-max);
  margin: 0 auto var(--space-6);
  flex-wrap: wrap;
}
.skills-head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
.skills-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--color-text);
}
.skills-sub {
  margin-top: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
.skills-sub code {
  padding: 1px var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  font-family: var(--font-mono);
  font-size: 12px;
}
.skills-error {
  max-width: var(--content-max);
  margin: 0 auto var(--space-4);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft, rgba(220, 60, 60, 0.12));
  color: var(--color-danger);
  font-size: var(--font-size-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.skills-retry {
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-danger);
  font-size: var(--font-size-xs);
  padding: 2px var(--space-3);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.skills-retry:hover {
  background: var(--color-hover);
}
.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-3);
  max-width: var(--content-max);
  margin: 0 auto;
}
.skill-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.skill-card:hover {
  border-color: var(--color-line-strong);
  box-shadow: var(--shadow-sm);
}
.skill-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.skill-cmd {
  font-family: var(--font-mono);
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-source {
  font-size: 10px;
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  border: 1px solid var(--color-line);
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
  flex-shrink: 0;
}
.skill-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: 1.5;
  min-height: calc(var(--font-size-sm) * 1.5);
}
.skill-card-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: auto;
}

/* 骨架：低对比脉冲条；reduced-motion 下静止呈现。 */
.skill-card.skeleton {
  pointer-events: none;
  gap: var(--space-3);
}
.skeleton-line {
  display: block;
  height: 12px;
  border-radius: var(--radius-xs);
  background: var(--color-surface-sunken);
  animation: skills-pulse var(--dur-slower, 1.2s) ease-in-out infinite alternate;
}
.skeleton-line-title {
  width: 45%;
  height: 16px;
}
.skeleton-line-short {
  width: 65%;
}
@keyframes skills-pulse {
  from {
    opacity: 0.5;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton-line {
    animation: none;
  }
}

.skills-empty {
  max-width: var(--content-max);
  margin: calc(var(--space-8) * 2) auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text-faint);
  text-align: center;
}
.skills-empty-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text-muted);
  margin: 0;
}
.skills-empty-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-faint);
  margin: 0 0 var(--space-2);
  max-width: 420px;
  line-height: 1.6;
}
@media (max-width: 640px) {
  .skills {
    padding: var(--space-4) var(--space-3);
  }
}
</style>
