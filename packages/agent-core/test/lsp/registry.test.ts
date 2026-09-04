import { describe, expect, it, vi } from 'vitest';

import type { Jian, JianProcess } from '@scream-code/jian';
import { EventEmitter } from 'node:events';

import { LspRegistry } from '../../src/lsp/registry';

function frameLspMessage(payload: object): Buffer {
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, 'utf8');
  return Buffer.from(`Content-Length: ${bytes}\r\n\r\n${json}`, 'utf8');
}

function createFakeProcess(): JianProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = {
    write: (data: string) => {
      const headerEnd = data.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = data.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null) return;
      const bodyLen = Number(match[1]);
      const body = data.slice(headerEnd + 4, headerEnd + 4 + bodyLen);
      try {
        const message = JSON.parse(body) as { id?: number; method: string };
        if (message.id !== undefined && message.method === 'initialize') {
          setImmediate(() =>
            stdout.emit(
              'data',
              frameLspMessage({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }),
            ),
          );
        }
        if (message.id !== undefined && message.method === 'shutdown') {
          setImmediate(() =>
            stdout.emit(
              'data',
              frameLspMessage({ jsonrpc: '2.0', id: message.id, result: null }),
            ),
          );
        }
      } catch {
        // ignore
      }
    },
  };
  return {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    exitCode: null,
    kill: async () => {},
    wait: async () => 0,
  } as unknown as JianProcess;
}

function createFakeJian(proc: JianProcess): Jian {
  return {
    name: 'fake',
    osEnv: {
      osKind: 'Linux',
      osArch: 'x86_64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
    },
    pathClass: () => 'posix',
    normpath: (p: string) => p,
    gethome: () => '/home/test',
    getcwd: () => '/workspace',
    withCwd: () => ({}) as Jian,
    chdir: async () => {},
    stat: async () => ({}) as never,
    iterdir: async function* () {},
    glob: async function* () {},
    readBytes: async () => new Uint8Array(),
    readText: async () => '',
    readLines: async function* () {},
    writeBytes: async () => {},
    writeText: async () => {},
    mkdir: async () => {},
    exec: async () => proc,
    execWithEnv: async () => proc,
  } as unknown as Jian;
}

describe('LspRegistry', () => {
  it('returns undefined for unsupported file extensions', async () => {
    const jian = createFakeJian(createFakeProcess());
    const registry = new LspRegistry(jian);
    const client = await registry.getClient('/workspace/file.unknown-ext', '/workspace');
    expect(client).toBeUndefined();
    await registry.stopAll();
  });

  it('creates a client for supported extensions', async () => {
    const jian = createFakeJian(createFakeProcess());
    const registry = new LspRegistry(jian);
    const client = await registry.getClient('/workspace/a.ts', '/workspace');
    expect(client).toBeDefined();
    await registry.stopAll();
  });

  it('returns the same client instance for concurrent getClient calls', async () => {
    const jian = createFakeJian(createFakeProcess());
    const startSpy = vi.spyOn(jian, 'exec');
    const registry = new LspRegistry(jian);

    const [a, b, c] = await Promise.all([
      registry.getClient('/workspace/a.ts', '/workspace'),
      registry.getClient('/workspace/b.ts', '/workspace'),
      registry.getClient('/workspace/c.ts', '/workspace'),
    ]);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(startSpy).toHaveBeenCalledTimes(1);
    await registry.stopAll();
  });

  it('reuses the client across sequential getClient calls', async () => {
    const jian = createFakeJian(createFakeProcess());
    const startSpy = vi.spyOn(jian, 'exec');
    const registry = new LspRegistry(jian);

    const first = await registry.getClient('/workspace/a.ts', '/workspace');
    const second = await registry.getClient('/workspace/b.ts', '/workspace');
    expect(first).toBe(second);
    expect(startSpy).toHaveBeenCalledTimes(1);
    await registry.stopAll();
  });

  it('does not cache a client whose start failed', async () => {
    const proc = createFakeProcess();
    const jian: Jian = {
      ...createFakeJian(proc),
      exec: async () => {
        throw new Error('server binary missing');
      },
    };
    const registry = new LspRegistry(jian);

    await expect(registry.getClient('/workspace/a.ts', '/workspace')).rejects.toThrow(
      'server binary missing',
    );
    const clients = (registry as unknown as {
      clients: Map<string, Promise<unknown>>;
    }).clients;
    expect(clients.size).toBe(0);
  });

  it('separates clients by workspace root', async () => {
    const jian = createFakeJian(createFakeProcess());
    const startSpy = vi.spyOn(jian, 'exec');
    const registry = new LspRegistry(jian);

    const fromA = await registry.getClient('/ws-a/a.ts', '/ws-a');
    const fromB = await registry.getClient('/ws-b/a.ts', '/ws-b');
    expect(fromA).toBeDefined();
    expect(fromB).toBeDefined();
    expect(fromA).not.toBe(fromB);
    expect(startSpy).toHaveBeenCalledTimes(2);
    await registry.stopAll();
  });

  it('stopAll tolerates a client whose stop rejects', async () => {
    const jian = createFakeJian(createFakeProcess());
    const registry = new LspRegistry(jian);
    await registry.getClient('/workspace/a.ts', '/workspace');
    await expect(registry.stopAll()).resolves.toBeUndefined();
  });

  it('passes the supervisor through to created clients', async () => {
    const proc = createFakeProcess();
    const jian = createFakeJian(proc);
    const registered: unknown[] = [];
    const unregistered: number[] = [];
    const supervisor = {
      ownerId: 'reg-owner',
      register: (...args: unknown[]) => {
        registered.push(args);
      },
      unregister: (pid: number) => {
        unregistered.push(pid);
      },
    } as unknown as import('../../src/lsp/process-supervisor').LspProcessSupervisor;
    const registry = new LspRegistry(jian, supervisor);
    await registry.getClient('/workspace/a.ts', '/workspace');
    expect(registered).toHaveLength(1);
    expect(registered[0]).toEqual([proc, '/workspace', 'typescript-language-server']);
    await registry.stopAll();
    expect(unregistered).toContain(12345);
  });

  it('short-circuits getClient after stopAll (stopping flag)', async () => {
    const jian = createFakeJian(createFakeProcess());
    const registry = new LspRegistry(jian);
    await registry.getClient('/workspace/a.ts', '/workspace');
    await registry.stopAll();
    const again = await registry.getClient('/workspace/a.ts', '/workspace');
    expect(again).toBeUndefined();
  });
});
