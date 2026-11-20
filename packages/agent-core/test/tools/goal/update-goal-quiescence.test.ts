import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { GoalSnapshot } from '../../../src/agent/goal';
import {
  UpdateGoalTool,
  type GoalGraderFn,
  type UpdateGoalToolInput,
} from '../../../src/tools/builtin/goal/update-goal';
import { executeTool } from '../fixtures/execute-tool';

const signal = new AbortController().signal;

const mockedExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockedExecFile(...args),
}));

function makeSnapshot(): GoalSnapshot {
  return {
    goalId: 'goal_1',
    objective: 'Implement feature X',
    completionCriterion: 'Tests pass',
    status: 'active',
    turnsUsed: 1,
    tokensUsed: 100,
    wallClockMs: 5_000,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
    notes: [],
  };
}

/** Build a minimal Agent whose background manager reports the given tasks. */
function makeAgent(runningTasks: { taskId: string }[]): { agent: Agent; grader: ReturnType<typeof vi.fn<GoalGraderFn>> } {
  const grader = vi.fn<GoalGraderFn>(async () => ({ pass: true, reason: 'Looks good' }));
  const agent = {
    config: { cwd: tmpdir() },
    goal: {
      getGoal: () => ({ goal: makeSnapshot() }),
      pauseGoal: vi.fn(async () => {}),
      resumeGoal: vi.fn(async () => {}),
      markComplete: vi.fn(async () => makeSnapshot()),
    },
    context: {
      history: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
      appendSystemReminder: vi.fn(),
    },
    background: {
      list: vi.fn((activeOnly = true) => (activeOnly ? runningTasks : runningTasks)),
    },
  } as unknown as Agent;
  return { agent, grader };
}

describe('UpdateGoalTool quiescence barrier (no completion with running subagents)', () => {
  it('refuses to mark the goal complete while agent subagents are still running', async () => {
    mockedExecFile.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: '', stderr: '' }));
    // Two agent tasks still running in the background.
    const { agent, grader } = makeAgent([{ taskId: 'agent-aaa' }, { taskId: 'agent-bbb' }]);
    const tool = new UpdateGoalTool(agent, grader);

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: { status: 'complete' } as UpdateGoalToolInput,
      signal,
    });

    // Completion refused: the grader never ran, the goal was never marked, and
    // the message points the model at waiting for the outstanding agents.
    expect(result.output).toContain('Cannot mark the goal complete');
    expect(result.output).toContain('2 subagents');
    expect(result.output).toContain('wait tool');
    expect(grader).not.toHaveBeenCalled();
    expect(agent.goal.markComplete).not.toHaveBeenCalled();
  });

  it('ignores non-agent background tasks (only subagents gate completion)', async () => {
    mockedExecFile.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: '', stderr: '' }));
    // A backgrounded bash command, not a subagent — must not block completion.
    const { agent, grader } = makeAgent([{ taskId: 'bash-123' }]);
    const tool = new UpdateGoalTool(agent, grader);

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: { status: 'complete' } as UpdateGoalToolInput,
      signal,
    });

    expect(grader).toHaveBeenCalled();
    expect(result.output).toContain('Goal verified and marked complete');
  });

  it('allows completion once all subagents have settled', async () => {
    mockedExecFile.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: '', stderr: '' }));
    const { agent, grader } = makeAgent([]);
    const tool = new UpdateGoalTool(agent, grader);

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: { status: 'complete' } as UpdateGoalToolInput,
      signal,
    });

    expect(grader).toHaveBeenCalled();
    expect(result.output).toContain('Goal verified and marked complete');
  });
});
