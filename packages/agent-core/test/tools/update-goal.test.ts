import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { GoalMode } from '../../src/agent/goal';
import type { ExecutableToolResult } from '../../src/loop';
import {
  UpdateGoalTool,
  type GoalGraderFn,
} from '../../src/tools/builtin/goal/update-goal';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function createGoalAgent(): {
  readonly agent: Agent;
  readonly appendSystemReminder: ReturnType<typeof vi.fn>;
} {
  const appendSystemReminder = vi.fn();
  const agent = {
    context: {
      history: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Implemented and verified the requested behavior.' }],
        },
      ],
      appendSystemReminder,
    },
    records: { logRecord: vi.fn() },
    emitEvent: vi.fn(),
  } as unknown as Agent;
  Object.assign(agent, { goal: new GoalMode(agent) });
  return { agent, appendSystemReminder };
}

async function executeComplete(agent: Agent, grader: GoalGraderFn): Promise<ExecutableToolResult> {
  return executeTool(new UpdateGoalTool(agent, grader), {
    turnId: '0',
    toolCallId: 'call_update_goal',
    args: { status: 'complete' },
    signal,
  });
}

describe('UpdateGoal completion grading', () => {
  it('pauses while grading, resumes, and completes only after an explicit pass', async () => {
    const { agent, appendSystemReminder } = createGoalAgent();
    await agent.goal.createGoal({
      objective: 'Ship the fix',
      completionCriterion: 'Focused tests pass',
    });
    const statusesDuringGrade: string[] = [];

    const result = await executeComplete(agent, async () => {
      statusesDuringGrade.push(agent.goal.getGoal().goal?.status ?? 'missing');
      return { pass: true, reason: 'All focused checks passed.' };
    });

    expect(statusesDuringGrade).toEqual(['paused']);
    expect(result).toEqual({
      output: 'Goal verified and marked complete.\nAll focused checks passed.',
      stopTurn: true,
    });
    expect(agent.goal.getGoal().goal).toBeNull();
    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Goal completed successfully'),
      { kind: 'system_trigger', name: 'goal_completion_summary' },
    );
  });

  it('restores active state and injects actionable feedback after a failed grade', async () => {
    const { agent, appendSystemReminder } = createGoalAgent();
    await agent.goal.createGoal({ objective: 'Ship the fix' });

    const result = await executeComplete(agent, async () => ({
      pass: false,
      reason: 'The regression test still fails.',
    }));

    expect(result).toEqual({
      output: 'Verification failed: The regression test still fails.. Continue working.',
    });
    expect(agent.goal.getGoal().goal?.status).toBe('active');
    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('The regression test still fails.'),
      { kind: 'system_trigger', name: 'goal_grading_feedback' },
    );
    expect(appendSystemReminder).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'goal_completion_summary' }),
    );
  });

  it.each([
    ['throws', async (): Promise<unknown> => { throw new Error('grader transport closed'); }],
    ['returns a non-object', async (): Promise<unknown> => 'pass'],
    ['omits a boolean pass', async (): Promise<unknown> => ({ pass: 'yes', reason: 'looks good' })],
    ['omits a usable reason', async (): Promise<unknown> => ({ pass: true, reason: '' })],
  ] as const)('returns an observable tool error, stays active, and continues when grader %s', async (_label, grader) => {
    const { agent, appendSystemReminder } = createGoalAgent();
    await agent.goal.createGoal({ objective: 'Ship the fix' });

    const result = await executeComplete(agent, grader);

    expect(result).toMatchObject({ isError: true });
    expect(result).not.toHaveProperty('stopTurn');
    expect(agent.goal.getGoal().goal?.status).toBe('active');
    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Goal verification could not be completed'),
      { kind: 'system_trigger', name: 'goal_grading_feedback' },
    );
    expect(appendSystemReminder).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'goal_completion_summary' }),
    );
  });

  it('reports a pause failure without grading or claiming a state change', async () => {
    const { agent } = createGoalAgent();
    await agent.goal.createGoal({ objective: 'Ship the fix' });
    const pauseError = new Error('persistence unavailable');
    const pauseGoal = vi.spyOn(agent.goal, 'pauseGoal').mockRejectedValue(pauseError);
    const grader = vi.fn<GoalGraderFn>();

    const result = await executeComplete(agent, grader);

    expect(result).toEqual({
      isError: true,
      output:
        'Failed to pause goal for verification: persistence unavailable. Current goal status: active.',
    });
    expect(pauseGoal).toHaveBeenCalled();
    expect(grader).not.toHaveBeenCalled();
    expect(agent.goal.getGoal().goal?.status).toBe('active');
  });

  it('reports a resume failure with the actual paused state and never completes', async () => {
    const { agent, appendSystemReminder } = createGoalAgent();
    await agent.goal.createGoal({ objective: 'Ship the fix' });
    const resumeGoal = vi
      .spyOn(agent.goal, 'resumeGoal')
      .mockRejectedValue(new Error('persistence unavailable'));

    const result = await executeComplete(agent, async () => ({
      pass: true,
      reason: 'All checks passed.',
    }));

    expect(result).toEqual({
      isError: true,
      output:
        'Failed to restore active goal after verification: persistence unavailable. Current goal status: paused.',
    });
    expect(resumeGoal).toHaveBeenCalled();
    expect(agent.goal.getGoal().goal?.status).toBe('paused');
    expect(appendSystemReminder).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'goal_completion_summary' }),
    );
  });
});
