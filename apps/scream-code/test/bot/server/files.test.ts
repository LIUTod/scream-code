import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotFiles, MAX_FILE_READ } from '../../../src/bot/server/files';
import { BotStore } from '../../../src/bot/server/store';

let directory: string;
let store: BotStore;
let files: BotFiles;
let workspace: string;
let otherWorkspace: string;
let botId: string;
beforeEach(() => {
  const cache = resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  directory = mkdtempSync(join(cache, 'bot-files-'));
  workspace = join(directory, 'first');
  otherWorkspace = join(directory, 'second');
  mkdirSync(workspace);
  mkdirSync(otherWorkspace);
  store = new BotStore(':memory:');
  store.open();
  botId = store.createBot({ name: 'Reader', workspace }).id;
  files = new BotFiles(store);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('workspace file access', () => {
  it('keeps an existing thread fixed to its workspace after the Bot default changes', async () => {
    writeFileSync(join(workspace, 'old.txt'), 'original workspace');
    const thread = store.createThread(botId);
    store.updateBot(botId, { workspace: otherWorkspace });
    expect(await files.list(botId, undefined, thread.id)).toMatchObject({
      path: workspace, entries: [{ name: 'old.txt', path: join(workspace, 'old.txt'), type: 'file', size: 18 }],
    });
    expect(await files.read(botId, 'old.txt', thread.id)).toEqual({ path: join(workspace, 'old.txt'), content: 'original workspace', truncated: false });
    expect(await files.kind(botId, 'old.txt', thread.id)).toBe('file');
    expect(await files.list(botId, undefined)).toEqual({ path: otherWorkspace, entries: [] });
  });

  it('rejects unknown or foreign threads rather than falling back to a Bot root', async () => {
    const other = store.createBot({ name: 'Other', workspace: otherWorkspace });
    const foreign = store.createThread(other.id);
    await expect(files.list(botId, undefined, foreign.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(files.read(botId, 'anything', 'missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('enters subdirectories and blocks lexical, realpath and symlink escapes', async () => {
    const nested = join(workspace, 'src');
    mkdirSync(nested);
    writeFileSync(join(nested, 'notes.txt'), 'notes');
    writeFileSync(join(otherWorkspace, 'secret.txt'), 'private');
    symlinkSync(otherWorkspace, join(workspace, 'outside'));
    symlinkSync(join(otherWorkspace, 'secret.txt'), join(workspace, 'secret-link'));
    symlinkSync(nested, join(workspace, 'inside'));
    expect((await files.list(botId, 'src')).path).toBe(nested);
    expect((await files.list(botId, undefined)).entries.map((entry) => entry.name)).toEqual(['inside', 'src']);
    await expect(files.list(botId, '../second')).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read(botId, join(otherWorkspace, 'secret.txt'))).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read(botId, 'outside/secret.txt')).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read(botId, 'secret-link')).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.write(botId, 'secret-link', 'must not escape')).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.write(botId, 'outside/new.txt', 'must not escape')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a dangling leaf symlink before a write can create a file outside the workspace', async () => {
    symlinkSync(join(otherWorkspace, 'new.txt'), join(workspace, 'dangling'));
    await expect(files.write(botId, 'dangling', 'must not create outside')).rejects.toMatchObject({ statusCode: 403 });
    expect((await files.list(botId, undefined)).entries).toEqual([]);
    expect((await files.list(store.createBot({ name: 'Outside', workspace: otherWorkspace }).id, undefined)).entries).toEqual([]);
  });

  it('bounds preview bytes, reports truncation truthfully and never splits a UTF-8 character', async () => {
    writeFileSync(join(workspace, 'large.txt'), 'a'.repeat(MAX_FILE_READ - 1) + '中'.repeat(MAX_FILE_READ));
    const preview = await files.read(botId, 'large.txt');
    expect(preview.truncated).toBe(true);
    expect(preview.content).toBe('a'.repeat(MAX_FILE_READ - 1));
    writeFileSync(join(workspace, 'exact.txt'), 'x'.repeat(MAX_FILE_READ));
    expect(await files.read(botId, 'exact.txt')).toMatchObject({ content: 'x'.repeat(MAX_FILE_READ), truncated: false });
    writeFileSync(join(workspace, 'empty.txt'), '');
    expect(await files.read(botId, 'empty.txt')).toMatchObject({ content: '', truncated: false });
  });
});
