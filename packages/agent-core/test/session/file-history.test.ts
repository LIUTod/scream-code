import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { LocalJian } from '@scream-code/jian';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FILE_HISTORY_MAX_FILE_BYTES, FileHistory } from '../../src/session/file-history';
import { withFileMutationLock } from '../../src/tools/builtin/file/mutation-queue';

let root: string;
let project: string;
let sessionDir: string;
let jian: LocalJian;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'file-history-'));
  project = join(root, 'project');
  sessionDir = join(root, 'session');
  jian = await LocalJian.create(root);
  await jian.mkdir(project, { parents: true, existOk: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const history = () => new FileHistory({ jian, sessionDir });
const file = (name: string) => join(project, name);
/** What a write tool does: write inside the lock with the history recording. */
const toolWrite = (h: FileHistory, path: string, text: string) =>
  withFileMutationLock(
    path,
    async () => {
      writeFileSync(path, text);
    },
    h,
  );

describe('FileHistory', () => {
  it('puts a changed file back and deletes a file the turn created', async () => {
    writeFileSync(file('a.ts'), 'original');
    const h = history();
    h.beginPrompt('m1');
    await toolWrite(h, file('a.ts'), 'edited once');
    await toolWrite(h, file('a.ts'), 'edited twice');
    await toolWrite(h, file('new.ts'), 'created');

    expect(await h.changedFiles(['m1'])).toEqual([file('a.ts'), file('new.ts')]);
    const result = await h.restore(['m1']);

    expect(result).toEqual({ restored: [file('a.ts'), file('new.ts')], skipped: [] });
    expect(readFileSync(file('a.ts'), 'utf8')).toBe('original');
    expect(existsSync(file('new.ts'))).toBe(false);
    expect(await h.changedFiles(['m1'])).toEqual([]);
  });

  it('keeps a file someone changed after the last write, and says so', async () => {
    writeFileSync(file('a.ts'), 'original');
    const h = history();
    h.beginPrompt('m1');
    await toolWrite(h, file('a.ts'), 'by the agent');
    writeFileSync(file('a.ts'), 'by hand');

    const result = await h.restore(['m1']);
    expect(result).toEqual({ restored: [], skipped: [{ path: file('a.ts'), reason: 'changed' }] });
    expect(readFileSync(file('a.ts'), 'utf8')).toBe('by hand');
  });

  it('undoing several prompts goes back to before the first of them; other prompts stay', async () => {
    writeFileSync(file('a.ts'), 'v0');
    const h = history();
    h.beginPrompt('m1');
    await toolWrite(h, file('a.ts'), 'v1');
    h.beginPrompt('m3');
    await toolWrite(h, file('a.ts'), 'v2');
    h.beginPrompt('m5');
    await toolWrite(h, file('a.ts'), 'v3');

    await h.restore(['m5', 'm3']);
    expect(readFileSync(file('a.ts'), 'utf8')).toBe('v1');
    // The earlier prompt can still be undone afterwards.
    await h.restore(['m1']);
    expect(readFileSync(file('a.ts'), 'utf8')).toBe('v0');
  });

  it('records nothing before the first prompt, and forgets prompts undone without their files', async () => {
    writeFileSync(file('a.ts'), 'v0');
    const h = history();
    await toolWrite(h, file('a.ts'), 'before any prompt');
    expect(await h.changedFiles(['m1'])).toEqual([]);

    h.beginPrompt('m1');
    await toolWrite(h, file('a.ts'), 'v1');
    await h.discard(['m1']);
    expect(await h.changedFiles(['m1'])).toEqual([]);
    expect(readFileSync(file('a.ts'), 'utf8')).toBe('v1');
  });

  it('survives a restart: a new history over the same session directory still restores', async () => {
    writeFileSync(file('a.ts'), 'original');
    const first = history();
    first.beginPrompt('m1');
    await toolWrite(first, file('a.ts'), 'edited');

    const resumed = history();
    expect(await resumed.changedFiles(['m1'])).toEqual([file('a.ts')]);
    expect((await resumed.restore(['m1'])).restored).toEqual([file('a.ts')]);
    expect(readFileSync(file('a.ts'), 'utf8')).toBe('original');
  });

  it('does not copy a file over the size limit, and reports it instead of restoring', async () => {
    writeFileSync(file('big.bin'), Buffer.alloc(FILE_HISTORY_MAX_FILE_BYTES + 1, 1));
    const h = history();
    h.beginPrompt('m1');
    await toolWrite(h, file('big.bin'), 'small now');
    expect(await h.restore(['m1'])).toEqual({ restored: [], skipped: [{ path: file('big.bin'), reason: 'too_large' }] });
  });

  it('leaves a file that ended up as it was alone (a failed write), without reporting it', async () => {
    writeFileSync(file('a.ts'), 'original');
    const h = history();
    h.beginPrompt('m1');
    await expect(
      withFileMutationLock(file('a.ts'), async () => {
        throw new Error('write refused');
      }, h),
    ).rejects.toThrow('write refused');
    expect(await h.restore(['m1'])).toEqual({ restored: [], skipped: [] });
  });

  it('never fails a write when the history cannot keep a copy', async () => {
    writeFileSync(file('a.ts'), 'original');
    const broken = new FileHistory({ jian, sessionDir: join(file('a.ts'), 'not-a-dir') });
    broken.beginPrompt('m1');
    await toolWrite(broken, file('a.ts'), 'written anyway');
    expect(readFileSync(file('a.ts'), 'utf8')).toBe('written anyway');
  });
});

describe('FileHistory — prompt source and untouched files', () => {
  it('files changes under the prompt the source names, and lists only files that really changed', async () => {
    writeFileSync(file('a.ts'), 'same');
    writeFileSync(file('b.ts'), 'before');
    const h = history();
    let prompt: string | undefined = 'm7';
    h.setPromptSource(() => prompt);
    // An edit that wrote nothing (its old text was not found).
    await withFileMutationLock(file('a.ts'), async () => {}, h);
    await toolWrite(h, file('b.ts'), 'after');
    expect(await h.changedFiles(['m7'])).toEqual([file('b.ts')]);
    prompt = undefined;
    await toolWrite(h, file('b.ts'), 'not filed');
    expect(await h.changedFiles(['m7'])).toEqual([file('b.ts')]);
  });
});
