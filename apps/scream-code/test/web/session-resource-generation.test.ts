import { afterEach, describe, expect, it, vi } from 'vitest';

import { createControlModule } from '../../src/web/frontend/src/composables/webClient/control';
import { createExtensionsModule } from '../../src/web/frontend/src/composables/webClient/extensions';
import { createMcpModule } from '../../src/web/frontend/src/composables/webClient/mcp';
import {
  createClientSharedState,
  type ClientContext,
} from '../../src/web/frontend/src/composables/webClient/state';

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function context(): ClientContext {
  const s = createClientSharedState();
  s.sessionId.value = 'session-a';
  s.currentSessionId.value = 'session-a';
  s.connectionStatus.value = 'connected';
  return {
    s,
    showToast: vi.fn(),
    connect: vi.fn(),
  } as unknown as ClientContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session resource request generations', () => {
  it('does not apply an extensions response after switching sessions', async () => {
    const ctx = context();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    ctx.s.skills.value = [{ name: 'new', description: 'current', source: 'builtin' }];

    const request = createExtensionsModule(ctx).fetchSkills();
    ctx.s.sessionId.value = 'session-b';
    ctx.s.currentSessionId.value = 'session-b';
    ctx.s.sessionGeneration++;
    pending.resolve(response([{ name: 'old', description: 'stale', source: 'builtin' }]));
    await request;

    expect(ctx.s.skills.value.map((skill) => skill.name)).toEqual(['new']);
  });

  it('keeps MCP data from a newer refresh when an older response resolves last', async () => {
    const ctx = context();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal('fetch', fetchMock);
    const mcp = createMcpModule(ctx);

    const older = mcp.fetchMcpServers();
    const newer = mcp.fetchMcpServers();
    second.resolve(response([{ name: 'newer', status: 'ready' }]));
    await newer;
    first.resolve(response([{ name: 'older', status: 'stopped' }]));
    await older;

    expect(ctx.s.mcpServers.value.map((server) => server.name)).toEqual(['newer']);
  });

  it('does not merge a stale control status into the selected session', async () => {
    const ctx = context();
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    ctx.s.status.value = { busy: false, model: 'current' };

    const request = createControlModule(ctx).fetchSessionStatus();
    ctx.s.sessionId.value = 'session-b';
    ctx.s.currentSessionId.value = 'session-b';
    ctx.s.sessionGeneration++;
    pending.resolve(response({ model: 'stale', busy: true }));
    await request;

    expect(ctx.s.status.value).toMatchObject({ model: 'current', busy: false });
  });
});
