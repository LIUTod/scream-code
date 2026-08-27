import { describe, expect, it } from 'vitest';

import type {
  ExecutableTool,
  ExecutableToolResult,
  ToolExecution,
} from '../../src/loop/index';

import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';

/**
 * Regression: turn/index.ts used to pass only a per-turn snapshot of the tool
 * table, so a plugin tool registered MID-TURN (the activate-then-call flow)
 * failed preflight with "Tool not found" until the next turn. `buildTools`
 * rebuilds the table per step — the newly registered tool must be
 * dispatchable on the very next step of the same turn.
 */

class BurstTool implements ExecutableTool {
  readonly name = 'burst';
  readonly description = 'the freshly registered tool';
  readonly parameters = {};
  calls = 0;

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (): Promise<ExecutableToolResult> => {
        this.calls += 1;
        return { output: 'burst ran' };
      },
    };
  }
}

class RegistrarTool implements ExecutableTool {
  readonly name = 'registrar';
  readonly description = 'registers the burst tool mid-turn (plugin-activate pattern)';
  readonly parameters = {};

  constructor(
    private readonly live: ExecutableTool[],
    private readonly burst: BurstTool,
  ) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (): Promise<ExecutableToolResult> => {
        this.live.push(this.burst);
        return { output: 'registered' };
      },
    };
  }
}

function makeScripted(): { live: ExecutableTool[]; burst: BurstTool; responses: ReturnType<typeof makeEndTurnResponse>[] } {
  const live: ExecutableTool[] = [];
  const burst = new BurstTool();
  live.push(new RegistrarTool(live, burst));
  return {
    live,
    burst,
    responses: [
      makeToolUseResponse([makeToolCall('registrar', {})]),
      makeToolUseResponse([makeToolCall('burst', {})]),
      makeEndTurnResponse('done'),
    ] as ReturnType<typeof makeEndTurnResponse>[],
  };
}

describe('runTurn — buildTools per-step tool table', () => {
  it('a tool registered mid-turn is dispatchable on the very next step', async () => {
    const { live, burst, responses } = makeScripted();

    const { result } = await runTurn({
      responses,
      tools: [...live],
      buildTools: () => live,
    });

    expect(result.stopReason).toBe('end_turn');
    expect(burst.calls).toBe(1);
  });

  it('without buildTools the same flow fails with "not found" (documents the fixed bug)', async () => {
    const { live, burst, responses } = makeScripted();

    const { result, sink } = await runTurn({
      responses,
      tools: [...live],
    });

    expect(burst.calls).toBe(0);
    expect(result.stopReason).toBe('end_turn');
    // The preflight rejects the unknown tool call as a normal tool error,
    // so the loop itself still completes — that part never regressed.
    const results = sink.byType('tool.result');
    const notFound = results.filter(
      (r) => r.result.isError === true && String(r.result.output).includes('not found'),
    );
    expect(notFound.length).toBe(1);
  });
});
