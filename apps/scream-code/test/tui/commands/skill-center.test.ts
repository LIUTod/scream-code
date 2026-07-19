import type { PluginSummary, SkillSummary } from '@scream-code/scream-code-sdk';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { handleSkillCommand } from '#/tui/commands/skill-center';
import { darkColors } from '#/tui/theme/colors';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';

vi.mock('#/utils/plugin-marketplace', () => ({
  loadPluginMarketplace: vi.fn(),
}));

const ESC = String.fromCodePoint(27);
const ENTER = String.fromCodePoint(13);
const DOWN = `${ESC}[B`;

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function rendered(component: { render: (w: number) => string[] }, width = 80): string {
  return component.render(width).map(stripAnsi).join('\n');
}

interface MockSession {
  listSkills: Mock;
  listPlugins: Mock;
  reloadPlugins: Mock;
  installPlugin: Mock;
  injectPlugin: Mock;
  removePlugin: Mock;
  removeSkill: Mock;
  activateSkill: Mock;
}

function makeSession(overrides: {
  listSkills?: SkillSummary[];
  listPlugins?: PluginSummary[];
} = {}): MockSession {
  return {
    listSkills: vi.fn(async () => overrides.listSkills ?? []),
    listPlugins: vi.fn(async () => overrides.listPlugins ?? []),
    reloadPlugins: vi.fn(async () => ({ added: [], removed: [], errors: [] })),
    installPlugin: vi.fn(),
    injectPlugin: vi.fn(),
    removePlugin: vi.fn(),
    removeSkill: vi.fn(),
    activateSkill: vi.fn(),
  };
}

function makeHost(session?: MockSession): SlashCommandHost {
  return {
    session,
    state: {
      appState: { workDir: '/tmp' },
      theme: { colors: darkColors },
      ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
    },
    showError: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    sendSkillActivation: vi.fn(),
    showProgressSpinner: vi.fn(() => ({ stop: vi.fn(), setLabel: vi.fn() })),
  } as unknown as SlashCommandHost;
}

function getLastMountedPicker(host: SlashCommandHost): {
  render: (w: number) => string[];
  handleInput: (data: string) => void;
} {
  const calls = (host.mountEditorReplacement as Mock).mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  return calls.at(-1)![0] as {
    render: (w: number) => string[];
    handleInput: (data: string) => void;
  };
}

describe('handleSkillCommand', () => {
  beforeEach(() => {
    vi.mocked(loadPluginMarketplace).mockReset();
    vi.mocked(loadPluginMarketplace).mockResolvedValue({
      source: 'https://example.com/marketplace.json',
      plugins: [
        {
          id: 'demo-pack',
          displayName: 'Demo Pack',
          description: 'A demo skill package',
          source: 'https://github.com/example/demo-pack',
        },
      ],
    });
  });

  it('shows an error when there is no active session', async () => {
    const host = makeHost(undefined);
    await handleSkillCommand(host, '');
    expect(host.showError).toHaveBeenCalledWith(
      '请先创建或恢复一个会话，再使用 Skill 中心。',
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('lists installed skills and installable packages in separate sections', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'daily-report',
          description: 'Generate daily report',
          path: '/skills/daily-report/SKILL.md',
          source: 'user',
          type: 'prompt',
        },
        {
          name: 'dream',
          description: 'Dream skill',
          path: '/builtin/dream.md',
          source: 'builtin',
          type: 'prompt',
        },
      ],
      listPlugins: [],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    
    const picker = getLastMountedPicker(host);
    const out = rendered(picker);
    expect(out).toContain('── 已安装的 Skill ──');
    expect(out).toContain('daily-report');
    expect(out).toContain('── 可安装的 Skill 包 ──');
    expect(out).toContain('Demo Pack');
    expect(out).not.toContain('dream');
  });

  it('shows plugin display name instead of plugin id in skill descriptions', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'plugin-skill',
          description: 'From plugin',
          path: '/plugins/pack/plugin-skill/SKILL.md',
          source: 'extra',
          type: 'prompt',
          pluginId: 'pack',
        },
      ],
      listPlugins: [
        {
          id: 'pack',
          displayName: 'My Pack',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          skills: [],
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'github',
        },
      ],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    const out = rendered(picker);
    // displayName 显示给用户，pluginId（'pack'）不直接出现在描述里。
    expect(out).toContain('My Pack');
    expect(out).not.toMatch(/插件: pack\b/);
  });

  it('activates an installed skill on Enter', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'daily-report',
          description: 'Generate daily report',
          path: '/skills/daily-report/SKILL.md',
          source: 'user',
          type: 'prompt',
        },
      ],
      listPlugins: [],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendSkillActivation).toHaveBeenCalledWith(
        session,
        'daily-report',
        '',
      );
    });
  });

  it('offers a confirm picker when pressing d on a plugin skill', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'plugin-skill',
          description: 'From plugin',
          path: '/plugins/pack/plugin-skill/SKILL.md',
          source: 'extra',
          type: 'prompt',
          pluginId: 'pack',
        },
      ],
      listPlugins: [
        {
          id: 'pack',
          displayName: 'My Pack',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          skills: [],
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'github',
        },
      ],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput('d');

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('确认卸载 "My Pack"？');
    });
    const confirmPicker = getLastMountedPicker(host);
    expect(rendered(confirmPicker)).toContain('确认卸载 "My Pack"？');
    // 必须明确告知用户：plugin Skill 只能整包卸载，无法单独删除。
    expect(rendered(confirmPicker)).toContain('将卸载整个包');
    expect(rendered(confirmPicker)).toContain('共 1 个 Skill');
  });

  it('warns about multi-skill impact when uninstalling a plugin with several skills', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'skill-a',
          description: 'A',
          path: '/plugins/pack/skill-a/SKILL.md',
          source: 'extra',
          type: 'prompt',
          pluginId: 'pack',
        },
        {
          name: 'skill-b',
          description: 'B',
          path: '/plugins/pack/skill-b/SKILL.md',
          source: 'extra',
          type: 'prompt',
          pluginId: 'pack',
        },
        {
          name: 'skill-c',
          description: 'C',
          path: '/plugins/pack/skill-c/SKILL.md',
          source: 'extra',
          type: 'prompt',
          pluginId: 'pack',
        },
      ],
      listPlugins: [
        {
          id: 'pack',
          displayName: 'Multi Pack',
          enabled: true,
          state: 'ok',
          skillCount: 3,
          skills: [],
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'github',
        },
      ],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput('d');

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('确认卸载 "Multi Pack"？');
    });
    const confirmPicker = getLastMountedPicker(host);
    expect(rendered(confirmPicker)).toContain('共 3 个 Skill');
  });

  it('uninstalls a plugin when confirming the uninstall picker', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'plugin-skill',
          description: 'From plugin',
          path: '/plugins/pack/plugin-skill/SKILL.md',
          source: 'extra',
          type: 'prompt',
          pluginId: 'pack',
        },
      ],
      listPlugins: [
        {
          id: 'pack',
          displayName: 'My Pack',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          skills: [],
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'github',
        },
      ],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput('d');

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('确认卸载');
    });
    const confirmPicker = getLastMountedPicker(host);
    // Move to "是，卸载" and confirm.
    confirmPicker.handleInput(DOWN);
    confirmPicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(session.removePlugin).toHaveBeenCalledWith('pack');
    });
    expect(host.showNotice).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('does not uninstall when cancelling the uninstall picker', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'plugin-skill',
          description: 'From plugin',
          path: '/plugins/pack/plugin-skill/SKILL.md',
          source: 'extra',
          type: 'prompt',
          pluginId: 'pack',
        },
      ],
      listPlugins: [
        {
          id: 'pack',
          displayName: 'My Pack',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          skills: [],
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'github',
        },
      ],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput('d');

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('确认卸载');
    });
    const confirmPicker = getLastMountedPicker(host);
    // Default option is "取消"; pressing Enter cancels.
    confirmPicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('plugin-skill');
    });
    expect(session.removePlugin).not.toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('offers a confirm picker when pressing d on a manual skill', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'manual-skill',
          description: 'Manual skill',
          path: '/home/user/.scream-code/skills/manual-skill/SKILL.md',
          source: 'user',
          type: 'prompt',
        },
      ],
      listPlugins: [],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput('d');

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('确认卸载 "manual-skill"？');
    });
    const confirmPicker = getLastMountedPicker(host);
    const out = rendered(confirmPicker);
    expect(out).toContain('确认卸载 "manual-skill"？');
    expect(out).toContain('将删除该 Skill 的安装目录及子 Skill');
  });

  it('deletes a manual skill when confirming the uninstall picker', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'manual-skill',
          description: 'Manual skill',
          path: '/home/user/.scream-code/skills/manual-skill/SKILL.md',
          source: 'user',
          type: 'prompt',
        },
      ],
      listPlugins: [],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput('d');

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('确认卸载');
    });
    const confirmPicker = getLastMountedPicker(host);
    confirmPicker.handleInput(DOWN);
    confirmPicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(session.removeSkill).toHaveBeenCalledWith('manual-skill');
    });
    expect(host.showNotice).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('does not delete a manual skill when cancelling the uninstall picker', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'manual-skill',
          description: 'Manual skill',
          path: '/home/user/.scream-code/skills/manual-skill/SKILL.md',
          source: 'user',
          type: 'prompt',
        },
      ],
      listPlugins: [],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput('d');

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('确认卸载');
    });
    const confirmPicker = getLastMountedPicker(host);
    confirmPicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('manual-skill');
    });
    expect(session.removeSkill).not.toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('installs, injects and activates a package when pressing i', async () => {
    const session = makeSession({
      listSkills: [],
      listPlugins: [],
    });
    session.installPlugin.mockResolvedValue({
      id: 'demo-pack',
      displayName: 'Demo Pack',
      enabled: true,
      state: 'ok',
      skillCount: 1,
      skills: [{ name: 'demo-skill', description: 'Demo' }],
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
      source: 'github',
    });

    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    // Navigate: section header → Demo Pack
    picker.handleInput(DOWN);
    picker.handleInput('i');

    // After install/inject, listSkills will be queried again for activation.
    session.listSkills.mockResolvedValue([
      {
        name: 'demo-skill',
        description: 'Demo',
        path: '/plugins/demo-pack/demo-skill/SKILL.md',
        source: 'extra',
        type: 'prompt',
        pluginId: 'demo-pack',
      },
    ]);

    await vi.waitFor(() => {
      expect(session.installPlugin).toHaveBeenCalledWith(
        'https://github.com/example/demo-pack',
      );
    });
    await vi.waitFor(() => {
      expect(host.sendSkillActivation).toHaveBeenCalledWith(
        session,
        'demo-skill',
        '',
      );
    });
    expect(session.injectPlugin).toHaveBeenCalledWith('demo-pack');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('falls back to the built-in marketplace when the remote source fails', async () => {
    vi.mocked(loadPluginMarketplace).mockRejectedValue(new Error('network'));
    const session = makeSession({ listSkills: [], listPlugins: [] });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    const out = rendered(picker);
    expect(out).toContain('── 可安装的 Skill 包 ──');
    expect(out).toContain('GSAP 动画技能包');
  });

  it('ignores section headers on Enter and refreshes the panel', async () => {
    const session = makeSession({
      listSkills: [
        {
          name: 'daily-report',
          description: 'Generate daily report',
          path: '/skills/daily-report/SKILL.md',
          source: 'user',
          type: 'prompt',
        },
      ],
      listPlugins: [],
    });
    const host = makeHost(session);
    await handleSkillCommand(host, '');

    const picker = getLastMountedPicker(host);
    // The initial selection is the section header; pressing Enter refreshes.
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(rendered(getLastMountedPicker(host))).toContain('daily-report');
    });
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
  });
});
