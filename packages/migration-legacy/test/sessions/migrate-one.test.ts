import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateOneSession, type MigrateOneResult } from '../../src/sessions/migrate-one.js';
import { computeWorkdirBucket } from '../../src/sessions/workdir-bucket.js';
import { targetSessionsDir } from '../../src/paths.js';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'migrate-one-'));
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
});

describe('migrateOneSession (tiny-hello-world fixture)', () => {
  it('produces a valid v1.0 session dir', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.title).toBe('hi');
    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const lines = wire.split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toContain('"protocol_version":"1.0"');
    // 2 messages (user + assistant); markers dropped
    expect(lines).toHaveLength(3);
  });

  it('reports already-migrated on an idempotent re-run', async () => {
    await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    const second = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    // The dir we wrote carries `imported_from_scream_cli`, so a re-run is an
    // idempotent skip, not a real collision.
    expect(second.outcome).toBe('already-migrated');
  });

  it('reports conflict when an unrelated scream-code session occupies the dir', async () => {
    const first = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(first.outcome).toBe('migrated');
    const targetDir = (first as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    // Overwrite state.json with a non-migrated (real) scream-code session.
    await writeFile(join(targetDir, 'state.json'), JSON.stringify({ title: 'real' }), 'utf-8');
    const second = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(second.outcome).toBe('conflict');
  });

  it('re-migrates a target dir left half-written by an interrupted run', async () => {
    const workdirPath = '/Users/me/proj';
    const targetDir = join(
      targetSessionsDir(targetHome),
      computeWorkdirBucket(workdirPath),
      'ses_tiny-uuid',
    );
    // Simulate a prior run killed after the dir + wire.jsonl were written but
    // before state.json — exactly the debris a hard crash leaves, since a
    // crash bypasses the in-process cleanup. Without state.json this is not a
    // real scream-code session, so it must be re-migrated, not reported as a
    // permanent conflict that strands the session forever.
    await mkdir(join(targetDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), '{"type":"metadata"}\n');

    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-uuid',
      workdirPath,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.custom.imported_from_scream_cli).toBe(true);
  });

  it('re-migrates a target dir whose state.json is corrupt', async () => {
    const workdirPath = '/Users/me/proj';
    const targetDir = join(
      targetSessionsDir(targetHome),
      computeWorkdirBucket(workdirPath),
      'ses_tiny-uuid',
    );
    // Simulate a crash mid-write of state.json: the dir + wire.jsonl exist and
    // state.json is present but unparseable. It is migration debris (the path
    // is `ses_<uuid>`), not a real scream-code session, so it must be
    // re-migrated, not reported as a permanent conflict.
    await mkdir(join(targetDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), '{"type":"metadata"}\n');
    await writeFile(join(targetDir, 'state.json'), '{ "createdAt": "broke');

    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-uuid',
      workdirPath,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8'));
    expect(state.custom.imported_from_scream_cli).toBe(true);
  });

  it('stamps written artifacts with the original wire_mtime', async () => {
    // tiny-hello-world/state.json has `wire_mtime: 1772616338.93`.
    // `SessionStore.list()` ranks sessions by filesystem mtime, so the
    // migrated artifacts must carry the original timestamp — not write-time.
    const expectedMs = Math.floor(1772616338.93 * 1000);
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;

    const stateStat = await stat(join(targetDir, 'state.json'));
    const wireStat = await stat(join(targetDir, 'agents', 'main', 'wire.jsonl'));
    const dirStat = await stat(targetDir);

    // Within one second of the fixture's wire_mtime.
    expect(Math.abs(stateStat.mtimeMs - expectedMs)).toBeLessThan(1000);
    expect(Math.abs(wireStat.mtimeMs - expectedMs)).toBeLessThan(1000);
    expect(Math.abs(dirStat.mtimeMs - expectedMs)).toBeLessThan(1000);
  });

  it('falls back to the wire.jsonl mtime when wire_mtime is absent', async () => {
    // A state.json without `wire_mtime` must stamp the migrated artifacts from
    // the SAME signal detection ranks recency by — the source wire.jsonl mtime
    // — so post-migration list ordering matches the detected order.
    const srcDir = join(targetHome, 'src-no-wiremtime');
    await mkdir(srcDir, { recursive: true });
    const fixtureContext = await readFile(
      join(FIXTURES, 'tiny-hello-world', 'context.jsonl'),
      'utf-8',
    );
    await writeFile(join(srcDir, 'context.jsonl'), fixtureContext, 'utf-8');
    await writeFile(join(srcDir, 'wire.jsonl'), '{"type":"metadata"}\n', 'utf-8');
    await writeFile(join(srcDir, 'state.json'), '{}', 'utf-8');
    const wireTime = new Date('2024-03-04T05:06:07.000Z');
    const contextTime = new Date('2020-01-01T00:00:00.000Z');
    await utimes(join(srcDir, 'context.jsonl'), contextTime, contextTime);
    await utimes(join(srcDir, 'wire.jsonl'), wireTime, wireTime);

    const result = await migrateOneSession({
      sourceSessionDir: srcDir,
      oldSessionUuid: 'no-wiremtime-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;
    const wireStat = await stat(join(targetDir, 'agents', 'main', 'wire.jsonl'));
    expect(Math.abs(wireStat.mtimeMs - wireTime.getTime())).toBeLessThan(1000);
  });

  it('reports outcome "empty" — not "failed" — when the context has no messages', async () => {
    // A context.jsonl with only markers (e.g. a session the user cleared in
    // scream-cli) carries no migratable conversation. That is an empty session,
    // not a migration failure.
    const srcDir = join(targetHome, 'src-empty-context');
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, 'context.jsonl'),
      '{"role":"_system_prompt","content":"You are ..."}\n',
      'utf-8',
    );
    await writeFile(join(srcDir, 'state.json'), '{}', 'utf-8');

    const result = await migrateOneSession({
      sourceSessionDir: srcDir,
      oldSessionUuid: 'empty-context-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('empty');
  });

  it('reports outcome "failed" when context.jsonl is corrupt (no parseable JSON lines)', async () => {
    // A disk-corrupted / truncated context.jsonl must be surfaced as a real
    // failure (so it ends up in `migration-errors.log`), not silently
    // counted as "skipped empty".
    const srcDir = join(targetHome, 'src-corrupt-context');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'context.jsonl'), 'not-json\n{broken\n}}}\n', 'utf-8');
    await writeFile(join(srcDir, 'state.json'), '{}', 'utf-8');

    const result = await migrateOneSession({
      sourceSessionDir: srcDir,
      oldSessionUuid: 'corrupt-context-uuid',
      workdirPath: '/Users/me/proj',
      targetHome,
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.reason).toMatch(/corrupt|parseable/i);
    }
  });
});
