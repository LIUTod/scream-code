import { expandSkillParameters, skillArgumentNames } from './parser';
import { discoverSkills, type DiscoverSkillsOptions } from './scanner';
import type { SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from './types';
import { isInlineSkillType, normalizeSkillName } from './types';

const LISTING_DESC_MAX = 250;

export class SkillNotFoundError extends Error {
  readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill "${skillName}" is not registered`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

export interface SkillRegistryOptions {
  readonly discover?: typeof discoverSkills;
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;
}

export class SkillRegistry {
  private readonly byName = new Map<string, SkillDefinition>();
  private readonly byPluginAndName = new Map<string, SkillDefinition>();
  private readonly roots: string[] = [];
  private readonly skipped: SkippedSkill[] = [];
  private readonly discoverImpl: typeof discoverSkills;
  private readonly onWarning: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;

  constructor(options: SkillRegistryOptions = {}) {
    this.discoverImpl = options.discover ?? discoverSkills;
    this.onWarning = options.onWarning ?? (() => {});
    this.sessionId = options.sessionId;
  }

  async loadRoots(roots: readonly SkillRoot[]): Promise<void> {
    for (const root of roots) {
      if (!this.roots.includes(root.path)) this.roots.push(root.path);
    }

    const skills = await this.discoverImpl({
      roots,
      onWarning: this.onWarning,
      onSkippedByPolicy: (skill) => this.skipped.push(skill),
      onDiscoveredSkill: (skill) => {
        // Index plugin-local name early so plugin-specific lookup survives
        // scanner-level deduplication of globally colliding names.
        this.indexPluginSkill(skill);
      },
    } satisfies DiscoverSkillsOptions);

    for (const skill of skills) {
      this.register(skill);
    }
  }

  registerBuiltinSkill(skill: SkillDefinition): void {
    this.register(skill.source === 'builtin' ? skill : { ...skill, source: 'builtin' });
  }

  register(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    const pluginId = skill.plugin?.id;
    const resolved = resolveUniqueSkillName(skill, this.byName, pluginId);
    if (resolved.shadowed) {
      this.onWarning(
        `Skill "${skill.name}" from ${skill.source}${pluginId !== undefined ? ` (plugin "${pluginId}")` : ''} is shadowed by an existing skill with the same name.`,
      );
      return;
    }
    const normalizedSkill = resolved.name === skill.name ? skill : { ...skill, name: resolved.name };
    const key = normalizeSkillName(resolved.name);
    if (options.replace === true || !this.byName.has(key)) {
      this.byName.set(key, normalizedSkill);
    }
    // Index by the original plugin-local name so getPluginSkill(pluginId, name)
    // still works even when the global name had to be prefixed to avoid collision.
    this.indexPluginSkill(skill, options);
    if (resolved.renamed) {
      this.onWarning(
        `Skill "${skill.name}" from plugin "${pluginId}" was renamed to "${resolved.name}" because a skill with the same name is already registered.`,
      );
    }
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.byName.get(normalizeSkillName(name));
  }

  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined {
    return this.byPluginAndName.get(pluginSkillKey(pluginId, name));
  }

  private indexPluginSkill(
    skill: SkillDefinition,
    options: { readonly replace?: boolean } = {},
  ): void {
    if (skill.plugin === undefined) return;
    const key = pluginSkillKey(skill.plugin.id, skill.name);
    if (options.replace === true || !this.byPluginAndName.has(key)) {
      this.byPluginAndName.set(key, skill);
    }
  }

  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    const argumentNames = skillArgumentNames(skill.metadata);
    const content = expandSkillParameters(skill.content, rawArgs, {
      skillDir: skill.dir,
      sessionId: this.sessionId,
      argumentNames,
    });
    const plugin = skill.plugin;
    if (plugin === undefined) return content;
    const instructions = plugin.instructions;
    if (instructions === undefined || instructions.trim().length === 0) return content;
    return (
      `<scream-plugin-instructions plugin="${escapeAttr(plugin.id)}">\n` +
      `${instructions}\n` +
      `</scream-plugin-instructions>\n\n${content}`
    );
  }

  listSkills(): readonly SkillDefinition[] {
    return [...this.byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listInvocableSkills(): readonly SkillDefinition[] {
    return this.listSkills().filter(
      (skill) =>
        skill.metadata.disableModelInvocation !== true && isInlineSkillType(skill.metadata.type),
    );
  }

  getSkillRoots(): readonly string[] {
    return [...this.roots];
  }

  getSkippedByPolicy(): readonly SkippedSkill[] {
    return [...this.skipped];
  }

  getScreamSkillsDescription(): string {
    const rendered = renderGroupedSkills(this.listSkills(), formatFullSkill);
    return rendered.length === 0 ? 'No skills' : rendered;
  }

  getModelSkillListing(): string {
    const lines = ['DISREGARD any earlier skill listings. Current available skills:'];
    const listing = renderGroupedSkills(this.listInvocableSkills(), formatModelSkill);
    if (listing.length > 0) {
      lines.push(listing);
    }
    return lines.length === 1 ? '' : lines.join('\n');
  }
}

function pluginSkillKey(pluginId: string, skillName: string): string {
  return `${pluginId}\0${normalizeSkillName(skillName)}`;
}

interface UniqueSkillNameResult {
  readonly name: string;
  readonly renamed: boolean;
  readonly shadowed: boolean;
}

/**
 * Resolve a unique skill name when registering across multiple sources.
 *
 * Non-plugin skills are never renamed; if their name collides with an existing
 * skill they are considered shadowed and should be reported to the caller.
 * Plugin skills get a "plugin-id:skill-name" prefix on collision so users can
 * still invoke them and distinguish them in listings. If even the prefixed
 * form collides, a numeric suffix is appended.
 */
function resolveUniqueSkillName(
  skill: SkillDefinition,
  byName: ReadonlyMap<string, SkillDefinition>,
  pluginId: string | undefined,
): UniqueSkillNameResult {
  const originalKey = normalizeSkillName(skill.name);
  if (!byName.has(originalKey)) {
    return { name: skill.name, renamed: false, shadowed: false };
  }
  if (pluginId === undefined) {
    return { name: skill.name, renamed: false, shadowed: true };
  }
  const prefixed = `${pluginId}:${skill.name}`;
  const prefixedKey = normalizeSkillName(prefixed);
  if (!byName.has(prefixedKey)) {
    return { name: prefixed, renamed: true, shadowed: false };
  }
  let index = 2;
  while (true) {
    const candidate = `${pluginId}:${skill.name}-${String(index)}`;
    const candidateKey = normalizeSkillName(candidate);
    if (!byName.has(candidateKey)) {
      return { name: candidate, renamed: true, shadowed: false };
    }
    index++;
  }
}

const SOURCE_GROUPS: ReadonlyArray<{ readonly source: SkillSource; readonly label: string }> = [
  { source: 'project', label: 'Project' },
  { source: 'user', label: 'User' },
  { source: 'extra', label: 'Extra' },
  { source: 'builtin', label: 'Built-in' },
];

function renderGroupedSkills(
  skills: readonly SkillDefinition[],
  format: (skill: SkillDefinition) => readonly string[],
): string {
  const lines: string[] = [];
  for (const group of SOURCE_GROUPS) {
    const groupSkills = skills.filter((skill) => skill.source === group.source);
    if (groupSkills.length === 0) continue;
    lines.push(`### ${group.label}`);
    for (const skill of groupSkills) {
      lines.push(...format(skill));
    }
  }
  return lines.join('\n');
}

function formatFullSkill(skill: SkillDefinition): readonly string[] {
  return [`- ${skill.name}`, `  - Path: ${skill.path}`, `  - Description: ${skill.description}`];
}

function formatModelSkill(skill: SkillDefinition): readonly string[] {
  const lines = [`- ${skill.name}: ${truncate(skill.description, LISTING_DESC_MAX)}`];
  if (typeof skill.metadata.whenToUse === 'string' && skill.metadata.whenToUse.length > 0) {
    lines.push(`  When to use: ${skill.metadata.whenToUse}`);
  }
  lines.push(`  Path: ${skill.path}`);
  return lines;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
