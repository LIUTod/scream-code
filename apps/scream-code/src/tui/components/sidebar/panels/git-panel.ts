import chalk from 'chalk';
import { basename } from 'node:path';
import { truncateToWidth } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';

import type { ColorPalette } from '#/tui/theme/colors';

import type { SidebarPanel, SidebarPanelContext } from '../sidebar-panel';

/**
 * Summary-only Git panel (摘要式): the workdir name plus added (green) /
 * deleted (red) line counts and the changed-file count. Reads the current
 * snapshot in render so the panel never shows a stale working tree.
 */
class GitPanelContent {
  constructor(
    private readonly ctx: SidebarPanelContext,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const git = this.ctx.getData().git;
    if (git === undefined) {
      return [chalk.hex(this.colors.textDim)(t('sidebar.git_no_repo'))];
    }
    const dim = (s: string): string => chalk.hex(this.colors.textDim)(s);
    const workDir = truncateToWidth(chalk.hex(this.colors.text)(basename(git.workDir)), width);

    if (git.diffAdded === 0 && git.diffDeleted === 0 && git.filesCount === 0) {
      return [workDir, dim(t('sidebar.git_clean'))];
    }
    const added = chalk.hex(this.colors.success)(`+${git.diffAdded}`);
    const deleted = chalk.hex(this.colors.error)(`−${git.diffDeleted}`);
    const count = dim(t('sidebar.git_files', { count: git.filesCount }));
    const summary = truncateToWidth(`${added} ${deleted}  ${count}`, width);
    return [workDir, summary];
  }
}

export const gitPanel: SidebarPanel = {
  id: 'git',
  get title() {
    return t('sidebar.git');
  },
  width: 30,
  build(ctx) {
    return new GitPanelContent(ctx, ctx.colors);
  },
};
