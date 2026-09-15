import { describe, expect, it } from 'vitest';

import {
  MOBILE_MAX_WIDTH,
  RIGHT_PANEL_MAX_VIEWPORT_RATIO,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_COMPACT_MAX_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
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

describe('column-width contract', () => {
  it('pins the agreed rail widths', () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(264);
    expect(SIDEBAR_MAX_WIDTH).toBe(420);
    expect(SIDEBAR_RAIL_WIDTH).toBe(56);
    expect(SIDEBAR_COMPACT_MAX_WIDTH).toBe(1024);
    // Below this width the dock becomes the full-screen overlay float.
    expect(SPLIT_PANEL_MIN_WIDTH).toBe(768);
    // The rail + middle floor + dock floor must fit the split breakpoint.
    expect(SIDEBAR_RAIL_WIDTH + 400 + RIGHT_PANEL_MIN_WIDTH).toBeLessThanOrEqual(
      SPLIT_PANEL_MIN_WIDTH,
    );
  });
});

describe('getDefaultRightPanelWidth', () => {
  it('uses 45% of the viewport on first open', () => {
    expect(getDefaultRightPanelWidth(1440)).toBe(Math.round(1440 * 0.45));
  });

  it('floors at the dock minimum on small viewports', () => {
    expect(getDefaultRightPanelWidth(600)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('uses 45% of the viewport — structurally below the 70vw ceiling', () => {
    const viewport = 4000;
    // 45% < 70%: the default width can never reach the ceiling, so this pins that
    // structural relation as it is instead of a misleading "never exceeds the
    // 70vw ceiling" title — that ceiling is really enforced by the drag clamp below.
    expect(getDefaultRightPanelWidth(viewport)).toBe(Math.round(viewport * 0.45));
    expect(getDefaultRightPanelWidth(viewport)).toBeLessThan(
      Math.round(viewport * RIGHT_PANEL_MAX_VIEWPORT_RATIO),
    );
    expect(RIGHT_PANEL_MAX_VIEWPORT_RATIO).toBe(0.7);
  });

  it('reaches the 70vw ceiling on the drag path (large viewport + large request)', () => {
    const viewport = 4000;
    const ceiling = Math.round(viewport * RIGHT_PANEL_MAX_VIEWPORT_RATIO); // 2800
    // The 4000px viewport minus the reserved chat floor still clears 70vw (2800),
    // so the ceiling is the only binding constraint.
    const max = getRightPanelMaxWidth({ viewportWidth: viewport, sidebarOpen: false, sidebarWidth: 0 });
    expect(max).toBe(ceiling);
    // An oversized drag request is clamped to 70vw; values below the ceiling pass
    // through unchanged (never raised).
    expect(clampPanelWidth(9999, RIGHT_PANEL_MIN_WIDTH, max)).toBe(ceiling);
    expect(clampPanelWidth(1200, RIGHT_PANEL_MIN_WIDTH, max)).toBe(1200);
  });
});

describe('panel interlock', () => {
  it('protects the chat column (400px desktop floor) when the sidebar grows', () => {
    const viewport = 1300;
    const right = 560;
    const max = getSidebarMaxWidth({ viewportWidth: viewport, rightPanelOpen: true, rightPanelWidth: right });
    expect(max).toBe(viewport - 400 - right); // interlock bites below the 420 cap
    expect(max).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH);
  });

  it('caps the sidebar at its own max when room is plentiful', () => {
    expect(getSidebarMaxWidth({ viewportWidth: 3000, rightPanelOpen: false, rightPanelWidth: 0 })).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('ignores the right panel below the split width (overlay mode)', () => {
    const overlay = MOBILE_MAX_WIDTH + 1; // 641: compact band, no 420 cap
    const withPanel = getSidebarMaxWidth({ viewportWidth: overlay, rightPanelOpen: true, rightPanelWidth: 560 });
    const without = getSidebarMaxWidth({ viewportWidth: overlay, rightPanelOpen: false, rightPanelWidth: 0 });
    expect(withPanel).toBe(without); // compact chat min = 320 both times
    expect(withPanel).toBe(overlay - 320);
  });

  it('caps the overlay dock at 70vw below the split width', () => {
    const viewport = SPLIT_PANEL_MIN_WIDTH - 1;
    expect(getRightPanelMaxWidth({ viewportWidth: viewport, sidebarOpen: true, sidebarWidth: 288 }))
      .toBe(Math.round(viewport * RIGHT_PANEL_MAX_VIEWPORT_RATIO));
  });

  it('subtracts the visible sidebar from the right panel max on desktop', () => {
    const viewport = 1440;
    // 1440 - 400 - 288 = 752 sits under the 70vw (1008px) ceiling.
    expect(getRightPanelMaxWidth({ viewportWidth: viewport, sidebarOpen: true, sidebarWidth: 288 }))
      .toBe(viewport - 400 - 288);
  });

  it('holds the 70vw ceiling when the interlock would allow more', () => {
    const viewport = 3000;
    expect(getRightPanelMaxWidth({ viewportWidth: viewport, sidebarOpen: false, sidebarWidth: 56 }))
      .toBe(Math.round(viewport * RIGHT_PANEL_MAX_VIEWPORT_RATIO));
  });

  it('lets the compact rail be passed through the sidebar interlock', () => {
    const viewport = 800; // split mode, sidebar forced to the rail
    expect(getRightPanelMaxWidth({ viewportWidth: viewport, sidebarOpen: true, sidebarWidth: SIDEBAR_RAIL_WIDTH }))
      .toBe(Math.min(Math.round(viewport * 0.7), viewport - 400 - SIDEBAR_RAIL_WIDTH));
  });

  it('keeps the right panel usable at the mobile boundary', () => {
    expect(RIGHT_PANEL_MIN_WIDTH).toBe(300);
    expect(getSidebarMaxWidth({ viewportWidth: MOBILE_MAX_WIDTH, rightPanelOpen: false, rightPanelWidth: 0 }))
      .toBe(SIDEBAR_MAX_WIDTH);
  });
});
