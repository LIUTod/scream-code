import type { McpServerConfig } from '#/config/schema';

/**
 * Capability semantics for MCP servers.
 *
 * A capability is an open-vocabulary, lowercase label describing *what a
 * server can do* (e.g. `browser`) rather than *what it is called*. Downstream
 * consumers (system-prompt guide injectors, the `/mcp` panel, future
 * scenario helpers) key off capabilities instead of hard-coded server names,
 * so renamed or third-party servers with the same behavior keep working.
 *
 * Resolution priority:
 *   1. Explicit `capabilities` in the server config (highest). An explicit
 *      empty array is a legitimate value: it opts the entry out of
 *      fingerprinting entirely.
 *   2. Built-in fingerprints matched against name / launch args.
 *   3. Otherwise: no capabilities.
 *
 * All functions here are pure and defensive: the runtime `addServer` path
 * (`session/rpc.ts`) forwards client payloads straight into the connection
 * manager *without* schema validation, so `config` may carry dirty values.
 * Dirty input must degrade to fingerprinting, never throw.
 */

export interface McpCapabilityPattern {
  readonly capability: string;
  readonly matches: (name: string, config: McpServerConfig) => boolean;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Normalize a declared list: string items only, trimmed, lowercased, deduped. */
function normalizeCapabilityList(value: readonly unknown[]): readonly string[] {
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase();
    if (normalized.length > 0 && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * `args` lives only on the stdio branch of the discriminated union, and the
 * runtime addServer path may carry unvalidated payloads — read it defensively
 * so fingerprints never throw regardless of transport or shape.
 */
function stringArgsOf(config: McpServerConfig): readonly string[] | undefined {
  const args = (config as { args?: unknown }).args;
  return isStringArray(args) ? args : undefined;
}

/**
 * Built-in fingerprint table. Keep entries cheap and conservative — a false
 * capability just shows a label / injects a guide; the user can always opt
 * out with an explicit `capabilities: []`.
 */
export const MCP_CAPABILITY_PATTERNS: readonly McpCapabilityPattern[] = [
  {
    // Chrome DevTools MCP server, whether installed under its default name,
    // a custom name, or via a cloned checkout: the launch package name in
    // args is the stable signal.
    capability: 'browser',
    matches: (name, config) =>
      name === 'chrome-devtools'
      || stringArgsOf(config)?.some((arg) => arg.includes('chrome-devtools-mcp')) === true,
  },
  {
    capability: 'memory',
    matches: (name, config) =>
      name === 'scream-life'
      || stringArgsOf(config)?.some((arg) => arg.includes('scream-life')) === true,
  },
];

function fingerprintCapabilities(name: string, config: McpServerConfig): readonly string[] {
  const out: string[] = [];
  for (const pattern of MCP_CAPABILITY_PATTERNS) {
    try {
      if (pattern.matches(name, config)) out.push(pattern.capability);
    } catch {
      // A fingerprint must never break connection bookkeeping.
    }
  }
  return out;
}

/**
 * Resolve the effective capabilities of one MCP server entry.
 * Never throws; returns `[]` for unknown servers.
 */
export function resolveServerCapabilities(
  name: string,
  config: McpServerConfig,
): readonly string[] {
  const raw = (config as { capabilities?: unknown }).capabilities;
  if (Array.isArray(raw)) {
    // Explicit key present (even dirty): declaration wins. A dirty array
    // (e.g. `["", 42]`) normalizes; if every item was garbage the result is
    // `[]`, which reads as "declared: none" — the conservative outcome.
    return normalizeCapabilityList(raw);
  }
  return fingerprintCapabilities(name, config);
}
