import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'pathe';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import { resolveConfigPath, resolveScreamHome } from '../../../config/path';
import type { PluginRecord } from '../../../plugin/types';
import { resolveMcpJsonPaths } from '../../../mcp/config-loader';
import { SkillParseError, parseSkillFromFile } from '../../../skill/parser';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ToolExecution } from '../../../loop/types';
import { resolveSkillInstallPaths } from '../../../skill/install-paths';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './inspect-own-assets.md';

const SCOPES = ['all', 'skills', 'mcp', 'config', 'memory', 'knowledge'] as const;

export const InspectOwnAssetsInputSchema = z.object({
  scope: z
    .enum(SCOPES)
    .optional()
    .describe(
      "Which self-assets to inspect: 'all' (default) reports everything; narrow to 'skills', 'mcp', 'config', 'memory', or 'knowledge'.",
    ),
});

export type InspectOwnAssetsInput = z.infer<typeof InspectOwnAssetsInputSchema>;

/**
 * Skills larger than this are reported as broken rather than parsed. Real
 * skill bundles are a few KB; the cap exists only to guard against reading a
 * pathological file (e.g. a multi-GB binary misnamed SKILL.md) in one shot.
 */
const SKILL_FILE_READ_LIMIT = 4 * 1024 * 1024;

/** Recursion bound for counting nested SKILL.md files inside unregistered dirs. */
const ORPHAN_SCAN_DEPTH = 4;

/**
 * Common documentation files shipped inside skill/plugin bundles are not
 * skills; matched case-insensitively against top-level flat `.md` entries
 * (mirrors skill/scanner.ts).
 */
const DOCUMENTATION_MARKDOWN_LOWER = new Set([
  'readme.md',
  'changelog.md',
  'changes.md',
  'history.md',
  'license.md',
  'copying.md',
  'authors.md',
  'notice.md',
  'contributing.md',
  'security.md',
  'code_of_conduct.md',
  'architecture.md',
  'design.md',
  'notes.md',
]);

interface FileInfo {
  readonly exists: boolean;
  readonly size: number;
}

async function fileInfo(path: string): Promise<FileInfo> {
  try {
    const s = await stat(path);
    return { exists: s.isFile(), size: s.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

function describeFile(info: FileInfo): string {
  if (!info.exists) return 'missing';
  return `${info.size} bytes`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

type FrontmatterStatus = 'ok' | 'missing' | 'broken';

interface SkillEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: 'dir' | 'flat';
  readonly frontmatter: FrontmatterStatus;
  /** Parse failure detail for `broken` entries (mirrors the registry's view). */
  readonly reason?: string;
  /** Set for plugin-managed entries: the plugin directory providing the skill. */
  readonly plugin?: string;
  /** Registration status; set only for plugin-managed entries tracked by the plugin table. */
  readonly registered?: true;
}

/**
 * Parse a skill file the same way the registry does (`skill/parser`), so the
 * inventory's status and names agree with what is actually invocable: a file
 * whose frontmatter fails YAML parsing is `broken` with the real message, not
 * a heuristic "ok" based on the presence of a `name:` line.
 */
async function parseSkillEntry(
  path: string,
  fallbackName: string,
  requireFrontmatter: boolean,
): Promise<Pick<SkillEntry, 'name' | 'frontmatter' | 'reason'>> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { name: fallbackName, frontmatter: 'missing' };
  }
  if (info.size > SKILL_FILE_READ_LIMIT) {
    // Oversize files are skipped unjudged rather than labelled broken: the
    // registry parses without a size cap, so "too large for the inventory"
    // is a skip, never a verdict on the file's health.
    return { name: fallbackName, frontmatter: 'ok' };
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { name: fallbackName, frontmatter: 'missing' };
  }
  if (text.split(/\r?\n/, 1)[0]?.trim() !== '---') {
    // Directory skills must open with a frontmatter fence; flat skills do not
    // require one (mirrors skill/parser.ts).
    if (requireFrontmatter) return { name: fallbackName, frontmatter: 'missing' };
    return { name: fallbackName, frontmatter: 'ok' };
  }
  try {
    const skill = await parseSkillFromFile({
      skillMdPath: path,
      skillDirName: fallbackName,
      source: 'user',
    });
    // The parsed name (frontmatter `name:` falling back to the directory
    // name) is authoritative — it is exactly what the registry holds.
    return { name: skill.name, frontmatter: 'ok' };
  } catch (error) {
    const reason =
      error instanceof SkillParseError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { name: fallbackName, frontmatter: 'broken', reason };
  }
}

/**
 * List skill entries under a skills directory, mirroring the loader's rules:
 * skip dot-entries, node_modules and README.md; directory skills must contain
 * SKILL.md; flat skills are non-README `.md` files (frontmatter optional).
 */
async function listSkills(dir: string): Promise<SkillEntry[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      const skillMd = join(dir, entry.name, 'SKILL.md');
      if (!(await isFile(skillMd))) continue;
      const parsed = await parseSkillEntry(skillMd, entry.name, true);
      out.push({ ...parsed, path: skillMd, kind: 'dir' });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (DOCUMENTATION_MARKDOWN_LOWER.has(entry.name.toLowerCase())) continue;
      const path = join(dir, entry.name);
      const parsed = await parseSkillEntry(path, entry.name.slice(0, -'.md'.length), false);
      out.push({ ...parsed, path, kind: 'flat' });
    }
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Count every SKILL.md reachable under `dirPath` (inclusive), depth-limited. */
async function countNestedSkillFiles(dirPath: string, depth: number): Promise<number> {
  if (depth > ORPHAN_SCAN_DEPTH) return 0;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      count += await countNestedSkillFiles(join(dirPath, entry.name), depth + 1);
    } else if (entry.name === 'SKILL.md') {
      count++;
    }
  }
  return count;
}

/**
 * Describe an unregistered directory under the managed plugins root so the
 * inventory can surface things the plugin table cannot see: orphan skill
 * bundles, nested skill trees, and dormant code plugins (entryPoint) that
 * would run arbitrary code on install+activate.
 */
async function describeUnregisteredDir(dirPath: string): Promise<string> {
  const parts: string[] = [];
  const topLevelSkillMd = await isFile(join(dirPath, 'SKILL.md'));
  const totalSkills = await countNestedSkillFiles(dirPath, 0);
  if (topLevelSkillMd) {
    parts.push(totalSkills > 1 ? `skill bundle (${totalSkills} SKILL.md)` : 'skill bundle');
  } else if (totalSkills > 0) {
    parts.push(`${totalSkills} nested skills (not registered)`);
  }
  try {
    const manifestText = await readFile(join(dirPath, 'scream.plugin.json'), 'utf8');
    let hasEntryPoint = false;
    try {
      const manifest = JSON.parse(manifestText) as { entryPoint?: unknown };
      hasEntryPoint = typeof manifest.entryPoint === 'string' && manifest.entryPoint.length > 0;
    } catch {
      parts.push('scream.plugin.json (unparseable)');
      return parts.join('; ');
    }
    parts.push(hasEntryPoint ? 'code plugin (entryPoint)' : 'manifest but not registered');
  } catch {
    // No scream.plugin.json — not a plugin by our manifest rules.
  }
  if (parts.length === 0) parts.push('no manifest or skill files');
  return parts.join('; ');
}

/**
 * Plugin-managed skills live under `<managedDir>/<plugin>/SKILL.md`. When the
 * plugin table (via `agent.toolServices.plugins`) is reachable, entries carry
 * their registration status and unregistered directories are reported in a
 * dedicated section; without it, the listing falls back to a pure file scan.
 */
async function listManagedSkills(
  managedDir: string,
  records: ReadonlyMap<string, PluginRecord> | undefined,
): Promise<{ readonly entries: SkillEntry[]; readonly orphanLines: string[] }> {
  let plugins;
  try {
    plugins = await readdir(managedDir, { withFileTypes: true });
  } catch {
    return { entries: [], orphanLines: [] };
  }
  const entries: SkillEntry[] = [];
  const orphanLines: string[] = [];
  for (const plugin of plugins) {
    if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue;
    const dirPath = join(managedDir, plugin.name);
    const skillMd = join(dirPath, 'SKILL.md');
    const record = records?.get(plugin.name);
    if (records === undefined || record === undefined) {
      if (records === undefined) {
        // No plugin table in this runtime: mirror the loader's file scan.
        if (!(await isFile(skillMd))) continue;
        const parsed = await parseSkillEntry(skillMd, plugin.name, true);
        entries.push({ ...parsed, path: skillMd, kind: 'dir', plugin: plugin.name });
      } else if (await isFile(skillMd)) {
        orphanLines.push(
          `- ${plugin.name} — ${await describeUnregisteredDir(dirPath)} — \`${dirPath}\``,
        );
      } else if (await isFile(join(dirPath, 'scream.plugin.json'))) {
        orphanLines.push(
          `- ${plugin.name} — ${await describeUnregisteredDir(dirPath)} — \`${dirPath}\``,
        );
      } else if ((await countNestedSkillFiles(dirPath, 0)) > 0) {
        orphanLines.push(
          `- ${plugin.name} — ${await describeUnregisteredDir(dirPath)} — \`${dirPath}\``,
        );
      }
      continue;
    }
    if (await isFile(skillMd)) {
      const parsed = await parseSkillEntry(skillMd, plugin.name, true);
      entries.push({ ...parsed, path: skillMd, kind: 'dir', plugin: plugin.name, registered: true });
    }
  }
  return { entries, orphanLines };
}

/**
 * Traffic-light status for a skill entry. The registry is the single source of
 * truth for what is callable; everything else is a disk-side explanation.
 */
function classify(
  entry: SkillEntry,
  invocableNames: ReadonlySet<string>,
  registeredNames: ReadonlySet<string>,
): string {
  const variants = [entry.name];
  if (entry.plugin !== undefined) variants.push(`${entry.plugin}:${entry.name}`);
  if (variants.some((v) => invocableNames.has(v))) return 'invocable';
  // Registered in the registry but not invocable (disabled model invocation,
  // non-inline type, or a renamed `plugin:name` form that is not listable).
  if (variants.some((v) => registeredNames.has(v))) {
    return 'not invocable — registered but not invocable';
  }
  if (entry.frontmatter === 'broken') {
    return `not invocable — broken: ${entry.reason ?? 'frontmatter failed to parse'}`;
  }
  return 'not invocable — unregistered';
}

function formatSkillEntry(entry: SkillEntry, status: string): string {
  const origin = entry.plugin === undefined ? '' : ` — plugin: ${entry.plugin}`;
  // `registered` is only ever set to true for plugin-managed entries tracked
  // by the plugin table; unregistered directories are reported in their own
  // section instead of as entry-level flags.
  const registration = entry.registered === true ? ' — registered' : '';
  return `- ${entry.name} — ${entry.kind} — ${entry.frontmatter} — ${status}${origin}${registration} — \`${entry.path}\``;
}

async function inspectConfig(home: string, userHome: string): Promise<string> {
  const items = [
    ['config.toml', resolveConfigPath({ homeDir: home })],
    ['tui.toml', join(home, 'tui.toml')],
    ['user-prefs.md', join(home, 'user-prefs.md')],
    ['AGENTS.md (user)', join(userHome, '.scream-code', 'AGENTS.md')],
  ] as const;

  const lines = ['## Config', ''];
  for (const [label, path] of items) {
    const info = await fileInfo(path);
    lines.push(`- ${label}: ${describeFile(info)} — \`${path}\``);
  }
  return lines.join('\n');
}

async function inspectSkills(
  home: string,
  userHome: string,
  cwd: string,
  agent: Agent,
): Promise<string> {
  const { userDir, projectDir } = await resolveSkillInstallPaths({
    userHomeDir: userHome,
    workDir: cwd,
  });
  const registry = agent.skills?.registry;
  const invocableNames = new Set((registry?.listInvocableSkills() ?? []).map((s) => s.name));
  const registeredNames = new Set((registry?.listSkills?.() ?? []).map((s) => s.name));

  // Same entry point as ManagePlugin (agent.toolServices.plugins): no second
  // parser for installed.json, and no plugin table in the runtime degrades to
  // a pure file scan.
  const manager = agent.toolServices?.plugins;
  const pluginRecords =
    manager === undefined ? undefined : new Map(manager.list().map((r) => [r.id, r] as const));

  const sections: string[] = ['## Skills', ''];
  let invocableCount = 0;
  let totalCount = 0;

  const track = (entry: SkillEntry): string => {
    totalCount++;
    if (classify(entry, invocableNames, registeredNames) === 'invocable') invocableCount++;
    return formatSkillEntry(entry, classify(entry, invocableNames, registeredNames));
  };

  const userEntries = await listSkills(userDir);
  sections.push(`User skills (${userDir}): ${userEntries.length === 0 ? 'none' : ''}`);
  sections.push(...userEntries.map(track));

  const extraDir = join(home, 'plugins', 'managed');
  const managed = await listManagedSkills(extraDir, pluginRecords);
  sections.push('');
  sections.push(`Plugin-managed skills (${extraDir}): ${managed.entries.length === 0 ? 'none' : ''}`);
  sections.push(...managed.entries.map(track));

  // Plugin-level warnings (e.g. a SKILL.md failing to parse) ride on the
  // record's diagnostics; surface them next to the plugin's listing so the
  // plugin table and the inventory can no longer disagree silently.
  if (pluginRecords !== undefined) {
    for (const record of pluginRecords.values()) {
      const warns = record.diagnostics.filter((d) => d.severity === 'warn');
      if (warns.length === 0) continue;
      sections.push(
        `plugin ${record.id}: warnings: [${warns.map((d) => d.message).join(' | ')}]`,
      );
    }
  }

  if (managed.orphanLines.length > 0) {
    sections.push('');
    sections.push(`Unregistered plugin dirs (${extraDir}):`);
    sections.push(...managed.orphanLines);
  }

  const projectEntries = await listSkills(projectDir);
  sections.push('');
  sections.push(`Project skills (${projectDir}): ${projectEntries.length === 0 ? 'none' : ''}`);
  sections.push(...projectEntries.map((e) => track(e)));

  sections.push('');
  sections.push(
    `Invocable now: ${invocableCount}/${totalCount} (against the live skill registry; ` +
      'entries marked "not invocable" carry their reason — registered-but-not, broken frontmatter, or unregistered)',
  );

  return sections.join('\n');
}

/** mcp.json files larger than this are reported as oversize and not parsed. */
const MCP_CONFIG_SIZE_LIMIT = 1024 * 1024;

async function inspectMcp(home: string, cwd: string): Promise<string> {
  const paths = resolveMcpJsonPaths({ cwd, homeDir: home });
  const candidates = [
    ['user', paths.user],
    ...paths.parents.map((p) => ['parent', p] as const),
    ['project', paths.project],
  ] as const;

  const lines = ['## MCP servers', ''];
  for (const [label, path] of candidates) {
    let servers = 0;
    let status: string;
    try {
      const info = await stat(path);
      if (info.size > MCP_CONFIG_SIZE_LIMIT) {
        status = 'oversize';
      } else {
        const text = await readFile(path, 'utf-8');
        const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
        const names = parsed.mcpServers ?? {};
        if (typeof names === 'object' && !Array.isArray(names)) {
          servers = Object.keys(names).length;
        }
        status = 'ok';
      }
    } catch (error) {
      status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'parse-error';
    }
    const serverDetail = status === 'ok' ? ` — ${servers} server${servers === 1 ? '' : 's'}` : '';
    lines.push(`- ${label}: ${status}${serverDetail} — \`${path}\``);
  }
  return lines.join('\n');
}

async function inspectMemory(home: string): Promise<string> {
  const dir = join(home, 'memory');
  const memos = await fileInfo(join(dir, 'memos.sqlite'));
  const entries = await fileInfo(join(dir, 'entries.jsonl'));

  return [
    '## Memory',
    '',
    `- store dir: \`${dir}\``,
    `- memos.sqlite: ${describeFile(memos)}`,
    `- entries.jsonl: ${describeFile(entries)}`,
  ].join('\n');
}

async function inspectKnowledge(home: string): Promise<string> {
  const dir = join(home, 'knowledge');
  const db = await fileInfo(join(dir, 'knowledge.db'));

  return [
    '## Knowledge',
    '',
    `- store dir: \`${dir}\``,
    `- knowledge.db: ${describeFile(db)}`,
  ].join('\n');
}

/**
 * Reports the agent's own persistent assets: skills, MCP server declarations,
 * configuration files, memory store, and knowledge base. Purely informational
 * and strictly read-only — it never writes, creates, or modifies anything.
 */
export class InspectOwnAssetsTool implements BuiltinTool<InspectOwnAssetsInput> {
  readonly name = 'InspectOwnAssets' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(InspectOwnAssetsInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly override?: { readonly homeDir?: string; readonly userHomeDir?: string },
  ) {}

  resolveExecution(args: InspectOwnAssetsInput): ToolExecution {
    const home = this.override?.homeDir ?? resolveScreamHome();
    const userHome = this.override?.userHomeDir ?? homedir();
    const cwd = this.agent.config.cwd;

    // Conservative read declarations: everything under the scream home, the
    // user-level .scream-code dir (AGENTS.md + skills), the working dir, and
    // every parent-level mcp.json that may exist above the cwd.
    //
    // Known boundary: in a monorepo, git-root project skills may live above
    // `cwd` and outside these declarations. Reads are not gated by accesses
    // (they only serialize against declared writes); this tool is read-only
    // and low-frequency, so the gap is accepted deliberately.
    const parentMcpPaths = resolveMcpJsonPaths({ cwd, homeDir: home }).parents;
    const accesses: ToolAccesses = [
      ...ToolAccesses.readTree(home),
      ...ToolAccesses.readTree(join(userHome, '.scream-code')),
      ...ToolAccesses.readTree(cwd),
      ...parentMcpPaths.flatMap((p) => ToolAccesses.readFile(p)),
    ];

    return {
      description: `Inspecting own assets (scope: ${args.scope ?? 'all'})`,
      approvalRule: this.name,
      accesses,
      execute: async () => {
        const scope = args.scope ?? 'all';
        const sections: string[] = [];
        if (scope === 'all' || scope === 'config') {
          sections.push(await inspectConfig(home, userHome));
        }
        if (scope === 'all' || scope === 'skills') {
          sections.push(await inspectSkills(home, userHome, cwd, this.agent));
        }
        if (scope === 'all' || scope === 'mcp') {
          sections.push(await inspectMcp(home, cwd));
        }
        if (scope === 'all' || scope === 'memory') {
          sections.push(await inspectMemory(home));
        }
        if (scope === 'all' || scope === 'knowledge') {
          sections.push(await inspectKnowledge(home));
        }
        return { isError: false, output: sections.join('\n\n') };
      },
    };
  }
}