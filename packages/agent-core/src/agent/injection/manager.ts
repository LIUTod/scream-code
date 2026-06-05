import type { Agent } from '..';
import type { DynamicInjector } from './injector';
import { MemoryRecallInjector } from './memory-recall';
import { PermissionModeInjector } from './permission-mode';
import { PluginSessionStartInjector } from './plugin-session-start';
import { PlanModeInjector } from './plan-mode';
import { TodoListReminderInjector } from './todo-list';

export class InjectionManager {
  private readonly injectors: DynamicInjector[];
  private readonly memoryRecall: MemoryRecallInjector | null;

  constructor(protected readonly agent: Agent) {
    // Feature-gated: only enable memory recall when the store is available.
    // Auto-recall can be disabled by setting memStore to undefined on the agent.
    const autoRecallEnabled = agent.memoStore !== undefined;

    this.memoryRecall = autoRecallEnabled ? new MemoryRecallInjector(agent) : null;

    this.injectors = [
      new PluginSessionStartInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
      new TodoListReminderInjector(agent),
      ...(this.memoryRecall ? [this.memoryRecall] : []),
    ];
  }

  async inject(): Promise<void> {
    for (const injector of this.injectors) {
      await injector.inject();
    }
  }

  /** Reset per-turn state on all injectors (e.g. memory recall flag). */
  resetForTurn(): void {
    this.memoryRecall?.resetForTurn();
  }

  onContextClear(): void {
    for (const injector of this.injectors) {
      injector.onContextClear();
    }
  }

  onContextCompacted(compactedCount: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextCompacted(compactedCount);
      } catch {
        continue;
      }
    }
  }

  onContextMessageRemoved(index: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextMessageRemoved(index);
      } catch {
        continue;
      }
    }
  }
}
