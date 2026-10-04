/**
 * Tool-result side channels (display / message / useless) must survive
 * `normalizeToolResult` and reach the `tool.result` event, the persisted
 * transcript record, and the AgentEvent mapping. Regression guard for the
 * pipeline that feeds TUI renderers (file diff, LSP diagnostics) and the
 * RPC layer.
 */

import { describe, expect, it } from 'vitest';

import { mapLoopEvent } from '../../src/agent/turn/utils';
import type { ExecutableToolResult, LoopEvent } from '../../src/loop/index';
import type { ToolResultDisplay } from '../../src/tools/display';

import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import { ContentBlocksTool } from './fixtures/tools';

const FILE_DIFF_DISPLAY: ToolResultDisplay = { kind: 'file_diff', added: 2, removed: 1 };
const LSP_MESSAGE = '[LSP] 1 diagnostic(s):\nsrc/a.ts:3:1 error TS2322: Type mismatch.';

type SuccessResult = Extract<ExecutableToolResult, { isError?: false | undefined }>;

/** Narrow a union result to the success shape (display/useless are success-only). */
function asSuccess(result: ExecutableToolResult | undefined, label: string): SuccessResult {
  if (result === undefined || result.isError === true) {
    throw new Error(`${label}: expected a success result, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe('tool.result side channels — event and transcript', () => {
  it('preserves display/message/useless on successful results', async () => {
    const tool = new ContentBlocksTool({
      output: 'Replaced 1 occurrence in src/a.ts',
      display: FILE_DIFF_DISPLAY,
      message: LSP_MESSAGE,
      useless: true,
    });
    const { sink, context } = await runTurn({
      responses: [
        makeToolUseResponse([makeToolCall('blocks', {}, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
      tools: [tool],
    });

    const eventResult = asSuccess(sink.byType('tool.result')[0]?.result, 'event');
    expect(eventResult.display).toEqual(FILE_DIFF_DISPLAY);
    expect(eventResult.message).toBe(LSP_MESSAGE);
    expect(eventResult.useless).toBe(true);

    const transcriptResult = asSuccess(context.toolResults()[0]?.result, 'transcript');
    expect(transcriptResult.display).toEqual(FILE_DIFF_DISPLAY);
    expect(transcriptResult.message).toBe(LSP_MESSAGE);
    expect(transcriptResult.useless).toBe(true);
    // Output normalization is unchanged: the text still collapses as before.
    expect(transcriptResult.output).toBe('Replaced 1 occurrence in src/a.ts');
  });

  it('preserves message on error results', async () => {
    const tool = new ContentBlocksTool({
      isError: true,
      output: 'Edit failed',
      message: LSP_MESSAGE,
    });
    const { sink, context } = await runTurn({
      responses: [
        makeToolUseResponse([makeToolCall('blocks', {}, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
      tools: [tool],
    });

    const eventResult = sink.byType('tool.result')[0]?.result;
    expect(eventResult?.isError).toBe(true);
    expect(eventResult?.message).toBe(LSP_MESSAGE);

    const transcriptResult = context.toolResults()[0]?.result;
    expect(transcriptResult?.message).toBe(LSP_MESSAGE);
  });

  it('keeps output/isError semantics identical for plain results', async () => {
    const tool = new ContentBlocksTool({ output: 'plain' });
    const { sink } = await runTurn({
      responses: [
        makeToolUseResponse([makeToolCall('blocks', {}, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
      tools: [tool],
    });

    const eventResult = sink.byType('tool.result')[0]?.result;
    expect(eventResult).toEqual({ output: 'plain' });
  });
});

describe('mapLoopEvent — tool.result side channels', () => {
  it('forwards display and message for successful results', () => {
    const event: LoopEvent = {
      type: 'tool.result',
      parentUuid: 'parent-1',
      toolCallId: 'tc-1',
      result: { output: 'x', display: FILE_DIFF_DISPLAY, message: LSP_MESSAGE },
    };
    const mapped = mapLoopEvent(event, 1);
    if (mapped?.type !== 'tool.result') throw new Error('expected tool.result mapping');
    expect(mapped.display).toEqual(FILE_DIFF_DISPLAY);
    expect(mapped.message).toBe(LSP_MESSAGE);
  });

  it('keeps message on error results (display is success-only by contract)', () => {
    const event: LoopEvent = {
      type: 'tool.result',
      parentUuid: 'parent-1',
      toolCallId: 'tc-1',
      result: { isError: true, output: 'x', message: LSP_MESSAGE },
    };
    const mapped = mapLoopEvent(event, 1);
    if (mapped?.type !== 'tool.result') throw new Error('expected tool.result mapping');
    expect(mapped.display).toBeUndefined();
    expect(mapped.message).toBe(LSP_MESSAGE);
  });
});
