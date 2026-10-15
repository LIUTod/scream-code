/**
 * Unit tests for the failure-streak classifier — the piece that keeps user
 * aborts out of the consecutive-failure counter.
 */

import { describe, expect, it } from 'vitest';

import { classifyToolResult } from '../../src/agent/turn/tool-failure-streak';

describe('classifyToolResult', () => {
  it('classifies a successful result as success', () => {
    expect(classifyToolResult({ isError: false, output: 'ok' })).toBe('success');
  });

  it('classifies an execution failure as failure', () => {
    expect(classifyToolResult({ isError: true, output: 'boom', code: 'failed' })).toBe('failure');
  });

  it('classifies a guard/permission block as failure (repeated blocks are the change-approach case)', () => {
    expect(classifyToolResult({ isError: true, output: 'blocked', code: 'blocked' })).toBe('failure');
  });

  it('classifies an abort as neutral — the user stopped the call, the model did not fail', () => {
    expect(
      classifyToolResult({
        isError: true,
        output: 'aborted',
        code: 'aborted',
        abortReason: 'user-cancel',
      }),
    ).toBe('neutral');
  });

  it('classifies a plain error without a code as failure', () => {
    expect(classifyToolResult({ isError: true, output: 'boom' })).toBe('failure');
  });
});
