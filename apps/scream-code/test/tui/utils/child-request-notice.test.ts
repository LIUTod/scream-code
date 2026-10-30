import { describe, expect, it } from 'vitest';
import type { SubagentChildRequestEvent } from '@scream-code/scream-code-sdk';

import { childRequestFieldsFromEvent, previewText } from '#/tui/utils/child-request-notice';

/** The delivery frame the kernel emits once a request actually landed. */
function requestEvent(overrides: Partial<SubagentChildRequestEvent> = {}): SubagentChildRequestEvent {
  return {
    type: 'subagent.child_request',
    subagentId: 'agent-7',
    requestType: 'info',
    message: 'x',
    ...overrides,
  };
}

describe('childRequestFieldsFromEvent', () => {
  it('reads every field the kernel delivers', () => {
    const fields = childRequestFieldsFromEvent(
      requestEvent({
        requestType: 'handoff',
        message: '需要独立验证这段逻辑',
        needs: 'independent verification',
        expecting: '带行号和文件路径的结论',
        artifacts: ['src/a.ts', 'src/b.ts'],
        evidence: [],
        missing: ['tests'],
      }),
    );
    expect(fields).toEqual({
      requestType: 'handoff',
      message: '需要独立验证这段逻辑',
      needs: 'independent verification',
      expecting: '带行号和文件路径的结论',
      artifacts: ['src/a.ts', 'src/b.ts'],
      evidence: undefined,
      missing: ['tests'],
    });
  });

  it('returns null without a request body', () => {
    // Events cross the wire as JSON: neither a missing nor a blank body is
    // guaranteed away by the declared type.
    expect(
      childRequestFieldsFromEvent({
        type: 'subagent.child_request',
        subagentId: 'agent-7',
        requestType: 'info',
      } as unknown as SubagentChildRequestEvent),
    ).toBeNull();
    expect(childRequestFieldsFromEvent(requestEvent({ message: '   ' }))).toBeNull();
  });

  it('degrades an unknown request type to info instead of guessing', () => {
    const event = { ...requestEvent(), requestType: 'yolo' } as unknown as SubagentChildRequestEvent;
    expect(childRequestFieldsFromEvent(event)?.requestType).toBe('info');
  });

  it('ignores a malformed payload', () => {
    const event = {
      ...requestEvent(),
      artifacts: 'not-an-array',
      evidence: [null, 'ok'],
    } as unknown as SubagentChildRequestEvent;
    const fields = childRequestFieldsFromEvent(event);
    expect(fields?.artifacts).toBeUndefined();
    expect(fields?.evidence).toEqual(['ok']);
  });
});

describe('previewText', () => {
  it('collapses newlines and trims so the ticker stays a single paragraph', () => {
    expect(previewText('第一行\n  第二行  ')).toBe('第一行 第二行');
  });

  it('caps an over-long request at 200 chars plus an ellipsis', () => {
    // The kernel allows 8192 chars; the ticker is one terminal line.
    const long = previewText('x'.repeat(8000));
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(201);
  });

  it('leaves short text untouched', () => {
    expect(previewText('因为缺少基线')).toBe('因为缺少基线');
  });

  it('strips terminal control sequences from untrusted request text', () => {
    // A child's message is model output: an unescaped sequence would reach the
    // status row and could clear the screen or write the clipboard (OSC 52).
    const hostile = '因为\u001B[2J缺少基\u001B]52;c;aGVsbG8=\u0007线\r';
    expect(previewText(hostile)).toBe('因为缺少基线');
  });

  it('caps by code point so an emoji at the boundary is never split', () => {
    const text = `${'x'.repeat(199)}😀tail`;
    const preview = previewText(text);
    // 199 ASCII + the emoji = 200 code points, then the ellipsis.
    expect(preview).toBe(`${'x'.repeat(199)}😀…`);
    expect(preview.includes('\uFFFD')).toBe(false);
    expect(Array.from(preview).length).toBe(201);
  });
});
