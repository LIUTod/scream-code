import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClientSharedState } from '../../src/web/frontend/src/composables/webClient/state';
import type { ClientContext } from '../../src/web/frontend/src/composables/webClient/state';
import { createControlModule } from '../../src/web/frontend/src/composables/webClient/control';

/**
 * Optimistic-update discipline for permission switching:
 * switchPermission must flip the local status.permission first (immediate chip
 * feedback) and roll back only when the request fails — a click must never wait
 * for a full round trip to become visible, or stay invisible forever.
 */

function makeCtx() {
  const s = createClientSharedState();
  const showToast = vi.fn();
  const ctx = { s, showToast } as unknown as ClientContext;
  const control = createControlModule(ctx);
  return { s, ctx, showToast, control };
}

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 500): Promise<Response> {
  return Promise.resolve({ ok, status, json: async () => body } as Response);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('switchPermission optimistic update', () => {
  it('the local permission flips while the POST is in flight and keeps the new value on success', async () => {
    const { s, control } = makeCtx();
    s.sessionId.value = 'sess-1';
    s.connectionStatus.value = 'connected';
    s.status.value = { ...s.status.value, permission: 'manual' };
    let resolvePost: ((r: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string) =>
          String(url).includes('/permission')
            ? new Promise<Response>((res) => {
                resolvePost = res;
              })
            : jsonResponse(true, { status: { permission: 'auto' } }),
      ),
    );
    const p = control.switchPermission('auto');
    await Promise.resolve();
    // The POST is still unresolved: the state the chip reads must already be auto.
    expect(s.status.value.permission).toBe('auto');
    resolvePost!(await jsonResponse(true, { status: true }));
    expect(await p).toBe(true);
    expect(s.status.value.permission).toBe('auto');
  });

  it('a failed POST rolls back to the value from before the switch', async () => {
    const { s, control, showToast } = makeCtx();
    s.sessionId.value = 'sess-1';
    s.connectionStatus.value = 'connected';
    s.status.value = { ...s.status.value, permission: 'manual' };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(false, { message: 'nope' }, 500)));
    const ok = await control.switchPermission('yolo');
    expect(ok).toBe(false);
    expect(s.status.value.permission).toBe('manual');
    expect(showToast).toHaveBeenCalled();
  });

  it('a stale request failure does not overwrite the value a newer request already confirmed (generation guard)', async () => {
    const { s, control } = makeCtx();
    s.sessionId.value = 'sess-1';
    s.connectionStatus.value = 'connected';
    s.status.value = { ...s.status.value, permission: 'manual' };
    let resolveFirst: ((r: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { body?: string }) => {
        const mode = init?.body ? (JSON.parse(init.body) as { mode?: string }).mode : undefined;
        // The first click's POST is held open; the second click succeeds immediately.
        if (mode === 'auto') return new Promise<Response>((res) => { resolveFirst = res; });
        if (mode !== undefined) return jsonResponse(true, { status: true });
        // fetchSessionStatus reconciliation: the authoritative server value is the
        // later yolo.
        return jsonResponse(true, { status: { permission: 'yolo' } });
      }),
    );

    const first = control.switchPermission('auto');
    await Promise.resolve();
    const second = control.switchPermission('yolo');
    expect(await second).toBe(true);
    expect(s.status.value.permission).toBe('yolo'); // the later request is confirmed

    // The stale request fails only now: its prev('manual') is an outdated snapshot,
    // so writing it back would roll back the confirmed new value.
    resolveFirst!(await jsonResponse(false, { message: 'nope' }, 500));
    expect(await first).toBe(false);
    expect(s.status.value.permission).toBe('yolo');
  });

  it('a stale failure rollback is not written into the session switched to meanwhile', async () => {
    const { s, control } = makeCtx();
    s.sessionId.value = 'sess-1';
    s.connectionStatus.value = 'connected';
    s.status.value = { ...s.status.value, permission: 'manual' };
    let resolvePost: ((r: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolvePost = res; })));

    const pending = control.switchPermission('auto');
    await Promise.resolve();
    // Session switch: the new session's permission is independent state, so the
    // previous session's rollback must be voided entirely.
    s.sessionId.value = 'sess-2';
    s.sessionGeneration += 1;
    s.status.value = { busy: false, permission: 'ask' };

    resolvePost!(await jsonResponse(false, { message: 'nope' }, 500));
    expect(await pending).toBe(false);
    expect(s.status.value.permission).toBe('ask');
  });
});
