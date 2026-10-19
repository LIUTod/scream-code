/**
 * runtime-marker.test.ts — 崩溃标记的读写与过期识别。
 *
 * 契约：活进程的标记不动；死进程的标记被**报告一次并删除**；损坏/过期版本
 * 的文件按垃圾清理且不抛错；正常退出能删掉自己的标记。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearRuntimeMarker,
  collectStaleMarkers,
  isProcessAlive,
  runtimeMarkerDir,
  writeRuntimeMarker,
} from '#/tui/utils/runtime-marker';

/** 远超任何系统实际分配范围，process.kill 必然 ESRCH。 */
const DEAD_PID = 2_000_000;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'runtime-marker-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('runtime-marker', () => {
  it('写入后：目录自动创建、自己的 pid 不被判定为过期', () => {
    writeRuntimeMarker(home, { pid: process.pid, startedAt: Date.now(), sessionId: 's1', title: 'My session' });

    expect(existsSync(join(runtimeMarkerDir(home), `${process.pid}.json`))).toBe(true);
    expect(collectStaleMarkers(home)).toEqual([]);
    // 活进程的标记不能被扫描删掉
    expect(existsSync(join(runtimeMarkerDir(home), `${process.pid}.json`))).toBe(true);
  });

  it('死进程的标记被报告一次并从磁盘移除', () => {
    writeRuntimeMarker(home, { pid: DEAD_PID, startedAt: 1234, sessionId: 'dead-session', title: 'Crashed run' });

    const stale = collectStaleMarkers(home);

    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ pid: DEAD_PID, sessionId: 'dead-session', title: 'Crashed run' });
    expect(existsSync(join(runtimeMarkerDir(home), `${DEAD_PID}.json`))).toBe(false);
    // 第二次扫描不再重复报告
    expect(collectStaleMarkers(home)).toEqual([]);
  });

  it('多个过期标记按启动时间倒序返回', () => {
    writeRuntimeMarker(home, { pid: DEAD_PID, startedAt: 1000 });
    writeRuntimeMarker(home, { pid: DEAD_PID + 1, startedAt: 2000 });

    const stale = collectStaleMarkers(home);

    expect(stale.map((marker) => marker.startedAt)).toEqual([2000, 1000]);
  });

  it('损坏的 JSON 与未知版本按垃圾清理，不抛出', () => {
    const dir = runtimeMarkerDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.json'), '{not json');
    writeFileSync(join(dir, '2.json'), JSON.stringify({ version: 999, pid: DEAD_PID, startedAt: 1 }));

    expect(collectStaleMarkers(home)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('clearRuntimeMarker 删除自己的标记，且对不存在的文件无副作用', () => {
    writeRuntimeMarker(home, { pid: process.pid, startedAt: Date.now() });
    clearRuntimeMarker(home);
    expect(existsSync(join(runtimeMarkerDir(home), `${process.pid}.json`))).toBe(false);

    expect(() => { clearRuntimeMarker(home); }).not.toThrow();
  });

  it('isProcessAlive：自己为真、明显越界的 pid 为假', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
