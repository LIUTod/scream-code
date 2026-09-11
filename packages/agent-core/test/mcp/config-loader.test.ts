import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, ScreamError } from '../../src/errors';
import { loadMcpServers, resolveMcpJsonPaths } from '../../src/mcp/config-loader';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scream-mcp-loader-'));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf-8');
}

describe('resolveMcpJsonPaths', () => {
  it('returns the canonical user and project paths', () => {
    const paths = resolveMcpJsonPaths({ cwd: '/work/proj', homeDir: '/home/user/.scream-code' });
    expect(paths.user).toBe('/home/user/.scream-code/mcp.json');
    expect(paths.project).toBe('/work/proj/.scream-code/mcp.json');
  });
});

describe('loadMcpServers', () => {
  it('returns an empty map when no files exist', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers).toEqual({});
  });

  it('treats empty JSON files as empty maps', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeFile(join(home, 'mcp.json'), '   \n');
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers).toEqual({});
  });

  it('merges project-local mcp.json with user-global, project overriding on conflict', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();

    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-user' },
        userOnly: { transport: 'stdio', command: 'user-only' },
      },
    });
    await writeJson(join(cwd, '.scream-code', 'mcp.json'), {
      mcpServers: {
        shared: { transport: 'stdio', command: 'shared-project' },
        local: { transport: 'http', url: 'http://localhost:8080/mcp' },
      },
    });

    const servers = await loadMcpServers({ cwd, homeDir: home });

    expect(Object.keys(servers).toSorted()).toEqual(['local', 'shared', 'userOnly']);
    expect(servers['shared']).toEqual({
      transport: 'stdio',
      command: 'shared-project',
    });
    expect(servers['userOnly']).toEqual({
      transport: 'stdio',
      command: 'user-only',
    });
    expect(servers['local']).toEqual({
      transport: 'http',
      url: 'http://localhost:8080/mcp',
    });
  });

  it('throws ScreamError(config.invalid) on invalid JSON', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeFile(join(home, 'mcp.json'), '{not json}', 'utf-8');
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toBeInstanceOf(ScreamError);
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws ScreamError(config.invalid) on schema violation (unknown transport)', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'sse', url: 'https://x' } },
    });
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('throws ScreamError(config.invalid) on schema violation (missing required field)', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'stdio' } },
    });
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('infers transport=stdio when an entry omits transport but has command', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    });
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers['gh']).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
  });

  it('infers transport=http when an entry omits transport but has url', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        remote: { url: 'https://mcp.example.com/sse' },
      },
    });
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers['remote']).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/sse',
    });
  });

  it('honors SCREAM_CODE_HOME env var when homeDir is not supplied', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { from_env: { transport: 'stdio', command: 'env-cmd' } },
    });
    const saved = process.env['SCREAM_CODE_HOME'];
    process.env['SCREAM_CODE_HOME'] = home;
    try {
      const servers = await loadMcpServers({ cwd });
      expect(servers['from_env']).toEqual({ transport: 'stdio', command: 'env-cmd' });
    } finally {
      if (saved === undefined) delete process.env['SCREAM_CODE_HOME'];
      else process.env['SCREAM_CODE_HOME'] = saved;
    }
  });
});

describe('loadMcpServers capabilities (config-layer semantics)', () => {
  it('keeps legacy entries (no capabilities key) parsing exactly as before', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { legacy: { transport: 'stdio', command: 'cmd', args: ['a'] } },
    });
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers['legacy']).toEqual({ transport: 'stdio', command: 'cmd', args: ['a'] });
    expect('capabilities' in (servers['legacy'] ?? {})).toBe(false);
  });

  it('preserves explicit capabilities arrays, including the opt-out []', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        chrome: { transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], capabilities: ['browser'] },
        off: { transport: 'stdio', command: 'x', capabilities: [] },
      },
    });
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers['chrome']?.capabilities).toEqual(['browser']);
    expect(servers['off']?.capabilities).toEqual([]);
  });

  it('strips unknown future keys so older binaries keep working (forward compat)', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        future: { transport: 'stdio', command: 'x', usageHints: ['preview'], someNewObj: { a: 1 } },
      },
    });
    const servers = await loadMcpServers({ cwd, homeDir: home });
    expect(servers['future']).toEqual({ transport: 'stdio', command: 'x' });
  });

  it('rejects a non-array capabilities value with CONFIG_INVALID', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { bad: { transport: 'stdio', command: 'x', capabilities: 'browser' } },
    });
    await expect(loadMcpServers({ cwd, homeDir: home })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('project-level entry fully replaces the user entry, capabilities included', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { svc: { transport: 'stdio', command: 'user', capabilities: ['browser'] } },
    });
    await writeJson(join(cwd, '.scream-code', 'mcp.json'), {
      mcpServers: { svc: { transport: 'stdio', command: 'proj' } },
    });
    const servers = await loadMcpServers({ cwd, homeDir: home });
    // Whole-entry override: the project entry carries no declaration, so the
    // merged config has none (fingerprinting downstream can still rescue
    // known servers by name/args).
    expect(servers['svc']).toEqual({ transport: 'stdio', command: 'proj' });
    expect(servers['svc']?.capabilities).toBeUndefined();
  });
});
