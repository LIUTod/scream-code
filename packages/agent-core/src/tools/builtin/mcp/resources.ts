/**
 * MCP resource tools — the same three names and semantics the other agents in
 * this space converged on (`list_mcp_resources`, `list_mcp_resource_templates`,
 * `read_mcp_resource`), so a model that knows one of them knows all three:
 *
 *   - `server` is optional; omitting it covers every connected server
 *   - pagination is not exposed: our client lists a server's resources in one call
 *   - output is JSON so the model can reason about URIs without re-parsing prose
 *
 * They exist as host tools rather than synthetic MCP tools because our MCP
 * registration path carries descriptors only (execution is always `callTool`),
 * and a resource read is not a tool call.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { McpConnectionManager } from '../../../mcp/connection-manager';
import type { MCPClient } from '../../../mcp/types';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const ServerArg = z
  .string()
  .min(1)
  .optional()
  .describe('Server config name. Omit to cover every connected server.');

export const ListMcpResourcesInputSchema = z
  .object({
    server: ServerArg,
  })
  .strict();
export type ListMcpResourcesInput = z.infer<typeof ListMcpResourcesInputSchema>;

export const ListMcpResourceTemplatesInputSchema = z
  .object({ server: ServerArg })
  .strict();
export type ListMcpResourceTemplatesInput = z.infer<typeof ListMcpResourceTemplatesInputSchema>;

export const ReadMcpResourceInputSchema = z
  .object({
    server: z.string().min(1).describe('Server config name.'),
    uri: z.string().min(1).describe('Resource URI, as listed by list_mcp_resources.'),
  })
  .strict();
export type ReadMcpResourceInput = z.infer<typeof ReadMcpResourceInputSchema>;

interface ConnectedServer {
  readonly name: string;
  readonly client: MCPClient;
}

/** Connected servers with a client, optionally narrowed to one name. */
function connectedServers(mcp: McpConnectionManager, server?: string): ConnectedServer[] {
  const names = server === undefined ? mcp.list().map((entry) => entry.name) : [server];
  const servers: ConnectedServer[] = [];
  for (const name of names) {
    const resolved = mcp.resolved(name);
    if (resolved !== undefined) servers.push({ name, client: resolved.client });
  }
  return servers;
}

function unknownServer(server: string, mcp: McpConnectionManager): string {
  const entries = mcp.list();
  if (entries.length === 0) return 'No MCP servers are configured.';
  const configured = entries.find((entry) => entry.name === server);
  if (configured !== undefined) {
    // Configured but not connected is a different fix for the caller than a typo.
    return `MCP server "${server}" is configured but not connected (status: ${configured.status}).`;
  }
  return `No MCP server named "${server}". Configured: ${entries.map((entry) => entry.name).join(', ')}.`;
}

export class ListMcpResourcesTool implements BuiltinTool<ListMcpResourcesInput> {
  readonly name = 'ListMcpResources' as const;
  readonly description =
    'List MCP resources. Omit `server` to cover every connected server. Returns JSON with ' +
    '`resources` (each carrying its `server`) and an `instructions` map for servers that sent ' +
    'any during the handshake.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListMcpResourcesInputSchema);
  readonly annotations = { readOnlyHint: true, openWorldHint: true } as const;

  constructor(private readonly tools: { mcp?: McpConnectionManager }) {}

  resolveExecution(args: ListMcpResourcesInput): ToolExecution {
    return {
      description: 'Listing MCP resources',
      approvalRule: this.name,
      execute: async () => {
        const mcp = this.tools.mcp;
        if (mcp === undefined) return { output: 'MCP is not configured.', isError: true };
        const servers = connectedServers(mcp, args.server);
        if (servers.length === 0) {
          return {
            output: args.server === undefined ? 'No MCP servers are connected.' : unknownServer(args.server, mcp),
            isError: args.server !== undefined,
          };
        }

        const resources: Array<Record<string, unknown>> = [];
        const instructions: Record<string, string> = {};
        const failures: Array<{ server: string; error: string }> = [];
        for (const { name, client } of servers) {
          if (client.listResources === undefined) continue;
          const text = client.getInstructions?.();
          if (text !== undefined) instructions[name] = text;
          // One broken server must not hide every other server's resources.
          try {
            for (const resource of await client.listResources()) {
              resources.push({ server: name, ...resource });
            }
          } catch (error) {
            failures.push({ server: name, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (resources.length === 0 && Object.keys(instructions).length === 0) {
          return {
            output: JSON.stringify({ resources: [], note: 'No server advertises resources.' }),
            isError: false,
          };
        }
        return {
          output: JSON.stringify({
            resources,
            ...(Object.keys(instructions).length === 0 ? {} : { instructions }),
            ...(failures.length === 0 ? {} : { failures }),
          }),
          isError: false,
        };
      },
    };
  }
}

export class ListMcpResourceTemplatesTool implements BuiltinTool<ListMcpResourceTemplatesInput> {
  readonly name = 'ListMcpResourceTemplates' as const;
  readonly description =
    'List MCP resource templates (URI patterns a server can expand). Omit `server` for all connected servers.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    ListMcpResourceTemplatesInputSchema,
  );
  readonly annotations = { readOnlyHint: true, openWorldHint: true } as const;

  constructor(private readonly tools: { mcp?: McpConnectionManager }) {}

  resolveExecution(args: ListMcpResourceTemplatesInput): ToolExecution {
    return {
      description: 'Listing MCP resource templates',
      approvalRule: this.name,
      execute: async () => {
        const mcp = this.tools.mcp;
        if (mcp === undefined) return { output: 'MCP is not configured.', isError: true };
        const servers = connectedServers(mcp, args.server);
        if (servers.length === 0) {
          return {
            output: args.server === undefined ? 'No MCP servers are connected.' : unknownServer(args.server, mcp),
            isError: args.server !== undefined,
          };
        }
        const templates: Array<Record<string, unknown>> = [];
        const failures: Array<{ server: string; error: string }> = [];
        for (const { name, client } of servers) {
          if (client.listResourceTemplates === undefined) continue;
          try {
            for (const template of await client.listResourceTemplates()) {
              templates.push({ server: name, ...template });
            }
          } catch (error) {
            failures.push({ server: name, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return {
          output: JSON.stringify({
            resourceTemplates: templates,
            ...(failures.length === 0 ? {} : { failures }),
          }),
          isError: false,
        };
      },
    };
  }
}

export class ReadMcpResourceTool implements BuiltinTool<ReadMcpResourceInput> {
  readonly name = 'ReadMcpResource' as const;
  readonly description =
    'Read one MCP resource by `server` + `uri`. Text contents are returned as-is; a resource ' +
    'without text content reports its MIME type so the caller knows it is binary.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadMcpResourceInputSchema);
  readonly annotations = { readOnlyHint: true, openWorldHint: true } as const;

  constructor(private readonly tools: { mcp?: McpConnectionManager }) {}

  resolveExecution(args: ReadMcpResourceInput): ToolExecution {
    return {
      description: `Reading MCP resource ${args.uri}`,
      approvalRule: this.name,
      execute: async () => {
        const mcp = this.tools.mcp;
        if (mcp === undefined) return { output: 'MCP is not configured.', isError: true };
        const resolved = mcp.resolved(args.server);
        if (resolved === undefined) return { output: unknownServer(args.server, mcp), isError: true };
        const { client } = resolved;
        if (client.readResource === undefined) {
          return { output: `Server "${args.server}" cannot read resources.`, isError: true };
        }
        const content = await client.readResource(args.uri);
        if (content.text !== undefined) return { output: content.text, isError: false };
        return {
          output: JSON.stringify({
            uri: content.uri,
            mimeType: content.mimeType ?? null,
            note: 'Resource has no text content (binary or unsupported).',
          }),
          isError: false,
        };
      },
    };
  }
}
