import { readdir, realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { McpServerConfigSchema, type McpServerConfig } from '../config/schema';
import {
  PLUGIN_NAME_REGEX,
  type PluginDiagnostic,
  type PluginInterface,
  type PluginManifest,
  type PluginManifestKind,
} from './types';

const SCREAM_PLUGIN_ROOT_PATH = 'scream.plugin.json';
const SCREAM_PLUGIN_DIR_PATH = '.scream-plugin/plugin.json';
const CLAUDE_PLUGIN_DIR_PATH = '.claude-plugin/plugin.json';
const BARE_SKILL_PATH = 'SKILL.md';

// Fields that look like third-party runtime extensions (Claude / Codex / old
// Scream CLI). We do not run them; emit an info diagnostic so plugin authors and
// users can see why a field is silently ignored.
const UNSUPPORTED_RUNTIME_FIELDS = [
  'tools',
  'commands',
  'hooks',
  'apps',
  'inject',
  'configFile',
  'config_file',
  'bootstrap',
] as const;

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function parseManifest(pluginRoot: string): Promise<ParsedManifestResult> {
  const rootJsonPath = path.join(pluginRoot, SCREAM_PLUGIN_ROOT_PATH);
  const dirJsonPath = path.join(pluginRoot, SCREAM_PLUGIN_DIR_PATH);
  const claudeDirJsonPath = path.join(pluginRoot, CLAUDE_PLUGIN_DIR_PATH);
  const rootJsonExists = await isFile(rootJsonPath);
  const dirJsonExists = await isFile(dirJsonPath);
  const claudeDirJsonExists = await isFile(claudeDirJsonPath);

  if (!rootJsonExists && !dirJsonExists && !claudeDirJsonExists) {
    // Fallback 1: bare SKILL.md at repo root (common Claude Code skill pattern).
    const skillMdPath = path.join(pluginRoot, BARE_SKILL_PATH);
    if (await isFile(skillMdPath)) {
      return {
        manifest: {
          name: path.basename(pluginRoot),
          skills: [pluginRoot],
        },
        manifestKind: 'bare-skill',
        manifestPath: skillMdPath,
        diagnostics: [],
      };
    }

    // Fallback 2: scan subdirectories for SKILL.md files (up to 3 levels deep).
    // Many community skills ship SKILL.md inside subdirectories rather than at
    // the repo root.  Auto-discover them so these repos can be installed without
    // forcing authors to add ScreamCode-specific packaging.
    const discoveredSkillDirs = await discoverSkillDirs(pluginRoot, 3);
    if (discoveredSkillDirs.length > 0) {
      return {
        manifest: {
          name: path.basename(pluginRoot),
          skills: discoveredSkillDirs,
        },
        manifestKind: 'bare-skill',
        manifestPath: path.join(discoveredSkillDirs[0]!, BARE_SKILL_PATH),
        diagnostics: [],
      };
    }

    return {
      diagnostics: [
        {
          severity: 'error',
          message: `No manifest at ${SCREAM_PLUGIN_ROOT_PATH}, ${SCREAM_PLUGIN_DIR_PATH}, or ${CLAUDE_PLUGIN_DIR_PATH}`,
        },
      ],
    };
  }

  // Priority: scream.plugin.json > .scream-plugin/plugin.json > .claude-plugin/plugin.json
  const manifestPath = rootJsonExists
    ? rootJsonPath
    : dirJsonExists
      ? dirJsonPath
      : claudeDirJsonPath;
  const manifestKind: PluginManifestKind = rootJsonExists
    ? 'scream-plugin-root'
    : dirJsonExists
      ? 'scream-plugin-dir'
      : 'claude-plugin-dir';
  const shadowedManifestPath = rootJsonExists
    ? (dirJsonExists ? dirJsonPath : claudeDirJsonExists ? claudeDirJsonPath : undefined)
    : dirJsonExists && claudeDirJsonExists
      ? claudeDirJsonPath
      : undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [
        {
          severity: 'error',
          message: `Failed to parse ${path.relative(pluginRoot, manifestPath)}: ${(error as Error).message}`,
        },
      ],
    };
  }

  if (!isObject(raw)) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [{ severity: 'error', message: 'manifest must be a JSON object' }],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name.length === 0) {
    diagnostics.push({ severity: 'error', message: '"name" is required' });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
      message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")`,
    });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }

  let skills = await resolveSkillsField(pluginRoot, raw['skills'], diagnostics);
  if (raw['skills'] === undefined) {
    const rootSkillMd = path.join(pluginRoot, 'SKILL.md');
    if (await isFile(rootSkillMd)) {
      skills = [pluginRoot];
    }
  }

  const skillInstructions =
    typeof raw['skillInstructions'] === 'string' ? raw['skillInstructions'] : undefined;

  recordUnsupportedRuntimeFields(raw, diagnostics);

  const manifest: PluginManifest = {
    name,
    version: stringField(raw, 'version'),
    description: stringField(raw, 'description'),
    keywords: stringArrayField(raw, 'keywords'),
    homepage: stringField(raw, 'homepage'),
    license: stringField(raw, 'license'),
    author: readAuthor(raw['author']),
    skills,
    sessionStart: readSessionStart(raw['sessionStart'], diagnostics),
    mcpServers: await readMcpServers(pluginRoot, raw['mcpServers'], diagnostics),
    interface: readInterface(raw['interface']),
    skillInstructions,
  };

  return { manifest, manifestKind, manifestPath, shadowedManifestPath, diagnostics };
}

function recordUnsupportedRuntimeFields(
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): void {
  for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
    if (raw[field] === undefined) continue;
    diagnostics.push({
      severity: 'info',
      message: `"${field}" is present but not supported by Scream plugins`,
    });
  }
}

async function resolveSkillsField(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) return [];
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'error', message: '"skills" must be a string or string[]' });
    return [];
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('./')) {
      diagnostics.push({
        severity: 'error',
        message: `"skills" path must start with "./" (got "${entry}")`,
      });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      real = absolute;
    }
    const rootReal = await realpath(pluginRoot).catch(() => pluginRoot);
    if (!isWithin(real, rootReal)) {
      diagnostics.push({
        severity: 'error',
        message: `"skills" path resolves outside the plugin (${entry})`,
      });
      continue;
    }
    if (!(await isDir(real))) {
      diagnostics.push({
        severity: 'warn',
        message: `"skills" path is not a directory (${entry})`,
      });
      continue;
    }
    resolved.push(real);
  }
  return resolved;
}

async function resolvePluginPathField(input: {
  readonly pluginRoot: string;
  readonly field: string;
  readonly value: string;
  readonly diagnostics: PluginDiagnostic[];
}): Promise<string | undefined> {
  if (!input.value.startsWith('./')) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"${input.field}" path must start with "./" (got "${input.value}")`,
    });
    return undefined;
  }
  const absolute = path.resolve(input.pluginRoot, input.value);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    real = absolute;
  }
  const rootReal = await realpath(input.pluginRoot).catch(() => input.pluginRoot);
  if (!isWithin(real, rootReal)) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"${input.field}" path resolves outside the plugin (${input.value})`,
    });
    return undefined;
  }
  return real;
}

function readSessionStart(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): PluginManifest['sessionStart'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: 'warn', message: '"sessionStart" must be an object' });
    return undefined;
  }
  const skill = typeof raw['skill'] === 'string' ? raw['skill'].trim() : '';
  if (skill.length === 0) {
    diagnostics.push({
      severity: 'warn',
      message: '"sessionStart.skill" is required when sessionStart is present',
    });
    return undefined;
  }
  return { skill };
}

async function readMcpServers(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<PluginManifest['mcpServers']> {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: 'warn', message: '"mcpServers" must be an object' });
    return undefined;
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      diagnostics.push({
        severity: 'warn',
        message: '"mcpServers" entries must have a non-empty name',
      });
      continue;
    }
    const parsed = McpServerConfigSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
        message: `Invalid MCP server "${trimmedName}": ${parsed.error.message}`,
      });
      continue;
    }
    const normalized = await normalizePluginMcpServer({
      pluginRoot,
      name: trimmedName,
      config: parsed.data,
      diagnostics,
    });
    if (normalized !== undefined) out[trimmedName] = normalized;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

async function normalizePluginMcpServer(input: {
  readonly pluginRoot: string;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly diagnostics: PluginDiagnostic[];
}): Promise<McpServerConfig | undefined> {
  const { config } = input;
  if (config.transport === 'http') return config;

  let command = config.command;
  if (command.startsWith('./')) {
    const resolvedCommand = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.command`,
      value: command,
      diagnostics: input.diagnostics,
    });
    if (resolvedCommand === undefined) return undefined;
    command = resolvedCommand;
  } else if (command.includes('/') || path.isAbsolute(command)) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"mcpServers.${input.name}.command" must be a PATH command or start with "./"`,
    });
    return undefined;
  }

  let cwd = config.cwd;
  if (cwd !== undefined) {
    const resolvedCwd = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.cwd`,
      value: cwd,
      diagnostics: input.diagnostics,
    });
    if (resolvedCwd === undefined) return undefined;
    cwd = resolvedCwd;
  }

  return { ...config, command, cwd };
}

function readAuthor(raw: unknown): PluginManifest['author'] {
  if (typeof raw === 'string') return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, 'name');
  const email = stringField(raw, 'email');
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

function readInterface(raw: unknown): PluginInterface | undefined {
  if (!isObject(raw)) return undefined;
  const out: PluginInterface = {
    displayName: stringField(raw, 'displayName'),
    shortDescription: stringField(raw, 'shortDescription'),
    longDescription: stringField(raw, 'longDescription'),
    developerName: stringField(raw, 'developerName'),
    websiteURL: stringField(raw, 'websiteURL'),
  };
  const hasAny = Object.values(out).some((value) => value !== undefined);
  return hasAny ? out : undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArrayField(raw: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return value as readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Recursively scan for `SKILL.md` files up to `maxDepth` levels below `root`.
 * Returns the unique parent directories, deduplicated so that a nested skill
 * dir is not listed if its ancestor is already a skill root.
 */
async function discoverSkillDirs(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (await isFile(path.join(child, BARE_SKILL_PATH))) {
        found.push(child);
      }
      await walk(child, depth + 1);
    }
  }

  await walk(root, 1);

  // Deduplicate: if a discovered dir is nested inside another discovered dir,
  // keep only the ancestor.
  const sorted = found.sort((a, b) => a.length - b.length);
  const result: string[] = [];
  for (const dir of sorted) {
    if (!result.some((parent) => dir.startsWith(parent + path.sep))) {
      result.push(dir);
    }
  }
  return result;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
