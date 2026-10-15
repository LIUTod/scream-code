/**
 * Author-declared hints about a tool's behaviour.
 *
 * These are **unverified claims**, consumed by the permission layer in the
 * conservative direction only: a `destructiveHint` can force an approval
 * where another policy would have auto-approved, it never grants one. MCP
 * servers supply them natively (`tools/list` annotations); built-ins leave
 * them unset and rely on the curated tool catalog.
 */
export interface ToolAnnotations {
  /** The tool does not modify any state (files, processes, remote systems). */
  readonly readOnlyHint?: boolean;
  /** The tool may perform destructive or irreversible changes. */
  readonly destructiveHint?: boolean;
  /** Repeating the call with identical arguments is equivalent to one call. */
  readonly idempotentHint?: boolean;
  /** The tool interacts with systems outside the local environment. */
  readonly openWorldHint?: boolean;
}

/**
 * A tool that the model may invoke during generation.
 *
 * The definition is provider-agnostic; each provider implementation converts
 * it to the appropriate wire format (e.g. OpenAI function-calling, Anthropic
 * tool-use, Google function declarations).
 */
export interface Tool {
  /** Unique tool name used to match invocations. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** JSON Schema describing the tool's parameters. */
  parameters: Record<string, unknown>;
  /** Optional author-declared behaviour hints (see {@link ToolAnnotations}). */
  annotations?: ToolAnnotations;
}
