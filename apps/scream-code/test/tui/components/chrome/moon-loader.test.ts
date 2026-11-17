import { afterEach, describe, expect, it, vi } from 'vitest';

import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { applyMotionEnv, resetMotion } from '#/tui/utils/motion';

const ui = (): never => ({ requestRender: vi.fn() }) as never;

describe('MoonLoader motion settings', () => {
  afterEach(() => {
    resetMotion();
    vi.useRealTimers();
  });

  it('animates by default', () => {
    vi.useFakeTimers();
    const loader = new MoonLoader(ui(), undefined, 'x');
    expect(vi.getTimerCount()).toBe(1);
    loader.stop();
  });

  it('shows one still frame and runs no timer when motion is off', () => {
    vi.useFakeTimers();
    applyMotionEnv({ SCREAM_MOTION: 'off' });
    const loader = new MoonLoader(ui(), undefined, 'loading');
    expect(vi.getTimerCount()).toBe(0);
    expect(loader.render(40).join('')).toContain('loading');
    loader.stop();
  });
});
