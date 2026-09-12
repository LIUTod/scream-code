import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getLocale, setLocale } from '@scream-code/config';

import { gitPanel } from '#/tui/components/sidebar/panels/git-panel';
import type { ColorPalette } from '#/tui/theme/colors';
import type { SidebarPanelContext } from '#/tui/components/sidebar/sidebar-panel';
import type { SidebarData } from '#/tui/components/sidebar/sidebar-panel';

const fakePalette = {
  primary: '#79eb00',
  success: '#3fb950',
  error: '#f85149',
  warning: '#e0ae21',
  textDim: '#888888',
  text: '#cccccc',
  textStrong: '#ffffff',
} as unknown as ColorPalette;

function ctx(git: SidebarData['git']): SidebarPanelContext {
  return {
    requestRender: () => {},
    getData: () => ({ git }),
    colors: fakePalette,
  };
}

describe('GitPanel', () => {
  // Captured inside beforeAll: vitest reuses one worker across files, so a
  // describe-time snapshot could inherit another file's locale.
  let originalLocale: ReturnType<typeof getLocale> | undefined;
  beforeAll(() => {
    originalLocale = getLocale();
    setLocale('en');
  });
  afterAll(() => {
    if (originalLocale !== undefined) setLocale(originalLocale);
  });

  it('shows the no-repo empty state when git data is missing', () => {
    const lines = gitPanel.build(ctx(undefined)).render(40);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no git repo');
  });

  it('shows the clean working tree state', () => {
    const lines = gitPanel
      .build(ctx({ workDir: '/home/acme/project', diffAdded: 0, diffDeleted: 0, filesCount: 0 }))
      .render(40);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('project');
    expect(lines[1]).toContain('clean working tree');
  });

  it('renders added/deleted counts and the file count on one line', () => {
    const lines = gitPanel
      .build(ctx({ workDir: '/home/acme/project', diffAdded: 120, diffDeleted: 34, filesCount: 7 }))
      .render(40);
    const text = lines.join('\n');
    expect(text).toContain('project');
    expect(text).toContain('+120');
    expect(text).toContain('−34');
    expect(text).toContain('7 files');
  });
});
