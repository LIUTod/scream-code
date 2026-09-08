import { Container, truncateToWidth, visibleWidth, type Component } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { SidebarManager } from './sidebar-manager';
import type { SidebarPanelContext } from './sidebar-panel';

const SIDE_PADDING = 1; // space between the │ and the content on each side

/**
 * Renders the active sidebar panel inside a full box border (┌─┐│└┘) with the
 * panel title embedded in the top frame, following plan-box's layout. The whole
 * frame is painted in the theme's accent color so the sidebar reads as part of
 * the active theme. The body is rebuilt when the active panel changes OR when
 * its runtime data changes, and the rendered width follows the SidebarManager
 * so `/sidebar width` and width persistence take effect.
 */
export class SidebarContainer extends Container {
  private readonly manager: SidebarManager;
  private readonly panelContext: SidebarPanelContext;
  private readonly accentHex: string;
  private renderedPanelId: string | null = null;
  private body: Component | undefined;
  private lastDataKey: string = '';

  constructor(manager: SidebarManager, requestRender: () => void, accentHex: string) {
    super();
    this.manager = manager;
    this.accentHex = accentHex;
    this.panelContext = { requestRender, getData: () => this.manager.getData() };
  }

  /** Rebuild the body from the current active panel (call on activate/close/refresh). */
  refresh(): void {
    const panel = this.manager.isOpen ? this.manager.activePanel : undefined;
    if (panel === undefined) {
      this.clear();
      this.body = undefined;
      this.renderedPanelId = null;
      this.lastDataKey = '';
      return;
    }
    this.renderedPanelId = panel.id;
    this.clear();
    this.body = panel.build(this.panelContext);
    this.addChild(this.body);
    this.lastDataKey = this.dataKey();
  }

  /** Cheap O(1) fingerprint of the runtime data a panel renders from. */
  private dataKey(): string {
    // Full snapshot: any rendered field (planMode, activeAgentCount, per-task
    // kind/label) that changes must re-trigger a rebuild, even when the
    // background-tasks count stays the same.
    return JSON.stringify(this.manager.getData());
  }

  override render(_width: number): string[] {
    const current = this.manager.isOpen ? this.manager.activePanel?.id ?? null : null;
    // Rebuild on panel change OR data change (avoids a frozen snapshot while open).
    if (current !== this.renderedPanelId || this.dataKey() !== this.lastDataKey) {
      this.refresh();
    }
    const panel = this.manager.activePanel;
    if (!this.manager.isOpen || panel === undefined || this.body === undefined) {
      return [];
    }

    // Full box frame: "┌─ <title> ────┐" / "│ <content> │" / "└────┘"
    // width = horzLen + 2 (left/right frame) ⇒ horzLen = width - 2
    // content width = horzLen - 2 * SIDE_PADDING = width - 4
    const horzLen = Math.max(2, this.manager.currentWidth - 2);
    const contentWidth = Math.max(1, horzLen - 2 * SIDE_PADDING);
    const paint = (s: string): string => chalk.hex(this.accentHex)(s);

    const title = truncateToWidth(String(panel.title), horzLen);
    const trailing = Math.max(0, horzLen - visibleWidth(title));
    const top = paint('┌') + paint(title) + paint('─'.repeat(trailing)) + paint('┐');
    const bottom = paint('└') + paint('─'.repeat(horzLen)) + paint('┘');

    const content = this.body.render(contentWidth);
    const lines: string[] = [top];
    for (const raw of content) {
      const row = truncateToWidth(raw, contentWidth);
      const pad = Math.max(0, contentWidth - visibleWidth(row));
      lines.push(paint('│') + ' ' + row + ' '.repeat(pad) + ' ' + paint('│'));
    }
    lines.push(bottom);
    return lines;
  }
}
