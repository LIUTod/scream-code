/**
 * Idle cache-warmer: keeps a session's provider prompt cache alive while the
 * agent sits idle.
 *
 * Providers (Anthropic) cache the request prefix — `[system][tool
 * declarations][messages]` — by exact byte match, and a cache entry expires
 * after a provider-declared TTL (5 minutes on the default tier, 1 hour when
 * the alias declares `cacheRetention: 'long'`). A user who thinks for ten
 * minutes between turns pays full input price on the entire prefix again.
 *
 * The warmer closes that gap: it captures the LAST routed request of a turn
 * (the agent's main-loop generate — see `Agent.get llm`), schedules a single
 * timer at ~90% of the declared TTL, and on tick — gated on idle, prefix
 * unchanged, and an expected dollar saving clearing the configured minimum —
 * replays the captured request verbatim. The replay response is discarded;
 * its only product is a refreshed cache entry, which the next real turn
 * then hits at the cache-read price instead of full input price.
 *
 * The replay deliberately burns tokens; that is the cost model, not a bug:
 * expectedSaving = (fullInputPrice - cacheReadPrice) * cachedPrefixTokens
 *                  - the replay's own estimated cost (its uncached input
 *                  tail plus an assumed output size — see
 *                  ASSUMED_REPLAY_OUTPUT_TOKENS)
 * must clear `minSavingsUsd` before anything is scheduled, and aliases that
 * do not declare `cacheRetention` (or whose model has no catalog pricing)
 * are never eligible. A provider without prompt caching must not enable
 * this — there is no cache to protect, so every replay is a pure loss.
 *
 * Tokens the replay consumes are recorded through the agent's normal usage
 * accounting (session scope, like compaction), so /usage stays honest.
 */

import { readFileSync } from 'node:fs';
import { join } from 'pathe';

import type { ChatProvider, Message, ModelPrice, TokenUsage, Tool } from '@scream-code/ltod';

import type { GenerateFn } from './turn/ltod-llm';
import {
  messageFingerprint,
  toolDeclarationsFingerprint,
  type ToolDeclaration,
} from './context/prefix-fingerprint';

/** Provider prompt-cache TTL tiers, mirroring the Anthropic adapter's
 *  `cacheRetention` mapping (short = 5-minute default tier, long = the
 *  1-hour tier with the extended-cache-ttl beta). */
const CACHE_TTL_MS = { short: 5 * 60_000, long: 60 * 60_000 } as const;
export type CacheRetentionTier = keyof typeof CACHE_TTL_MS;

/** Fire at 90% of the TTL so the refresh lands before expiry, minus a
 *  10s scheduling slop, floored at 15s so a misconfigured tier can never
 *  produce a hot loop. */
const REPLAY_MARGIN_RATIO = 0.9;
const REPLAY_MARGIN_SUBTRACT_MS = 10_000;
const MIN_DELAY_MS = 15_000;

/** Default `loop_control.cache_warmer.min_savings_usd`. Comfortably above a
 *  short replay's own output cost at current catalog pricing, and small
 *  enough to protect a normal session prefix (≈25k cached tokens at a
 *  typical 3.0 input vs 0.3 cache-read rate). */
export const DEFAULT_MIN_SAVINGS_USD = 0.05;

/**
 * Output tokens assumed for one replay when pricing its own cost in the
 * net-savings gate. The replay's INPUT is fully known — it re-sends the
 * captured bytes verbatim — but its OUTPUT is the dominant uncontrolled
 * term, and the response is discarded, so a generous bound beats an
 * optimistic guess: a mid-turn context replay is a single completion with
 * no tool loop and finishes well under 2000 tokens on every supported
 * wire. Over-estimating only makes the gate stricter, never looser.
 */
const ASSUMED_REPLAY_OUTPUT_TOKENS = 2_000;

/** Timer delay for one refresh cycle of the given cache tier. */
export function cacheWarmerDelayMs(retention: CacheRetentionTier): number {
  return Math.max(MIN_DELAY_MS, CACHE_TTL_MS[retention] * REPLAY_MARGIN_RATIO - REPLAY_MARGIN_SUBTRACT_MS);
}

/**
 * Opaque fingerprint of a full provider request: tool declaration table plus
 * per-message fingerprints (the same primitives the prefix-stability
 * observer uses), joined with separators beyond the \u0000-\u0004 range that
 * module already uses so the concatenation cannot alias.
 *
 * The warmer compares fingerprints PREFIX-WISE, not for equality: after a
 * turn ends, the context legitimately grows (assistant response, tool
 * results, new user input) — appends preserve the cached prefix. Equality
 * would therefore reject every healthy capture; a prefix match rejects only
 * genuine mutations (compaction, message edits, tool table changes).
 */
export function requestFingerprint(
  tools: readonly ToolDeclaration[],
  messages: readonly Message[],
): string {
  return `${toolDeclarationsFingerprint(tools)}\u0005${messages.map(messageFingerprint).join('\u0006')}`;
}

interface ParsedFingerprint {
  readonly toolFp: string;
  readonly msgFps: readonly string[];
}

function parseFingerprint(fingerprint: string): ParsedFingerprint | undefined {
  const separator = fingerprint.indexOf('\u0005');
  if (separator === -1) return undefined;
  return {
    toolFp: fingerprint.slice(0, separator),
    msgFps: fingerprint.slice(separator + 1).split('\u0006'),
  };
}

/** True when the captured request's bytes are still a prefix of the live request. */
function fingerprintPrefixMatches(captured: ParsedFingerprint, live: ParsedFingerprint): boolean {
  if (live.toolFp !== captured.toolFp) return false;
  if (live.msgFps.length < captured.msgFps.length) return false;
  return captured.msgFps.every((fp, index) => fp === live.msgFps[index]);
}

/** Everything `noteRoutedRequest` needs to own one warm-eligible request. */
export interface CacheWarmerRequestInput {
  /** Provider instance the original request used (replayed verbatim). */
  readonly provider: ChatProvider;
  /** Usage-record key for the replay — the session's model alias (the same
   *  key the main loop records under); may be undefined on unusual setups. */
  readonly aliasName: string | undefined;
  readonly systemPromptBlocks: string | string[];
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  /** Usage of the original request; sizes the protected saving. */
  readonly usage: TokenUsage | undefined;
  /** Alias cache TTL tier; undefined = the alias never opted into prompt
   *  caching (e.g. a non-Anthropic wire) → never eligible. */
  readonly cacheRetention: CacheRetentionTier | undefined;
  /** Alias pricing from the model catalog; undefined = the savings gate
   *  cannot run → never eligible (logged once). */
  readonly price: ModelPrice | undefined;
  /** Fingerprint of THIS exact request (`requestFingerprint(tools, messages)`). */
  readonly fingerprint: string;
}

export interface CacheWarmerDeps {
  /** Read fresh at both capture and tick time so runtime config changes apply. */
  getEnabled: () => boolean;
  getMinSavingsUsd: () => number;
  /** The agent's generate entry point (auth-resolving wrapper included) —
   *  the replay is an ordinary routed-shaped call through the same path. */
  generate: GenerateFn;
  /** Fingerprint of what the NEXT routed request would send right now (live
   *  context view — the caller computes it with `requestFingerprint`). */
  getFingerprint: () => string | undefined;
  /** False while a turn is in flight; the tick never fires mid-turn. */
  isIdle: () => boolean;
  /** Injectable for tests; the default is a plain setTimeout slot. */
  scheduleTimer?: (cb: () => void, ms: number) => void;
  clearTimer?: () => void;
  /** Where the replay's token burn is recorded (the agent's usage recorder,
   *  session scope — the same accounting compaction uses). */
  recordUsage?: (model: string, usage: TokenUsage) => void;
  log?: (message: string) => void;
}

interface CapturedRequest {
  readonly provider: ChatProvider;
  readonly aliasName: string | undefined;
  readonly systemPromptBlocks: string | string[];
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly cachedTokens: number;
  /** Uncached input tokens of the captured request (the tail beyond the
   *  last cache breakpoint) — sizes the replay's own input cost in the
   *  net-savings gate. */
  readonly inputOtherTokens: number;
  readonly fingerprint: ParsedFingerprint;
  readonly retention: CacheRetentionTier;
  readonly price: ModelPrice;
}

/** Number of input tokens the provider reported as cache-backed for the
 *  captured request. These are the tokens the next real turn would re-pay at
 *  full input price if the entry expired — the quantity the warmer protects.
 *  Uncached input (`inputOther`, typically the tail beyond the last cache
 *  breakpoint) is never cache-protected and stays out of the estimate. */
function cachedPrefixTokens(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation;
}

/**
 * One warmer per agent (session tenant). Holds at most one captured request
 * — always the LATEST routed one — and at most one pending timer. A model
 * switch or tool-table change is not special-cased: the next routed request
 * replaces the capture wholesale.
 */
export class CacheWarmer {
  private captured: CapturedRequest | undefined;
  private disposed = false;
  private warnedNoPricing = false;

  private readonly scheduleTimerFn: NonNullable<CacheWarmerDeps['scheduleTimer']>;
  private readonly clearTimerFn: NonNullable<CacheWarmerDeps['clearTimer']>;
  /** Slot for the default timer implementation when the owner does not inject one. */
  private defaultTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: CacheWarmerDeps) {
    this.scheduleTimerFn =
      deps.scheduleTimer ??
      ((cb, ms) => {
        this.defaultTimer = setTimeout(cb, ms);
      });
    this.clearTimerFn =
      deps.clearTimer ??
      (() => {
        if (this.defaultTimer !== undefined) {
          clearTimeout(this.defaultTimer);
          this.defaultTimer = undefined;
        }
      });
  }

  /**
   * Capture the latest routed request. Called by the agent after every
   * successful main-loop generate. Always replaces the previous capture;
   * clears any pending timer first so exactly one request is ever warm.
   */
  noteRoutedRequest(input: CacheWarmerRequestInput): void {
    if (this.disposed) return;
    this.clearTimerFn();
    this.captured = undefined;

    if (!this.deps.getEnabled()) return;
    if (input.cacheRetention === undefined) {
      // Alias never opted into prompt caching (non-Anthropic wire, or the
      // field unset) — there is no provider cache to protect.
      return;
    }
    if (input.price === undefined) {
      // No pricing source for this alias: the savings gate cannot run, and
      // scheduling a replay without a cost bound would be reckless.
      if (!this.warnedNoPricing) {
        this.warnedNoPricing = true;
        this.deps.log?.(
          'cache warmer disabled for this alias: no model pricing available, so the savings gate cannot be evaluated',
        );
      }
      return;
    }
    const usage = input.usage;
    if (usage === undefined) {
      // Provider reported no usage: cannot size the protected prefix.
      return;
    }
    const cachedTokens = cachedPrefixTokens(usage);
    if (cachedTokens <= 0) {
      // Nothing was cache-backed on the routed request — either the provider
      // did not cache anything or the prefix is below the minimum cacheable
      // size. Nothing to protect.
      return;
    }
    const fingerprint = parseFingerprint(input.fingerprint);
    if (fingerprint === undefined) return;

    this.captured = {
      provider: input.provider,
      aliasName: input.aliasName,
      systemPromptBlocks: input.systemPromptBlocks,
      tools: input.tools,
      messages: input.messages,
      cachedTokens,
      inputOtherTokens: usage.inputOther,
      fingerprint,
      retention: input.cacheRetention,
      price: input.price,
    };
    this.arm();
  }

  /** Tear down for agent close: no pending timer may survive its owner. */
  dispose(): void {
    this.disposed = true;
    this.captured = undefined;
    this.clearTimerFn();
  }

  private arm(): void {
    if (this.disposed || this.captured === undefined) return;
    this.clearTimerFn();
    this.scheduleTimerFn(() => {
      void this.tick();
    }, cacheWarmerDelayMs(this.captured.retention));
  }

  private async tick(): Promise<void> {
    // Single-shot timer: consume it first so a failure path cannot leave a
    // zombie timer behind.
    this.clearTimerFn();
    const captured = this.captured;
    if (captured === undefined || this.disposed) return;
    if (!this.deps.getEnabled()) return;
    // A turn started (or is running): its own routed request will re-capture
    // and re-arm. Do not re-arm here — the busy turn re-owns the schedule.
    if (!this.deps.isIdle()) return;

    const live = this.deps.getFingerprint();
    if (live === undefined) return;
    const liveFingerprint = parseFingerprint(live);
    if (liveFingerprint === undefined || !fingerprintPrefixMatches(captured.fingerprint, liveFingerprint)) {
      // The prefix mutated since capture (compaction, message edit, tool
      // table change): the cached bytes the replay would refresh are no
      // longer the next request's prefix, so the capture is worthless.
      // Reset and wait for the next routed request.
      this.captured = undefined;
      this.deps.log?.('cache warmer skipped: request prefix changed since the last routed request');
      return;
    }

    // Net-savings gate, priced with ltod's `estimateCost` unit conventions
    // (USD per 1M tokens). Protected side: the full-input price the next
    // real turn would pay on the cached prefix if the entry expired. Cost
    // side: the replay's own burn — its uncached input tail (the capture's
    // `inputOther`, re-sent at full price) plus ASSUMED_REPLAY_OUTPUT_TOKENS
    // at the output rate. Output price is always available here: ModelPrice
    // requires `output` and createCatalogPricingLookup only yields prices
    // for catalog entries that carry both input and output, so no
    // input-only fallback branch is needed. Subtracting the replay cost
    // matters on marginal prefixes: a cached slice can clear the gross
    // saving while the replay as a whole is net-negative.
    const cacheReadPrice = captured.price.cacheRead ?? captured.price.input;
    const protectedSavingUsd = ((captured.price.input - cacheReadPrice) * captured.cachedTokens) / 1_000_000;
    const replayCostUsd =
      (captured.inputOtherTokens * captured.price.input + ASSUMED_REPLAY_OUTPUT_TOKENS * captured.price.output) /
      1_000_000;
    const expectedSavingUsd = protectedSavingUsd - replayCostUsd;
    if (expectedSavingUsd < this.deps.getMinSavingsUsd()) return;

    try {
      const result = await this.deps.generate(
        captured.provider,
        captured.systemPromptBlocks,
        [...captured.tools],
        [...captured.messages],
      );
      // Honest accounting: the replay's burn lands in /usage under the
      // captured alias, session scope (the same shape compaction records).
      // A provider that reports no usage is not recorded as free.
      if (result.usage !== null && this.deps.recordUsage !== undefined && !this.disposed) {
        this.deps.recordUsage(captured.aliasName ?? captured.provider.modelName, result.usage);
      }
    } catch (error) {
      // Idle-time failure (network blip, auth expiry): log and retry on the
      // next cycle — the TTL cadence bounds the retry rate by itself.
      this.deps.log?.(
        `cache warmer replay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The cache is fresh again (or the retry is scheduled): re-arm from now.
    // The capture stays valid — its bytes were just re-sent unchanged.
    this.arm();
  }
}

// ─── Alias pricing from the on-disk model catalog ──────────────────────────

/**
 * The model catalog snapshot (models.dev) is cached at
 * `<scream home>/catalog-cache.json` by the product's catalog fetcher; it is
 * the same source the usage panel prices token records with. Prices are USD
 * per 1M tokens and are keyed by catalog model id — aliases name their
 * underlying model either as `providerId/modelId` (catalog-stamped) or a
 * bare/custom model id, so both spellings are indexed, exact
 * `providerId/modelId` preferred.
 */
interface CatalogCostEntry {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cache_read?: unknown;
  readonly cache_write?: unknown;
}

export type AliasPricingLookup = (
  alias: { readonly provider?: string | undefined; readonly model: string },
) => ModelPrice | undefined;

/**
 * Build an alias → price lookup from the cached catalog. Returns a lookup
 * that always yields `undefined` when no home (or no readable cache file)
 * exists — the warmer degrades to never scheduling instead of guessing a
 * price. The snapshot is read once per lookup instance and memoized; a
 * long-lived session may hold slightly stale list prices, which is
 * acceptable for a savings *gate* (the /usage panel reads the same file
 * fresh per render).
 */
export function createCatalogPricingLookup(screamHomeDir: string | undefined): AliasPricingLookup {
  if (screamHomeDir === undefined) return () => undefined;
  // Lazy + memoized: the capture path is the only reader, and reading on
  // every routed step would re-parse a potentially large JSON blob.
  let cache: Map<string, ModelPrice> | undefined;
  const read = (): Map<string, ModelPrice> => {
    if (cache !== undefined) return cache;
    cache = new Map();
    try {
      // Mirrors the node-sdk cache file shape: a bare catalog (legacy) or
      // `{ catalog, etag, fetchedAt }`.
      const raw = JSON.parse(readCatalogCacheFile(screamHomeDir)) as unknown;
      const catalog =
        typeof raw === 'object' && raw !== null && 'catalog' in raw
          ? (raw as { catalog?: unknown }).catalog
          : raw;
      if (typeof catalog !== 'object' || catalog === null) return cache;
      for (const [providerId, provider] of Object.entries(catalog as Record<string, unknown>)) {
        if (typeof provider !== 'object' || provider === null) continue;
        const models = (provider as { models?: unknown }).models;
        if (typeof models !== 'object' || models === null) continue;
        for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
          if (typeof entry !== 'object' || entry === null) continue;
          const cost = (entry as { cost?: unknown }).cost as CatalogCostEntry | undefined;
          if (cost === undefined || typeof cost !== 'object') continue;
          if (typeof cost.input !== 'number' || typeof cost.output !== 'number') continue;
          const price: ModelPrice = {
            input: cost.input,
            output: cost.output,
            ...(typeof cost.cache_read === 'number' ? { cacheRead: cost.cache_read } : {}),
            ...(typeof cost.cache_write === 'number' ? { cacheWrite: cost.cache_write } : {}),
          };
          // Bare model id last-wins across providers, exactly like the usage
          // panel's index; the exact `providerId/modelId` spelling is
          // unambiguous and preferred at lookup time.
          cache.set(modelId, price);
          cache.set(`${providerId}/${modelId}`, price);
        }
      }
    } catch {
      cache = new Map();
    }
    return cache;
  };
  return (alias) => {
    const prices = read();
    return (
      (alias.provider !== undefined ? prices.get(`${alias.provider}/${alias.model}`) : undefined) ??
      prices.get(alias.model)
    );
  };
}

function readCatalogCacheFile(screamHomeDir: string): string {
  return readFileSync(join(screamHomeDir, 'catalog-cache.json'), 'utf-8');
}
