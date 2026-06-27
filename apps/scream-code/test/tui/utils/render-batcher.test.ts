import { describe, it, expect, vi } from 'vitest';

import { createRenderBatcher } from '#/tui/utils/render-batcher';

describe('createRenderBatcher', () => {
  it('coalesces multiple requestRender calls into one', async () => {
    const doRender = vi.fn();
    const batcher = createRenderBatcher(doRender);

    batcher.requestRender();
    batcher.requestRender();
    batcher.requestRender();

    expect(doRender).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(doRender).toHaveBeenCalledTimes(1);
    expect(doRender).toHaveBeenCalledWith(false);
  });

  it('preserves force flag when any call is forced', async () => {
    const doRender = vi.fn();
    const batcher = createRenderBatcher(doRender);

    batcher.requestRender();
    batcher.requestRender(true);
    batcher.requestRender();

    await Promise.resolve();
    expect(doRender).toHaveBeenCalledTimes(1);
    expect(doRender).toHaveBeenCalledWith(true);
  });

  it('defers renders inside batchUpdate and queues one force render at the end', async () => {
    const doRender = vi.fn();
    const batcher = createRenderBatcher(doRender);

    const result = batcher.batchUpdate(() => {
      batcher.requestRender();
      batcher.requestRender();
      return 42;
    });

    expect(result).toBe(42);
    expect(doRender).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(doRender).toHaveBeenCalledTimes(1);
    expect(doRender).toHaveBeenCalledWith(true);
  });

  it('only renders once for nested batches', async () => {
    const doRender = vi.fn();
    const batcher = createRenderBatcher(doRender);

    batcher.batchUpdate(() => {
      batcher.requestRender();
      batcher.batchUpdate(() => {
        batcher.requestRender();
      });
      batcher.requestRender();
    });

    await Promise.resolve();
    expect(doRender).toHaveBeenCalledTimes(1);
  });

  it('still coalesces after a batch ends', async () => {
    const doRender = vi.fn();
    const batcher = createRenderBatcher(doRender);

    batcher.batchUpdate(() => {
      batcher.requestRender();
    });
    await Promise.resolve();
    doRender.mockClear();

    batcher.requestRender();
    batcher.requestRender();
    await Promise.resolve();
    expect(doRender).toHaveBeenCalledTimes(1);
  });
});
