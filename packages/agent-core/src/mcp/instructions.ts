import type { McpConnectionManager } from './connection-manager';

/**
 * Server instructions from every connected MCP server, as a bullet list.
 *
 * The MCP handshake lets a server describe how its tools should be used
 * (`initialize.instructions`). Those notes are per-connection, so they cannot
 * live in the static system prompt: MCP servers load asynchronously after the
 * prompt is rendered, and a prompt rebuilt later would invalidate the prefix
 * cache. The session injects this text as a reminder once the connections
 * settle, and again when the set of connected servers changes.
 */
export function collectMcpInstructions(mcp: McpConnectionManager | undefined): string {
  if (mcp === undefined) return '';
  const blocks: string[] = [];
  for (const entry of mcp.list()) {
    if (entry.status !== 'connected') continue;
    const text = mcp.resolved(entry.name)?.client.getInstructions?.();
    if (text === undefined) continue;
    blocks.push(`- **${entry.name}**: ${text.replaceAll('\n', '\n  ')}`);
  }
  return blocks.join('\n');
}

/**
 * Wrap collected server instructions in their own third-party block.
 *
 * These strings come from the connected server, not from this runtime, so they
 * must not wear the runtime's `<system-reminder>` marker: the prompt treats
 * only a standalone reminder message as an authoritative directive, and
 * everything else as guidance that cannot grant permissions or consent. The
 * distinct wrapper keeps that distinction visible to the model.
 */
export function formatMcpInstructionsBlock(text: string): string {
  return `<mcp-server-instructions>\n${text}\n</mcp-server-instructions>`;
}
