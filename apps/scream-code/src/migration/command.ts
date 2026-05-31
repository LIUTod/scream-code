/**
 * `scream migrate` sub-command — permanently disabled.
 *
 * The scream-cli → scream-code migration feature has been removed.
 * The command is kept for backwards compatibility but prints a notice.
 */

import type { Command } from 'commander';

export function registerMigrateCommand(parent: Command, _onMigrate: () => void): void {
  parent
    .command('migrate')
    .description('将旧版 scream-cli 安装的数据迁移到 scream-code。（已停用）')
    .action(() => {
      process.stdout.write('迁移功能已取消，不再支持从 scream-cli 导入数据。\n');
      process.exit(0);
    });
}
