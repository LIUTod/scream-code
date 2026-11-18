import { describe, expect, it } from 'vitest';

import { buildSelfMap } from '../../src/profile/self-map';

describe('buildSelfMap', () => {
  const opts = {
    homeDir: '/home/user/.scream-code',
    cwd: '/work/project',
  };

  it('lists configuration assets with their resolved paths', () => {
    const map = buildSelfMap(opts);

    expect(map).toContain('config.toml');
    expect(map).toContain('/home/user/.scream-code/config.toml');
    expect(map).toContain('tui.toml');
    expect(map).toContain('/home/user/.scream-code/tui.toml');
    expect(map).toContain('user-prefs.md');
    expect(map).toContain('/home/user/.scream-code/user-prefs.md');
    expect(map).toContain('mcp.json');
    expect(map).toContain('/home/user/.scream-code/mcp.json');
    expect(map).toContain('/work/project/.scream-code/mcp.json');
    expect(map).toContain('AGENTS.md');
    expect(map).toContain('/home/user/.scream-code/AGENTS.md');
  });

  it('lists data assets (skills / plugins / memory / knowledge)', () => {
    const map = buildSelfMap(opts);

    expect(map).toContain('skills/');
    expect(map).toContain('/home/user/.scream-code/skills');
    expect(map).toContain('plugins/');
    expect(map).toContain('/home/user/.scream-code/plugins');
    expect(map).toContain('memory/');
    expect(map).toContain('/home/user/.scream-code/memory');
    expect(map).toContain('memos.sqlite');
    expect(map).toContain('knowledge/');
    expect(map).toContain('/home/user/.scream-code/knowledge');
    expect(map).toContain('knowledge.db');
    expect(map).toContain('KnowledgeLookup tool');
  });

  it('puts the user-level AGENTS.md and skills in the scream home with everything else', () => {
    // SCREAM_CODE_HOME scenario: the scream home is not ~/.scream-code.
    const map = buildSelfMap({
      homeDir: '/custom/scream-home',
      cwd: '/work/project',
    });

    // The user's own instructions and skills move with SCREAM_CODE_HOME too.
    expect(map).toContain('/custom/scream-home/AGENTS.md');
    expect(map).toContain('/custom/scream-home/skills');
    expect(map).not.toContain('.scream-code/AGENTS.md');
    expect(map).toContain('/custom/scream-home/config.toml');
    expect(map).toContain('/custom/scream-home/tui.toml');
    expect(map).toContain('/custom/scream-home/memory');
    expect(map).toContain('/custom/scream-home/knowledge');
  });

  it('declares the boundary: core code and runtime artifacts are not assets', () => {
    const map = buildSelfMap(opts);

    expect(map).toContain('Do not modify these files unless the user explicitly asks');
    expect(map).toContain('NEVER modify core code');
    expect(map).toContain('packages/agent-core');
    expect(map).toContain('Runtime artifacts');
    expect(map).toContain('sessions/');
    expect(map).toContain('logs/');
    expect(map).toContain('session_index.jsonl');
    expect(map).toContain('device_id');
    expect(map).toContain('dream-lock.json');
    // Wildcard must be code-fenced so it cannot pair with stray asterisks
    expect(map).toContain('`*cache.json`');
    expect(map).not.toContain('(*cache.json)');
  });

  it('keeps backticks paired (markdown render hygiene)', () => {
    const map = buildSelfMap(opts);
    const ticks = (map.match(/`/g) ?? []).length;

    expect(ticks % 2).toBe(0);
  });

  it('does not leave unrendered template variables', () => {
    const map = buildSelfMap(opts);

    expect(map).not.toContain('{{');
    expect(map).not.toContain('}}');
    expect(map).not.toContain('${');
  });

  it('derives paths from the provided options (no hardcoded absolute paths)', () => {
    const map = buildSelfMap({
      homeDir: '/custom/home/.scream-code',
      cwd: '/custom/proj',
    });

    expect(map).toContain('/custom/home/.scream-code/config.toml');
    expect(map).toContain('/custom/proj/.scream-code/mcp.json');
    expect(map).not.toContain('/home/user/.scream-code');
    expect(map).not.toContain('/work/project');
  });

  it('handles Windows-style paths without breaking backtick pairing', () => {
    const map = buildSelfMap({
      homeDir: 'C:\\Users\\someone\\.scream-code',
      cwd: 'C:\\work\\project',
    });

    // pathe normalizes Windows backslashes to forward slashes — the map
    // output stays valid on Windows (Node accepts forward-slash paths).
    expect(map).toContain('C:/Users/someone/.scream-code/config.toml');
    expect(map).toContain('C:/work/project/.scream-code/mcp.json');
    const ticks = (map.match(/`/g) ?? []).length;
    expect(ticks % 2).toBe(0);
  });
});
