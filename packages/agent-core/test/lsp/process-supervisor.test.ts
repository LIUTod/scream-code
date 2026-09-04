import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import type { JianProcess } from '@scream-code/jian';

import {
  LspProcessSupervisor,
  type LspOwnerRecord,
  type LspProcessOps,
} from '../../src/lsp/process-supervisor';

function createFakeProcess(pid: number): JianProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return {
    stdout,
    stderr,
    stdin: { write: () => {} },
    pid,
    exitCode: null,
    kill: async () => {},
    wait: async () => 0,
  } as unknown as JianProcess;
}

interface FakeOpsState {
  alive: Set<number>;
  ppidByPid: Map<number, number>;
  commandByPid: Map<number, string>;
  killCalls: number[];
  startFingerprints: Map<number, string>;
}

function createFakeOps(state: FakeOpsState): LspProcessOps {
  return {
    isAlive: (pid) => state.alive.has(pid),
    psInfo: (pid) => {
      if (!state.alive.has(pid)) return null;
      return {
        ppid: state.ppidByPid.get(pid) ?? null,
        command: state.commandByPid.get(pid) ?? null,
      };
    },
    hostStartFingerprint: (pid) => state.startFingerprints.get(pid) ?? null,
    killGroupSync: (pid) => {
      state.killCalls.push(pid);
      state.alive.delete(pid);
      return true;
    },
    psSupported: () => true,
    envTokenMatches: () => undefined,
  };
}

function makeState(): FakeOpsState {
  return {
    alive: new Set(),
    ppidByPid: new Map(),
    commandByPid: new Map(),
    killCalls: [],
    startFingerprints: new Map(),
  };
}

function makeRecord(overrides: Partial<LspOwnerRecord> = {}): LspOwnerRecord {
  return {
    version: 1,
    ownerId: 'owner-1',
    sessionId: 'session-1',
    hostPid: 9000,
    hostStartFingerprint: 'Fri Sep  4 12:00:00 2026',
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    entries: [],
    ...overrides,
  };
}

describe('LspProcessSupervisor', () => {
  it('tracks registered processes and killAllSync kills every tracked pid', () => {
    const state = makeState();
    const ops = createFakeOps(state);
    const supervisor = new LspProcessSupervisor({ ops, installProcessHooks: false });
    const a = createFakeProcess(1001);
    const b = createFakeProcess(1002);
    supervisor.register(a, '/ws', 'typescript-language-server');
    supervisor.register(b, '/ws', 'pyright-langserver');
    supervisor.killAllSync();
    expect(state.killCalls).toEqual([1001, 1002]);
    supervisor.dispose();
  });

  it('unregister removes a process so killAllSync skips it', () => {
    const state = makeState();
    const ops = createFakeOps(state);
    const supervisor = new LspProcessSupervisor({ ops, installProcessHooks: false });
    const a = createFakeProcess(1001);
    supervisor.register(a, '/ws', 'typescript-language-server');
    supervisor.unregister(1001);
    supervisor.killAllSync();
    expect(state.killCalls).toEqual([]);
    supervisor.dispose();
  });

  it('writes and deletes an owner record under screamHomeDir', () => {
    const dir = join(tmpdir(), `lsp-sup-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const supervisor = new LspProcessSupervisor({
        screamHomeDir: dir,
        ops: createFakeOps(makeState()),
        installProcessHooks: false,
      });
      const ownersDir = join(dir, 'runtime', 'lsp', 'owners');
      expect(existsSync(ownersDir)).toBe(false);

      const proc = createFakeProcess(2001);
      supervisor.register(proc, '/ws', 'typescript-language-server');
      expect(existsSync(join(ownersDir, `${supervisor.ownerId}.json`))).toBe(true);
      const record = JSON.parse(
        readFileSync(join(ownersDir, `${supervisor.ownerId}.json`), 'utf8'),
      ) as LspOwnerRecord;
      expect(record.version).toBe(1);
      expect(record.hostPid).toBe(process.pid);
      expect(record.entries).toHaveLength(1);
      expect(record.entries[0]?.pid).toBe(2001);
      expect(record.entries[0]?.commandFingerprint).toBe('typescript-language-server');

      supervisor.unregister(2001);
      expect(existsSync(join(ownersDir, `${supervisor.ownerId}.json`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('recoverStaleOwners', () => {
    it('reaps an orphan: reparented away from the recorded host + command match', async () => {
      const dir = join(tmpdir(), `lsp-sup-reap-${Date.now()}`);
      const ownersDir = join(dir, 'runtime', 'lsp', 'owners');
      mkdirSync(ownersDir, { recursive: true });
      const state = makeState();
      // Simulate the previous host (9000) dying and the LSP child (3001)
      // being reparented to init (1).
      state.alive.add(3001);
      state.ppidByPid.set(3001, 1);
      state.commandByPid.set(3001, 'node /usr/local/bin/typescript-language-server --stdio');
      state.startFingerprints.set(9000, 'Fri Sep  4 12:00:00 2026');
      writeFileSync(
        join(ownersDir, 'owner-1.json'),
        JSON.stringify(
          makeRecord({
            ownerId: 'owner-1',
            hostPid: 9000,
            entries: [
              {
                pid: 3001,
                workspaceRoot: '/ws',
                commandFingerprint: 'typescript-language-server',
                launchedAt: new Date().toISOString(),
              },
            ],
          }),
        ),
      );
      try {
        const supervisor = new LspProcessSupervisor({
          screamHomeDir: dir,
          ops: createFakeOps(state),
          installProcessHooks: false,
        });
        await supervisor.recoverStaleOwners();
        expect(state.killCalls).toEqual([3001]);
        // Record gone once every entry was resolved.
        expect(existsSync(join(ownersDir, 'owner-1.json'))).toBe(false);
        supervisor.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('leaves a live host untouched even when the heartbeat is stale', async () => {
      const dir = join(tmpdir(), `lsp-sup-live-${Date.now()}`);
      const ownersDir = join(dir, 'runtime', 'lsp', 'owners');
      mkdirSync(ownersDir, { recursive: true });
      const state = makeState();
      // Host 9000 still alive and verified by start fingerprint; the child's
      // ppid still points at it → ownership intact, never kill.
      state.alive.add(3001);
      state.alive.add(9000);
      state.ppidByPid.set(3001, 9000);
      state.commandByPid.set(3001, 'node typescript-language-server --stdio');
      state.startFingerprints.set(9000, 'Fri Sep  4 12:00:00 2026');
      writeFileSync(
        join(ownersDir, 'owner-1.json'),
        JSON.stringify(
          makeRecord({
            ownerId: 'owner-1',
            hostPid: 9000,
            entries: [
              {
                pid: 3001,
                workspaceRoot: '/ws',
                commandFingerprint: 'typescript-language-server',
                launchedAt: new Date().toISOString(),
              },
            ],
          }),
        ),
      );
      try {
        const supervisor = new LspProcessSupervisor({
          screamHomeDir: dir,
          ops: createFakeOps(state),
          installProcessHooks: false,
        });
        await supervisor.recoverStaleOwners();
        expect(state.killCalls).toEqual([]);
        supervisor.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('never kills on a command mismatch (PID reuse guard)', async () => {
      const dir = join(tmpdir(), `lsp-sup-reuse-${Date.now()}`);
      const ownersDir = join(dir, 'runtime', 'lsp', 'owners');
      mkdirSync(ownersDir, { recursive: true });
      const state = makeState();
      // Orphaned ppid, but the command is NOT our fingerprint → PID was
      // recycled by an unrelated process; leave it alone.
      state.alive.add(3001);
      state.ppidByPid.set(3001, 1);
      state.commandByPid.set(3001, 'com.apple.backgroundtaskmanagementd');
      state.startFingerprints.set(9000, 'Fri Sep  4 12:00:00 2026');
      writeFileSync(
        join(ownersDir, 'owner-1.json'),
        JSON.stringify(
          makeRecord({
            ownerId: 'owner-1',
            hostPid: 9000,
            entries: [
              {
                pid: 3001,
                workspaceRoot: '/ws',
                commandFingerprint: 'typescript-language-server',
                launchedAt: new Date().toISOString(),
              },
            ],
          }),
        ),
      );
      try {
        const supervisor = new LspProcessSupervisor({
          screamHomeDir: dir,
          ops: createFakeOps(state),
          installProcessHooks: false,
        });
        await supervisor.recoverStaleOwners();
        expect(state.killCalls).toEqual([]);
        supervisor.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps a still-attached child when the host fingerprint mismatches (PID-reuse fail-closed)', async () => {
      const dir = join(tmpdir(), `lsp-sup-fp-${Date.now()}`);
      const ownersDir = join(dir, 'runtime', 'lsp', 'owners');
      mkdirSync(ownersDir, { recursive: true });
      const state = makeState();
      // The record's hostPid is OUR pid but its start fingerprint differs →
      // the pid was recycled; the entry's ppid still points at the recorded
      // hostPid, so it is a live child of the process that recycled the pid.
      // Its command matches the fingerprint, yet it must NOT be killed.
      state.alive.add(3001);
      state.ppidByPid.set(3001, process.pid);
      state.commandByPid.set(3001, 'node typescript-language-server --stdio');
      state.startFingerprints.set(process.pid, 'Fri Jan  1 00:00:00 2021');
      writeFileSync(
        join(ownersDir, 'owner-1.json'),
        JSON.stringify(
          makeRecord({
            ownerId: 'owner-1',
            hostPid: process.pid,
            hostStartFingerprint: 'Fri Sep  4 12:00:00 2026',
            entries: [
              {
                pid: 3001,
                workspaceRoot: '/ws',
                commandFingerprint: 'typescript-language-server',
                launchedAt: new Date().toISOString(),
              },
            ],
          }),
        ),
      );
      try {
        const supervisor = new LspProcessSupervisor({
          screamHomeDir: dir,
          ops: createFakeOps(state),
          installProcessHooks: false,
        });
        await supervisor.recoverStaleOwners();
        expect(state.killCalls).toEqual([]);
        supervisor.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails closed when ps cannot inspect the process', async () => {
      const dir = join(tmpdir(), `lsp-sup-noinspect-${Date.now()}`);
      const ownersDir = join(dir, 'runtime', 'lsp', 'owners');
      mkdirSync(ownersDir, { recursive: true });
      const state = makeState();
      state.alive.add(3001);
      const ops: LspProcessOps = {
        ...createFakeOps(state),
        psInfo: () => null, // Platform cannot inspect.
      };
      writeFileSync(
        join(ownersDir, 'owner-1.json'),
        JSON.stringify(
          makeRecord({
            ownerId: 'owner-1',
            hostPid: 9000,
            entries: [
              {
                pid: 3001,
                workspaceRoot: '/ws',
                commandFingerprint: 'typescript-language-server',
                launchedAt: new Date().toISOString(),
              },
            ],
          }),
        ),
      );
      try {
        const supervisor = new LspProcessSupervisor({
          screamHomeDir: dir,
          ops,
          installProcessHooks: false,
        });
        await supervisor.recoverStaleOwners();
        expect(state.killCalls).toEqual([]);
        supervisor.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
