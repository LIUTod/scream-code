import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { getCoreVersion } from '#/version';

import type { MCPToolDefinition, MCPToolResult } from './types';

export const SCREAM_MCP_CLIENT_NAME = 'scream-code';
// Resolved from agent-core's package.json so MCP servers see the real version
// in `initialize` (used for compatibility checks and debugging).
// `getCoreVersion()` falls back to '0.0.0' if the package.json read fails.
export const SCREAM_MCP_CLIENT_VERSION = getCoreVersion();

/**
 * Why-context attached when a runtime client notices its underlying transport
 * has gone away on its own — i.e. {@link RuntimeMcpClient.close} was NOT
 * called. The connection manager turns this into a `failed` status so the
 * UI/SDK do not keep advertising tools backed by a dead transport.
 *
 * - `error` is the last error reported via the SDK's `onerror` channel, if
 *   any. Useful for HTTP where there is no stderr.
 * - `stderr` is the tail of bytes captured from the child process's stderr;
 *   populated only for the stdio transport.
 */
export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

/**
 * Returns the directories this client advertises as its workspace roots (the
 * MCP `roots` capability). Consulted on every `roots/list` request rather than
 * captured once, so a provider that tracks the live workspace is re-read
 * without reconnecting.
 */
export type McpRootsProvider = () => readonly string[];

/**
 * Shape a `roots/list` response from filesystem paths.
 *
 * Roots-aware servers (chrome-devtools-mcp and friends) confine their file
 * writes to the directories listed here; with no `roots` capability they fall
 * back to the OS temp dir, so a screenshot aimed at the workspace gets
 * rejected. The MCP schema carries `file://` URIs — plain paths are not
 * accepted.
 *
 * Paths are normalised with the platform's OWN semantics (then deduplicated,
 * so `/a/` and `/a` collapse to one root). Cross-platform path helpers are
 * deliberately avoided here: they rewrite POSIX names containing backslashes
 * and mangle Windows drive / UNC roots, producing a root that does not exist —
 * which the server drops, taking workspace writes down with it. A filesystem
 * root (`/`) has an empty basename, so the optional `name` is omitted.
 */
export function toRootsResult(paths: readonly string[]): {
  roots: Array<{ uri: string; name?: string }>;
} {
  const seen = new Set<string>();
  const roots: Array<{ uri: string; name?: string }> = [];
  for (const input of paths) {
    const path = resolve(input);
    if (seen.has(path)) continue;
    seen.add(path);
    const root: { uri: string; name?: string } = { uri: pathToFileURL(path).href };
    const name = basename(path);
    if (name.length > 0) root.name = name;
    roots.push(root);
  }
  return { roots };
}

/**
 * Declare the `roots` capability on an SDK client and answer `roots/list` from
 * `provider`. Must run BEFORE `connect()` so the handler is registered by the
 * time the server completes its handshake — and only when the capability was
 * declared, since the SDK refuses to register a `roots/list` handler
 * otherwise (the two travel together at the construction site).
 */
export function installRootsHandler(client: Client, provider: McpRootsProvider): void {
  client.setRequestHandler(ListRootsRequestSchema, async () => toRootsResult(provider()));
}

export interface McpRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

/**
 * Build the `RequestOptions` object accepted by the MCP SDK's `callTool`,
 * including either the configured tool-call timeout, an in-flight abort
 * signal, both, or neither. Returns `undefined` when nothing needs to be
 * passed so the SDK falls back to its defaults.
 *
 * `McpServerConfig.toolTimeoutMs` resolves to `DEFAULT_TOOL_TIMEOUT_MS` when
 * unset, which equals the SDK's own request timeout — a config-derived call
 * therefore arrives here with the same budget the SDK would have applied on
 * its own.
 */
export function buildRequestOptions(
  toolCallTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): McpRequestOptions | undefined {
  if (toolCallTimeoutMs === undefined && signal === undefined) return undefined;
  return { timeout: toolCallTimeoutMs, signal };
}

interface SdkListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export function toMcpToolDefinition(tool: SdkListedTool): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
  };
}

/**
 * Normalise the SDK's `callTool` return into ltod's {@link MCPToolResult}.
 * The SDK can return either the modern `{ content, isError }` shape or a
 * legacy `{ toolResult }` shape; we collapse the legacy shape to a single
 * text content block.
 */
export function toMcpToolResult(result: unknown): MCPToolResult {
  if (typeof result === 'object' && result !== null && 'content' in result) {
    const typed = result as { content: unknown; isError?: unknown };
    if (Array.isArray(typed.content)) {
      return {
        content: typed.content as MCPToolResult['content'],
        isError: typed.isError === true,
      };
    }
  }
  if (typeof result === 'object' && result !== null && 'toolResult' in result) {
    const legacy = (result as { toolResult: unknown }).toolResult;
    return {
      content: [
        {
          type: 'text',
          text: typeof legacy === 'string' ? legacy : JSON.stringify(legacy),
        },
      ],
      isError: false,
    };
  }
  return { content: [], isError: false };
}

/**
 * Returns true when an MCP tool-call failure looks like a dead transport rather
 * than an application-level error. These are the cases where tearing down and
 * reconnecting the server is likely to help.
 */
export function isRetriableMcpCallError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const patterns = [
    /\be?connrefused\b/,
    /\be?connreset\b/,
    /\bepipe\b/,
    /\be?netunreach\b/,
    /\be?hostunreach\b/,
    /fetch failed/,
    /transport not connected/,
    /transport closed/,
    /network error/,
    /maximum reconnection attempts/,
  ];
  return patterns.some((pattern) => pattern.test(message));
}
