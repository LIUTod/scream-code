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
      thinking: true,
      permissionMode: 'manual',
      planMode: false,
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
    expect(output).toMatch(/模型\s+Scream K2 \(thinking on\)/);
    expect(output).toMatch(/目录\s+\/tmp\/project/);
    expect(output).toMatch(/权限\s+auto/);
    expect(output).toMatch(/计划模式\s+on/);
    expect(output).toMatch(/会话\s+ses-1/);
    expect(output).toMatch(/标题\s+Implement status/);
    expect(output).toContain('上下文窗口');
    expect(output).toContain('25.0%');
    expect(output).toContain('(3.0k / 12.0k)');
    expect(output).toContain('计划用量');
    expect(output).toContain('8% 已用');
    expect(output).not.toContain('Account');
    expect(output).not.toContain('AGENTS.md');
    expect(output).not.toContain('Runtime');
  });

  it('falls back to app state and shows status load errors as warnings', () => {
    const lines = buildStatusReportLines({
      colors: darkColors,
      version: '1.2.3',
      model: '',
      workDir: '/tmp/project',
      sessionId: '',
      sessionTitle: null,
      thinking: false,
      permissionMode: 'manual',
      planMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      statusError: 'No active session',
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toMatch(/模型\s+未设置/);
    expect(output).toMatch(/会话\s+无/);
    expect(output).toMatch(/警告\s+No active session/);
    expect(output).toContain('暂无上下文窗口数据。');
  });
});
