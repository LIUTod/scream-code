import { describe, expect, it } from 'vitest';

import {
  MOBILE_MAX_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SPLIT_PANEL_MIN_WIDTH,
  clampPanelWidth,
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
} from '../../src/web/frontend/src/utils/panelLayout';

describe('clampPanelWidth', () => {
  it('clamps to the band and rounds', () => {
    expect(clampPanelWidth(100, 300, 1200)).toBe(300);
    expect(clampPanelWidth(5000, 300, 1200)).toBe(1200);
    expect(clampPanelWidth(640.4, 300, 1200)).toBe(640);
  });

  it('falls back to min on non-finite input', () => {
    expect(clampPanelWidth(Number.NaN, 300, 1200)).toBe(300);
  });

  it('survives an inverted band', () => {
    expect(clampPanelWidth(500, 900, 300)).toBe(900);
  });
});

describe('getDefaultRightPanelWidth', () => {
  it('uses 42% of the viewport inside the clamp band', () => {
    expect(getDefaultRightPanelWidth(1440)).toBe(Math.round(1440 * 0.42));
  });

  it('clamps small and huge viewports into the band', () => {
    expect(getDefaultRightPanelWidth(700)).toBe(360);
    expect(getDefaultRightPanelWidth(4000)).toBe(640);
  });
});

describe('panel interlock', () => {
  it('protects the chat column when the sidebar grows', () => {
    const viewport = 1440;
    const right = 560;
    const max = getSidebarMaxWidth({ viewportWidth: viewport, rightPanelOpen: true, rightPanelWidth: right });
    expect(max).toBe(viewport - 420 - right); // desktop chat min = 420
    expect(max).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH);
  });

  it('caps the sidebar at its own max when room is plentiful', () => {
    expect(getSidebarMaxWidth({ viewportWidth: 3000, rightPanelOpen: false, rightPanelWidth: 0 })).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('ignores the right panel below the split width (overlay mode)', () => {
    const overlay = MOBILE_MAX_WIDTH + 1; // 641: compact band, no 480 cap
    const withPanel = getSidebarMaxWidth({ viewportWidth: overlay, rightPanelOpen: true, rightPanelWidth: 560 });
    const without = getSidebarMaxWidth({ viewportWidth: overlay, rightPanelOpen: false, rightPanelWidth: 0 });
    expect(withPanel).toBe(without); // compact chat min = 320 both times
    expect(withPanel).toBe(overlay - 320);
  });

  it('gives the right panel full headroom below the split width', () => {
    expect(getRightPanelMaxWidth({ viewportWidth: SPLIT_PANEL_MIN_WIDTH - 1, sidebarOpen: true, sidebarWidth: 288 }))
      .toBe(RIGHT_PANEL_MAX_WIDTH);
  });

  it('subtracts the visible sidebar from the right panel max on desktop', () => {
    const viewport = 1440;
    expect(getRightPanelMaxWidth({ viewportWidth: viewport, sidebarOpen: true, sidebarWidth: 288 }))
      .toBe(viewport - 420 - 288);
  });

  it('keeps the right panel usable at the mobile boundary', () => {
    expect(RIGHT_PANEL_MIN_WIDTH).toBe(300);
    expect(getSidebarMaxWidth({ viewportWidth: MOBILE_MAX_WIDTH, rightPanelOpen: false, rightPanelWidth: 0 }))
      .toBe(SIDEBAR_MAX_WIDTH);
  });
});
