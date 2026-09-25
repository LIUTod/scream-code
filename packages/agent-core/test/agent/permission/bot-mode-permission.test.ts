import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import { BotModePermissionPolicy } from '../../../src/agent/permission/policies/bot-mode-permission';
import type { PermissionPolicyContext } from '../../../src/agent/permission/types';

function ctx(toolName: string, args: Record<string, unknown> = {}): PermissionPolicyContext {
  return { toolCall: { name: toolName, arguments: undefined }, args } as unknown as PermissionPolicyContext;
}

function botPolicy(): BotModePermissionPolicy {
  return new BotModePermissionPolicy({
    permission: { mode: 'bot' },
    config: { cwd: '/work' },
  } as unknown as Agent);
}

function manualPolicy(): BotModePermissionPolicy {
  return new BotModePermissionPolicy({ permission: { mode: 'manual' } } as unknown as Agent);
}

describe('BotModePermissionPolicy', () => {
  it('is inert outside bot mode', () => {
    expect(manualPolicy().evaluate(ctx('Bash', { command: 'rm -rf /' }))).toBeUndefined();
    expect(manualPolicy().evaluate(ctx('Write', { path: '/tmp/x' }))).toBeUndefined();
  });

  it('approves read-only tools in bot mode', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'WebSearch', 'TodoList', 'ContactParent', 'Agent', 'UpdateGoal']) {
      expect(botPolicy().evaluate(ctx(tool))?.kind).toBe('approve');
    }
  });

  it('approves in-workspace edits in bot mode', () => {
    expect(botPolicy().evaluate(ctx('Write', { path: './file.ts' }))?.kind).toBe('approve');
    expect(botPolicy().evaluate(ctx('Edit', { path: './file.ts' }))?.kind).toBe('approve');
  });

  it('denies Windows drive and UNC writes outside a POSIX workspace', () => {
    // `C:\outside\f.txt` used to read as a relative name (it does not start
    // with `/`) and got joined onto the workspace, so the policy approved a
    // write that lands outside it.
    for (const path of [
      String.raw`C:\outside\f.txt`,
      'C:/outside/f.txt',
      String.raw`C:outside\f.txt`,
      String.raw`\\server\share\f.txt`,
      '/outside/f.txt',
      '../outside/f.txt',
    ]) {
      expect(botPolicy().evaluate(ctx('Write', { path }))?.kind).toBe('deny');
    }
  });

  it('keeps a Windows workspace writable through a drive and UNC base', () => {
    const drivePolicy = new BotModePermissionPolicy({
      permission: { mode: 'bot' },
      config: { cwd: String.raw`C:\work` },
    } as unknown as Agent);
    expect(drivePolicy.evaluate(ctx('Write', { path: String.raw`C:\work\sub\f.ts` }))?.kind).toBe('approve');
    expect(drivePolicy.evaluate(ctx('Write', { path: String.raw`c:\WORK\sub\f.ts` }))?.kind).toBe('approve');
    expect(drivePolicy.evaluate(ctx('Write', { path: String.raw`C:\work-evil\f.ts` }))?.kind).toBe('deny');
    expect(drivePolicy.evaluate(ctx('Write', { path: String.raw`C:\outside\f.ts` }))?.kind).toBe('deny');

    const uncPolicy = new BotModePermissionPolicy({
      permission: { mode: 'bot' },
      config: { cwd: String.raw`\\server\share` },
    } as unknown as Agent);
    expect(uncPolicy.evaluate(ctx('Edit', { path: String.raw`\\server\share\f.ts` }))?.kind).toBe('approve');
    expect(uncPolicy.evaluate(ctx('Edit', { path: String.raw`\\server\other\f.ts` }))?.kind).toBe('deny');
  });

  it('still denies sensitive files inside the workspace', () => {
    for (const path of ['sub/.env', '.env.local', 'keys/id_rsa', 'creds/token.txt']) {
      expect(botPolicy().evaluate(ctx('Write', { path }))?.kind).toBe('deny');
    }
  });

  it('approves read-only Bash commands in bot mode', () => {
    for (const command of ['git status', 'git diff --stat', 'ls -la', 'cat package.json', 'node -v', 'pnpm ls']) {
      expect(botPolicy().evaluate(ctx('Bash', { command }))?.kind).toBe('approve');
    }
  });

  it('denies dangerous Bash commands in bot mode', () => {
    for (const command of ['rm -rf /', 'git push origin main', 'npm publish', 'chmod 777 file', 'sudo shutdown']) {
      expect(botPolicy().evaluate(ctx('Bash', { command }))?.kind).toBe('deny');
    }
  });

  it('denies unclassified Bash commands in bot mode (fail-closed)', () => {
    expect(botPolicy().evaluate(ctx('Bash', { command: 'some-custom-tool --migrate' }))?.kind).toBe('deny');
  });

  it('denies tools outside the reversible allowlist in bot mode', () => {
    expect(botPolicy().evaluate(ctx('MakeSkillPlan'))?.kind).toBe('deny');
    expect(botPolicy().evaluate(ctx('Bash', { command: 'sleep 10' }))?.kind).toBe('deny');
  });
});
