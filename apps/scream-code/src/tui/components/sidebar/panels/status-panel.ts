import { Container, Text } from '@liutod-scream/pi-tui';

import type { SidebarPanel, SidebarPanelContext } from '../sidebar-panel';

/**
 * A demo/status sidebar panel. It shows a small snapshot of runtime state
 * (mode/plan/active agents) fed through {@link SidebarPanelContext.getData}.
 * Intentionally minimal and non-interactive: the first batch of sidebar panels
 * stay display-only, since fork horizontal-pane cursor/selection offsets are
 * not yet confirmed.
 */
class StatusPanelComponent extends Container {
  constructor(ctx: SidebarPanelContext) {
    super();
    const data = ctx.getData();
    this.addChild(this.line(`plan  ${data.planMode ?? '—'}`));
    this.addChild(this.line(`tasks ${data.backgroundTasks?.length ?? 0}`));
  }

  private line(text: string): Text {
    return new Text(text, 0, 0);
  }
}

export const statusPanel: SidebarPanel = {
  id: 'status',
  title: 'Status',
  width: 30,
  build(ctx) {
    return new StatusPanelComponent(ctx);
  },
};
