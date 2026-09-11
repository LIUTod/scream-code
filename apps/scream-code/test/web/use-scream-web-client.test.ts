// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { useScreamWebClient } from '../../src/web/frontend/src/composables/useScreamWebClient';
import { useToast } from '../../src/web/frontend/src/composables/useToast';

/**
 * Behaviour tests for the web session client factory (useScreamWebClient).
 *
 * The composable talks to the page through exactly two globals:
 *   - fetch(`${API_BASE}/...`)          → REST (sessions / models / snapshot / git…)
 *   - new WebSocket(wsUrl())            → the event stream (:872 server, relative URL)
 * Both are stubbed here; nothing in these tests may touch the real network.
 *
 * A throwaway host component drives the Vue lifecycle so that the
 * factory's onBeforeUnmount cleanup (timers / ws / listeners) is exercised.
 */

const API = '/api/v1';
const OFFLINE_KEY = 'scream-offline-prompt-queue';
const RECENT_KEY = 'scream-recent-prompts';

// ── Fake WebSocket ─────────────────────────────────────────────────────────
// Mirrors the DOM constants the composable compares against
// (WebSocket.OPEN / CONNECTING). Every constructed instance is recorded in
// `wsInstances`; tests drive lifecycle callbacks manually and inspect `sent`.

let wsInstances: FakeWS[] = [];

class FakeWS {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState: number = FakeWS.CONNECTING;
  /** Parsed JSON payloads passed to send(), in order. */
  sent: Record<string, unknown>[] = [];
  closeCalls = 0;

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    // Real sockets fire onclose asynchronously; tests do that explicitly via
    // fireClose() so they can null out handlers first (as switchSession and
    // unmount do) and still observe the close call itself.
    this.closeCalls++;
  }

  // Test drivers ────────────────────────────────────────────────────────────
  open(): void {
    this.readyState = FakeWS.OPEN;
    this.onopen?.({});
  }
  fireMessage(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  fireClose(code: number, reason = ''): void {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.({ code, reason });
  }
}

// ── Harness ────────────────────────────────────────────────────────────────

function okJson(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

/** Mutable per-test response bodies; tests tweak fields before advancing time. */
interface HarnessState {
  snapshot: {
    sessionId: string;
    workDir: string;
    seq: number;
    epoch: number;
    messages: unknown[];
    pendingApprovals: unknown[];
    status: { busy: boolean; model: string };
    busy: boolean;
    goal: null;
    todos: unknown[];
    olderAvailable: boolean;
    oldestSeq: number;
    createdAt: number;
    title: string;
    model: string;
    permission: string;
  };
}

function setupHarness() {
  wsInstances = [];
  const calls: { url: string; method: string }[] = [];
  const state: HarnessState = {
    snapshot: {
      sessionId: 'sess-1',
      workDir: '/wd-snap',
      seq: 4,
      epoch: 10,
      messages: [{ id: 'm-snap', role: 'user', content: 'snap-msg', tools: [], ts: 1 }],
      pendingApprovals: [],
      status: { busy: false, model: 'test-model' },
      busy: false,
      goal: null,
      todos: [],
      olderAvailable: false,
      oldestSeq: 1,
      createdAt: 0,
      title: 't',
      model: 'test-model',
      permission: 'default',
    },
  };

  const fetchImpl = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.startsWith(`${API}/sessions/sess-1/snapshot`)) return okJson(state.snapshot);
    if (url === `${API}/sessions` && method === 'GET') return okJson([{ sessionId: 'sess-1' }]);
    if (url === `${API}/models`) return okJson({ models: [] });
    if (url === `${API}/git/status`) return okJson({ isRepo: false });
    // Anything unexpected: a swallowed 404, never the real network.
    return okJson({ message: 'not stubbed' }, 404);
  };

  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('fetch', fetchImpl);

  let client!: ReturnType<typeof useScreamWebClient>;
  const Host = defineComponent({
    setup() {
      client = useScreamWebClient();
      return () => h('div');
    },
  });
  const wrapper = mount(Host);

  const firstWs = () => wsInstances[0];
  const promptsSent = (ws: FakeWS) => ws.sent.filter((s) => s.type === 'prompt');
  const fetchCallsFor = (fragment: string) => calls.filter((c) => c.url.includes(fragment));

  /** Drive mount → open → server_hello(active) and settle the REST fan-out. */
  async function handshake(ws = firstWs()) {
    expect(ws).toBeDefined();
    ws.open();
    ws.fireMessage({
      type: 'server_hello',
      sessionId: 'sess-1',
      workDir: '/wd-hello',
      active: true,
      epoch: 10,
      heartbeat_ms: 1000,
    });
    await flushPromises();
    return ws;
  }

  return { client, wrapper, calls, state, wsInstances, firstWs, promptsSent, fetchCallsFor, handshake };
}

type Harness = ReturnType<typeof setupHarness>;

const { toasts } = useToast();
function toastTexts(): string[] {
  return toasts.value.map((t) => t.message);
}

function readLS(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

async function settle(): Promise<void> {
  await flushPromises();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useScreamWebClient', () => {
  let h: Harness | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    toasts.value = [];
  });

  afterEach(() => {
    // Deterministic teardown: unmount (idempotent) then drop stubs/timers so
    // no interval, listener or socket leaks into the next test.
    try {
      h?.wrapper.unmount();
    } catch {
      // already unmounted by the test itself
    }
    h = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('server_hello backfills session state, replies client_hello and fans out the trio fetch', async () => {
    h = setupHarness();
    expect(h.client.connectionStatus.value).toBe('connecting');
    expect(h.wsInstances.length).toBe(1);
    expect(h.firstWs().url).toContain('/api/v1/ws');

    const ws = await h.handshake();

    expect(h.client.connectionStatus.value).toBe('connected');
    expect(h.client.sessionId.value).toBe('sess-1');
    expect(h.client.currentSessionId.value).toBe('sess-1');
    expect(h.client.isArchived.value).toBe(false);

    // client_hello is the first frame, carrying the pre-hello resume cursor.
    expect(ws.sent[0]).toEqual({ type: 'client_hello', lastSeq: 0, epoch: 0 });

    // Triple fetch: snapshot (tail window) + sessions + git status, on top of
    // the two boot fetches (sessions + models) fired by the factory itself.
    expect(h.fetchCallsFor('/snapshot').length).toBe(1);
    expect(h.fetchCallsFor('/snapshot')[0].url).toContain('snapshot?tail=100');
    expect(h.fetchCallsFor(`${API}/git/status`).length).toBe(1);
    expect(h.fetchCallsFor(`${API}/models`).length).toBe(1);
    expect(h.calls.filter((c) => c.url === `${API}/sessions`).length).toBe(2); // boot + hello

    // The snapshot response is applied wholesale (supersedes hello's workDir).
    expect(h.client.workDir.value).toBe('/wd-snap');
    expect(h.client.messages.value.map((m) => m.content)).toContain('snap-msg');
  });

  it('sendPrompt while idle shows a toast and neither sends nor queues', async () => {
    h = setupHarness();
    const ws = h.firstWs();
    ws.open();
    ws.fireMessage({ type: 'server_empty' });
    expect(h.client.connectionStatus.value).toBe('idle');

    h.client.sendPrompt('hello?');

    expect(ws.sent).toHaveLength(0);
    expect(h.wsInstances.length).toBe(1); // idle must not trigger reconnect
    expect(h.client.messages.value).toHaveLength(0);
    expect(toastTexts().some((t) => t.includes('暂无会话'))).toBe(true);
    expect(readLS(OFFLINE_KEY)).toBeNull(); // not queued either
  });

  it('sendPrompt while connected sends a clientMessageId frame and blocks until the turn settles', async () => {
    h = setupHarness();
    const ws = await h.handshake();

    h.client.sendPrompt('你好世界');

    const prompts = h.promptsSent(ws);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toBe('你好世界');
    expect(String(prompts[0].clientMessageId)).toMatch(/^client_/);
    // Optimistic local copy carries the same clientMessageId and arms busy.
    const last = h.client.messages.value.at(-1);
    expect(last).toMatchObject({ role: 'user', content: '你好世界', clientMessageId: prompts[0].clientMessageId });
    expect(h.client.isBusy.value).toBe(true);

    // Busy guard: a second send while the first is in flight is dropped.
    h.client.sendPrompt('ignored');
    expect(h.promptsSent(ws)).toHaveLength(1);
  });

  it('sendPrompt while disconnected queues the text, persists it and starts a reconnect', async () => {
    h = setupHarness();
    const ws = await h.handshake();
    ws.fireClose(1006); // abnormal drop → disconnected + scheduled backoff
    expect(h.client.connectionStatus.value).toBe('reconnecting');

    h.client.sendPrompt('queued-1');

    expect(readLS(OFFLINE_KEY)).toEqual(['queued-1']);
    expect(toastTexts().some((t) => t.includes('已排队'))).toBe(true);
    // connect() is fired immediately *and* the backoff timer stays armed.
    expect(h.wsInstances.length).toBe(2);
    expect(h.promptsSent(h.wsInstances[1])).toHaveLength(0); // new socket not open yet
    vi.advanceTimersByTime(2000); // the scheduled reconnect hits the in-flight guard
    expect(h.wsInstances.length).toBe(2);
    // Queued text is not appended to the transcript before it actually sends.
    expect(h.client.messages.value.map((m) => m.content)).not.toContain('queued-1');
  });

  it('offline queue replays strictly one item at a time after the hello', async () => {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(['q1', 'q2']));
    h = setupHarness();
    const ws = await h.handshake();

    // Only the head is in flight; the rest waits for the server echo.
    const prompts = h.promptsSent(ws);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toBe('q1');
    expect(h.client.messages.value.map((m) => m.content)).toEqual(['snap-msg', 'q1']);
    // Head is not consumed until echoed, so storage still holds both.
    expect(readLS(OFFLINE_KEY)).toEqual(['q1', 'q2']);
  });

  it('offline queue advances on each user_message echo and drains localStorage', async () => {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(['q1', 'q2']));
    h = setupHarness();
    const ws = await h.handshake();
    const q1Id = h.promptsSent(ws)[0].clientMessageId;

    // Server echoes q1 → head drops, q2 goes out, storage is rewritten.
    ws.fireMessage({ type: 'user_message', text: 'q1', clientMessageId: q1Id });
    const prompts = h.promptsSent(ws);
    expect(prompts).toHaveLength(2);
    expect(prompts[1].text).toBe('q2');
    expect(readLS(OFFLINE_KEY)).toEqual(['q2']);

    // Echo q2 → queue drained; no further prompt frames.
    ws.fireMessage({ type: 'user_message', text: 'q2', clientMessageId: prompts[1].clientMessageId });
    expect(readLS(OFFLINE_KEY)).toEqual([]);
    expect(h.promptsSent(ws)).toHaveLength(2);
    // Echoes matching an in-flight id are not appended a second time.
    expect(h.client.messages.value.map((m) => m.content)).toEqual(['snap-msg', 'q1', 'q2']);
  });

  it('event from a new epoch triggers resync: snapshot refetch instead of applying the frame', async () => {
    h = setupHarness();
    const ws = await h.handshake();
    // Next snapshot fetch answers with the new epoch (server rotated journal).
    Object.assign(h.state.snapshot, { epoch: 11, seq: 7, workDir: '/wd-resync' });

    ws.fireMessage({ type: 'event', epoch: 11, seq: 9, payload: { type: 'turn.started' } });
    await settle();

    // acceptJournalEvent: epoch mismatch → resync → fetchSnapshot (2nd call).
    expect(h.fetchCallsFor('/snapshot').length).toBe(2);
    // The frame itself was never applied — no assistant turn message exists.
    expect(h.client.messages.value.some((m) => m.role === 'assistant')).toBe(false);
    // …but the authoritative snapshot re-anchored the state.
    expect(h.client.workDir.value).toBe('/wd-resync');
  });

  it('close code 1008 clears the session to idle without reconnecting', async () => {
    h = setupHarness();
    const ws = await h.handshake();

    ws.fireClose(1008);

    expect(h.client.connectionStatus.value).toBe('idle');
    expect(h.client.sessionId.value).toBeNull();
    expect(h.client.currentSessionId.value).toBeNull();
    expect(h.client.isArchived.value).toBe(false);
    expect(h.client.goal.value).toBeNull();
    expect(h.client.todos.value).toEqual([]);

    // No reconnect loop: neither new sockets nor heartbeat pings appear.
    vi.advanceTimersByTime(60_000);
    expect(h.wsInstances.length).toBe(1);
    expect(ws.sent).toHaveLength(1); // still just the client_hello frame
  });

  it('unmount closes the socket, stops heartbeat/backoff and removes window listeners', async () => {
    h = setupHarness();
    const ws = await h.handshake();

    // Heartbeat is live: two ping frames within ~2× the hello interval.
    vi.advanceTimersByTime(2100);
    expect(ws.sent.filter((s) => s.type === 'ping').length).toBe(2);

    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    h.wrapper.unmount();

    expect(ws.closeCalls).toBe(1);
    expect(windowRemove.mock.calls.some(([type]) => type === 'online')).toBe(true);
    expect(docRemove.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true);

    // Still inside the pong window: if the interval lived on it would ping.
    vi.advanceTimersByTime(2100);
    expect(ws.sent.filter((s) => s.type === 'ping').length).toBe(2);
    // A pending reconnect/backoff must not resurrect a socket either.
    vi.advanceTimersByTime(60_000);
    expect(h.wsInstances.length).toBe(1);
  });

  it('sendPrompt records recent prompts in localStorage newest-first with dedupe', async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['old-one']));
    h = setupHarness();
    const ws = await h.handshake();

    // alpha: send → echo → turn.started → turn.ended to free the busy guard.
    h.client.sendPrompt('alpha');
    const alphaId = h.promptsSent(ws)[0].clientMessageId;
    ws.fireMessage({ type: 'user_message', text: 'alpha', clientMessageId: alphaId });
    ws.fireMessage({ type: 'event', epoch: 10, seq: 5, payload: { type: 'turn.started' } });
    ws.fireMessage({ type: 'event', epoch: 10, seq: 6, payload: { type: 'turn.ended' } });

    h.client.sendPrompt('beta');
    const betaId = h.promptsSent(ws)[1].clientMessageId;
    // Server rejects beta: pending state clears so the next send goes through.
    ws.fireMessage({ type: 'error', message: 'rejected', clientMessageId: betaId });

    h.client.sendPrompt('alpha'); // repeat → moves to the front, no duplicate

    expect(readLS(RECENT_KEY)).toEqual(['alpha', 'beta', 'old-one']);
    expect(h.promptsSent(ws)).toHaveLength(3);
    expect(h.client.error.value).toBe('rejected');
  });

  // ── Regression: queue-race eviction & heartbeat clamp & 1008 transcript ──

  it('error for a plain connected send leaves an unrelated offline queue item intact', async () => {
    // Timeline exposing the pre-fix race: send A while connected, drop the
    // link, queue B (never sent), then a late error arrives *for A*. The old
    // unconditional shift() evicted B — a prompt that was never sent.
    h = setupHarness();
    const ws1 = await h.handshake();
    h.client.sendPrompt('plain-A');
    const aId = h.promptsSent(ws1)[0].clientMessageId;
    ws1.fireClose(1006);
    h.client.sendPrompt('queued-B');
    expect(readLS(OFFLINE_KEY)).toEqual(['queued-B']);
    const ws2 = h.wsInstances[1];
    // Late rejection for A, before ws2 even handshakes (no flush ran).
    ws2.fireMessage({ type: 'error', message: 'late no', clientMessageId: aId });
    // B is untouched: still the only queued item, and nothing was sent.
    expect(readLS(OFFLINE_KEY)).toEqual(['queued-B']);
    expect(h.promptsSent(ws2)).toHaveLength(0);
  });

  it('user_message echo of a plain send does not advance the offline queue', async () => {
    // Pre-fix, ANY echo matching a known clientMessageId ran flushQueueNext
    // and evicted the queue head. A plain send's entry is only alive until
    // the next hello's snapshot apply clears it, so the stray window is
    // exactly: A in flight → link drops → B/C queued → replayed echo of A
    // lands on the fresh socket *before* its hello.
    h = setupHarness();
    const ws1 = await h.handshake();
    h.client.sendPrompt('plain-A'); // in flight, never echoed
    const aId = h.promptsSent(ws1)[0].clientMessageId;
    ws1.fireClose(1006);
    h.client.sendPrompt('queued-B');
    h.client.sendPrompt('queued-C');
    expect(readLS(OFFLINE_KEY)).toEqual(['queued-B', 'queued-C']);
    const ws2 = h.wsInstances[1];
    ws2.fireMessage({ type: 'user_message', text: 'plain-A', clientMessageId: aId });
    // Post-fix: queue intact, nothing flushed early.
    // (Pre-fix: flushQueueNext shifted B off the head → LS held only C.)
    expect(readLS(OFFLINE_KEY)).toEqual(['queued-B', 'queued-C']);
    expect(h.promptsSent(ws2)).toHaveLength(0);
  });

  it('absurd server heartbeat_ms is clamped instead of hot-looping', async () => {
    h = setupHarness();
    const ws = h.firstWs();
    ws.open();
    ws.fireMessage({
      type: 'server_hello', sessionId: 'sess-1', workDir: '/wd', active: true,
      epoch: 10, heartbeat_ms: 0, // pre-fix: setInterval(0) → thousands of pings
    });
    await settle();
    vi.advanceTimersByTime(14_000);
    expect(ws.sent.filter((s) => s.type === 'ping')).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(ws.sent.filter((s) => s.type === 'ping').length).toBeGreaterThanOrEqual(1);
    expect(ws.sent.filter((s) => s.type === 'ping').length).toBeLessThan(10);
  });

  it('close 1008 clears transcript and error state of the rejected session', async () => {
    h = setupHarness();
    const ws = await h.handshake();
    expect(h.client.messages.value.length).toBeGreaterThan(0); // snapshot applied
    ws.fireMessage({ type: 'error', message: 'stray failure' });
    expect(h.client.error.value).toBe('stray failure');

    ws.fireClose(1008);

    // Pre-fix, the rejected session's messages/errors haunted the idle view.
    expect(h.client.messages.value).toEqual([]);
    expect(h.client.error.value).toBeNull();
  });

  it('close 1008 toasts the rejection and refreshes the session list', async () => {
    h = setupHarness();
    const ws = await h.handshake();
    const sessionListFetches = () =>
      h.calls.filter((c) => c.url === `${API}/sessions` && c.method === 'GET').length;
    const before = sessionListFetches();

    ws.fireClose(1008, 'Session not found');

    expect(h.client.connectionStatus.value).toBe('idle');
    expect(toastTexts().some((t) => t.includes('会话不可用'))).toBe(true);
    expect(sessionListFetches()).toBe(before + 1);
  });

  it('caps auto-reconnect after repeated failures and surfaces a terminal error', async () => {
    h = setupHarness();
    // No handshake: heartbeat never starts, isolating the reconnect scheduler.
    expect(h.wsInstances.length).toBe(1);

    for (let i = 0; i < 12; i++) {
      const current = h.wsInstances.at(-1);
      current.fireClose(1006); // abnormal closure → scheduleReconnect
      await vi.advanceTimersByTimeAsync(60_000); // covers the 30s backoff cap
    }

    // 1 initial + MAX_RECONNECT_ATTEMPTS(8) retries; pre-fix the socket count
    // grew with every loop iteration and the storm never stopped.
    expect(h.wsInstances.length).toBe(9);
    expect(h.client.connectionStatus.value).toBe('disconnected');
    expect(h.client.error.value).toContain('上限');
  });

  it('reconnectNow re-arms the reconnect budget after the cap', async () => {
    h = setupHarness();
    for (let i = 0; i < 10; i++) {
      h.wsInstances.at(-1).fireClose(1006);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(h.wsInstances.length).toBe(9); // capped

    h.client.reconnectNow();

    expect(h.wsInstances.length).toBe(10);
    expect(h.client.connectionStatus.value).toBe('connecting');
    expect(h.client.error.value).toBeNull();
  });

  it('resync_required frame drops the journal cursor and re-fetches the snapshot', async () => {
    h = setupHarness();
    const ws = await h.handshake();
    const snapshotFetches = () =>
      h.calls.filter((c) => c.url.startsWith(`${API}/sessions/sess-1/snapshot`)).length;
    const before = snapshotFetches(); // hello itself pulls one snapshot

    ws.fireMessage({ type: 'resync_required' });
    await flushPromises();

    // Pre-fix the frame type had no registered handler and was silently
    // dropped, leaving the UI stale after server-side drift detection.
    expect(snapshotFetches()).toBe(before + 1);
  });
});
