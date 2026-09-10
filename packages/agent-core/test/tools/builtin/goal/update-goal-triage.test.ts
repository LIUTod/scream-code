import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../../src/agent';
import {
  MAX_EVIDENCE_RETRIES,
  UpdateGoalTool,
  type GoalGraderFn,
} from '../../../../src/tools/builtin/goal/update-goal';

function mockAgent(objective: string) {
  const blockedSnapshot = {
    objective,
    status: 'blocked',
    reason: { reason: 'parked by test' },
    completionCriterion: 'criterion',
    wallClockMs: 0,
  };
  const goal = {
    getGoal: () => ({
      goal: { objective, completionCriterion: 'criterion', notes: [] },
    }),
    pauseGoal: vi.fn(async () => {}),
    resumeGoal: vi.fn(async () => {}),
    markBlocked: vi.fn(async () => blockedSnapshot),
    markComplete: vi.fn(async () => ({ ...blockedSnapshot, status: 'complete' })),
  };
  const agent = {
    goal,
    context: { history: [], appendSystemReminder: vi.fn() },
    config: { cwd: undefined },
    homedir: undefined,
  } as unknown as Agent;
  return { agent, goal };
}

function toolFor(agent: Agent, grader: GoalGraderFn): UpdateGoalTool {
  return new UpdateGoalTool(agent, grader);
}

async function complete(tool: UpdateGoalTool) {
  const exec = tool.resolveExecution({ status: 'complete' }) as unknown as {
    execute: () => Promise<{ output: unknown; stopTurn?: boolean }>;
  };
  return exec.execute();
}

describe('UpdateGoalTool verification triage', () => {
  it('treats a FAIL with no concrete issues as invalid and does not park the goal', async () => {
    const { agent, goal } = mockAgent('triage-no-gaps');
    const grader: GoalGraderFn = vi.fn(async () => ({ pass: false, reason: 'not good enough' }));
    const result = await complete(toolFor(agent, grader));

    expect(goal.markBlocked).not.toHaveBeenCalled();
    expect(String(result.output)).toContain('without specific gaps');
  });

  it('parks the goal when a FAIL raises only subjective issues', async () => {
    const { agent, goal } = mockAgent('triage-subjective');
    const grader: GoalGraderFn = vi.fn(async () => ({
      pass: false,
      reason: 'taste call',
      issues: [{ issue: 'the tone feels off', kind: 'subjective' }],
    }));
    const result = await complete(toolFor(agent, grader));

    expect(goal.markBlocked).toHaveBeenCalledTimes(1);
    expect(String(result.output)).toContain('parked for human decision');
    expect(result.stopTurn).toBe(true);
  });

  it('parks the goal after MAX_EVIDENCE_RETRIES evidence-gap rounds', async () => {
    const { agent, goal } = mockAgent('triage-evidence-budget');
    const grader: GoalGraderFn = vi.fn(async () => ({
      pass: false,
      reason: `evidence round ${Math.random()}`,
      issues: [{ issue: 'tests are failing', kind: 'evidence' }],
    }));
    const tool = toolFor(agent, grader);

    for (let i = 0; i < MAX_EVIDENCE_RETRIES; i += 1) {
      const result = await complete(tool);
      expect(goal.markBlocked).not.toHaveBeenCalled();
      expect(String(result.output)).toContain('Verification failed');
    }
    // One more evidence FAIL exceeds the budget → parked.
    const finalResult = await complete(tool);
    expect(goal.markBlocked).toHaveBeenCalledTimes(1);
    expect(String(finalResult.output)).toContain('Repeated evidence gaps');
    expect(finalResult.stopTurn).toBe(true);
  });

  it('defaults unclassified legacy string issues to subjective (parks)', async () => {
    const { agent, goal } = mockAgent('triage-legacy-strings');
    const grader: GoalGraderFn = vi.fn(async () => ({
      pass: false,
      reason: 'legacy shape',
      issues: ['something is off'],
    }));
    const result = await complete(toolFor(agent, grader));

    expect(goal.markBlocked).toHaveBeenCalledTimes(1);
    expect(String(result.output)).toContain('parked for human decision');
  });

  it('accepts grader issues in the normalized {text,kind} shape (createGoalGrader output)', async () => {
    const { agent, goal } = mockAgent('triage-normalized-shape');
    const grader: GoalGraderFn = vi.fn(async () => ({
      pass: false,
      reason: 'normalized shape',
      issues: [{ text: 'tests are failing', kind: 'evidence' }],
    }));
    const result = await complete(toolFor(agent, grader));

    // Evidence-class issues consume the evidence budget (no immediate park) —
    // this locks the field-name contract between createGoalGrader ({text,kind})
    // and the triage normalizer.
    expect(goal.markBlocked).not.toHaveBeenCalled();
    expect(String(result.output)).toContain('Verification failed');
  });
});

