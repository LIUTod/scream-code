import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read-only plugin marketplace catalog.
 *
 * This module mirrors the shape the TUI consumes so a main agent can browse the
 * same catalog from inside a session. It intentionally does NOT download or
 * install anything: it only reads a JSON document and returns display fields.
 * Nothing here feeds the permission chain — a marketplace `tier` is a label, and
 * `install` always goes through its own approval gate regardless of it.
 */

/** Env var that overrides the catalog location. Shared name with the TUI copy. */
export const SCREAM_CODE_PLUGIN_MARKETPLACE_URL_ENV = 'SCREAM_CODE_PLUGIN_MARKETPLACE_URL';

/** Default catalog: the marketplace file published in this repository. */
export const SCREAM_CODE_PLUGIN_MARKETPLACE_URL =
  'https://raw.githubusercontent.com/LIUTod/scream-code/main/plugins/marketplace.json';

/** Network budget for a catalog read. The catalog is small; fail fast. */
const MARKETPLACE_FETCH_TIMEOUT_MS = 15_000;

export const PLUGIN_MARKETPLACE_TIERS = ['official', 'curated'] as const;

export type PluginMarketplaceTier = (typeof PLUGIN_MARKETPLACE_TIERS)[number];

export interface PluginMarketplaceEntry {
  readonly id: string;
  readonly displayName: string;
  readonly source: string;
  /** Display-only provenance label. Never an approval shortcut. */
  readonly tier?: PluginMarketplaceTier;
  readonly version?: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
}

export interface PluginMarketplace {
  /** The location actually read (after env/default resolution). */
  readonly source: string;
  readonly version?: string;
  readonly entries: readonly PluginMarketplaceEntry[];
}

interface MarketplaceLocation {
  readonly raw: string;
  readonly kind: 'remote' | 'local';
  readonly resolved: string;
}

export interface LoadPluginMarketplaceOptions {
  /** Explicit catalog location; wins over the env var and the built-in default. */
  readonly source?: string;
  /** Base directory for a relative local-path source. */
  readonly workDir?: string;
  /** Injectable fetch for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Load and parse the marketplace catalog.
 *
 * Throws on an unreadable or malformed catalog; callers surface the failure as a
 * tool error with an actionable `next`.
 */
export async function loadPluginMarketplace(
  options: LoadPluginMarketplaceOptions = {},
): Promise<PluginMarketplace> {
  const location = resolveMarketplaceLocation(
    options.source ?? process.env[SCREAM_CODE_PLUGIN_MARKETPLACE_URL_ENV] ?? SCREAM_CODE_PLUGIN_MARKETPLACE_URL,
    options.workDir,
  );
  const raw = await readMarketplaceText(location, options.fetchImpl ?? fetch);
  return parsePluginMarketplace(raw, location);
}

/**
 * Case-insensitive substring filter over the searchable fields.
 *
 * An empty/omitted query returns every entry, so callers can pass the raw
 * argument straight through.
 */
export function filterMarketplaceEntries(
  entries: readonly PluginMarketplaceEntry[],
  query?: string,
): readonly PluginMarketplaceEntry[] {
  const needle = query?.trim().toLowerCase();
  if (needle === undefined || needle.length === 0) return entries;
  return entries.filter((entry) => {
    const haystack = [
      entry.id,
      entry.displayName,
      entry.description ?? '',
      ...(entry.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

function resolveMarketplaceLocation(source: string, workDir?: string): MarketplaceLocation {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new Error(`Marketplace source is empty (${SCREAM_CODE_PLUGIN_MARKETPLACE_URL_ENV} must not be blank)`);
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { raw: trimmed, kind: 'remote', resolved: trimmed };
  }
  if (trimmed.startsWith('file://')) {
    return { raw: trimmed, kind: 'local', resolved: fileURLToPath(trimmed) };
  }
  return { raw: trimmed, kind: 'local', resolved: resolveLocalPath(trimmed, workDir) };
}

async function readMarketplaceText(
  location: MarketplaceLocation,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (location.kind === 'local') {
    try {
      return await readFile(location.resolved, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read the marketplace file at ${location.resolved}: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }
  const response = await fetchImpl(location.resolved, {
    signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The marketplace at ${location.resolved} returned HTTP ${String(response.status)}`);
  }
  return response.text();
}

/**
 * Parse the catalog document.
 *
 * The array key is tolerated as either `entries` or `plugins` because both
 * shapes are in the wild. Per-entry fields are optional except `source`: without
 * one there is nothing to install. `id` falls back to the manifest name so a
 * hand-written catalog without ids still browses.
 */
export function parsePluginMarketplace(
  raw: string,
  location: MarketplaceLocation,
): PluginMarketplace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The marketplace at ${location.resolved} is not valid JSON: ${messageOf(error)}`, {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new TypeError(`The marketplace at ${location.resolved} must be a JSON object.`);
  }
  const rawEntries = rawEntriesOf(parsed);
  if (rawEntries === undefined) {
    throw new TypeError(
      `The marketplace at ${location.resolved} must contain an "entries" (or "plugins") array.`,
    );
  }

  const entries: PluginMarketplaceEntry[] = [];
  rawEntries.forEach((value, index) => {
    const entry = parseMarketplaceEntry(value, index, location);
    if (entry !== undefined) entries.push(entry);
  });

  return {
    source: location.resolved,
    version: stringField(parsed, 'version'),
    entries,
  };
}

function rawEntriesOf(parsed: Record<string, unknown>): readonly unknown[] | undefined {
  for (const key of ['entries', 'plugins']) {
    const value = parsed[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function parseMarketplaceEntry(
  value: unknown,
  index: number,
  location: MarketplaceLocation,
): PluginMarketplaceEntry | undefined {
  if (!isRecord(value)) return undefined;
  const source =
    stringField(value, 'source') ?? stringField(value, 'url') ?? stringField(value, 'downloadUrl');
  if (source === undefined) {
    // Without an install source the row is informational only; skip it rather
    // than failing the whole catalog on one bad entry.
    return undefined;
  }
  const id = stringField(value, 'id') ?? stringField(value, 'name') ?? `entry-${String(index + 1)}`;
  return {
    id,
    displayName: stringField(value, 'displayName') ?? stringField(value, 'name') ?? id,
    source: resolveEntrySource(source, location),
    tier: parseMarketplaceTier(value),
    version: stringField(value, 'version'),
    description: stringField(value, 'description') ?? stringField(value, 'shortDescription'),
    homepage: stringField(value, 'homepage') ?? stringField(value, 'websiteURL'),
    keywords: stringArrayField(value, 'keywords') ?? stringArrayField(value, 'tags'),
  };
}

function parseMarketplaceTier(value: Record<string, unknown>): PluginMarketplaceTier | undefined {
  const raw = value['tier'];
  if (typeof raw !== 'string') return undefined;
  const tier = raw.trim();
  // Unknown labels are dropped instead of rejected: a tier is a display hint,
  // so a newer catalog must not break an older client.
  return (PLUGIN_MARKETPLACE_TIERS as readonly string[]).includes(tier)
    ? (tier as PluginMarketplaceTier)
    : undefined;
}

function resolveEntrySource(source: string, location: MarketplaceLocation): string {
  const trimmed = source.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('~/') ||
    trimmed === '~' ||
    isAbsolute(trimmed)
  ) {
    return trimmed;
  }
  if (trimmed.startsWith('file://')) return fileURLToPath(trimmed);
  if (location.kind === 'remote') {
    return new URL(trimmed, location.resolved).toString();
  }
  return resolve(dirname(location.resolved), trimmed);
}

function resolveLocalPath(input: string, workDir?: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return isAbsolute(input) ? input : resolve(workDir ?? process.cwd(), input);
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArrayField(
  value: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const raw = value[field];
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return out.length > 0 ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
