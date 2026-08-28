import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'pathe';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import { resolveConfigPath, resolveScreamHome } from '../../../config/path';
import { resolveMcpJsonPaths } from '../../../mcp/config-loader';
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

/** Bytes to read from the head of a file when checking frontmatter. */
const FRONTMATTER_READ_LIMIT = 32 * 1024;

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

type FrontmatterStatus = 'ok' | 'missing' | 'broken';

/** Frontmatter check (bounded read): starts with `---` and contains a `name:` line. */
async function checkFrontmatter(path: string): Promise<FrontmatterStatus> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(FRONTMATTER_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_READ_LIMIT, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf-8').split('\n').slice(0, 25);
    if (head[0]?.trim() !== '---') return 'missing';
    return head.some((line) => /^name\s*:/.test(line)) ? 'ok' : 'broken';
  } catch {
    return 'missing';
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface SkillEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: 'dir' | 'flat';
  readonly frontmatter: FrontmatterStatus;
  /** Set for plugin-managed entries: the plugin directory providing the skill. */
  readonly plugin?: string;
}

/** True if a directory is a directory-based skill (contains SKILL.md). */
async function isSkillDir(dir: string): Promise<boolean> {
  try {
    const info = await stat(join(dir, 'SKILL.md'));
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * List skill entries under a managed skills directory, mirroring the loader's
 * rules: skip dot-entries, node_modules and README.md; directory skills must
 * contain SKILL.md; flat skills are non-README `.md` files.
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
      if (!(await isSkillDir(join(dir, entry.name)))) continue;
      const skillMd = join(dir, entry.name, 'SKILL.md');
      const fm = await checkFrontmatter(skillMd);
      // Mirror the parser's naming (frontmatter `name:` falling back to the
      // directory name) so inventory names line up with the skill registry.
      const skillName = (await readSkillName(skillMd)) ?? entry.name;
      out.push({ name: skillName, path: skillMd, kind: 'dir', frontmatter: fm });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (DOCUMENTATION_MARKDOWN_LOWER.has(entry.name.toLowerCase())) continue;
      const path = join(dir, entry.name);
      // Flat skills fall back to the filename like the parser does
      // (frontmatter `name:` wins when present); frontmatter stays optional.
      const skillName = (await readSkillName(path)) ?? entry.name.slice(0, -3);
      out.push({ name: skillName, path, kind: 'flat', frontmatter: 'ok' });
    }
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

function buildInvocableNameSet(agent: Agent): Set<string> {
  return new Set((agent.skills?.registry.listInvocableSkills() ?? []).map((s) => s.name));
}

function formatSkillEntry(entry: SkillEntry, invocable: boolean): string {
  const origin = entry.plugin === undefined ? '' : ` — plugin: ${entry.plugin}`;
  return `- ${entry.name} — ${entry.kind === 'dir' ? 'dir' : 'flat'} — ${entry.frontmatter} — ${invocable ? 'invocable' : 'not invocable'}${origin} — \`${entry.path}\``;
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
  const invocableNames = buildInvocableNameSet(agent);
  const sections: string[] = ['## Skills', ''];
  let invocableCount = 0;
  let totalCount = 0;

  // Plugin skills that lost a name clash are registered under `plugin:name`;
  // match both forms so renamed entries are not mislabelled as not invocable.
  const isInvocable = (entry: SkillEntry): boolean =>
    invocableNames.has(entry.name) ||
    (entry.plugin !== undefined && invocableNames.has(`${entry.plugin}:${entry.name}`));

  const track = (entry: SkillEntry, invocable: boolean): string => {
    totalCount++;
    if (invocable) invocableCount++;
    return formatSkillEntry(entry, invocable);
  };

  const userEntries = await listSkills(userDir);
  sections.push(`User skills (${userDir}): ${userEntries.length === 0 ? 'none' : ''}`);
  sections.push(...userEntries.map((e) => track(e, isInvocable(e))));

  const extraDir = join(home, 'plugins', 'managed');
  const extraEntries = await listManagedSkills(extraDir);
  sections.push('');
  sections.push(`Plugin-managed skills (${extraDir}): ${extraEntries.length === 0 ? 'none' : ''}`);
  sections.push(...extraEntries.map((e) => track(e, isInvocable(e))));

  const projectEntries = await listSkills(projectDir);
  sections.push('');
  sections.push(`Project skills (${projectDir}): ${projectEntries.length === 0 ? 'none' : ''}`);
  sections.push(...projectEntries.map((e) => track(e, isInvocable(e))));

  sections.push('');
  sections.push(
    `Invocable now: ${invocableCount}/${totalCount} (against the live skill registry; ` +
      'entries marked "not invocable" exist on disk but are disabled, shadowed, renamed, or broken)',
  );

  return sections.join('\n');
}

/**
 * Extracts the skill name from SKILL.md frontmatter (best effort) so the
 * inventory name matches what the skill registry holds; returns null when
 * frontmatter is missing or has no name line.
 */
async function readSkillName(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(FRONTMATTER_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_READ_LIMIT, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf-8').split('\n').slice(0, 25);
    if (head[0]?.trim() !== '---') return null;
    let closed = false;
    for (const line of head.slice(1)) {
      const trimmed = line.trim();
      if (trimmed === '---') {
        closed = true;
        break;
      }
      const m = /^name\s*:\s*(.+)$/.exec(line);
      if (m !== null) {
        const value = m[1]!.trim().replaceAll(/^["']|["']$/g, '');
        return value.length > 0 ? value : null;
      }
    }
    // Closing fence seen but no `name:` line (or the bounded window ended
    // inside the frontmatter): fall back to the directory name upstream.
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * List plugin-managed skills: each `<dir>/SKILL.md` under a managed plugin
 * directory is a skill entry (Extra source, mirroring plugin/manager.ts).
 */
async function listManagedSkills(managedDir: string): Promise<SkillEntry[]> {
  let plugins;
  try {
    plugins = await readdir(managedDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const plugin of plugins) {
    if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue;
    const skillMd = join(managedDir, plugin.name, 'SKILL.md');
    if (!(await isSkillDir(join(managedDir, plugin.name)))) continue;
    const fm = await checkFrontmatter(skillMd);
    const skillName = await readSkillName(skillMd) ?? plugin.name;
    out.push({ name: skillName, path: skillMd, kind: 'dir', frontmatter: fm, plugin: plugin.name });
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
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
