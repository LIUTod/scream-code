import chalk from 'chalk';

import { t } from '@scream-code/config';

import {
  HUB_MODEL_ROW_ID,
  formatHubLatency,
  type HubSample,
  type HubTone,
} from '#/tui/utils/hub-probe';
import { layoutSidebarGrid, type SidebarGridRow } from '#/tui/utils/display-width';
import type { ColorPalette } from '#/tui/theme/colors';

import {
  SIDEBAR_STATIC_MARKER,
  type SidebarPanel,
  type SidebarPanelContext,
} from '../sidebar-panel';

/** Pending marker: three middle dots (Latin-1, so terminal width is stable). */
const PENDING_MARK = '···';
/** No reading at all — a site that stopped answering, or nothing measured yet. */
const EMPTY_MARK = '--';

/**
 * Hub panel: network health at a glance. One row per reading — the measured
 * model-provider response time first, then a probe round trip for each
 * well-known endpoint.
 *
 * Values share one right edge through the same two-column engine the Session
 * panel uses, so rows never jitter as numbers change width, and only the value
 * carries colour (green ≤100ms, amber above it, red when a site stopped
 * answering). The panel is a pure view: probing happens in the data provider,
 * which is what keeps a slow endpoint from ever touching a frame.
 */
class HubPanelContent {
  constructor(
    private readonly ctx: SidebarPanelContext,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const hub = this.ctx.getData().hub;
    if (hub === undefined || hub.samples.length === 0) return [];

    const rows: SidebarGridRow[] = hub.samples.map((sample) => ({
      marker: SIDEBAR_STATIC_MARKER,
      label: this.labelOf(sample.id),
      value: this.reading(sample, hub),
    }));

    return layoutSidebarGrid(rows, width).map((cell, index) => {
      const tone = hub.samples[index]?.tone ?? 'dim';
      const labelCell = chalk.hex(this.colors.textDim)(`${cell.marker}${cell.label}`);
      return `${labelCell}${' '.repeat(cell.gap)}${chalk.hex(this.toneColor(tone))(cell.value ?? '')}`;
    });
  }

  private labelOf(id: string): string {
    return id === HUB_MODEL_ROW_ID ? t('sidebar.hub_model') : id;
  }

  private reading(sample: HubSample, hub: { pending: boolean }): string {
    if (sample.ms !== undefined) return formatHubLatency(sample.ms);
    // While the very first round is still running a missing reading is "not
    // yet", not "unreachable" — painting `--` there would be a false alarm.
    if (hub.pending && sample.tone === 'dim' && sample.id !== HUB_MODEL_ROW_ID) {
      return PENDING_MARK;
    }
    // The provider row is measured, never probed: an idle app simply has no
    // reading yet, and a probe round in flight does not change that.
    return EMPTY_MARK;
  }

  private toneColor(tone: HubTone): string {
    switch (tone) {
      case 'ok':
        return this.colors.success;
      case 'warn':
        return this.colors.warning;
      case 'down':
        return this.colors.error;
      case 'dim':
        return this.colors.textDim;
    }
  }
}

export const hubPanel: SidebarPanel = {
  id: 'hub',
  get title() {
    return t('sidebar.hub');
  },
  width: 30,
  build(ctx: SidebarPanelContext) {
    return new HubPanelContent(ctx, ctx.colors);
  },
};
