/**
 * Latency probe for the sidebar Hub panel: a handful of well-known endpoints,
 * measured so the user can tell at a glance whether the machine's network is
 * reachable right now.
 *
 * Two deliberate design choices:
 *
 * 1. **No timer.** Probing is driven by rendering. The sidebar container stops
 *    rendering entirely while it is closed (see `SidebarContainer.render`), so a
 *    read-through TTL here means zero outbound traffic whenever the panel is out
 *    of sight — and there is no interval to register, pause or leak.
 * 2. **Never blocks a frame.** `sampleIfStale()` fires a round and returns;
 *    callers keep painting the previous snapshot. A dead endpoint costs the
 *    caller nothing beyond one aborted request, and no rejection ever escapes.
 */

/** A round is refreshed when the last one finished this long ago. */
export const HUB_PROBE_INTERVAL_MS = 60_000;
/** Per-request budget: long enough for a slow CDN, short enough to never hang. */
export const HUB_PROBE_TIMEOUT_MS = 1_500;
/** A site stays readable for this many consecutive failed rounds before `--`. */
export const HUB_FAILURE_LIMIT = 3;
/** Older than N intervals, the values are dimmed: the network may have changed. */
export const HUB_STALE_MULTIPLIER = 2;
/** At or below this round trip a reading reads as healthy (green). */
export const HUB_GOOD_MS = 100;
/** Row id for the model provider, whose latency is measured, never probed. */
export const HUB_MODEL_ROW_ID = 'model';
/** A measured provider reading older than this is dimmed: nothing was asked lately. */
export const HUB_MODEL_STALE_MS = 5 * 60_000;

export interface HubEndpoint {
  readonly id: string;
  readonly url: string;
  /** Display text; defaults to `id`. Use it when the host alone is ambiguous
   *  (e.g. `x` is clearer to the reader as `x (twitter)`). */
  readonly label?: string;
}

/** Default probe targets: the endpoints day-to-day development tends to need. */
export const HUB_ENDPOINTS: readonly HubEndpoint[] = Object.freeze([
  { id: 'github', url: 'https://github.com/' },
  { id: 'google', url: 'https://www.google.com/' },
  { id: 'x', url: 'https://x.com/', label: 'x (twitter)' },
  { id: 'huggingface', url: 'https://huggingface.co/' },
  { id: 'aliyun', url: 'https://www.aliyun.com/' },
  { id: 'baidu', url: 'https://www.baidu.com/' },
]);

/** Rendering tone: the panel maps these onto the theme palette. */
export type HubTone = 'ok' | 'warn' | 'down' | 'dim';

export interface HubSample {
  readonly id: string;
  /** Row label as configured (probe rows). Omitted for the model row, whose
   *  label is a translated product term the panel resolves itself. */
  readonly label?: string;
  /** Round trip of the last successful probe; undefined when never measured. */
  readonly ms: number | undefined;
  readonly tone: HubTone;
}

export interface HubSnapshot {
  readonly samples: readonly HubSample[];
  /** Epoch ms when the last round finished; undefined before the first one. */
  readonly roundAt: number | undefined;
  /** The last round is older than {@link HUB_STALE_MULTIPLIER} intervals. */
  readonly stale: boolean;
  /** A round is in flight (the very first one paints as pending). */
  readonly pending: boolean;
}

export interface ProbeRequestInit {
  readonly method: string;
  readonly redirect: string;
  readonly signal: AbortSignal;
}

export interface ProbeResponse {
  readonly status: number;
}

/** Narrow on purpose: we measure the response, we never read or send a body. */
export type ProbeFetch = (url: string, init: ProbeRequestInit) => Promise<ProbeResponse>;

export interface HubProbeOptions {
  readonly endpoints?: readonly HubEndpoint[];
  readonly fetchImpl?: ProbeFetch;
  readonly now?: () => number;
}

export interface HubProbe {
  /** Start a round when the previous one is older than the interval. Fire and
   *  forget: never throws, never awaits, never launches a second round while one
   *  is still running. */
  sampleIfStale(): void;
  /** Last known state, with tones resolved against `now()`. */
  snapshot(): HubSnapshot;
}

interface SiteState {
  ms: number | undefined;
  failures: number;
}

function defaultFetch(url: string, init: ProbeRequestInit): Promise<ProbeResponse> {
  // The narrow init we expose is a subset of the platform RequestInit; the cast
  // keeps the probe free of DOM/undici lib types while still calling real fetch.
  return globalThis.fetch(url, init as RequestInit) as Promise<ProbeResponse>;
}

export function createHubProbe(options: HubProbeOptions = {}): HubProbe {
  const endpoints = options.endpoints ?? HUB_ENDPOINTS;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? defaultFetch;

  const sites = new Map<string, SiteState>();
  for (const endpoint of endpoints) sites.set(endpoint.id, { ms: undefined, failures: 0 });

  let roundAt: number | undefined;
  let inFlight = false;

  const runRound = async (): Promise<void> => {
    const startedAt = now();
    const results = await Promise.allSettled(
      endpoints.map(async (endpoint) => {
        const response = await fetchImpl(endpoint.url, {
          method: 'HEAD',
          // Any HTTP answer proves reachability; following redirects just adds
          // latency we are not trying to measure.
          redirect: 'manual',
          signal: AbortSignal.timeout(HUB_PROBE_TIMEOUT_MS),
        });
        return { id: endpoint.id, ms: Math.max(0, now() - startedAt), status: response.status };
      }),
    );

    for (const [index, result] of results.entries()) {
      const site = sites.get(endpoints[index]!.id);
      if (site === undefined) continue;
      if (result.status === 'fulfilled') {
        // A 4xx/5xx is still a server answering: we time responses, not success.
        site.ms = result.value.ms;
        site.failures = 0;
      } else {
        site.failures += 1;
        if (site.failures >= HUB_FAILURE_LIMIT) site.ms = undefined;
      }
    }

    // Advances even when every site failed: a fully unreachable network must not
    // make every frame kick off a new round of requests.
    roundAt = now();
    inFlight = false;
  };

  return {
    sampleIfStale: () => {
      if (inFlight) return;
      const at = now();
      if (roundAt !== undefined && at - roundAt < HUB_PROBE_INTERVAL_MS) return;
      inFlight = true;
      // Nothing may reject on this path: vitest/CI treat stray rejections as
      // failures, and a probe is never worth an error dialog.
      void runRound().catch(() => {
        inFlight = false;
      });
    },

    snapshot: () => {
      const at = now();
      const stale =
        roundAt === undefined || at - roundAt >= HUB_PROBE_INTERVAL_MS * HUB_STALE_MULTIPLIER;
      const samples: HubSample[] = [];
      for (const endpoint of endpoints) {
        const site = sites.get(endpoint.id)!;
        samples.push({
          id: endpoint.id,
          label: endpoint.label ?? endpoint.id,
          ms: site.ms,
          tone: toneFor(site, stale),
        });
      }
      return { samples, roundAt, stale, pending: inFlight };
    },
  };
}

function toneFor(site: SiteState, stale: boolean): HubTone {
  // Staleness wins over an outage colour: after the sidebar has been closed for
  // a while, the stored readings describe the past. Painting them red would make
  // reopening look like the network just died, one frame before the fresh round
  // lands. A genuinely unreachable site turns red as soon as that round fails.
  if (stale) return 'dim';
  if (site.failures >= HUB_FAILURE_LIMIT) return 'down';
  // A held-over value from a round that missed is informative but not current.
  return hubLatencyTone(site.ms, site.failures > 0);
}

/**
 * Merge the measured provider reading with the probe samples into Hub rows.
 * The provider row always leads (it answers "is the model I'm using reachable"),
 * and it staleness-checks against its own budget: a long idle stretch means
 * nothing was asked, not that the network died.
 */
export function buildHubSamples(
  snapshot: HubSnapshot,
  provider: { ms: number | undefined; sampledAt: number | undefined },
  now: number = Date.now(),
): HubSample[] {
  const ageMs = provider.sampledAt === undefined ? 0 : now - provider.sampledAt;
  const modelRow: HubSample = {
    id: HUB_MODEL_ROW_ID,
    ms: provider.ms,
    tone: hubLatencyTone(provider.ms, ageMs >= HUB_MODEL_STALE_MS),
  };
  return [modelRow, ...snapshot.samples];
}

/** Shared tone rule for every Hub row (probe sites and the measured provider). */
export function hubLatencyTone(ms: number | undefined, stale = false): HubTone {
  if (ms === undefined || stale) return 'dim';
  return ms <= HUB_GOOD_MS ? 'ok' : 'warn';
}

/**
 * Compact latency reading: whole milliseconds below a second, one-decimal
 * seconds above — a probe that never answers must never read as `65400ms`.
 */
export function formatHubLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
