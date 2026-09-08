import { Container, Text } from '@liutod-scream/pi-tui';

import type { SidebarPanel, SidebarPanelContext } from '../sidebar-panel';

/**
 * A display-only sidebar panel listing active background tasks (injected via
 * {@link SidebarPanelContext.getData}). Mirrors a task/queue panel idea and
 * stays non-interactive, consistent with the first batch of sidebar panels.
 */
class TasksPanelComponent extends Container {
  constructor(ctx: SidebarPanelContext) {
    super();
    const tasks = ctx.getData().backgroundTasks ?? [];
    if (tasks.length === 0) {
      this.addChild(new Text('No background tasks', 0, 0));
      return;
    }
    for (const task of tasks) {
      this.addChild(new Text(`${task.kind ?? '?'}  ${task.label ?? task.id}`, 0, 0));
    }
  }
}

export const tasksPanel: SidebarPanel = {
  id: 'tasks',
  title: 'Tasks',
  width: 34,
  build(ctx) {
    return new TasksPanelComponent(ctx);
  },
};
