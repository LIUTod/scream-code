import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { Jian, JianProcess } from '@scream-code/jian';

import { LSP_OWNER_TOKEN_ENV } from '../../src/lsp/process-supervisor';
import type { LspProcessSupervisor } from '../../src/lsp/process-supervisor';
import { LspClient, pathToUri } from '../../src/lsp/client';

describe('pathToUri', () => {
  it('returns an existing file URI unchanged', () => {
    expect(pathToUri('file:///tmp/a.ts')).toBe('file:///tmp/a.ts');
  });

  it('converts POSIX absolute paths', () => {
    expect(pathToUri('/tmp/a.ts')).toBe('file:///tmp/a.ts');
    expect(pathToUri('/home/user/project/src/index.ts')).toBe(
      'file:///home/user/project/src/index.ts',
    );
  });

  it('converts Windows backslash paths', () => {
    expect(pathToUri('C:\\project\\a.ts')).toBe('file:///C:/project/a.ts');
    expect(pathToUri('c:\\project\\a.ts')).toBe('file:///C:/project/a.ts');
    expect(pathToUri('C:\\')).toBe('file:///C:/');
  });

  it('converts Windows forward-slash paths', () => {
    expect(pathToUri('D:/project/a.ts')).toBe('file:///D:/project/a.ts');
  });

  it('prepends a leading slash to relative paths', () => {
    expect(pathToUri('relative/path.ts')).toBe('file:///relative/path.ts');
  });
});

function frameLspMessage(payload: object): Buffer {
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, 'utf8');
  return Buffer.from(`Content-Length: ${bytes}\r\n\r\n${json}`, 'utf8');
}

interface FakeStdio {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (data: string) => void };
  kill: (signal: string) => Promise<void>;
  wait: () => Promise<number>;
  pid: number;
  exitCode: number | null;
}

function createFakeProcess(responses: Map<number, unknown>): {
  process: JianProcess;
  stdio: FakeStdio;
  sentMessages: { id: number; method: string; params: unknown }[];
} {
  const merged = new Map(responses);
  if (!merged.has(2)) merged.set(2, null);
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const sentMessages: { id: number; method: string; params: unknown }[] = [];

  const emitResponse = (id: number, result: unknown) => {
    const framed = frameLspMessage({ jsonrpc: '2.0', id, result });
    setImmediate(() => stdout.emit('data', framed));
  };

  const stdin = {
    write: (data: string) => {
      let cursor = 0;
      while (cursor < data.length) {
        const headerEnd = data.indexOf('\r\n\r\n', cursor);
        if (headerEnd === -1) return;
        const header = data.slice(cursor, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (match === null) {
          cursor = headerEnd + 4;
          continue;
        }
        const bodyLen = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const body = data.slice(bodyStart, bodyStart + bodyLen);
        cursor = bodyStart + bodyLen;
        try {
          const message = JSON.parse(body) as { id?: number; method: string; params?: unknown };
          if (message.id !== undefined) {
            sentMessages.push({ id: message.id, method: message.method, params: message.params });
            // Respond by METHOD for the standard handshake/teardown requests so
            // a restarted client (fresh request ids) still gets its replies;
            // anything else falls back to the per-id responses map.
            if (message.method === 'initialize') {
              emitResponse(message.id, { capabilities: {} });
            } else if (message.method === 'shutdown') {
              emitResponse(message.id, null);
            } else {
              const response = merged.get(message.id);
              if (response !== undefined) {
                emitResponse(message.id, response);
              }
            }
          } else {
            sentMessages.push({ id: -1, method: message.method, params: message.params });
          }
        } catch {
          // ignore
        }
      }
    },
  };

  const proc = {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    exitCode: null,
    kill: async () => {},
    wait: async () => 0,
  } as unknown as JianProcess;

  const stdio: FakeStdio = {
    stdout,
    stderr,
    stdin,
    kill: async () => {},
    wait: async () => 0,
    pid: 12345,
    exitCode: null,
  };

  return { process: proc, stdio, sentMessages };
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

describe('LspClient message parsing', () => {
  it('parses a single ASCII publishDiagnostics message', async () => {
    const { process, sentMessages } = createFakeProcess(new Map([[1, { capabilities: {} }]]));
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();

    const diagPayload = {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/a.ts',
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            severity: 1,
            message: 'Type error',
          },
        ],
      },
    };
    process.stdout.emit('data', frameLspMessage(diagPayload));
    await new Promise((r) => setImmediate(r));

    const collected = (client as unknown as { collectedDiagnostics: Map<string, { message: string }[]> }).collectedDiagnostics;
    expect(collected.get('file:///workspace/a.ts')).toHaveLength(1);
    expect(collected.get('file:///workspace/a.ts')![0]!.message).toBe('Type error');
    expect(sentMessages.some((m) => m.method === 'initialize')).toBe(true);
    await client.stop();
  });

  it('parses messages containing multi-byte UTF-8 (Chinese diagnostics)', async () => {
    const { process } = createFakeProcess(new Map([[1, { capabilities: {} }]]));
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();

    const diagPayload = {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///workspace/中文.ts',
        diagnostics: [
          {
            range: {
              start: { line: 2, character: 3 },
              end: { line: 2, character: 6 },
            },
            severity: 1,
            message: '类型"字符串"不能分配给类型"数字"',
          },
        ],
      },
    };
    process.stdout.emit('data', frameLspMessage(diagPayload));
    await new Promise((r) => setImmediate(r));

    const collected = (client as unknown as { collectedDiagnostics: Map<string, { message: string }[]> }).collectedDiagnostics;
    expect(collected.get('file:///workspace/中文.ts')).toHaveLength(1);
    expect(collected.get('file:///workspace/中文.ts')![0]!.message).toBe('类型"字符串"不能分配给类型"数字"');
    await client.stop();
  });

  it('parses multiple concatenated messages in one chunk', async () => {
    const { process } = createFakeProcess(new Map([[1, { capabilities: {} }]]));
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();

    const msg1 = frameLspMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///workspace/a.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'first' }] },
    });
    const msg2 = frameLspMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///workspace/a.ts', diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, message: 'second' }] },
    });
    process.stdout.emit('data', Buffer.concat([msg1, msg2]));
    await new Promise((r) => setImmediate(r));

    const collected = (client as unknown as { collectedDiagnostics: Map<string, { message: string }[]> }).collectedDiagnostics;
    expect(collected.get('file:///workspace/a.ts')).toHaveLength(1);
    expect(collected.get('file:///workspace/a.ts')![0]!.message).toBe('second');
    await client.stop();
  });

  it('buffers a partial message body across chunks', async () => {
    const { process } = createFakeProcess(new Map([[1, { capabilities: {} }]]));
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();

    const full = frameLspMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///workspace/a.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'split across chunks' }] },
    });
    const mid = Math.floor(full.length / 2);
    process.stdout.emit('data', full.subarray(0, mid));
    await new Promise((r) => setImmediate(r));
    process.stdout.emit('data', full.subarray(mid));
    await new Promise((r) => setImmediate(r));

    const collected = (client as unknown as { collectedDiagnostics: Map<string, { message: string }[]> }).collectedDiagnostics;
    expect(collected.get('file:///workspace/a.ts')).toHaveLength(1);
    expect(collected.get('file:///workspace/a.ts')![0]!.message).toBe('split across chunks');
    await client.stop();
  });

  it('skips malformed header without Content-Length and resyncs', async () => {
    const { process } = createFakeProcess(new Map([[1, { capabilities: {} }]]));
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();

    const garbage = Buffer.from('garbage line\r\n\r\n', 'utf8');
    const valid = frameLspMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///workspace/a.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'after garbage' }] },
    });
    process.stdout.emit('data', Buffer.concat([garbage, valid]));
    await new Promise((r) => setImmediate(r));

    const collected = (client as unknown as { collectedDiagnostics: Map<string, { message: string }[]> }).collectedDiagnostics;
    expect(collected.get('file:///workspace/a.ts')).toHaveLength(1);
    expect(collected.get('file:///workspace/a.ts')![0]!.message).toBe('after garbage');
    await client.stop();
  });
});

describe('LspClient supervisor wiring', () => {
  interface FakeSupervisor extends LspProcessSupervisor {
    registered: { pid: number; workspaceRoot: string; fingerprint: string }[];
    unregistered: number[];
  }

  function createFakeSupervisor(): FakeSupervisor {
    const registered: { pid: number; workspaceRoot: string; fingerprint: string }[] = [];
    const unregistered: number[] = [];
    return {
      ownerId: 'test-owner-1',
      registered,
      unregistered,
      recoveryReady: Promise.resolve(),
      register: (proc: JianProcess, workspaceRoot: string, fingerprint: string) => {
        registered.push({ pid: proc.pid, workspaceRoot, fingerprint });
      },
      unregister: (pid: number) => {
        unregistered.push(pid);
      },
    } as unknown as FakeSupervisor;
  }

  it('injects the owner token env and registers the spawned process', async () => {
    const { process } = createFakeProcess(new Map([[1, { capabilities: {} }]]));
    const jian = createFakeJian(process);
    const execWithEnvSpy = vi.spyOn(jian, 'execWithEnv');
    const supervisor = createFakeSupervisor();
    const client = new LspClient(['server'], '/workspace', jian, undefined, supervisor);
    await client.start();

    expect(execWithEnvSpy).toHaveBeenCalledTimes(1);
    expect(execWithEnvSpy).toHaveBeenCalledWith(['server'], {
      [LSP_OWNER_TOKEN_ENV]: 'test-owner-1',
    });
    expect(supervisor.registered).toEqual([
      { pid: 12345, workspaceRoot: '/workspace', fingerprint: 'server' },
    ]);
    await client.stop();
  });

  it('spawns without a supervisor via plain exec', async () => {
    const { process } = createFakeProcess(new Map([[1, { capabilities: {} }]]));
    const jian = createFakeJian(process);
    const execSpy = vi.spyOn(jian, 'exec');
    const client = new LspClient(['server'], '/workspace', jian);
    await client.start();
    expect(execSpy).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it('unregisters the process on stop', async () => {
    const { process } = createFakeProcess(new Map([[1, { capabilities: {} }]]));
    const supervisor = createFakeSupervisor();
    const client = new LspClient(['server'], '/workspace', createFakeJian(process), undefined, supervisor);
    await client.start();
    await client.stop();
    expect(supervisor.unregistered).toEqual([12345]);
  });
});

describe('LspClient.stop()', () => {
  it('resets started flag so the client can be restarted', async () => {
    const responses = new Map<number, unknown>([
      [1, { capabilities: {} }],
      [2, null],
    ]);
    const { process } = createFakeProcess(responses);
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();
    await client.stop();
    expect((client as unknown as { started: boolean }).started).toBe(false);
  });

  it('sends shutdown as a request (awaiting response) before exit', async () => {
    const responses = new Map<number, unknown>([
      [1, { capabilities: {} }],
      [2, null],
    ]);
    const { process, sentMessages } = createFakeProcess(responses);
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();
    await client.stop();
    const methods = sentMessages.map((m) => m.method);
    const shutdown = sentMessages.find((m) => m.method === 'shutdown');
    expect(shutdown, `sent methods: ${methods.join(', ')}`).toBeDefined();
    const exit = sentMessages.find((m) => m.method === 'exit');
    expect(exit, `sent methods: ${methods.join(', ')}`).toBeDefined();
    const shutdownIdx = sentMessages.indexOf(shutdown!);
    const exitIdx = sentMessages.indexOf(exit!);
    expect(shutdownIdx).toBeLessThan(exitIdx);
  });

  it('clears opened documents and diagnostics on stop', async () => {
    const responses = new Map<number, unknown>([
      [1, { capabilities: {} }],
      [2, null],
    ]);
    const { process } = createFakeProcess(responses);
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();
    client.didOpen('/workspace/a.ts', 'const x = 1', 'typescript');
    expect(
      (client as unknown as { openedDocuments: Set<string> }).openedDocuments.size,
    ).toBeGreaterThan(0);
    await client.stop();
    expect(
      (client as unknown as { openedDocuments: Set<string> }).openedDocuments.size,
    ).toBe(0);
    expect(
      (client as unknown as { collectedDiagnostics: Map<string, unknown[]> })
        .collectedDiagnostics.size,
    ).toBe(0);
  });

  it('cleans state even when process is undefined', async () => {
    const responses = new Map<number, unknown>([
      [1, { capabilities: {} }],
      [2, null],
    ]);
    const { process } = createFakeProcess(responses);
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();
    client.didOpen('/workspace/a.ts', 'const x = 1', 'typescript');
    await client.stop();
    expect((client as unknown as { process: unknown }).process).toBeUndefined();
    await client.stop();
    expect(
      (client as unknown as { openedDocuments: Set<string> }).openedDocuments.size,
    ).toBe(0);
  });

  it('a restarted client tears down its new process on a second stop', async () => {
    // Regression: start() resets stopPromise so a stale stop from the first
    // run cannot short-circuit (and leak) the restarted process, and the
    // identity guard prevents an in-flight stop closure from clobbering the
    // new process handle. The fake server responds by method, so both
    // sessions' initialize/shutdown requests resolve.
    const responses = new Map<number, unknown>([[1, { capabilities: {} }]]);
    const { process } = createFakeProcess(responses);
    const client = new LspClient(['server'], '/workspace', createFakeJian(process));
    await client.start();
    await client.stop();
    // Restart on the same instance.
    await client.start();
    expect((client as unknown as { started: boolean }).started).toBe(true);
    await client.stop();
    expect((client as unknown as { process: unknown }).process).toBeUndefined();
    expect((client as unknown as { started: boolean }).started).toBe(false);
  });
});
