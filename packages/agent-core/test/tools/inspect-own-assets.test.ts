import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { DEFAULT_AGENT_PROFILES } from '../../src/profile';
import {
  InspectOwnAssetsInputSchema,
  InspectOwnAssetsTool,
} from '../../src/tools/builtin/state/inspect-own-assets';

describe('InspectOwnAssetsTool', () => {
  let root: string;
  let home: string;
  let userHome: string;
  let cwd: string;
  let tool: InspectOwnAssetsTool;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'inspect-own-assets-'));
    home = join(root, 'scream-home');
    userHome = join(root, 'user-home');
    cwd = join(root, 'project');

    // scream home assets
    await mkdir(join(home, 'memory'), { recursive: true });
    await mkdir(join(home, 'knowledge'), { recursive: true });
    await writeFile(join(home, 'config.toml'), 'model = "test"\n');
    await writeFile(join(home, 'tui.toml'), 'theme = "dark"\n');
    await writeFile(join(home, 'user-prefs.md'), '# Prefs\n');
    await writeFile(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }));
    await writeFile(join(home, 'memory', 'memos.sqlite'), 'SQLITE');
    await writeFile(join(home, 'memory', 'entries.jsonl'), '{}\n{}\n');
    await writeFile(join(home, 'knowledge', 'knowledge.db'), 'DB');

    // OS-home anchored assets (AGENTS.md + user skills)
    await mkdir(join(userHome, '.scream-code', 'skills', 'my-skill'), { recursive: true });
    await mkdir(join(userHome, '.scream-code', 'skills', 'bad-skill'), { recursive: true });
    await writeFile(join(userHome, '.scream-code', 'AGENTS.md'), '# User instructions\n');
    await writeFile(
      join(userHome, '.scream-code', 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\n---\nDo things.\n',
    );
    await writeFile(join(userHome, '.scream-code', 'skills', 'bad-skill', 'SKILL.md'), 'no frontmatter here\n');
    await writeFile(join(userHome, '.scream-code', 'skills', 'flat.md'), '---\nname: flat\n---\nFlat skill.\n');

    // project-level assets
    await mkdir(join(cwd, '.scream-code'), { recursive: true });
    await writeFile(join(cwd, '.scream-code', 'mcp.json'), JSON.stringify({ mcpServers: { gamma: {} } }));

    tool = new InspectOwnAssetsTool({ config: { cwd } } as unknown as Agent, {
      homeDir: home,
      userHomeDir: userHome,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function run(scope?: 'all' | 'skills' | 'mcp' | 'config' | 'memory' | 'knowledge') {
    const execution = tool.resolveExecution(scope === undefined ? {} : { scope });
    if (execution.isError) {
      throw new TypeError('unexpected error execution');
    }
    const result = await execution.execute({
      turnId: 'test',
      toolCallId: 'test',
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    return result.output;
  }

  it('reports all asset categories with scope=all (default)', async () => {
    const out = await run();

    expect(out).toContain('## Config');
    expect(out).toContain('## Skills');
    expect(out).toContain('## MCP servers');
    expect(out).toContain('## Memory');
    expect(out).toContain('## Knowledge');
  });

  it('reports config files with existence and size', async () => {
    const out = await run('config');

    expect(out).toContain('config.toml');
    expect(out).toContain('bytes');
    expect(out).toContain('tui.toml');
    expect(out).toContain('user-prefs.md');
    expect(out).toContain('AGENTS.md (user)');
    expect(out).toContain(join(userHome, '.scream-code', 'AGENTS.md'));
  });

  it('lists skills with frontmatter status, anchored to the OS home', async () => {
    const out = await run('skills');

    expect(out).toContain('my-skill');
    expect(out).toContain('ok');
    expect(out).toContain('bad-skill');
    expect(out).toContain('missing');
    expect(out).toContain('flat');
    expect(out).toContain(join(userHome, '.scream-code', 'skills'));
  });

  it('reports mcp.json files with server counts (user + project)', async () => {
    const out = await run('mcp');

    expect(out).toContain('user: ok — 2 servers');
    expect(out).toContain('project: ok — 1 server');
    expect(out).toContain(join(home, 'mcp.json'));
    expect(out).toContain(join(cwd, '.scream-code', 'mcp.json'));
  });

  it('reports memory and knowledge stores', async () => {
    const mem = await run('memory');
    expect(mem).toContain('memos.sqlite');
    expect(mem).toContain('bytes');
    expect(mem).toContain('entries.jsonl');

    const know = await run('knowledge');
    expect(know).toContain('knowledge.db');
  });

  it('reports missing files as missing without failing', async () => {
    await rm(join(home, 'config.toml'));
    const out = await run('config');

    expect(out).toContain('config.toml: missing');
  });

  it('reports parse errors in mcp.json as parse-error', async () => {
    await writeFile(join(home, 'mcp.json'), '{ not json');
    const out = await run('mcp');

    expect(out).toContain('user: parse-error');
  });

  it('reports parent-level mcp.json files found above the cwd', async () => {
    const parentDir = join(root, 'parent');
    await mkdir(join(parentDir, '.scream-code'), { recursive: true });
    await writeFile(join(parentDir, '.scream-code', 'mcp.json'), JSON.stringify({ mcpServers: { delta: {} } }));

    const nestedCwd = join(parentDir, 'nested', 'deep');
    await mkdir(nestedCwd, { recursive: true });
    const nestedTool = new InspectOwnAssetsTool(
      { config: { cwd: nestedCwd } } as unknown as Agent,
      { homeDir: home, userHomeDir: userHome },
    );
    const execution = nestedTool.resolveExecution({ scope: 'mcp' });
    if (execution.isError) {
      throw new TypeError('unexpected error execution');
    }
    const result = await execution.execute({
      turnId: 'test',
      toolCallId: 'test',
      signal: new AbortController().signal,
    });

    expect(result.output).toContain('parent: ok — 1 server');
  });

  it('discovers project skills anchored at the git root, not the cwd', async () => {
    // cwd is a nested subdirectory; the git root lives one level up.
    const gitRoot = join(root, 'repo');
    const projectSkills = join(gitRoot, '.scream-code', 'skills');
    await mkdir(join(gitRoot, '.git'), { recursive: true });
    await mkdir(join(projectSkills, 'repo-skill'), { recursive: true });
    await writeFile(
      join(projectSkills, 'repo-skill', 'SKILL.md'),
      '---\nname: repo-skill\n---\nRepo skill.\n',
    );
    const nestedCwd = join(gitRoot, 'src', 'nested');
    await mkdir(nestedCwd, { recursive: true });

    const nestedTool = new InspectOwnAssetsTool(
      { config: { cwd: nestedCwd } } as unknown as Agent,
      { homeDir: home, userHomeDir: userHome },
    );
    const execution = nestedTool.resolveExecution({ scope: 'skills' });
    if (execution.isError) {
      throw new TypeError('unexpected error execution');
    }
    const result = await execution.execute({
      turnId: 'test',
      toolCallId: 'test',
      signal: new AbortController().signal,
    });

    expect(result.output).toContain('repo-skill');
    expect(result.output).toContain(projectSkills);
  });

  it('skips non-skill entries (dot-dirs, node_modules, README.md, dirs without SKILL.md)', async () => {
    const skillsDir = join(userHome, '.scream-code', 'skills');
    await mkdir(join(skillsDir, '.hidden'), { recursive: true });
    await mkdir(join(skillsDir, 'node_modules'), { recursive: true });
    await mkdir(join(skillsDir, 'no-skill-md'), { recursive: true });
    await writeFile(join(skillsDir, 'README.md'), '# Skills\n');

    const out = await run('skills');

    expect(out).not.toContain('.hidden');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('no-skill-md');
    expect(out).not.toContain('README');
  });

  it('reports none when skills directories are missing', async () => {
    await rm(join(userHome, '.scream-code', 'skills'), { recursive: true, force: true });
    const out = await run('skills');

    expect(out).toContain('none');
  });

  it('reports plugin-managed (Extra) skills', async () => {
    const managed = join(home, 'plugins', 'managed', 'humanizer');
    await mkdir(managed, { recursive: true });
    await writeFile(join(managed, 'SKILL.md'), '---\nname: humanizer\n---\nExtra skill.\n');

    const out = await run('skills');

    expect(out).toContain('Plugin-managed skills');
    expect(out).toContain('humanizer');
    expect(out).toContain('ok');
  });

  it('reports oversize mcp.json as oversize without parsing it', async () => {
    await writeFile(join(home, 'mcp.json'), 'x'.repeat(1024 * 1024 + 1));
    const out = await run('mcp');

    expect(out).toContain('user: oversize');
  });

  it('marks dir skills with frontmatter but no name as broken', async () => {
    await mkdir(join(userHome, '.scream-code', 'skills', 'named-less'), { recursive: true });
    await writeFile(
      join(userHome, '.scream-code', 'skills', 'named-less', 'SKILL.md'),
      '---\ndescription: no name here\n---\nBody.\n',
    );

    const out = await run('skills');

    expect(out).toContain('named-less');
    expect(out).toContain('broken');
  });

  it('filters scopes: a single scope excludes other sections', async () => {
    const out = await run('memory');

    expect(out).toContain('## Memory');
    expect(out).not.toContain('## Config');
    expect(out).not.toContain('## Skills');
    expect(out).not.toContain('## MCP servers');
    expect(out).not.toContain('## Knowledge');
  });

  it('rejects an invalid scope at the schema level', () => {
    const result = InspectOwnAssetsInputSchema.safeParse({ scope: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('is not advertised by any subagent profile', () => {
    for (const [name, profile] of Object.entries(DEFAULT_AGENT_PROFILES)) {
      if (name === 'agent') continue;
      expect(profile.tools, name).not.toContain('InspectOwnAssets');
    }
  });

  it('is strictly read-only: file contents are unchanged after execution', async () => {
    const before = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(home, 'config.toml'), 'utf-8'),
    );
    await run();
    const after = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(home, 'config.toml'), 'utf-8'),
    );
    expect(after).toBe(before);
  });
});
