import type { Environment } from '@scream-code/jian';
import { z } from 'zod';

import type { SkillRegistry } from '../skill';

export const RawSubagentProfileSchema = z.object({
  description: z.string().optional(),
});

export type RawSubagentProfile = z.infer<typeof RawSubagentProfileSchema>;

export const RawAgentProfileSchema = z.object({
  extends: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPromptPath: z.string().optional(),
  systemPromptTemplate: z.string().optional(),
  promptVars: z.record(z.string(), z.string()).optional(),
  // Exact builtin/user tool names, plus optional MCP glob patterns
  // (`mcp__*`, `mcp__github__*`) that gate which MCP tools the profile sees.
  tools: z.array(z.string()).optional(),
  whenToUse: z.string().optional(),
  subagents: z.record(z.string(), RawSubagentProfileSchema).optional(),
  // Subagent profile names this agent is allowed to spawn. When omitted,
  // the agent cannot spawn subagents (but may inherit from a parent profile).
  spawns: z.array(z.string().min(1)).optional(),
});

export type RawAgentProfile = z.infer<typeof RawAgentProfileSchema>;

/**
 * Runtime context supplied to a system prompt renderer.
 *
 * Captures everything determined at render time rather than at profile-load
 * time: the OS/shell, working directory, AGENTS.md instructions, available
 * skills, and so on. Loaders return renderers; callers invoke them with
 * the live context whenever a concrete prompt is needed.
 */
export interface SystemPromptContext {
  readonly osEnv: Environment;
  readonly cwd: string;
  readonly now?: string | Date;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly skills?: SkillRegistry | string;
  readonly additionalDirsInfo?: string;
  readonly roleAdditional?: string;
}

export type SystemPromptRenderer = (context: SystemPromptContext) => string;

export interface ResolvedAgentProfile {
  name: string;
  description?: string;
  systemPrompt: SystemPromptRenderer;
  tools: string[];
  /**
   * True when `tools` is an explicit contract: the profile definition
   * declared its own `tools:` list, or a pinned session profile supplied
   * `activeTools`. `useProfile` applies such a list verbatim.
   *
   * False for the default resolved set — the root profile (the main agent's
   * default) and anything that only inherits its list. That set has no
   * per-profile contract, so the deferred-tool portal shapes it instead
   * (`ToolManager.defaultShapedToolNames`): deferred group names held back,
   * `DiscoverTools` offered in their place, groups enabled earlier in the
   * session kept.
   */
  toolsExplicit: boolean;
  whenToUse?: string;
  subagents?: Record<string, ResolvedAgentProfile>;
  // Subagent profile names this agent is allowed to spawn. Undefined means
  // no spawning (main agents with no whitelist are treated as unrestricted
  // and pass undefined to allow all configured subagents).
  spawns?: string[];
}
