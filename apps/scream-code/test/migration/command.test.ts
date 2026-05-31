/**
 * `scream migrate` — permanently disabled. The command is kept for backwards
 * compatibility but prints a notice and exits.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerMigrateCommand } from '#/migration/command';

describe('registerMigrateCommand', () => {
  it('adds a flagless migrate subcommand to the program', () => {
    const program = new Command('scream');
    registerMigrateCommand(program, () => {});
    const sub = program.commands.find((c) => c.name() === 'migrate');
    expect(sub).toBeDefined();
    expect(sub!.description()).toContain('迁移');
    expect(sub!.options).toHaveLength(0);
  });

  it('prints a disabled notice and exits when `migrate` runs', () => {
    const program = new Command('scream');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    registerMigrateCommand(program, () => {});
    program.parse(['migrate'], { from: 'user' });
    expect(stdoutSpy).toHaveBeenCalledWith('迁移功能已取消，不再支持从 scream-cli 导入数据。\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
