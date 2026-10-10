import { describe, expect, it } from 'vitest';

import { adaptApprovalRequest, adaptPanelResponse, formatApprovalSource } from '#/tui/reverse-rpc/approval/adapter';

describe('approval adapter', () => {
  it('adapts generic command displays into shell blocks with approval choices', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-1',
        toolName: 'EnterPlanMode',
        action: 'run',
        display: {
          kind: 'generic',
          summary: 'run',
          detail: {
            command: 'sudo rm -rf /tmp/cache',
            cwd: '/tmp',
          },
        },
      },
    );

    expect(adapted).toMatchObject({
      id: 'tc-1',
      tool_call_id: 'tc-1',
      tool_name: 'EnterPlanMode',
      display: [
        {
          type: 'shell',
          language: 'bash',
          command: 'sudo rm -rf /tmp/cache',
          cwd: '/tmp',
          danger: '递归删除',
        },
      ],
    });
    expect(adapted.choices.map((choice) => choice.label)).toEqual([
      '批准一次',
      '批准（当前会话）',
      '拒绝',
      '拒绝并反馈',
    ]);
  });

  it('emits only a diff block for Edit — no separate file_op title row', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-edit',
        toolName: 'Edit',
        action: 'edit',
        display: {
          kind: 'generic',
          summary: 'edit',
          detail: {
            file_path: 'src/foo.ts',
            old_string: 'a\nb\nc',
            new_string: 'a\nB\nc',
          },
        },
      },
    );

    expect(adapted.display).toEqual([
      { type: 'diff', path: 'src/foo.ts', old_text: 'a\nb\nc', new_text: 'a\nB\nc' },
    ]);
  });

  it('emits a file_content block for Write so the new file previews as code, not diff', () => {
    const adapted = adaptApprovalRequest(
      {
        toolCallId: 'tc-write',
        toolName: 'Write',
        action: 'write',
        display: {
          kind: 'generic',
          summary: 'write',
          detail: {
            file_path: 'src/new.ts',
            content: 'export const x = 1;\nexport const y = 2;',
          },
        },
      },
    );

    expect(adapted.display).toEqual([
      {
        type: 'file_content',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    ]);
  });

  // The builtin Write tool emits its display as file_io (operation=write) with
  // the file content alongside the path, so the approval panel can show — and
  // ctrl+e expand — the bytes about to land on disk.
  it('emits a file_content block for file_io write with content', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-write-io',
      toolName: 'Write',
      action: 'Writing src/new.ts',
      display: {
        kind: 'file_io',
        operation: 'write',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    });

    expect(adapted.display).toEqual([
      {
        type: 'file_content',
        path: 'src/new.ts',
        content: 'export const x = 1;\nexport const y = 2;',
      },
    ]);
  });

  // The builtin Edit tool emits its display as file_io (operation=edit) with
  // before/after carrying old_string/new_string, so the panel can render the
  // hunk as a diff just like the generic-fallback path used to.
  it('emits a diff block for file_io edit with before/after', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-edit-io',
      toolName: 'Edit',
      action: 'Editing src/foo.ts',
      display: {
        kind: 'file_io',
        operation: 'edit',
        path: 'src/foo.ts',
        before: 'a\nb\nc',
        after: 'a\nB\nc',
      },
    });

    expect(adapted.display).toEqual([
      { type: 'diff', path: 'src/foo.ts', old_text: 'a\nb\nc', new_text: 'a\nB\nc' },
    ]);
  });

  // Read/Glob/Grep have no content to preview, so file_io without
  // content/before/after still collapses to a path-only file_op row.
  it('keeps a path-only file_op block for file_io without preview fields', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-read',
      toolName: 'Read',
      action: 'Reading src/foo.ts',
      display: {
        kind: 'file_io',
        operation: 'read',
        path: 'src/foo.ts',
      },
    });

    expect(adapted.display).toEqual([
      { type: 'file_op', operation: 'read', path: 'src/foo.ts', detail: undefined },
    ]);
  });

  it('omits plan review content from the approval panel while keeping Python-style choices', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-plan',
      toolName: 'ExitPlanMode',
      action: 'Review plan',
      display: {
        kind: 'plan_review',
        plan: '# Plan\n\n- Inspect\n- Change\n- Verify',
        path: '/tmp/scream-plan.md',
      },
    });

    expect(adapted.display).toEqual([]);
    expect(adapted.choices).toEqual([
      { label: '批准', response: 'approved', selected_label: '批准' },
      { label: '拒绝', response: 'rejected', selected_label: '拒绝' },
      {
        label: '修订',
        response: 'rejected',
        selected_label: '修订',
        requires_feedback: true,
      },
    ]);
  });

  it('renders multi-option plan review choices ahead of reject controls', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-plan-options',
      toolName: 'ExitPlanMode',
      action: 'Review plan and choose an option',
      display: {
        kind: 'plan_review',
        plan: '# Plan',
        path: '/tmp/scream-plan.md',
        options: [
          { label: 'Approach A', description: 'Small refactor' },
          { label: 'Approach B', description: 'Full refactor' },
        ],
      },
    });

    expect(adapted.choices).toEqual([
      { label: 'Approach A', response: 'approved', selected_label: 'Approach A' },
      { label: 'Approach B', response: 'approved', selected_label: 'Approach B' },
      { label: '拒绝', response: 'rejected', selected_label: '拒绝' },
      {
        label: '修订',
        response: 'rejected',
        selected_label: '修订',
        requires_feedback: true,
      },
    ]);
  });

  it('drops the session grant when the policy offers a one-time grant only', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-once',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'generic', summary: 'run', detail: { command: 'rm -rf /tmp/cache' } },
      reasons: ['dangerous command: recursive force delete'],
      grantOptions: ['once'],
    });

    expect(adapted.choices.map((choice) => choice.response)).toEqual([
      'approved',
      'rejected',
      'rejected',
    ]);
    expect(adapted.reasons).toEqual(['dangerous command: recursive force delete']);
  });

  it('keeps every grant and omits the reasons row for payloads that carry neither', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-legacy-grants',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'generic', summary: 'run', detail: { command: 'ls' } },
    });

    expect(adapted.choices.map((choice) => choice.response)).toEqual([
      'approved',
      'approved_for_session',
      'rejected',
      'rejected',
    ]);
    expect(adapted).not.toHaveProperty('reasons');
  });

  it('carries the turn prompt summary and omits it for payloads without one', () => {
    const withSummary = adaptApprovalRequest({
      toolCallId: 'tc-summary',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'generic', summary: 'run', detail: { command: 'ls' } },
      requestSummary: 'deploy the release',
    });
    expect(withSummary.request_summary).toBe('deploy the release');

    const withoutSummary = adaptApprovalRequest({
      toolCallId: 'tc-no-summary',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'generic', summary: 'run', detail: { command: 'ls' } },
    });
    expect(withoutSummary).not.toHaveProperty('request_summary');
  });

  it('carries approval source attribution into the panel label', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-src',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'generic', summary: 'run', detail: { command: 'ls' } },
      sourceAgentId: 'agent-3',
      sourceAgentName: 'explore',
      sourceToolName: 'Bash',
    });

    expect(adapted.source_label).toBe('来源：explore（agent-3） · Bash');
  });

  it('falls back to the agent id when the payload carries no readable name', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-src-main',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'generic', summary: 'run', detail: { command: 'ls' } },
      sourceAgentId: 'main',
      sourceToolName: 'Bash',
    });

    expect(adapted.source_label).toBe('来源：main · Bash');
  });

  it('omits the source label for payloads without attribution (older emitters)', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-legacy',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'generic', summary: 'run', detail: { command: 'ls' } },
    });

    expect(adapted).not.toHaveProperty('source_label');
    expect(formatApprovalSource({ toolName: 'Bash' })).toBeUndefined();
  });

  it('maps approved-for-session responses into core approval payloads', () => {
    expect(
      adaptPanelResponse({
        response: 'approved_for_session',
        feedback: 'looks good',
        selected_label: '批准（当前会话）',
      }),
    ).toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks good',
      selectedLabel: '批准（当前会话）',
    });
  });
});
