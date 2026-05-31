import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateMcpStep } from '../../src/steps/mcp.js';

let src: string;
let tgt: string;
beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'src-'));
  tgt = await mkdtemp(join(tmpdir(), 'tgt-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(tgt, { recursive: true, force: true });
});

describe('migrateMcpStep', () => {
  it('writes mcp.json when target absent', async () => {
    await writeFile(
      join(src, 'mcp.json'),
      JSON.stringify({ mcpServers: { foo: { command: 'foo' } } }),
    );
    const r = await migrateMcpStep({ sourceHome: src, targetHome: tgt });
    expect(r.mergedServers).toEqual(['foo']);
    const text = await readFile(join(tgt, 'mcp.json'), 'utf-8');
    expect(JSON.parse(text).mcpServers.foo.command).toBe('foo');
  });

  it('merges, keeping new for conflicts on same name', async () => {
    await writeFile(
      join(src, 'mcp.json'),
      JSON.stringify({
        mcpServers: { foo: { command: 'old-foo' }, baz: { command: 'baz' } },
      }),
    );
    await writeFile(
      join(tgt, 'mcp.json'),
      JSON.stringify({
        mcpServers: { foo: { command: 'new-foo' }, bar: { command: 'bar' } },
      }),
    );
    const r = await migrateMcpStep({ sourceHome: src, targetHome: tgt });
    const final = JSON.parse(await readFile(join(tgt, 'mcp.json'), 'utf-8'));
    expect(final.mcpServers.foo.command).toBe('new-foo');
    expect(final.mcpServers.bar.command).toBe('bar');
    expect(final.mcpServers.baz.command).toBe('baz');
    expect(r.keptNewForConflicts).toEqual(['foo']);
    expect(r.mergedServers).toEqual(['baz']);
  });

  it('no source mcp.json: nothing happens', async () => {
    const r = await migrateMcpStep({ sourceHome: src, targetHome: tgt });
    expect(r.mergedServers).toEqual([]);
  });

  it('drops MCP server entries scream-code\'s schema rejects', async () => {
    await writeFile(
      join(src, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          good: { command: 'good-cmd' },
          bad: { description: 'has neither command nor url' },
        },
      }),
    );
    const r = await migrateMcpStep({ sourceHome: src, targetHome: tgt });
    expect(r.mergedServers).toEqual(['good']);
    expect(r.droppedServers).toEqual(['bad']);
    const final = JSON.parse(await readFile(join(tgt, 'mcp.json'), 'utf-8'));
    expect(final.mcpServers.good).toBeDefined();
    expect(final.mcpServers.bad).toBeUndefined();
  });

  it('preserves a malformed target mcp.json and writes a sibling instead', async () => {
    await writeFile(
      join(src, 'mcp.json'),
      JSON.stringify({ mcpServers: { foo: { command: 'foo' } } }),
    );
    await writeFile(join(tgt, 'mcp.json'), 'this is not json {{{');
    const r = await migrateMcpStep({ sourceHome: src, targetHome: tgt });
    expect(r.wroteSiblingDueToConflict).toBe(true);
    // The user's malformed file is left untouched — no data loss.
    expect(await readFile(join(tgt, 'mcp.json'), 'utf-8')).toBe('this is not json {{{');
    // Migrated servers land in the sibling instead.
    const sibling = JSON.parse(
      await readFile(join(tgt, 'mcp.migrated-from-scream-cli.json'), 'utf-8'),
    );
    expect(sibling.mcpServers.foo.command).toBe('foo');
  });
});
