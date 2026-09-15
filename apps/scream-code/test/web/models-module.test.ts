import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClientSharedState } from '../../src/web/frontend/src/composables/webClient/state';
import type { ClientContext } from '../../src/web/frontend/src/composables/webClient/state';
import { createModelsModule } from '../../src/web/frontend/src/composables/webClient/models';

/**
 * Silent-failure sweep for models.ts: switching with no session, a failed POST and
 * a failed list load must all produce perceivable feedback (toast / modelsError
 * state) instead of a silent return.
 */

function makeCtx() {
  const s = createClientSharedState();
  const showToast = vi.fn();
  const appendSystemMessage = vi.fn();
  const ctx = {
    s,
    showToast,
    appendSystemMessage,
    fetchModels: async () => undefined,
  } as unknown as ClientContext;
  const models = createModelsModule(ctx);
  return { s, ctx, showToast, appendSystemMessage, models };
}

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 500): Promise<Response> {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  } as Response);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchModels failure state exposure', () => {
  it('an HTTP failure records modelsError, and a successful recovery clears it', async () => {
    const { s, models } = makeCtx();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(false, {}, 503)));
    await models.fetchModels();
    expect(s.modelsError.value).toContain('HTTP 503');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(true, { models: [{ alias: 'm1' }] })),
    );
    await models.fetchModels();
    expect(s.models.value).toHaveLength(1);
    expect(s.modelsError.value).toBeNull();
  });

  it('a network error puts the reason into modelsError', async () => {
    const { s, models } = makeCtx();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );
    await models.fetchModels();
    expect(s.modelsError.value).toContain('boom');
  });
});

describe('switchModel / switchThinking feedback paths', () => {
  it('with no active session it toasts "open a session first" and sends no request', async () => {
    const { showToast, models } = makeCtx();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await models.switchModel('m2');
    expect(showToast).toHaveBeenCalledWith('请先打开一个会话', 'warning');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed POST toasts the server error message', async () => {
    const { s, showToast, models } = makeCtx();
    s.sessionId.value = 'sess-1';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(false, { message: '模型不存在' }, 400)));
    await models.switchModel('m2');
    expect(showToast).toHaveBeenCalledWith('模型不存在', 'error');
  });

  it('a POST network error toasts the exception message', async () => {
    const { s, showToast, models } = makeCtx();
    s.sessionId.value = 'sess-1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await models.switchThinking('high');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('offline'), 'error');
  });

  it('on success it backfills state and toasts, with no system message; the same-model early return stays idempotent (no toast, no request)', async () => {
    const { s, showToast, appendSystemMessage, models } = makeCtx();
    s.sessionId.value = 'sess-1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(true, { status: { model: 'm2' } })),
    );
    await models.switchModel('m2');
    expect(s.status.value.model).toBe('m2');
    // Switch feedback uses a transient toast: a system message would be pinned to
    // the end of the transcript, and during streaming that reads as "always stuck
    // at the bottom".
    expect(showToast).toHaveBeenCalledWith('已切换模型：m2', 'success');
    expect(appendSystemMessage).not.toHaveBeenCalled();

    // Idempotent: no further POST when the target is already the current model.
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await models.switchModel('m2');
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});
