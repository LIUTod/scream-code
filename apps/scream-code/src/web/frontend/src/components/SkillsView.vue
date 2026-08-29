<script setup lang="ts">
import { SLASH_COMMANDS } from '../commands';
import SvgIcon from './ui/SvgIcon.vue';
import Button from './ui/Button.vue';

const emit = defineEmits<{ (e: 'create'): void }>();

const TARGET_LABEL: Record<string, string> = {
  backend: '服务端',
  local: '本地',
};
</script>

<template>
  <div class="skills">
    <div class="skills-head">
      <div>
        <h1 class="skills-title">技能中心</h1>
        <p class="skills-sub">在输入框中输入 <code>/</code> 即可触发以下命令</p>
      </div>
      <Button variant="primary" @click="emit('create')">
        <SvgIcon name="plus" :size="16" />
        新建会话
      </Button>
    </div>

    <div class="skills-grid">
      <article v-for="cmd in SLASH_COMMANDS" :key="cmd.name" class="skill-card">
        <div class="skill-card-head">
          <span class="skill-cmd">/{{ cmd.name }}</span>
          <span class="skill-target" :class="`target-${cmd.target}`">{{ TARGET_LABEL[cmd.target] }}</span>
        </div>
        <p class="skill-desc">{{ cmd.description }}</p>
        <p v-if="cmd.aliases?.length" class="skill-aliases">
          别名：{{ cmd.aliases.map((a) => `/${a}`).join(' ') }}
        </p>
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
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.skill-card:hover {
  border-color: var(--color-line-strong);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
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
}
.skill-target {
  font-size: 10px;
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  border: 1px solid var(--color-line);
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
  flex-shrink: 0;
}
.skill-target.target-backend {
  color: var(--color-info);
  border-color: var(--color-info);
  background: var(--color-info-soft);
}
.skill-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: 1.5;
}
.skill-aliases {
  font-size: 11px;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
}
@media (max-width: 640px) {
  .skills {
    padding: var(--space-4) var(--space-3);
  }
}
</style>
