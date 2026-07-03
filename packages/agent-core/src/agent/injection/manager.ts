import type { Agent } from '..';
import type { DynamicInjector } from './injector';
import { GoalInjector } from './goal';
import { PermissionModeInjector } from './permission-mode';
import { PluginSessionStartInjector } from './plugin-session-start';
import { PlanModeInjector } from './plan-mode';
import { TodoListReminderInjector } from './todo-list';
import { UserPrefsInjector } from './user-prefs';
import { WolfPackModeInjector } from './wolfpack';
import { WorkingSetInjector } from './working-set';

export class InjectionManager {
  private readonly injectors: DynamicInjector[];

  constructor(protected readonly agent: Agent) {
    this.injectors = [
      new PluginSessionStartInjector(agent),
      new WolfPackModeInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
      new TodoListReminderInjector(agent),
      new GoalInjector(agent),
      new WorkingSetInjector(agent),
      new UserPrefsInjector(agent),
    ];
  }

  async inject(): Promise<void> {
    for (const injector of this.injectors) {
      await injector.inject();
    }
  }

  /** Reset per-turn state on all injectors. */
  resetForTurn(): void {
    // No-op: none of the current injectors maintain per-turn state.
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
