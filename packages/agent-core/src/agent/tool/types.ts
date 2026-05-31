import type { ExecutableTool } from '../../loop';

export type ToolSource = 'builtin' | 'user' | 'mcp';

export type BuiltinTool<Input = unknown> = ExecutableTool<Input>;

export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
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
