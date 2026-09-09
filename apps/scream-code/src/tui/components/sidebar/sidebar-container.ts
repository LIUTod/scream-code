import { Container, truncateToWidth, visibleWidth, type Component } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

import type { SidebarManager } from './sidebar-manager';
import type { SidebarPanelContext } from './sidebar-panel';

const SIDE_PADDING = 1; // space between the │ and the content on each side

/**
 * Renders the stacked sidebar: every visible registered panel gets its own
 * full box frame (┌─┐│└┘) with the panel title embedded in the top frame, one
 * below the other. Panels render live each frame (their body reads the
 * current data snapshot), so time-based values (uptime, goal wall-clock)
 * tick without rebuilding. The focused panel's title is bolded; focus is
 * moved by the SidebarManager (`/sidebar next/prev`, Ctrl+X toggles).
 * The whole frame is painted in the theme accent colour and the rendered
 * width follows the SidebarManager so `/sidebar width` takes effect.
 */
export class SidebarContainer extends Container {
  private readonly manager: SidebarManager;
  private readonly panelContext: SidebarPanelContext;
  private readonly accentHex: string;
  /** Built panel bodies, keyed by panel id. Bodies render live so they are
   * only rebuilt when the visible panel set changes. */
  private readonly bodies = new Map<string, Component>();
  private builtStackKey = '';
  /** 1s heartbeat while the sidebar is open: keeps live values (uptime,
   * goal wall-clock, gradient phase of busy agent slots) ticking without
   * needing an event. Stopped when the sidebar closes. */
  private readonly heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(manager: SidebarManager, requestRender: () => void, colors: ColorPalette) {
    super();
    this.manager = manager;
    this.accentHex = colors.primary;
    this.panelContext = { requestRender, getData: () => this.manager.getData(), colors };
    this.heartbeat = setInterval(() => {
      if (this.manager.isOpen) requestRender();
    }, 1000);
    // Never keep the process alive solely for the sidebar heartbeat.
    this.heartbeat.unref();
  }

  /** Stop the heartbeat. Called by the TUI teardown (see scream-tui.ts). */
  dispose(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
  }

  /** Re-sync built bodies with the current visible stack (call on register/
   * unregister/activate changes; cheap idempotent check). */
  refresh(): void {
    const key = this.manager.isOpen
      ? this.manager.getStackPanels().map((panel) => panel.id).join('|')
      : '';
    if (key === this.builtStackKey) return;
    const keep = new Set<string>();
    if (this.manager.isOpen) {
      for (const panel of this.manager.getStackPanels()) {
        keep.add(panel.id);
        if (!this.bodies.has(panel.id)) {
          this.bodies.set(panel.id, panel.build(this.panelContext));
        }
      }
    }
    for (const id of [...this.bodies.keys()]) {
      if (!keep.has(id)) this.bodies.delete(id);
    }
    this.builtStackKey = key;
    this.clear();
  }

  override render(_width: number): string[] {
    if (!this.manager.isOpen) return [];
    this.refresh();
    const panels = this.manager.getStackPanels();
    if (panels.length === 0) return [];
    // Leading blank line: the transcript's first component (Welcome) also
    // starts with a blank line, so the sidebar's top border aligns with the
    // welcome box instead of floating one row above it.
    const lines: string[] = [''];

    const horzLen = Math.max(2, this.manager.currentWidth - 2);
    const contentWidth = Math.max(1, horzLen - 2 * SIDE_PADDING);
    const paint = (s: string): string => chalk.hex(this.accentHex)(s);
    const activeId = this.manager.activePanel?.id ?? null;

    for (const panel of panels) {
      const body = this.bodies.get(panel.id);
      if (body === undefined) continue;
      const title = truncateToWidth(String(panel.title), horzLen);
      const titleText = panel.id === activeId ? chalk.bold(title) : title;
      const trailing = Math.max(0, horzLen - visibleWidth(title));
      lines.push(paint('┌') + paint(titleText) + paint('─'.repeat(trailing)) + paint('┐'));
      for (const raw of body.render(contentWidth)) {
        const row = truncateToWidth(raw, contentWidth);
        const pad = Math.max(0, contentWidth - visibleWidth(row));
        lines.push(paint('│') + ' ' + row + ' '.repeat(pad) + ' ' + paint('│'));
      }
      lines.push(paint('└') + paint('─'.repeat(horzLen)) + paint('┘'));
    }
    return lines;
  }
}
