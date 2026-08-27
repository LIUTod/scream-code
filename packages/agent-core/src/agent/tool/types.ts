import type { ExecutableTool, ExecutableToolContext, ExecutableToolResult } from '../../loop';

export type ToolSource = 'builtin' | 'user' | 'mcp';

export type BuiltinTool<Input = unknown> = ExecutableTool<Input>;

/**
 * The serializable half of a registration — what the wire record and the
 * host-facing `registerTool` RPC carry.
 */
export interface UserToolRegistrationBase {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface UserToolRegistration extends UserToolRegistrationBase {
  /**
   * In-process implementation. When present the tool runs it directly instead of
   * round-tripping to the host over `rpc.toolCall`, which is what a code plugin
   * needs: its closure is in this process and the host has no way to call it.
   * Thrown errors are converted to an `isError` result so plugin code can never
   * break the agent loop.
   *
   * Deliberately not part of the wire record: a function cannot be serialized,
   * so replay re-registers the tool without it and the RPC callback path applies.
   */
  readonly execute?:
    | ((
        args: Record<string, unknown>,
        context: ExecutableToolContext,
      ) => ExecutableToolResult | Promise<ExecutableToolResult>)
    | undefined;
  /**
   * Plugin that owns this tool. Recording the owner is what lets removing (or
   * disabling) a plugin drop exactly its own tools from a running agent instead
   * of leaving a tool whose implementation is gone.
   */
  readonly ownerPluginId?: string | undefined;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly source: ToolSource;
}

export interface McpToolCollision {
  readonly qualified: string;
  readonly toolName: string;
  readonly collidesWith:
    | { readonly kind: 'same_server'; readonly toolName: string }
    | { readonly kind: 'other_server'; readonly serverName: string };
}

export interface McpServerRegistrationResult {
  readonly registered: readonly string[];
  readonly collisions: readonly McpToolCollision[];
}
