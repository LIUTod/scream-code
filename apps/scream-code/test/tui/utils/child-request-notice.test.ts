import { describe, expect, it } from 'vitest';
import { t } from '@scream-code/config';

import {
  childRequestFieldsFromArgs,
  childRequestFieldsFromNotification,
  renderChildRequestNotice,
} from '#/tui/utils/child-request-notice';

/**
 * The kernel builds the injected notification in
 * `packages/agent-core/src/session/subagent-host.ts` (`submitChildRequest`),
 * and `packages/agent-core/test/session/contact-parent.test.ts` pins its shape.
 * This fixture replicates that format so the parser is tested against the real
 * wire text rather than an invented one.
 */
function kernelNotification(sourceId: string, bodyLines: readonly string[]): string {
  const head = bodyLines[0] ?? '';
  const requestType = head.split(':')[0] ?? 'info';
  return [
    `<notification id="child_request:${sourceId}:1700000000000" category="task" type="child_request" source_kind="subagent" source_id="${sourceId}">`,
    `Title: Subagent ${requestType} request`,
    'Severity: info',
    ...bodyLines,
    '</notification>',
  ].join('\n');
}

/** Same line builder the kernel uses, so a live request and its replay agree. */
function kernelBody(fields: {
  requestType: string;
  message: string;
  needs?: string | undefined;
  artifacts?: readonly string[] | undefined;
}): string[] {
  return [
    `${fields.requestType}: ${fields.message}`,
    fields.needs !== undefined ? `needs: ${fields.needs}` : undefined,
    fields.artifacts !== undefined && fields.artifacts.length > 0
      ? `artifacts: [${fields.artifacts.join(', ')}]`
      : undefined,
  ].filter((line): line is string => line !== undefined);
}

describe('childRequestFieldsFromArgs', () => {
  it('reads every field the tool exposes', () => {
    const fields = childRequestFieldsFromArgs({
      request_type: 'handoff',
      message: '需要独立验证这段逻辑',
      needs: 'independent verification',
      payload: { artifacts: ['src/a.ts', 'src/b.ts'], evidence: [], missing: ['tests'] },
    });
    expect(fields).toEqual({
      requestType: 'handoff',
      message: '需要独立验证这段逻辑',
      needs: 'independent verification',
      artifacts: ['src/a.ts', 'src/b.ts'],
      evidence: undefined,
      missing: ['tests'],
    });
  });

  it('refuses to build a notice without a request body', () => {
    expect(childRequestFieldsFromArgs({ request_type: 'info' })).toBeNull();
    expect(childRequestFieldsFromArgs({ request_type: 'info', message: '   ' })).toBeNull();
  });

  it('degrades an unknown request type to info instead of guessing', () => {
    expect(childRequestFieldsFromArgs({ request_type: 'yolo', message: 'x' })?.requestType).toBe('info');
  });

  it('ignores a malformed payload', () => {
    const fields = childRequestFieldsFromArgs({
      request_type: 'info',
      message: 'x',
      payload: { artifacts: 'not-an-array', evidence: [null, 'ok'] },
    });
    expect(fields?.artifacts).toBeUndefined();
    expect(fields?.evidence).toEqual(['ok']);
  });
});

describe('childRequestFieldsFromNotification', () => {
  it('round-trips what the kernel injects', () => {
    const args = {
      request_type: 'handoff',
      message: '需要独立验证这段逻辑',
      needs: 'independent verification',
      payload: { artifacts: ['src/a.ts', 'src/b.ts'] },
    };
    const fromArgs = childRequestFieldsFromArgs(args);
    const fromNotification = childRequestFieldsFromNotification(
      kernelNotification(
        'agent-7',
        kernelBody({
          requestType: args.request_type,
          message: args.message,
          needs: args.needs,
          artifacts: args.payload.artifacts,
        }),
      ),
    );
    // Live and replay must never disagree about the same request.
    expect(fromNotification).toEqual(fromArgs);
  });

  it('keeps extra lines that are not fields attached to the message', () => {
    const fields = childRequestFieldsFromNotification(
      kernelNotification('agent-7', ['escalate: 第一行', '第二行还是正文', 'needs: 决策']),
    );
    expect(fields?.requestType).toBe('escalate');
    expect(fields?.message).toBe('第一行\n第二行还是正文');
    expect(fields?.needs).toBe('决策');
  });

  it('returns null for anything that is not a child_request notification', () => {
    expect(childRequestFieldsFromNotification('plain user text')).toBeNull();
    expect(
      childRequestFieldsFromNotification(
        kernelNotification('agent-7', ['info: x']).replace('type="child_request"', 'type="task.completed"'),
      ),
    ).toBeNull();
    expect(childRequestFieldsFromNotification('<notification type="child_request">\n</notification>')).toBeNull();
  });

  it('only treats the kernel bracket form as a payload field', () => {
    const fields = childRequestFieldsFromNotification(
      kernelNotification('agent-7', [
        'info: 第一行',
        'missing: 这一行其实是正文，不是字段',
        'artifacts: [a.ts, b.ts]',
      ]),
    );
    expect(fields?.message).toBe('第一行\nmissing: 这一行其实是正文，不是字段');
    expect(fields?.missing).toBeUndefined();
    expect(fields?.artifacts).toEqual(['a.ts', 'b.ts']);
  });

  it('returns null when the request text is empty, same as the live path', () => {
    expect(childRequestFieldsFromNotification(kernelNotification('agent-7', ['info:    ']))).toBeNull();
  });
});

describe('renderChildRequestNotice', () => {
  it('names the requester when the live path knows it', () => {
    const notice = renderChildRequestNotice(
      { requestType: 'info', message: '目标终端宽度是否含侧栏展开态' },
      'coder',
    );
    expect(notice.title).toBe(
      t('transcript.child_request', { name: 'coder', type: t('transcript.child_request_type_info') }),
    );
    expect(notice.title).toContain('coder');
    expect(notice.detail).toBe('目标终端宽度是否含侧栏展开态');
  });

  it('falls back to an unnamed title on replay', () => {
    const notice = renderChildRequestNotice({ requestType: 'escalate', message: '需要人工决策' });
    expect(notice.title).toContain(t('transcript.child_request_type_escalate'));
    expect(notice.title).toBe(t('transcript.child_request_anon', { type: t('transcript.child_request_type_escalate') }));
  });

  it('collapses newlines and caps an over-long request so one row stays readable', () => {
    const short = renderChildRequestNotice({ requestType: 'info', message: '第一行\n第二行' });
    expect(short.detail).toBe('第一行 第二行');

    // The kernel allows 8192 chars; the transcript must not turn into a wall.
    const long = renderChildRequestNotice({ requestType: 'info', message: 'x'.repeat(8000) });
    expect(long.detail.endsWith('…')).toBe(true);
    expect(long.detail.length).toBeLessThanOrEqual(201);
  });

  it('joins needs and payload previews into the detail line', () => {
    const notice = renderChildRequestNotice({
      requestType: 'handoff',
      message: '需要复核',
      needs: 'independent verification',
      artifacts: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
    });
    expect(notice.detail).toContain('需要复核');
    expect(notice.detail).toContain(t('transcript.child_request_needs', { value: 'independent verification' }));
    // Long lists collapse to three names plus a hidden count.
    expect(notice.detail).toContain('+2');
    expect(notice.detail).not.toContain('e.ts');
  });

  it('keeps the hidden count when a long path list has to be truncated', () => {
    const long = `${'dir/'.repeat(40)}a.ts`;
    const notice = renderChildRequestNotice({
      requestType: 'escalate',
      message: '看产物',
      artifacts: [long, long, long, 'x.ts', 'y.ts'],
    });
    // Truncation happens to the names, so the +N tail is never cut off.
    expect(notice.detail).toContain('+2');
    expect(notice.detail).not.toContain('x.ts');
    expect(notice.detail.length).toBeLessThanOrEqual(240);
  });
});
