import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, resolveAgentProfiles } from '../../src/profile';

/**
 * Prompt ↔ tool consistency guard.
 *
 * Tool names are maintained in four places: profile `tools:` lists, the
 * construction gates in `agent/tool/index.ts`, the classification sets in
 * `tools/tool-catalog.ts`, and the prompt / injection text that tells the
 * model to call them. Only the first two decide what an agent can actually
 * call, so the text has drifted before — `ReadGroup`, `MemoryEdit` and
 * `WriteGoalNote` were named by shipped prompt or injection text while not
 * being enabled anywhere. These checks tie the text back to the registry:
 *
 *   1. every non-MCP name a profile lists must exist in the tool registry;
 *   2. every prompt only names tools its agent can call, except for the
 *      reviewed allowances below;
 *   3. every registered tool name mentioned by a runtime injection source
 *      (e.g. the goal-mode text) must be enabled for the main agent.
 *
 * When a check fails, fix the drift: enable the tool for that profile, gate
 * the section on `IS_MAIN` / `CAN_SPAWN` in `system.md`, or add the name to
 * an allowance below with a one-line reason.
 *
 * Sections that *instruct* a tool call carry a condition instead of an
 * allowance. `resolve.ts` derives the tool-existence variables from the
 * profile's own `tools:` list — `IS_MAIN`, `CAN_SPAWN`, and `HAS_WRITE_EDIT`
 * (the profile declares both `Write` and `Edit`, the pair the file-mutation
 * guidance is written around). Wrap any new instruction in the matching one;
 * the last two checks below pin both directions (never mention what the role
 * cannot call, never strip the guidance from a role that can).
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');

// Matches `readonly name = 'ToolName'` / `readonly name: string = 'ToolName'`
// declarations on BuiltinTool classes, plus the identifier form
// (`readonly name = SCRIPT_TOOL_NAME;`), resolved against string constants
// declared in the same file. Error subclasses declared in the same files are
// filtered out by the `Error` suffix check in `collectRegistryNames`.
const NAME_DECLARATION =
  /(?:override\s+)?readonly\s+name(?:\s*:\s*string)?\s*=\s*(?:['"]([A-Za-z_][A-Za-z0-9_]*)['"]|([A-Za-z_$][A-Za-z0-9_$]*))/g;
const STRING_CONSTANT = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*['"]([^'"]+)['"]/g;

/**
 * Main-prompt allowance. The main prompt describes the *subagent* side of
 * collaboration: children report back through `ContactParent`, which the main
 * agent itself can never call, so the mention is expected.
 */
const MAIN_PROMPT_ALLOWANCES = new Map<string, string>([
  ['ContactParent', 'described as the subagent-side channel, not a main-agent call'],
]);

/**
 * Subagent-prompt allowances: mentions that are descriptive, self-guarded
 * ("if the tool is available"), fallback-covered, or routing hints — never an
 * instruction to call a tool the agent does not have. Anything NOT listed
 * here fails the check, so a new name appearing in a subagent prompt gets
 * reviewed before it ships.
 */
const SUBAGENT_PROMPT_ALLOWANCES = new Map<string, string>([
  ['Agent', 'the word appears in prose ("AI Agent assistant") and in anti-hallucination guards'],
  ['Skill', 'the skills section carries an explicit fallback to reading the skill file'],
  // "Write the code in a modular and maintainable way" / "Write a plan that is
  // executable ..." — the English verb, not a tool reference. Every actual
  // tool mention is gated on HAS_WRITE_EDIT and covered by the check below.
  ['Write', 'prose verb in the coding/planning guidance, not an instruction to call a tool'],
  ['LSP', 'tool-mapping table row (symbol navigation), a routing hint'],
  ['ImageGenerate', 'self-assets section: which main-only builtin manages image config'],
  ['KnowledgeLookup', 'self-assets section: which main-only builtin reads the knowledge base'],
  ['ManagePlugin', 'self-assets section: which main-only builtin manages plugins'],
  ['TaskList', 'background-task paragraph is guarded by "if ... available and you are the root agent"'],
  ['TaskOutput', 'background-task paragraph is guarded by "if ... available and you are the root agent"'],
  ['TaskStop', 'background-task paragraph is guarded by "if ... available and you are the root agent"'],
  ['PaperSearch', 'retrieval-routing section describes the source hierarchy, not a required call'],
  ['WebSearch', 'retrieval-routing section describes the source hierarchy, not a required call'],
  ['python', 'verify role text uses it in command examples (`python3 -m py_compile`)'],
]);

const promptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
} as const;

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTypeScriptFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

function collectRegistryNames(): Set<string> {
  const names = new Set<string>();
  for (const area of ['builtin', 'background', 'cron']) {
    for (const file of listTypeScriptFiles(join(PACKAGE_ROOT, 'src', 'tools', area))) {
      const text = readFileSync(file, 'utf8');
      const constants = new Map<string, string>();
      for (const match of text.matchAll(STRING_CONSTANT)) {
        const [, key, value] = match;
        if (key !== undefined && value !== undefined) constants.set(key, value);
      }
      for (const match of text.matchAll(NAME_DECLARATION)) {
        const literal = match[1];
        const identifier = match[2];
        const name = literal ?? (identifier === undefined ? undefined : constants.get(identifier));
        if (name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.endsWith('Error')) {
          names.add(name);
        }
      }
    }
  }
  return names;
}

function mentionsTool(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

describe('prompt ↔ tool consistency', () => {
  const registry = collectRegistryNames();

  it('collects a plausible registry from the tool sources', () => {
    // Sanity floor: if the scan pattern stops matching (declaration refactor),
    // the checks below would pass vacuously.
    expect(registry.size).toBeGreaterThan(30);
    expect(registry.has('Read')).toBe(true);
    expect(registry.has('Agent')).toBe(true);
    // Declared through a module constant rather than a string literal.
    expect(registry.has('RunScript')).toBe(true);
  });

  it('every profile tool name exists in the tool registry', () => {
    const unknown: string[] = [];
    for (const [profileName, profile] of Object.entries(DEFAULT_AGENT_PROFILES)) {
      for (const name of profile?.tools ?? []) {
        if (name.startsWith('mcp__')) continue;
        if (!registry.has(name)) unknown.push(`${profileName}: ${name}`);
      }
    }

    expect(unknown).toEqual([]);
  });

  it('every prompt only names tools its agent can call', () => {
    const issues: string[] = [];
    for (const [profileName, profile] of Object.entries(DEFAULT_AGENT_PROFILES)) {
      const prompt = profile?.systemPrompt(promptContext) ?? '';
      const enabled = new Set(profile?.tools ?? []);
      const allowances =
        profileName === 'agent' ? MAIN_PROMPT_ALLOWANCES : SUBAGENT_PROMPT_ALLOWANCES;
      const missing = [...registry].filter(
        (name) => mentionsTool(prompt, name) && !enabled.has(name) && !allowances.has(name),
      );
      if (missing.length > 0) issues.push(`${profileName}: ${missing.join(', ')}`);
    }

    expect(issues).toEqual([]);
  });

  it('runtime injection sources only name tools the main agent can call', () => {
    const mainTools = new Set(DEFAULT_AGENT_PROFILES['agent']?.tools ?? []);
    const missing: string[] = [];
    for (const file of listTypeScriptFiles(join(PACKAGE_ROOT, 'src', 'agent', 'injection'))) {
      const text = readFileSync(file, 'utf8');
      for (const name of registry) {
        if (mentionsTool(text, name) && !mainTools.has(name)) {
          missing.push(`${file.split('/').pop() ?? file}: ${name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  /**
   * Tool-existence conditioning, negative direction: a role that cannot call
   * `Write` / `Edit` must not be handed file-mutation instructions. The
   * rendered prompt is the surface the subagent reads, so a leftover
   * "use `Write`" paragraph is a broken instruction, not a cosmetic issue.
   * Only code-spanned names count — the bare verb ("Write the code in a
   * modular way") is prose.
   */
  it('never instructs a profile without Write/Edit to use them', () => {
    const issues: string[] = [];
    for (const [profileName, profile] of Object.entries(DEFAULT_AGENT_PROFILES)) {
      const enabled = new Set(profile?.tools ?? []);
      if (enabled.has('Write') && enabled.has('Edit')) continue;
      const prompt = profile?.systemPrompt(promptContext) ?? '';
      const mentioned = [...prompt.matchAll(/`(Write|Edit)`/g)].map((match) => match[1]);
      if (mentioned.length > 0) {
        issues.push(`${profileName}: ${[...new Set(mentioned)].join(', ')}`);
      }
    }

    expect(issues).toEqual([]);
  });

  /**
   * Tool-existence conditioning, positive direction: the gate must not be
   * stuck off. A `HAS_WRITE_EDIT` typo (or a condition wired to the wrong
   * variable) would silently strip these paragraphs from the *main* prompt —
   * the byte-stable prefix the provider cache depends on.
   */
  it('keeps the Write/Edit guidance for profiles that own the pair', () => {
    for (const [profileName, profile] of Object.entries(DEFAULT_AGENT_PROFILES)) {
      const enabled = new Set(profile?.tools ?? []);
      const ownsPair = enabled.has('Write') && enabled.has('Edit');
      const prompt = profile?.systemPrompt(promptContext) ?? '';
      // The mapping rows, the tool-implementation bullets, and the Read->Edit
      // anchor protocol are the three gated paragraphs.
      expect(prompt.includes('| `echo ... > file` or heredocs to create files | `Write` |'), profileName).toBe(
        ownsPair,
      );
      expect(prompt.includes('- Use `Write` to create or overwrite source files.'), profileName).toBe(
        ownsPair,
      );
      expect(prompt.includes('prefer `Read` before `Edit`'), profileName).toBe(ownsPair);
    }
  });

  /**
   * The variables are derived from the profile's own tool list at resolve
   * time, so `extends` inheritance and partial tool sets behave predictably:
   * both names are required, and a child that adds the pair turns the section
   * back on without re-declaring the template.
   */
  it('derives HAS_WRITE_EDIT from the resolved profile tool list', () => {
    const template = 'role:{% if HAS_WRITE_EDIT %}mutating{% else %}read-only{% endif %}';
    const profiles = resolveAgentProfiles([
      { name: 'root', tools: ['Read'], systemPromptTemplate: template },
      { name: 'full', extends: 'root', tools: ['Read', 'Write', 'Edit'] },
      { name: 'write-only', extends: 'root', tools: ['Read', 'Write'] },
    ]);

    expect(profiles['root']?.systemPrompt(promptContext)).toBe('role:read-only');
    expect(profiles['full']?.systemPrompt(promptContext)).toBe('role:mutating');
    // Half the pair is not the pair: the guidance assumes both tools exist.
    expect(profiles['write-only']?.systemPrompt(promptContext)).toBe('role:read-only');
  });
});
