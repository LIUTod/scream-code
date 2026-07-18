import { describe, expect, it } from 'vitest';

import { buildStatusReportLines } from '#/tui/components/messages/status-panel';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('status panel report lines', () => {
  it('formats runtime status, context, and managed usage without account or AGENTS.md rows', () => {
    const lines = buildStatusReportLines({
      colors: darkColors,
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: 'Implement status',
      thinkingLevel: 'high',
      permissionMode: 'manual',
      planMode: 'plan',
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      availableModels: {
        k2: {
          provider: 'managed:scream-code',
          model: 'scream-k2',
          maxContextSize: 10000,
          displayName: 'Scream K2',
        },
      },
      status: {
        model: 'k2',
        thinkingLevel: 'high',
        permission: 'auto',
        planMode: true,
        wolfpackMode: false,
        contextTokens: 3000,
        maxContextTokens: 12000,
        contextUsage: 0.25,
      },
      managedUsage: {
        summary: null,
        limits: [
          {
            label: '5h limit',
            used: 8,
            limit: 100,
            resetHint: 'resets in 1h',
          },
        ],
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('>_ Scream Code (v1.2.3)');
    expect(output).toMatch(/模型名称\s+Scream K2 \(thinking on\)/);
    expect(output).toMatch(/工作目录\s+\/tmp\/project/);
    expect(output).toMatch(/权限模式\s+auto/);
    expect(output).toMatch(/计划模式\s+plan/);
    expect(output).toMatch(/会话编号\s+ses-1/);
    expect(output).toMatch(/会话标题\s+Implement status/);
    expect(output).toContain('上下文窗口');
    expect(output).toContain('25.0%');
    expect(output).toContain('(3.0k / 12.0k)');
    expect(output).toContain('计划用量');
    expect(output).toContain('8% 已用');
    expect(output).not.toContain('Account');
    expect(output).not.toContain('AGENTS.md');
    expect(output).not.toContain('Runtime');
  });
  it('falls back to session status when app planMode is off', () => {
    const lines = buildStatusReportLines({
      colors: darkColors,
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingLevel: 'off',
      permissionMode: 'manual',
      planMode: 'off',
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      status: {
        model: 'k2',
        thinkingLevel: 'high',
        permission: 'auto',
        planMode: true,
        wolfpackMode: false,
        planStrategy: 'fusion',
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      },
    }).map(strip);

    expect(lines.join('\n')).toMatch(/计划模式\s+fusion/);
  });

  it('falls back to app state and shows status load errors as warnings', () => {
    const lines = buildStatusReportLines({
      colors: darkColors,
      version: '1.2.3',
      model: '',
      workDir: '/tmp/project',
      sessionId: '',
      sessionTitle: null,
      thinkingLevel: 'off',
      permissionMode: 'manual',
      planMode: 'off',
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      statusError: 'No active session',
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toMatch(/模型名称\s+未设置/);
    expect(output).toMatch(/会话编号\s+无/);
    expect(output).toMatch(/状态警告\s+No active session/);
  });
});
