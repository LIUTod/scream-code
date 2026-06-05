import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'pathe';

import { resolveScreamHome } from '#/config/path';
import { McpServerConfigSchema, type McpServerConfig } from '#/config/schema';
import { ErrorCodes, ScreamError } from '#/errors';
import { z } from 'zod';

const McpJsonFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
});

/** Maximum number of parent directories to walk when discovering mcp.json. */
const MAX_PARENT_WALK = 20;

export interface McpJsonPaths {
  readonly user: string;
  readonly project: string;
  /** Parent `.scream-code/mcp.json` paths, ordered from root to shallowest. */
  readonly parents: readonly string[];
}

export interface ResolveMcpJsonPathsInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export function resolveMcpJsonPaths(input: ResolveMcpJsonPathsInput): McpJsonPaths {
  const cwd = resolve(input.cwd);
  return {
    user: join(resolveScreamHome(input.homeDir), 'mcp.json'),
    project: join(cwd, '.scream-code', 'mcp.json'),
    parents: findParentMcpJsonPaths(cwd),
  };
}

/** Walk up from `cwd` collecting `.scream-code/mcp.json` paths (root→shallow). */
function findParentMcpJsonPaths(cwd: string): string[] {
  const paths: string[] = [];
  let dir = dirname(cwd);
  for (let i = 0; i < MAX_PARENT_WALK && dir !== dirname(dir); i++) {
    paths.push(join(dir, '.scream-code', 'mcp.json'));
    dir = dirname(dir);
  }
  // Reverse so root is first, shallowest parent is last.
  return paths.reverse();
}

export interface LoadMcpServersInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

/**
 * Load MCP server declarations from:
 *   1. `~/.scream-code/mcp.json` (lowest priority)
 *   2. Parent `.scream-code/mcp.json` files, root→shallow
 *   3. `<cwd>/.scream-code/mcp.json` (highest project priority)
 *
 * Entries in deeper/nearer directories override those from ancestors, so a
 * monorepo root can define shared MCP servers that child projects inherit
 * and optionally override.
 *
 * Note: project-local entries may spawn stdio commands at session start, so
 * opening a session inside an untrusted checkout will execute whatever its
 * `mcp.json` declares. Only enable this in repos you trust.
 */
export async function loadMcpServers(
  input: LoadMcpServersInput,
): Promise<Record<string, McpServerConfig>> {
  const paths = resolveMcpJsonPaths({ cwd: input.cwd, homeDir: input.homeDir });
  const allPaths = [paths.user, ...paths.parents, paths.project];
  const results = await Promise.all(allPaths.map((p) => readMcpJson(p)));
  return Object.assign({}, ...results);
}

async function readMcpJson(filePath: string): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    if (isFileNotFound(error)) return {};
    throw new ScreamError(ErrorCodes.CONFIG_INVALID, `Failed to read ${filePath}: ${describeError(error)}`, {
      cause: error,
    });
  }

  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new ScreamError(ErrorCodes.CONFIG_INVALID, `Invalid JSON in ${filePath}: ${describeError(error)}`, {
      cause: error,
    });
  }

  try {
    return McpJsonFileSchema.parse(data).mcpServers;
  } catch (error: unknown) {
    throw new ScreamError(ErrorCodes.CONFIG_INVALID, `Invalid MCP server config in ${filePath}: ${describeError(error)}`, {
      cause: error,
    });
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
