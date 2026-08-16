import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const DEFAULT_APPROVE_TOOLS: Record<string, true> = {
  Read: true,
  Grep: true,
  Glob: true,
  ReadMediaFile: true,
  InspectOwnAssets: true,
  SetTodoList: true,
  TodoList: true,
  TaskList: true,
  TaskOutput: true,
  CronList: true,
  WebSearch: true,
  FetchURL: true,
  Agent: true,
  AskUserQuestion: true,
  Skill: true,
  WolfPack: true,
  CreateGoal: true,
  UpdateGoal: true,
  GetGoal: true,
  SetGoalBudget: true,
  WriteGoalNote: true,
  MakeSkillPlan: true,
  MakeSkillApply: true,
};

export class DefaultToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!DEFAULT_APPROVE_TOOLS[context.toolCall.name]) return;
    return {
      kind: 'approve',
    };
  }
}
