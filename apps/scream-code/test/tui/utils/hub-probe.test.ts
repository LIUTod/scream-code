import { describe, expect, it } from 'vitest';

import { displayWidth, SIDEBAR_LABEL_COLS } from '#/tui/utils/display-width';
import {
  HUB_ENDPOINTS,
  HUB_FAILURE_LIMIT,
  HUB_GOOD_MS,
  HUB_MODEL_ROW_ID,
  HUB_MODEL_STALE_MS,
  HUB_PROBE_INTERVAL_MS,
  HUB_STALE_MULTIPLIER,
  buildHubSamples,
  createHubProbe,
  formatHubLatency,
  hubLatencyTone,
  type ProbeFetch,
  type ProbeRequestInit,
} from '#/tui/utils/hub-probe';

interface Clock {
  now: () => number;
  advance: (delta: number) => void;
}

function makeClock(start = 1_000_000): Clock {
  let value = start;
  return { now: () => value, advance: (delta: number) => { value += delta; } };
}

/** Let the fire-and-forget round settle: every await hands back to the microtask
 *  queue until all probe promises have run to completion. */
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

interface Recorder {
  readonly fetch: ProbeFetch;
  readonly calls: ProbeRequestInit[];
  urls: string[];
}

/** Latency defaults to 0: a round is measured from one start instant, so a
 *  non-zero default would hand every later endpoint a bigger number than the
 *  first. Tests that assert a value use a single endpoint and explicit latency. */
function recordingFetch(options: {
  clock: Clock;
  latency?: number;
  status?: number;
  failIds?: ReadonlySet<string>;
  pending?: boolean;
  throwSync?: boolean;
}): Recorder & { release: () => void } {
  const calls: ProbeRequestInit[] = [];
  const urls: string[] = [];
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  const fetch: ProbeFetch = (url, init) => {
    calls.push(init);
    urls.push(url);
    if (options.throwSync === true) throw new Error('boom');
    const failed = options.failIds !== undefined && [...options.failIds].some((id) => url.includes(id));
    if (failed) return Promise.reject(new Error('unreachable'));
    const work = async (): Promise<{ status: number }> => {
      if (options.pending === true) await gate;
      options.clock.advance(options.latency ?? 0);
      return { status: options.status ?? 200 };
    };
    return work();
  };

  return { fetch, calls, urls, release: () => releaseFn() };
}

const sampleOf = (snapshot: ReturnType<ReturnType<typeof createHubProbe>['snapshot']>, id: string) =>
  snapshot.samples.find((sample) => sample.id === id);

describe('createHubProbe', () => {
  it('starts empty and pending-free until the first round is asked for', () => {
    const clock = makeClock();
    const probe = createHubProbe({ fetchImpl: recordingFetch({ clock }).fetch, now: clock.now });
    const snapshot = probe.snapshot();
    expect(snapshot.samples).toHaveLength(HUB_ENDPOINTS.length);
    expect(snapshot.samples.every((sample) => sample.ms === undefined)).toBe(true);
    expect(snapshot.samples.every((sample) => sample.tone === 'dim')).toBe(true);
    expect(snapshot.roundAt).toBeUndefined();
    expect(snapshot.pending).toBe(false);
  });

  it('runs one round on demand with HEAD, manual redirects and a timeout signal', async () => {
    const clock = makeClock();
    const recorder = recordingFetch({ clock });
    const probe = createHubProbe({ fetchImpl: recorder.fetch, now: clock.now });

    probe.sampleIfStale();
    await flush();

    expect(recorder.calls).toHaveLength(HUB_ENDPOINTS.length);
    expect(recorder.calls.every((init) => init.method === 'HEAD')).toBe(true);
    expect(recorder.calls.every((init) => init.redirect === 'manual')).toBe(true);
    expect(recorder.calls.every((init) => init.signal instanceof AbortSignal)).toBe(true);
    expect(probe.snapshot().roundAt).toBe(clock.now());
  });

  it('keeps the TTL: no traffic until an interval has passed, then exactly one new round', async () => {
    const clock = makeClock();
    const recorder = recordingFetch({ clock });
    const probe = createHubProbe({ fetchImpl: recorder.fetch, now: clock.now });

    probe.sampleIfStale();
    await flush();
    probe.sampleIfStale();
    await flush();
    expect(recorder.calls).toHaveLength(HUB_ENDPOINTS.length);

    clock.advance(HUB_PROBE_INTERVAL_MS);
    probe.sampleIfStale();
    await flush();
    expect(recorder.calls).toHaveLength(HUB_ENDPOINTS.length * 2);
  });

  it('never overlaps rounds while one is in flight', async () => {
    const clock = makeClock();
    const recorder = recordingFetch({ clock, pending: true });
    const probe = createHubProbe({ fetchImpl: recorder.fetch, now: clock.now });

    probe.sampleIfStale();
    probe.sampleIfStale();
    probe.sampleIfStale();
    await flush();

    expect(recorder.calls).toHaveLength(HUB_ENDPOINTS.length);
    expect(probe.snapshot().pending).toBe(true);

    recorder.release();
    await flush();
    expect(probe.snapshot().pending).toBe(false);
  });

  it('treats any HTTP answer as reachable — we time responses, not success', async () => {
    const clock = makeClock();
    const recorder = recordingFetch({ clock, status: 404 });
    const probe = createHubProbe({ fetchImpl: recorder.fetch, now: clock.now });

    probe.sampleIfStale();
    await flush();

    const github = sampleOf(probe.snapshot(), 'github');
    expect(github?.ms).toBeLessThanOrEqual(HUB_GOOD_MS);
    expect(github?.tone).toBe('ok');
  });

  it('keeps the last good value on a single failure, dimmed', async () => {
    const clock = makeClock();
    let breakGoogle = false;
    const fetch: ProbeFetch = (url) => {
      if (breakGoogle && url.includes('google')) return Promise.reject(new Error('unreachable'));
      clock.advance(32);
      return Promise.resolve({ status: 200 });
    };
    const probe = createHubProbe({
      endpoints: [{ id: 'google', url: 'https://www.google.com/' }],
      fetchImpl: fetch,
      now: clock.now,
    });

    probe.sampleIfStale();
    await flush();
    expect(sampleOf(probe.snapshot(), 'google')?.tone).toBe('ok');

    breakGoogle = true;
    clock.advance(HUB_PROBE_INTERVAL_MS);
    probe.sampleIfStale();
    await flush();

    const held = sampleOf(probe.snapshot(), 'google');
    expect(held?.ms).toBe(32); // held, not wiped — the reading is just no longer current
    expect(held?.tone).toBe('dim');
  });

  it('turns a site red only after the failure limit', async () => {
    const clock = makeClock();
    const good = recordingFetch({ clock });
    const probe = createHubProbe({ endpoints: [{ id: 'x', url: 'https://x.com/' }], fetchImpl: good.fetch, now: clock.now });
    probe.sampleIfStale();
    await flush();
    expect(sampleOf(probe.snapshot(), 'x')?.tone).toBe('ok');

    let failRounds = 0;
    const bad: ProbeFetch = () => {
      failRounds += 1;
      return Promise.reject(new Error('down'));
    };
    const failing = createHubProbe({ endpoints: [{ id: 'x', url: 'https://x.com/' }], fetchImpl: bad, now: clock.now });
    for (let round = 0; round < HUB_FAILURE_LIMIT; round += 1) {
      clock.advance(HUB_PROBE_INTERVAL_MS);
      failing.sampleIfStale();
      await flush();
      const tone = sampleOf(failing.snapshot(), 'x')?.tone;
      // Value is held (dimmed) until the limit is reached, then the row goes red.
      expect(tone).toBe(round === HUB_FAILURE_LIMIT - 1 ? 'down' : 'dim');
    }
    expect(failRounds).toBe(HUB_FAILURE_LIMIT);
    expect(sampleOf(failing.snapshot(), 'x')?.ms).toBeUndefined();
  });

  it('dims every value once the round is older than the stale budget', async () => {
    const clock = makeClock();
    const recorder = recordingFetch({ clock });
    const probe = createHubProbe({ fetchImpl: recorder.fetch, now: clock.now });
    probe.sampleIfStale();
    await flush();
    expect(sampleOf(probe.snapshot(), 'tencent')?.tone).toBe('ok');

    clock.advance(HUB_PROBE_INTERVAL_MS * HUB_STALE_MULTIPLIER);
    const stale = probe.snapshot();
    expect(stale.stale).toBe(true);
    expect(stale.samples.every((sample) => sample.tone === 'dim')).toBe(true);
  });

  it('maps latency onto tones at the documented boundary', async () => {
    for (const [latency, tone] of [
      [HUB_GOOD_MS, 'ok'],
      [HUB_GOOD_MS + 1, 'warn'],
    ] as const) {
      const clock = makeClock();
      const probe = createHubProbe({
        endpoints: [{ id: 'github', url: 'https://github.com/' }],
        fetchImpl: recordingFetch({ clock, latency }).fetch,
        now: clock.now,
      });
      probe.sampleIfStale();
      await flush();
      expect(sampleOf(probe.snapshot(), 'github')).toMatchObject({ ms: latency, tone });
    }
  });

  it('a fetch that throws synchronously cannot escape the probe', async () => {
    const clock = makeClock();
    const probe = createHubProbe({
      endpoints: [{ id: 'github', url: 'https://github.com/' }],
      fetchImpl: recordingFetch({ clock, throwSync: true }).fetch,
      now: clock.now,
    });

    expect(() => probe.sampleIfStale()).not.toThrow();
    await flush();

    expect(probe.snapshot().roundAt).toBe(clock.now());
    expect(sampleOf(probe.snapshot(), 'github')?.tone).toBe('dim');
  });

  it('honours a custom endpoint list and keeps the default list frozen', async () => {
    expect(Object.isFrozen(HUB_ENDPOINTS)).toBe(true);
    expect(HUB_ENDPOINTS.map((endpoint) => endpoint.id)).toEqual([
      'github',
      'google',
      'x',
      'huggingface',
      'alibaba',
      'tencent',
    ]);
    // Labels are what the sidebar shows: an ambiguous host gets an explicit one,
    // and nothing may outgrow the shared label column (which would truncate it).
    expect(HUB_ENDPOINTS.find((endpoint) => endpoint.id === 'x')?.label).toBe('x (twitter)');
    for (const endpoint of HUB_ENDPOINTS) {
      expect(displayWidth(endpoint.label ?? endpoint.id)).toBeLessThanOrEqual(SIDEBAR_LABEL_COLS);
    }

    const clock = makeClock();
    const recorder = recordingFetch({ clock });
    const probe = createHubProbe({
      endpoints: [
        { id: 'intranet', url: 'https://intranet.example/' },
        { id: 'registry', url: 'https://registry.example/' },
      ],
      fetchImpl: recorder.fetch,
      now: clock.now,
    });
    probe.sampleIfStale();
    await flush();

    expect(probe.snapshot().samples.map((sample) => sample.id)).toEqual(['intranet', 'registry']);
    expect(recorder.urls).toEqual(['https://intranet.example/', 'https://registry.example/']);
  });
});

describe('hub display helpers', () => {
  it('puts the measured provider row first and keeps probe rows behind it', () => {
    const clock = makeClock();
    const probe = createHubProbe({
      endpoints: [
        { id: 'github', url: 'https://github.com/' },
        { id: 'tencent', url: 'https://cloud.tencent.com/' },
      ],
      fetchImpl: recordingFetch({ clock }).fetch,
      now: clock.now,
    });
    probe.sampleIfStale();
    const snapshot = probe.snapshot();

    const rows = buildHubSamples(snapshot, { ms: 128, sampledAt: clock.now() }, clock.now());
    expect(rows.map((row) => row.id)).toEqual([HUB_MODEL_ROW_ID, 'github', 'tencent']);
    expect(rows[0]).toMatchObject({ ms: 128, tone: 'warn' });
  });

  it('stales the provider row on its own budget, independent of the probes', () => {
    const base = 1_000_000;
    const fresh = { ms: 40, sampledAt: base };
    const idle = { ms: 40, sampledAt: base - HUB_MODEL_STALE_MS };
    const never = { ms: undefined, sampledAt: undefined };

    expect(buildHubSamples(emptySnapshot(), fresh, base)[0]?.tone).toBe('ok');
    // Nothing asked recently: dim, but the number stays — it is not an outage.
    const staleRow = buildHubSamples(emptySnapshot(), idle, base)[0];
    expect(staleRow?.tone).toBe('dim');
    expect(staleRow?.ms).toBe(40);
    expect(buildHubSamples(emptySnapshot(), never, base)[0]).toMatchObject({
      ms: undefined,
      tone: 'dim',
    });
  });

  it('formats readings and tones at the documented boundaries', () => {
    expect(formatHubLatency(12)).toBe('12ms');
    expect(formatHubLatency(999)).toBe('999ms');
    expect(formatHubLatency(1000)).toBe('1.0s');
    expect(formatHubLatency(65_400)).toBe('65.4s');
    expect(hubLatencyTone(HUB_GOOD_MS)).toBe('ok');
    expect(hubLatencyTone(HUB_GOOD_MS + 1)).toBe('warn');
    expect(hubLatencyTone(HUB_GOOD_MS, true)).toBe('dim');
    expect(hubLatencyTone(undefined)).toBe('dim');
  });
});

describe('stale versus outage', () => {
  it('dims an unreachable site once the round is out of date, red only while fresh', async () => {
    const clock = makeClock();
    const probe = createHubProbe({
      endpoints: [{ id: 'x', url: 'https://x.com/' }],
      fetchImpl: () => Promise.reject(new Error('unreachable')),
      now: clock.now,
    });
    for (let round = 0; round < HUB_FAILURE_LIMIT; round += 1) {
      clock.advance(HUB_PROBE_INTERVAL_MS);
      probe.sampleIfStale();
      await flush();
    }
    // A fresh round that failed three times is a real outage report.
    expect(sampleOf(probe.snapshot(), 'x')?.tone).toBe('down');

    // Reopening the sidebar hours later must not flash red before the first new
    // round lands: the stored outage describes the past.
    clock.advance(HUB_PROBE_INTERVAL_MS * HUB_STALE_MULTIPLIER);
    expect(sampleOf(probe.snapshot(), 'x')?.tone).toBe('dim');
  });
});

function emptySnapshot() {
  return { samples: [], roundAt: undefined, stale: false, pending: false };
}
