import chalk from 'chalk';
import { truncateToWidth } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';
import { displayWidth, padLabel } from '#/tui/utils/display-width';
import { lerpGradient } from '#/tui/utils/gradient';
import type { SubagentSlot, SubagentSlotStatus } from '#/tui/utils/subagent-slots';

/** Gradient cycle for active agent slots. Shorter than the footer's 4s cycle:
 *  with the 1s sidebar heartbeat each tick advances half the cycle, so the
 *  colour jump is clearly visible instead of drifting imperceptibly. */
const AGENT_GRADIENT_CYCLE_MS = 2000;

import type { SidebarPanel, SidebarPanelContext } from '../sidebar-panel';

/** Localized status word per slot state. */
function statusText(status: SubagentSlotStatus): string {
  switch (status) {
    case 'idle':
      return t('sidebar.agent_idle');
    case 'working':
      return t('sidebar.agent_working');
    case 'outputting':
      return t('sidebar.agent_outputting');
    case 'messaging':
      return t('sidebar.agent_messaging');
    case 'reworking':
      return t('sidebar.agent_reworking');
    case 'requesting':
      return t('sidebar.agent_requesting');
  }
}

/**
 * Fixed 8-slot subagent panel: one row per default subagent type (plus any
 * custom types appended in spawn order). Live-rendered each frame from the
 * current snapshot; idle slots stay greyed out.
 */
class AgentsPanelContent {
  constructor(
    private readonly ctx: SidebarPanelContext,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const agents = this.ctx.getData().agents;
    // The provider always returns the fixed 8 default slots (+ extras), so
    // agents is never empty; no empty-state branch needed.
    if (agents === undefined || agents.length === 0) return [];
    const lines: string[] = [];
    const nameWidth = Math.max(...agents.map((a) => displayWidth(a.type)));
    for (const [index, slot] of agents.entries()) {
      lines.push(this.renderSlot(slot, index, nameWidth, width));
    }
    return lines;
  }

  private renderSlot(slot: SubagentSlot, index: number, nameWidth: number, width: number): string {
    const dim = (s: string): string => chalk.hex(this.colors.textDim)(s);
    if (slot.status === 'idle') {
      const dot = dim('○');
      const name = dim(padLabel(slot.type, nameWidth));
      const status = dim(statusText('idle'));
      return `${dot} ${name}  ${status}`;
    }
    // Busy slots pulse along the same brand gradient as the footer status
    // spinner, phase-shifted per slot so they never all sync up. The whole
    // active marker (dot + status word) is painted with the gradient so the
    // light effect is clearly visible, not just a single character.
    const phase = ((Date.now() % AGENT_GRADIENT_CYCLE_MS) / AGENT_GRADIENT_CYCLE_MS + index * 0.125) % 1;
    const active =
      slot.status === 'working' || slot.status === 'outputting'
        ? chalk.hex(lerpGradient(phase)).bold
        : undefined;
    const dot = active
      ? active('●')
      : chalk.hex(this.statusColor(slot.status))('●');
    const name = chalk.hex(this.colors.textStrong)(padLabel(slot.type, nameWidth));
    // The help marker is a static warning word — deliberately kept off the brand
    // gradient so it reads as an alert, not as one more busy working row.
    const status = active
      ? active(statusText(slot.status))
      : slot.status === 'requesting'
        ? chalk.hex(this.colors.warning)(statusText(slot.status))
        : chalk.hex(this.colors.text)(statusText(slot.status));
    // Type + status + instance count only; no live output previews. The
    // status word starts on the SAME column as idle rows (2-space separator)
    // and the count sits two spaces after it, so busy rows never shift left.
    const count = slot.count > 1 ? `  ${dim('×' + slot.count)}` : '';
    return truncateToWidth(`${dot} ${name}  ${status}${count}`, width);
  }

  private statusColor(status: SubagentSlotStatus): string {
    switch (status) {
      case 'working':
      case 'outputting':
        return this.colors.primary;
      case 'messaging':
        return this.colors.accent;
      case 'reworking':
        return this.colors.warning;
      case 'requesting':
        return this.colors.warning;
      case 'idle':
        return this.colors.textDim;
    }
  }
}

export const agentsPanel: SidebarPanel = {
  id: 'agents',
  get title() {
    return t('sidebar.agents');
  },
  width: 34,
  build(ctx) {
    return new AgentsPanelContent(ctx, ctx.colors);
  },
};
