import { CURSOR_MARKER, visibleWidth } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import type {
  DiffDisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '#/tui/reverse-rpc/types';
import { getColorPalette } from '#/tui/theme/colors';

import { captureProcessWrite } from '../../../helpers/process';

const COLORS = getColorPalette('dark');

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makePending(): PendingApproval {
  return {
    data: {
      id: 'approval_1',
      tool_call_id: 'tool_1',
      tool_name: 'WriteFile',
      action: 'write a file',
      description: 'Update README.md',
      display: [],
      choices: [
        { label: 'Approve once', response: 'approved' },
        { label: 'Approve for this session', response: 'approved_for_session' },
        { label: 'Reject', response: 'rejected' },
        { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
      ],
    },
  };
}

function makeDialog(): {
  dialog: ApprovalPanelComponent;
  responses: Array<{
    response: string;
    feedback?: string | undefined;
    selected_label?: string | undefined;
  }>;
} {
  const responses: Array<{
    response: string;
    feedback?: string | undefined;
    selected_label?: string | undefined;
  }> = [];
  const dialog = new ApprovalPanelComponent(
    makePending(),
    (response) => responses.push(response),
    COLORS,
  );
  return { dialog, responses };
}

describe('ApprovalPanelComponent', () => {
  it('renders only numeric approval shortcuts in the hint', () => {
    const { dialog } = makeDialog();
    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('1/2/3/4 直选');
    expect(out).not.toContain('y/a/n/f');
  });

  it('renders dangerous shell warnings with simple copy and no icon', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_danger',
        tool_call_id: 'tool_danger',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [
          {
            type: 'shell',
            language: 'bash',
            command: 'rm -rf /tmp/cache',
            danger: 'recursive delete',
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS);

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('危险：recursive delete');
    expect(out).not.toContain('potentially destructive');
    expect(out).not.toContain('⚠');
  });

  it('numeric shortcuts still drive approval actions', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('2');
    expect(responses).toEqual([{ response: 'approved_for_session', feedback: undefined }]);
  });

  it('shortcut 4 enters feedback mode and submits the typed feedback', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'no' }]);
  });

  it('renders feedback input inline with the selected choice', () => {
    const { dialog } = makeDialog();
    dialog.handleInput('4');

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('█ 4. Reject with feedback');
    expect(out).not.toContain('\n  > ');
  });

  it('legacy y/a/n/f shortcuts no longer trigger approval actions', () => {
    for (const key of ['y', 'a', 'n', 'f']) {
      const { dialog, responses } = makeDialog();
      dialog.handleInput(key);
      expect(responses).toEqual([]);
    }
  });

  it('feedback input supports left/right cursor editing', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\u001B[D');
    dialog.handleInput('!');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'n!o' }]);
  });

  it('feedback input keeps editor shortcuts like ctrl+b / ctrl+f', () => {
    const { dialog, responses } = makeDialog();
    dialog.handleInput('4');
    dialog.handleInput('a');
    dialog.handleInput('b');
    dialog.handleInput('c');
    dialog.handleInput('\u0002');
    dialog.handleInput('\u0002');
    dialog.handleInput('X');
    dialog.handleInput('\u0006');
    dialog.handleInput('Y');
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'aXbYc' }]);
  });

  it('renders an IME cursor marker while editing feedback', () => {
    const { dialog } = makeDialog();
    dialog.focused = true;
    dialog.handleInput('4');

    const out = dialog.render(80).join('\n');
    expect(out).toContain(CURSOR_MARKER);
  });

  it.each(['\u0003', '\u0004', '\u001B'])(
    'shortcut %j rejects approval immediately',
    (key) => {
      const { dialog, responses } = makeDialog();
      dialog.handleInput(key);
      expect(responses).toEqual([{ response: 'rejected' }]);
    },
  );

  it('renders ExitPlanMode with plan-specific header and plan-review choices', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan',
        tool_call_id: 'tool_plan',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [
          { label: 'Approve', response: 'approved' },
          { label: 'Reject', response: 'rejected' },
          { label: 'Revise', response: 'rejected', requires_feedback: true },
        ],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS);

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('是否按此计划构建？');
    expect(out).not.toContain('Approve ExitPlanMode?');
    expect(out).toContain('Approve');
    expect(out).toContain('Reject');
    expect(out).toContain('Revise');
    expect(out).not.toContain('Approve for this session');
    expect(out).not.toContain('Investigate');
  });

  // Inline expand-in-place used to inflate the panel past the viewport on
  // any non-trivial Edit, which then collided with pi-tui's inline scroll
  // and made the terminal flicker / refuse to scroll. The panel now always
  // renders the diff in its compact cluster form; ctrl+e instead asks the
  // host to open a dedicated full-screen preview that can manage its own
  // scrolling.
  it('renders an Edit diff in compact form and asks the host to open a preview on ctrl+e', () => {
    const responses: Array<{ response: string }> = [];
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      oldLines.push(`old${String(i)}`);
      newLines.push(`new${String(i)}`);
    }
    const diffBlock: DiffDisplayBlock = {
      type: 'diff',
      path: 'src/foo.ts',
      old_text: oldLines.join('\n'),
      new_text: newLines.join('\n'),
    };
    const pending: PendingApproval = {
      data: {
        id: 'approval_diff',
        tool_call_id: 'tool_diff',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [diffBlock],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    let toolOutputToggles = 0;
    let planToggles = 0;
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      (r) => responses.push(r),
      COLORS,
      () => toolOutputToggles++,
      () => planToggles++,
      (block) => previewCalls.push(block),
    );

    const before = strip(dialog.render(120).join('\n'));
    expect(before).toContain('+30');
    expect(before).toContain('-30');
    expect(before).toContain('ctrl+e 预览');
    expect(before).not.toContain('new30'); // compact view stays compact

    dialog.handleInput('\u0005'); // Ctrl+E

    // The panel itself does not expand; it delegates to the host.
    const after = strip(dialog.render(120).join('\n'));
    expect(after).not.toContain('new30');
    expect(after).toContain('ctrl+e 预览');
    expect(previewCalls).toEqual([diffBlock]);
    // The unrelated forward-only callbacks must not fire for ctrl+e.
    expect(planToggles).toBe(0);
    expect(toolOutputToggles).toBe(0);
    expect(responses).toEqual([]);
  });

  it('forwards ctrl+o to the global tool-output toggle without affecting the panel', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_forward',
        tool_call_id: 'tool_forward',
        tool_name: 'Edit',
        action: 'edit',
        description: '',
        display: [
          {
            type: 'diff',
            path: 'src/foo.ts',
            old_text: Array.from({ length: 30 }, (_, i) => `old${String(i + 1)}`).join('\n'),
            new_text: Array.from({ length: 30 }, (_, i) => `new${String(i + 1)}`).join('\n'),
          },
        ],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    let globalToggleCalls = 0;
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS, () => globalToggleCalls++);

    dialog.handleInput('\u000F'); // Ctrl+O

    const after = strip(dialog.render(120).join('\n'));
    expect(globalToggleCalls).toBe(1);
    expect(after).toContain('ctrl+e 预览');
    expect(after).not.toContain('new30');
  });

  // When there is no diff / file_content block to preview (e.g. plan_review
  // with an empty display), ctrl+e falls through to the legacy global plan
  // expand toggle so plan mode keeps working.
  it('falls through to onTogglePlanExpand when there is nothing to preview', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan_only',
        tool_call_id: 'tool_plan_only',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [{ label: 'Approve', response: 'approved' }],
      },
    };
    let planToggles = 0;
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      () => {},
      COLORS,
      undefined,
      () => planToggles++,
      (block) => previewCalls.push(block),
    );

    dialog.handleInput('\u0005'); // Ctrl+E
    expect(planToggles).toBe(1);
    expect(previewCalls).toEqual([]);
  });

  it('renders Write as a syntax-highlighted code block (file_content), not a diff', () => {
    const responses: Array<{ response: string }> = [];
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`const x${String(i)} = ${String(i)};`);
    const contentBlock: FileContentDisplayBlock = {
      type: 'file_content',
      path: 'src/new.ts',
      content: lines.join('\n'),
    };
    const pending: PendingApproval = {
      data: {
        id: 'approval_write',
        tool_call_id: 'tool_write',
        tool_name: 'Write',
        action: 'write',
        description: '',
        display: [contentBlock],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
    const dialog = new ApprovalPanelComponent(
      pending,
      (r) => responses.push(r),
      COLORS,
      undefined,
      undefined,
      (block) => previewCalls.push(block),
    );

    const collapsed = strip(dialog.render(120).join('\n'));
    // No diff markers, no +N -M header.
    expect(collapsed).not.toMatch(/^\s*\+\d+/m);
    expect(collapsed).not.toMatch(/^\s*-\d+/m);
    expect(collapsed).toContain('src/new.ts');
    expect(collapsed).toContain('const x1 = 1;');
    expect(collapsed).toContain('const x10 = 10;');
    expect(collapsed).not.toContain('const x25 = 25;');
    expect(collapsed).toContain('另有 20 行已折叠');
    expect(collapsed).toContain('ctrl+e 预览');

    dialog.handleInput('\u0005'); // Ctrl+E hands off to the host preview.
    const after = strip(dialog.render(120).join('\n'));
    // The panel itself stays compact; the full content is opened elsewhere.
    expect(after).not.toContain('const x30 = 30;');
    expect(previewCalls).toEqual([contentBlock]);
    expect(responses).toEqual([]);
  });

  it('renders unknown file_content extensions as plain text without stderr noise', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_unknown_write',
        tool_call_id: 'tool_unknown_write',
        tool_name: 'Write',
        action: 'write',
        description: '',
        display: [{ type: 'file_content', path: 'demo.abcxyz', content: 'hello\nworld' }],
        choices: [{ label: 'Approve once', response: 'approved' }],
      },
    };
    const stderr = captureProcessWrite('stderr');
    try {
      const previewCalls: Array<DiffDisplayBlock | FileContentDisplayBlock> = [];
      const dialog = new ApprovalPanelComponent(
        pending,
        () => {},
        COLORS,
        undefined,
        undefined,
        (block) => previewCalls.push(block),
      );
      const collapsed = strip(dialog.render(120).join('\n'));
      expect(collapsed).toContain('hello');

      dialog.handleInput('\u0005'); // Ctrl+E
      expect(previewCalls).toHaveLength(1);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('returns feedback for plan-review revise choice', () => {
    const responses: Array<{
      response: string;
      feedback?: string | undefined;
      selected_label?: string | undefined;
    }> = [];
    const pending: PendingApproval = {
      data: {
        id: 'approval_plan',
        tool_call_id: 'tool_plan',
        tool_name: 'ExitPlanMode',
        action: 'review plan',
        description: '',
        display: [],
        choices: [
          { label: 'Approve', response: 'approved' },
          {
            label: 'Revise',
            response: 'rejected',
            selected_label: 'Revise',
            requires_feedback: true,
          },
        ],
      },
    };
    const dialog = new ApprovalPanelComponent(
      pending,
      (response) => responses.push(response),
      COLORS,
    );

    dialog.handleInput('2');
    dialog.handleInput('n');
    dialog.handleInput('o');
    dialog.handleInput('\r');
    expect(responses).toEqual([
      { response: 'rejected', feedback: 'no', selected_label: 'Revise' },
    ]);
  });
});

describe('ApprovalPanelComponent — selection pulse', () => {
  it('advances the pixel frame on the timer and requests component-scoped renders', () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const ui = { requestRender } as never;
      const dialog = new ApprovalPanelComponent(makePending(), () => {}, COLORS, undefined, undefined, undefined, ui);

      const first = strip(dialog.render(80).join('\n'));
      expect(first).toContain('█ 1. Approve once');

      vi.advanceTimersByTime(250); // 2 frames: █ → ▓ → ▒
      const pulsed = strip(dialog.render(80).join('\n'));
      expect(pulsed).toContain('▒ 1. Approve once');
      expect(requestRender).toHaveBeenCalled();

      dialog.stop();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the pulse on submit and on reject keys (no ghost timer)', () => {
    vi.useFakeTimers();
    try {
      const responses: unknown[] = [];
      const ui = { requestRender: vi.fn() } as never;

      const approved = new ApprovalPanelComponent(makePending(), (r) => responses.push(r), COLORS, undefined, undefined, undefined, ui);
      approved.handleInput('\r');
      expect(vi.getTimerCount()).toBe(0);

      const rejected = new ApprovalPanelComponent(makePending(), (r) => responses.push(r), COLORS, undefined, undefined, undefined, ui);
      rejected.handleInput('');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders static first frame when no TUI is provided (test/headless path)', () => {
    const dialog = new ApprovalPanelComponent(makePending(), () => {}, COLORS);
    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('█ 1. Approve once');
    expect(out).toContain('  2. Approve for this session');
  });

  it('shows the requesting agent and tool as a source row', () => {
    const pending = makePending();
    pending.data.source_label = '来源：explore（agent-3） · Bash';
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS);

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('来源：explore（agent-3） · Bash');
  });

  it('omits the source row for payloads without attribution (older emitters)', () => {
    const dialog = new ApprovalPanelComponent(makePending(), () => {}, COLORS);

    expect(strip(dialog.render(80).join('\n'))).not.toContain('来源：');
  });

  it('renders the policy risk notes above the choices', () => {
    const pending = makePending();
    pending.data.reasons = [
      'dangerous command: recursive force delete',
      'dangerous command: privilege escalation',
    ];
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS);

    const out = strip(dialog.render(80).join('\n'));
    expect(out).toContain('风险提示');
    expect(out).toContain('· dangerous command: recursive force delete');
    expect(out).toContain('· dangerous command: privilege escalation');
  });

  it('omits the risk rows for payloads without reasons (older emitters)', () => {
    const dialog = new ApprovalPanelComponent(makePending(), () => {}, COLORS);

    expect(strip(dialog.render(80).join('\n'))).not.toContain('风险提示');
  });

  it('renders the turn prompt summary as a dim context row', () => {
    const pending = makePending();
    pending.data.request_summary = 'deploy the release';
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS);

    expect(strip(dialog.render(80).join('\n'))).toContain('本回合请求： deploy the release');
  });

  it('omits the prompt summary row for payloads without one (older emitters)', () => {
    const dialog = new ApprovalPanelComponent(makePending(), () => {}, COLORS);

    expect(strip(dialog.render(80).join('\n'))).not.toContain('本回合请求');
  });

  it('keeps a long prompt summary inside the terminal width with a visible ellipsis', () => {
    const pending = makePending();
    pending.data.request_summary = 'deploy '.repeat(40).trim();
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS);

    const summaryLine = dialog
      .render(60)
      .map(strip)
      .find((line) => line.includes('本回合请求'));

    expect(summaryLine).toBeDefined();
    // The row must fit on its own, not by being clipped in the final width
    // pass: indent + label + text leave two columns of slack.
    expect(visibleWidth(summaryLine ?? '')).toBeLessThanOrEqual(58);
    expect((summaryLine ?? '').trimEnd().endsWith('...')).toBe(true);
  });
});

describe('ApprovalPanelComponent — layout', () => {
  const editPending = (): PendingApproval => ({
    data: {
      id: 'approval_layout',
      tool_call_id: 'tool_layout',
      tool_name: 'Edit',
      action: 'edit',
      description: '',
      display: [
        {
          type: 'diff',
          path: 'src/server/config.ts',
          old_text: "export const config = {\n  port: 3000,\n  host: 'localhost',\n};",
          new_text: "export const config = {\n  port: 8080,\n  host: 'localhost',\n};",
          old_start: 9,
          new_start: 9,
        },
      ],
      choices: [
        { label: '批准一次', response: 'approved' },
        { label: '批准（当前会话）', response: 'approved_for_session' },
        { label: '拒绝', response: 'rejected' },
      ],
      source_label: '来源：main · Edit',
      request_summary: '把端口改成 8080',
    },
  });

  it('puts the file and the size of the change on the title row', () => {
    const dialog = new ApprovalPanelComponent(editPending(), () => {}, COLORS);
    const lines = dialog.render(100).map(strip);
    const title = lines[1] ?? '';
    expect(title).toContain('编辑文件');
    expect(title).toContain('src/server/config.ts');
    expect(title).toMatch(/\+1 -1\s*$/);
    expect(visibleWidth(title)).toBeLessThanOrEqual(100);
  });

  it('draws the diff the way the activity block does: file line numbers, signs, a dashed frame', () => {
    const dialog = new ApprovalPanelComponent(editPending(), () => {}, COLORS);
    const text = dialog.render(100).map(strip).join('\n');
    expect(text).toContain('╌╌╌╌');
    expect(text).toMatch(/\n\s+10 - {3}port: 3000,/);
    expect(text).toMatch(/\n\s+10 \+ {3}port: 8080,/);
    expect(text).toMatch(/\n\s+9 {3}export const config = \{/);
  });

  it('asks the question directly above the choices', () => {
    const dialog = new ApprovalPanelComponent(editPending(), () => {}, COLORS);
    const lines = dialog.render(100).map(strip);
    const question = lines.findIndex((line) => line.includes('是否应用这些编辑？'));
    const first = lines.findIndex((line) => line.includes('1. 批准一次'));
    expect(question).toBeGreaterThan(0);
    expect(first).toBe(question + 1);
  });

  it('keeps the source and the request on one quiet line', () => {
    const dialog = new ApprovalPanelComponent(editPending(), () => {}, COLORS);
    const lines = dialog.render(100).map(strip);
    expect(lines[2]).toContain('来源：main · Edit');
    expect(lines[2]).toContain('本回合请求： 把端口改成 8080');
  });

  it('puts the hint in the interface language, with Esc, and leaves English words out', () => {
    const dialog = new ApprovalPanelComponent(editPending(), () => {}, COLORS);
    const hint = dialog.render(100).map(strip).find((line) => line.includes('直选')) ?? '';
    expect(hint).toContain('↑↓ 选择');
    expect(hint).toContain('1/2/3 直选');
    expect(hint).toContain('Esc 拒绝');
    expect(hint).toContain('ctrl+e 预览');
    expect(hint).not.toMatch(/select|choose|confirm/);
  });

  it('offers a note only while a refusal is focused, and sends it with the refusal', () => {
    const responses: Array<{ response: string; feedback?: string | undefined }> = [];
    const dialog = new ApprovalPanelComponent(editPending(), (r) => responses.push(r), COLORS);
    const hintOf = (): string => dialog.render(100).map(strip).find((line) => line.includes('直选')) ?? '';

    expect(hintOf()).not.toContain('Tab');
    dialog.handleInput('\t'); // Tab on an approval does nothing
    expect(dialog.render(100).map(strip).join('\n')).not.toContain('输入反馈');

    dialog.handleInput('\u001B[B'); // down
    dialog.handleInput('\u001B[B'); // down → the refusal
    expect(hintOf()).toContain('Tab 附加说明');
    dialog.handleInput('\t');
    expect(dialog.render(100).map(strip).join('\n')).toContain('输入反馈');
    for (const ch of 'nope') dialog.handleInput(ch);
    dialog.handleInput('\r');
    expect(responses).toEqual([{ response: 'rejected', feedback: 'nope', selected_label: undefined }]);
  });

  it('keeps the choices, the question and the hint on a short terminal and stays inside the room it has', () => {
    const pending = editPending();
    pending.data.display = [
      {
        type: 'diff',
        path: 'src/big.ts',
        old_text: Array.from({ length: 30 }, (_, i) => `old${String(i + 1)}`).join('\n'),
        new_text: Array.from({ length: 30 }, (_, i) => `new${String(i + 1)}`).join('\n'),
      },
    ];
    for (const rows of [14, 18, 24, 40]) {
      const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS, undefined, undefined, undefined, undefined, () => rows);
      const lines = dialog.render(80).map(strip);
      const room = Math.max(6, rows - 1 - 2 - 1);
      expect(lines.length, `rows ${String(rows)}`).toBeLessThanOrEqual(room);
      const text = lines.join('\n');
      expect(text).toContain('1. 批准一次');
      expect(text).toContain('3. 拒绝');
      expect(text).toContain('是否应用这些编辑？');
      expect(text).toContain('直选');
    }
  });

  it('is roomy only when the terminal is: the dashed frame and the source line give way first', () => {
    const roomy = new ApprovalPanelComponent(editPending(), () => {}, COLORS, undefined, undefined, undefined, undefined, () => 40);
    const tight = new ApprovalPanelComponent(editPending(), () => {}, COLORS, undefined, undefined, undefined, undefined, () => 14);
    const roomyText = roomy.render(80).map(strip).join('\n');
    const tightText = tight.render(80).map(strip).join('\n');
    expect(roomyText).toContain('╌╌╌╌');
    expect(roomyText).toContain('来源：main');
    expect(tightText).not.toContain('╌╌╌╌');
    expect(tightText).toContain('10 - ');
    expect(tightText).toContain('10 + ');
  });

  it('puts a command first, then the danger, and localizes the labels', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_cmd',
        tool_call_id: 'tool_cmd',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [
          {
            type: 'shell',
            language: 'bash',
            command: 'rm -rf node_modules && pnpm install',
            cwd: '/work/app',
            description: '重新安装依赖',
            danger: '将删除 node_modules 目录',
          },
        ],
        choices: [{ label: '批准一次', response: 'approved' }],
        reasons: ['命令包含 rm -rf'],
      },
    };
    const lines = new ApprovalPanelComponent(pending, () => {}, COLORS).render(100).map(strip);
    const at = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    expect(at('$ rm -rf node_modules')).toBeLessThan(at('风险提示：命令包含 rm -rf'));
    expect(at('风险提示：命令包含 rm -rf')).toBeLessThan(at('危险：将删除 node_modules 目录'));
    expect(at('危险：将删除 node_modules 目录')).toBeLessThan(at('是否执行此命令？'));
    expect(lines.join('\n')).toContain('目录 /work/app');
    expect(lines.join('\n')).not.toMatch(/Dangerous|cwd:/);
  });
});

describe('ApprovalPanelComponent — very short terminal', () => {
  it('drops the closing rule rather than a choice when even the tightest layout is over', () => {
    const pending: PendingApproval = {
      data: {
        id: 'approval_tiny',
        tool_call_id: 'tool_tiny',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display: [
          { type: 'shell', language: 'bash', command: 'rm -rf node_modules', danger: '将删除 node_modules 目录' },
        ],
        choices: [
          { label: '批准一次', response: 'approved' },
          { label: '批准（当前会话）', response: 'approved_for_session' },
          { label: '拒绝', response: 'rejected' },
        ],
        reasons: ['命令包含 rm -rf'],
      },
    };
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS, undefined, undefined, undefined, undefined, () => 14);
    const lines = dialog.render(60).map(strip);
    expect(lines.length).toBeLessThanOrEqual(14 - 1 - 2 - 1);
    const text = lines.join('\n');
    expect(text).toContain('3. 拒绝');
    expect(text).toContain('直选');
    expect(lines.at(-1)).not.toMatch(/^─+$/);
  });

  const CHOICES: PendingApproval['data']['choices'] = [
    { label: '批准一次', response: 'approved' },
    { label: '批准（当前会话）', response: 'approved_for_session' },
    { label: '拒绝', response: 'rejected' },
  ];

  function heavy(display: PendingApproval['data']['display'], reasons: string[]): PendingApproval {
    return {
      data: {
        id: 'approval_heavy',
        tool_call_id: 'tool_heavy',
        tool_name: 'Bash',
        action: 'run',
        description: '',
        display,
        choices: CHOICES,
        reasons,
      },
    };
  }

  it('fits a long command with several reasons by counting what it leaves out, and keeps the danger and the choices', () => {
    const command = Array.from({ length: 8 }, (_, index) => `echo step ${String(index + 1)}`).join('\n');
    const pending = heavy([{ type: 'shell', language: 'bash', command, danger: 'deletes files' }], ['one', 'two', 'three']);
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS, undefined, undefined, undefined, undefined, () => 14);
    const lines = dialog.render(60).map(strip);

    expect(lines.length).toBeLessThanOrEqual(14 - 1 - 2 - 1);
    const text = lines.join('\n');
    // The rest of the command is not silently gone: seven of its eight lines are said to be hidden.
    expect(text).toContain('echo step 1');
    expect(text).toContain(t('approval.more_lines', { count: '7' }));
    // Several reasons fold into one row that says how many more there are.
    expect(text).toContain('one (+2)');
    expect(text).toContain('deletes files');
    for (const label of ['1. 批准一次', '2. 批准（当前会话）', '3. 拒绝']) expect(text).toContain(label);
  });

  it('shows the danger of a block the layout has no room for, and counts the blocks it hides', () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      type: 'file_op' as const,
      operation: 'write' as const,
      path: `/p/${String(index)}`,
    }));
    const pending = heavy(
      [...files, { type: 'shell', language: 'bash', command: 'rm -rf /', danger: 'wipes the disk' }, ...files.slice(0, 1)],
      ['r1'],
    );
    const dialog = new ApprovalPanelComponent(pending, () => {}, COLORS, undefined, undefined, undefined, undefined, () => 30);
    const text = dialog.render(60).map(strip).join('\n');

    // Five blocks fit; the sixth (the dangerous one) and the seventh are counted, and the danger still shows.
    expect(text).toContain(t('approval.more_items', { count: '2' }));
    expect(text).toContain('wipes the disk');
  });

  it('draws everything, uncounted, when the terminal height is unknown', () => {
    const command = Array.from({ length: 6 }, (_, index) => `echo step ${String(index + 1)}`).join('\n');
    const dialog = new ApprovalPanelComponent(
      heavy([{ type: 'shell', language: 'bash', command }], ['a', 'b', 'c']),
      () => {},
      COLORS,
    );
    const text = dialog.render(60).map(strip).join('\n');
    expect(text).toContain('echo step 6');
    expect(text).not.toContain('+2)');
  });
});
