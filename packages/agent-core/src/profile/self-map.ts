import { join } from 'pathe';

import { resolveConfigPath } from '../config/path';

export interface BuildSelfMapOptions {
  /** Scream home directory (usually ~/.scream-code, overridable via SCREAM_CODE_HOME). */
  readonly homeDir: string;
  /**
   * OS user home directory (homedir()). User-level AGENTS.md and skills are
   * anchored to this (e.g. ~/.scream-code/AGENTS.md) regardless of
   * SCREAM_CODE_HOME, matching loadAgentsMd / resolveSkillInstallPaths.
   */
  readonly userHomeDir: string;
  /** Current working directory (used to derive project-level paths). */
  readonly cwd: string;
}

/**
 * Build the "Self Assets" block injected into the system prompt via the
 * SCREAM_SELF_ASSETS template variable.
 *
 * Its primary purpose is self-awareness: it tells the model what its
 * persistent self is (configuration and data), where it lives, and what it
 * may never touch. It is intentionally informational only — it does not
 * invite self-modification and introduces no write path.
 *
 * Pure and synchronous by design: `buildTemplateVars` (profile/resolve.ts) is
 * synchronous and is the single render path for every agent profile.
 */
export function buildSelfMap(options: BuildSelfMapOptions): string {
  const home = options.homeDir;
  const userHome = options.userHomeDir;
  const cwd = options.cwd;

  const configPath = resolveConfigPath({ homeDir: home });
  const tuiConfigPath = join(home, 'tui.toml');
  const userPrefsPath = join(home, 'user-prefs.md');
  const userMcpJson = join(home, 'mcp.json');
  const projectMcpJson = join(cwd, '.scream-code', 'mcp.json');
  const userAgentsMd = join(userHome, '.scream-code', 'AGENTS.md');
  const userSkillsDir = join(userHome, '.scream-code', 'skills');
  const pluginsDir = join(home, 'plugins');
  const memoryDir = join(home, 'memory');
  const knowledgeDir = join(home, 'knowledge');

  const block = [
    'Your persistent configuration and data live under your Scream home directory',
    `(\`${home}\`, unless \`SCREAM_CODE_HOME\` overrides it).`,
    '',
    'Configuration:',
    `- config.toml — main config (providers, keys, permissions): \`${configPath}\``,
    `- tui.toml — TUI settings: \`${tuiConfigPath}\``,
    `- user-prefs.md — nickname and tone preferences: \`${userPrefsPath}\``,
    `- mcp.json — MCP server declarations (user level: \`${userMcpJson}\`; project level: \`${projectMcpJson}\`, plus the parent-directory chain)`,
    `- AGENTS.md — user-level instructions: \`${userAgentsMd}\`; project-level AGENTS.md files in the working-directory chain are loaded as well`,
    '',
    'Data:',
    `- skills/ — user skills: \`${userSkillsDir}\` (project skills are listed with their \`Path\` under Available skills above)`,
    `- plugins/ — managed plugins and plugin-managed skills: \`${pluginsDir}\` (installed.json + managed/<name>/)`,
    `- memory/ — persistent cross-session memory: \`${memoryDir}\` (memos.sqlite + entries.jsonl)`,
    `- knowledge/ — local knowledge base (via the KnowledgeLookup tool): \`${knowledgeDir}\` (knowledge.db)`,
    '',
    'Boundaries:',
    '- Do not modify these files unless the user explicitly asks you to',
    '- NEVER modify core code (packages/agent-core, approval/permission logic, MCP connection management)',
    '- Runtime artifacts (sessions/, logs/, cache/, updates/, user-history/, web-sessions/, session_index.jsonl, device_id, dream-lock.json, and home-root `*cache.json` files) are not assets — do not treat them as configurable',
    '',
  ].join('\n');

  return block.trim();
}
