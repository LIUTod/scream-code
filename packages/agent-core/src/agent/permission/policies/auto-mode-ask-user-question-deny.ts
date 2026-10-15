import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class AutoModeAskUserQuestionDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'auto-mode-ask-user-question-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;
    if (context.toolCall.name !== 'AskUserQuestion') return;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is unavailable in auto permission mode. Decide reasonable defaults and ' +
        'keep working — but when a decision genuinely requires the user, stop that direction, state ' +
        'the question and your recommended option in a normal text reply, and end the turn so the ' +
        'user can answer when they return. Do not keep guessing past a question only the user can settle.',
    };
  }
}
