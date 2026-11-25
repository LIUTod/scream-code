import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BashTool } from '../../src/tools/builtin/shell/bash';
import { computeAnchor } from '../../src/tools/builtin/file/line-endings';
import { EditSnapshotStore } from '../../src/tools/support/edit-snapshot-store';
import { testJian } from '../fixtures/test-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const run = (tool: BashTool, command: string) =>
  executeTool(tool, { turnId: '0', toolCallId: 'tc_bash', args: { command }, signal });
const textOf = (output: unknown): string => (typeof output === 'string' ? output : JSON.stringify(output));

describe.skipIf(process.platform === 'win32')('BashTool — files a command changed', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bash-changes-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a tracked file the command edited, with its diff, and adopts the new text', async () => {
    const file = join(dir, 'app.ts');
    await writeFile(file, 'const port = 3000;\nconst host = "x";\n');
    const store = new EditSnapshotStore();
    const before = 'const port = 3000;\nconst host = "x";\n';
    store.remember(file, { content: before, anchor: computeAnchor(before), recordedAt: 'read' });
    const tool = new BashTool(testJian, dir, undefined, { editSnapshots: store });

    const result = await run(tool, `python3 -c "import pathlib; p=pathlib.Path('app.ts'); p.write_text(p.read_text().replace('3000','8080'))"`);

    expect(await readFile(file, 'utf8')).toContain('8080');
    expect(textOf(result.output)).toContain('[note] This command changed app.ts');
    expect(textOf(result.output)).toContain('use Edit or Write');
    const display = (result as { display?: { kind: string; files: { path: string; added: number; removed: number }[] } }).display;
    expect(display?.kind).toBe('file_changes');
    expect(display?.files[0]).toMatchObject({ path: 'app.ts', added: 1, removed: 1 });
    // The command's output is now the known view: an Edit with the Read's
    // anchor is recognised as working across the agent's own change.
    expect(store.recall(file)?.content).toContain('8080');
    expect(store.changedOnlyByOwnEdits(file, computeAnchor(before), store.recall(file)!.content)).toBe(true);
  });

  it('adds nothing when the command leaves tracked files alone', async () => {
    const file = join(dir, 'app.ts');
    await writeFile(file, 'x\n');
    const store = new EditSnapshotStore();
    store.remember(file, { content: 'x\n', anchor: computeAnchor('x\n'), recordedAt: 'read' });
    const tool = new BashTool(testJian, dir, undefined, { editSnapshots: store });

    const result = await run(tool, 'echo hello');

    expect(textOf(result.output)).not.toContain('[note]');
    expect((result as { display?: unknown }).display).toBeUndefined();
  });

  it('says so when commands keep editing files', async () => {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'one\n');
    const store = new EditSnapshotStore();
    store.remember(file, { content: 'one\n', anchor: computeAnchor('one\n'), recordedAt: 'read' });
    const tool = new BashTool(testJian, dir, undefined, { editSnapshots: store });

    await run(tool, 'printf "two\\n" >> a.txt');
    const second = await run(tool, 'printf "three\\n" >> a.txt');

    expect(textOf(second.output)).toContain('That is 2 commands in this session that edited files.');
  });
});
