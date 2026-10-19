import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  pendingMutationKeys,
  withFileMutationLock,
} from '../../../../src/tools/builtin/file/mutation-queue';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withFileMutationLock', () => {
  it('同一路径串行：第二笔写必须等第一笔落完', async () => {
    const order: string[] = [];
    const gate = deferred();

    const first = withFileMutationLock('same-file.txt', async () => {
      order.push('a-start');
      await gate.promise;
      order.push('a-end');
    });
    const second = withFileMutationLock('same-file.txt', async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await Promise.resolve();
    expect(order).toEqual(['a-start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('不同路径并行：互不等待（吞吐不变）', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const started: string[] = [];

    const a = withFileMutationLock('x.txt', async () => {
      started.push('x');
      await gateA.promise;
    });
    const b = withFileMutationLock('y.txt', async () => {
      started.push('y');
      await gateB.promise;
    });

    await Promise.resolve();
    // 两个任务都已进入执行体 → 没有互相排队
    expect(started.toSorted()).toEqual(['x', 'y']);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([a, b]);
  });

  it('前一笔失败不阻塞后续：链继续推进', async () => {
    const failed = withFileMutationLock('z.txt', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');

    await expect(withFileMutationLock('z.txt', async () => 'ok')).resolves.toBe('ok');
  });

  it('相对路径与绝对路径归一为同一把锁', async () => {
    const order: string[] = [];
    const gate = deferred();
    const relative = './locked-target.txt';
    const absolute = path.resolve('locked-target.txt');

    const first = withFileMutationLock(relative, async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-end');
    });
    const second = withFileMutationLock(absolute, async () => {
      order.push('second-start');
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('链尾完成后清理表项（不泄漏）', async () => {
    await withFileMutationLock('leak-check.txt', async () => 'done');
    // 清理在尾链的 then 回调里，需要让微任务跑完
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingMutationKeys()).toBe(0);
  });
});
