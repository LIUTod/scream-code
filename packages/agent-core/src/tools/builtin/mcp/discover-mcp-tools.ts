/**
 * DiscoverMcpToolsTool — list the MCP tools this session can use and enable
 * the ones it needs.
 *
 * Why this exists: every declared tool costs its JSON schema on every model
 * request. A browser-automation or code-index MCP server can easily expose
 * dozens of tools, which added tens of thousands of tokens per turn before
 * the first user message. Servers therefore default to `exposure:
 * 'on-demand'` (`agent-core` config): tools are registered, callable and
 * permission-checked as usual, but their schemas stay out of the request
 * until the model enables them here. `exposure: 'always'` opts a server
 * back into eager declaration.
 *
 * Modes:
 *   - no arguments        → overview: one line per server with tool counts
 *   - `server`            → that server's withheld tools, one line each
 *   - `tools: [...]`      → enable exactly those qualified names; they are
 *                           offered from the next step on
 */

import { z } from 'zod';

import type { BuiltinTool, ToolManager } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

// ── Input schema ─────────────────────────────────────────────────────

export const DiscoverMcpToolsInputSchema = z
  .object({
    server: z
      .string()
      .min(1)
      .optional()
      .describe('List only this server (its config name, not a qualified tool name).'),
    tools: z
      .array(z.string().min(1))
      .optional()
      .describe('Qualified tool names to enable for this session, e.g. ["mcp__myserver__search"].'),
  })
  .strict();
export type DiscoverMcpToolsInput = z.infer<typeof DiscoverMcpToolsInputSchema>;

// ── Constants ────────────────────────────────────────────────────────

/** One-line description cap for list output; keeps a fat server readable. */
const DESCRIPTION_PREVIEW_CHARS = 160;

function previewDescription(description: string): string {
  const flat = description.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= DESCRIPTION_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, DESCRIPTION_PREVIEW_CHARS)}…`;
}

// ── Implementation ───────────────────────────────────────────────────

export class DiscoverMcpToolsTool implements BuiltinTool<DiscoverMcpToolsInput> {
  readonly name = 'DiscoverMcpTools' as const;
  readonly description =
    'List and enable MCP (external) tools that are not declared by default. ' +
    'MCP servers are on-demand: their tool schemas stay out of the request until you enable ' +
    'them here. No arguments → overview of servers; `server` → that server\'s tools with ' +
    'one-line descriptions; `tools` → enable exactly those qualified names for this session ' +
    '(they appear from the next step on).';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(DiscoverMcpToolsInputSchema);

  constructor(private readonly tools: ToolManager) {}

  resolveExecution(args: DiscoverMcpToolsInput): ToolExecution {
    return {
      description: 'Discovering MCP tools',
      approvalRule: this.name,
      execute: async () => {

        if (args.tools !== undefined && args.tools.length > 0) {
          const { enabled, skipped } = this.tools.enableDeferredMcpTools(args.tools);
          const lines: string[] = [];
          if (enabled.length > 0) {
            lines.push(`enabled: ${String(enabled.length)}`);
            lines.push(...enabled.map((name) => `- ${name}`));
            lines.push('These tools are callable from the next step on.');
          } else {
            lines.push('enabled: 0');
          }
          if (skipped.length > 0) {
            lines.push(
              `skipped: ${String(skipped.length)} (not on-demand, already enabled, or excluded by the active tool patterns)`,
              ...skipped.map((name) => `- ${name}`),
            );
          }
          return { output: lines.join('\n'), isError: false };
        }

        if (args.server !== undefined) {
          const tools = this.tools.listDeferredMcpTools(args.server);
          if (tools.length === 0) {
            return {
              output:
                `No on-demand tools for server "${args.server}". ` +
                'The server is absent, eager (`exposure: always`), or all of its tools are already enabled.',
              isError: false,
            };
          }
          return {
            output: [
              `server: ${args.server}`,
              `tools: ${String(tools.length)}`,
              ...tools.map((t) => `- ${t.name} — ${previewDescription(t.description)}`),
            ].join('\n'),
            isError: false,
          };
        }

        const tools = this.tools.listDeferredMcpTools();
        if (tools.length === 0) {
          return {
            output:
              'No on-demand MCP tools are available. Either no MCP server is connected, ' +
              'every server declares its tools eagerly, or everything accessible is already enabled.',
            isError: false,
          };
        }
        const byServer = new Map<string, string[]>();
        for (const tool of tools) {
          const names = byServer.get(tool.serverName) ?? [];
          names.push(tool.name);
          byServer.set(tool.serverName, names);
        }
        return {
          output: [
            `withheld_tools: ${String(tools.length)}`,
            `servers: ${String(byServer.size)}`,
            ...[...byServer.entries()].map(
              ([server, names]) => `- ${server}: ${String(names.length)} tool(s)`,
            ),
            'Call again with `server` to list one server, or with `tools` to enable specific names.',
          ].join('\n'),
          isError: false,
        };
      },
    };
  }
}
