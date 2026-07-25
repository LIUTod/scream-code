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

function makeSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'goal_1',
    objective: 'Implement feature X',
    completionCriterion: 'Tests pass and code is reviewed',
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
    ...overrides,
  };
}

function makeAgent(options: {
  readonly snapshot?: GoalSnapshot;
  readonly history?: { role: string; content: { type: string; text?: string }[] }[];
  readonly grade?: unknown;
  readonly cwd?: string;
}): {
  readonly agent: Agent;
  readonly grader: ReturnType<typeof vi.fn<GoalGraderFn>>;
} {
  const grader = vi.fn<GoalGraderFn>(
    async (_objective: string, _criterion: string | undefined, _output: string) =>
      options.grade ?? { pass: true, reason: 'Looks good' },
  );

  const agent = {
    config: { cwd: options.cwd ?? tmpdir() },
    goal: {
      getGoal: () => ({ goal: options.snapshot ?? makeSnapshot() }),
      pauseGoal: vi.fn(async () => {}),
      resumeGoal: vi.fn(async () => {}),
      markComplete: vi.fn(async () => options.snapshot ?? makeSnapshot({ status: 'complete' })),
    },
    context: {
      history: options.history ?? [
        { role: 'assistant', content: [{ type: 'text', text: 'Implementation complete.' }] },
      ],
      appendSystemReminder: vi.fn(),
    },
  } as unknown as Agent;

  return { agent, grader };
}

function input(status: UpdateGoalToolInput['status']): UpdateGoalToolInput {
  return { status };
}

describe('UpdateGoalTool', () => {
  it('marks the goal complete when the grader passes', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, callback) => callback(null, { stdout: '', stderr: '' }));
    const { agent, grader } = makeAgent({});
    const tool = new UpdateGoalTool(agent, grader);

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: input('complete'),
      signal,
    });

    expect(result.isError ?? false).toBe(false);
    expect(result.output).toContain('Goal verified and marked complete');
    expect(agent.goal.pauseGoal).toHaveBeenCalledWith({ reason: 'verifying' }, 'system');
    expect(agent.goal.markComplete).toHaveBeenCalledWith({}, 'model');
  });

  it('includes cross-turn working notes in the grader input', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, callback) => callback(null, { stdout: '', stderr: '' }));
    const notes = [
      { content: 'First discovery: use async iteration', time: 1 },
      { content: 'Second discovery: cache the result', time: 2 },
    ];
    const { agent, grader } = makeAgent({
      snapshot: makeSnapshot({ notes }),
      history: [
        { role: 'assistant', content: [{ type: 'text', text: 'Final implementation done.' }] },
      ],
    });
    const tool = new UpdateGoalTool(agent, grader);

    await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: input('complete'),
      signal,
    });

    expect(grader).toHaveBeenCalledTimes(1);
    const gradedOutput = grader.mock.calls[0]![2];
    expect(gradedOutput).toContain('Final implementation done.');
    expect(gradedOutput).toContain('## Cross-turn working notes');
    expect(gradedOutput).toContain('• First discovery: use async iteration');
    expect(gradedOutput).toContain('• Second discovery: cache the result');
  });

  it('does not append a notes section when there are no notes', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, callback) => callback(null, { stdout: '', stderr: '' }));
    const { agent, grader } = makeAgent({
      snapshot: makeSnapshot({ notes: [] }),
      history: [
        { role: 'assistant', content: [{ type: 'text', text: 'Done with no notes.' }] },
      ],
    });
    const tool = new UpdateGoalTool(agent, grader);

    await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: input('complete'),
      signal,
    });

    const gradedOutput = grader.mock.calls[0]![2];
    expect(gradedOutput).toBe('Done with no notes.');
    expect(gradedOutput).not.toContain('Cross-turn working notes');
  });

  it('includes git diff stat in the grader input when changes exist', async () => {
    const diffStat = 'src/index.ts | 10 ++++++++++\n 1 file changed, 10 insertions(+)';
    mockedExecFile.mockImplementation((_file, _args, _opts, callback) => callback(null, { stdout: diffStat, stderr: '' }));

    const { agent, grader } = makeAgent({
      history: [
        { role: 'assistant', content: [{ type: 'text', text: 'Implementation complete.' }] },
      ],
    });
    const tool = new UpdateGoalTool(agent, grader);

    await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: input('complete'),
      signal,
    });

    expect(grader).toHaveBeenCalledTimes(1);
    const gradedOutput = grader.mock.calls[0]![2];
    expect(gradedOutput).toContain('Implementation complete.');
    expect(gradedOutput).toContain('## Changes this turn');
    expect(gradedOutput).toContain(diffStat);
  });

  it('tells the reviewer when git diff is unavailable', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, callback) =>
      callback(new Error('git not found'), { stdout: '', stderr: '' }));

    const { agent, grader } = makeAgent({
      history: [
        { role: 'assistant', content: [{ type: 'text', text: 'Implementation complete.' }] },
      ],
    });
    const tool = new UpdateGoalTool(agent, grader);

    await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: input('complete'),
      signal,
    });

    expect(grader).toHaveBeenCalledTimes(1);
    const gradedOutput = grader.mock.calls[0]![2];
    expect(gradedOutput).toContain('Implementation complete.');
    expect(gradedOutput).toContain('## Changes this turn');
    expect(gradedOutput).toContain('Git diff unavailable');
  });

  it('returns a failure message and resumes the goal when the grader rejects', async () => {
    mockedExecFile.mockImplementation((_file, _args, _opts, callback) => callback(null, { stdout: '', stderr: '' }));
    const { agent, grader } = makeAgent({
      grade: { pass: false, reason: 'Missing error handling' },
    });
    const tool = new UpdateGoalTool(agent, grader);

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_update_goal',
      args: input('complete'),
      signal,
    });

    expect(result.isError ?? false).toBe(false);
    expect(result.output).toContain('Verification failed');
    expect(result.output).toContain('Missing error handling');
    expect(agent.goal.markComplete).not.toHaveBeenCalled();
  });
});
