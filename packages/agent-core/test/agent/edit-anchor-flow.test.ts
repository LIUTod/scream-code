import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolCall } from '@scream-code/ltod';
import { afterEach, describe, expect, it } from 'vitest';

import { computeAnchor } from '../../src/tools/builtin/file/line-endings';
import { testAgent } from './harness/agent';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

describe('Edit across the agent’s own earlier edit, through a real turn', () => {
  it('applies a second string edit that still carries the anchor of the first Read', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scream-anchor-flow-')));
    dirs.push(dir);
    const filePath = join(dir, 'target.ts');
    const original = 'const a = 1;\nconst b = 2;\n';
    writeFileSync(filePath, original, 'utf8');
    const anchor = computeAnchor(original);

    const ctx = testAgent();
    ctx.configure({ tools: ['Read', 'Edit'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.agent.config.update({ cwd: dir });

    ctx.mockNextResponse({ type: 'text', text: 'Reading.' }, call('r1', 'Read', { path: filePath }));
    ctx.mockNextResponse({ type: 'text', text: 'First edit.' }, call('e1', 'Edit', { path: filePath, old_string: 'const a = 1;', new_string: 'const a = 10;', anchor }));
    ctx.mockNextResponse({ type: 'text', text: 'Second edit.' }, call('e2', 'Edit', { path: filePath, old_string: 'const b = 2;', new_string: 'const b = 20;', anchor }));
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Edit the file' }] });
    await ctx.untilTurnEnd();

    expect(readFileSync(filePath, 'utf8')).toBe('const a = 10;\nconst b = 20;\n');
    const history = JSON.stringify(ctx.agent.context.data().history);
    expect(history).not.toContain('anchor no longer matches');
    // Its own change is not reported back as someone else's.
    expect(history).not.toContain('not by your edits');
    expect(history).not.toContain('changed since you last saw them');
  });

  it.skipIf(process.platform === 'win32')('reports a shell command’s change once, on its own result, not again before the next step', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scream-shell-flow-')));
    dirs.push(dir);
    const filePath = join(dir, 'app.ts');
    writeFileSync(filePath, 'const port = 3000;\n', 'utf8');

    const ctx = testAgent();
    ctx.configure({ tools: ['Read', 'Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.agent.config.update({ cwd: dir });

    ctx.mockNextResponse({ type: 'text', text: 'Reading.' }, call('r1', 'Read', { path: filePath }));
    ctx.mockNextResponse(
      { type: 'text', text: 'Patching with a script.' },
      call('b1', 'Bash', { command: `python3 -c "import pathlib; p=pathlib.Path('app.ts'); p.write_text(p.read_text().replace('3000','8080'))"` }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Change the port' }] });
    await ctx.untilTurnEnd();

    expect(readFileSync(filePath, 'utf8')).toBe('const port = 8080;\n');
    const history = JSON.stringify(ctx.agent.context.data().history);
    expect(history).toContain('[note] This command changed app.ts');
    expect(history).not.toContain('changed since you last saw them');
  });
});
