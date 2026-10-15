/**
 * Author-declared destructiveness → ask.
 *
 * Tools may carry `annotations.destructiveHint` (unverified, declared by the
 * tool author — MCP servers supply them natively). The hint is consumed in
 * the conservative direction only: it can force an approval where another
 * policy would have auto-approved; it never grants one.
 *
 * Ordered ABOVE `default-tool-approve` (the chain is first-match-wins), so a
 * helper that ships in the default-approve group still asks once it declares
 * itself destructive. auto/yolo approve earlier in the chain and keep their
 * pass-through semantics; user rules, session grants and wolfpack mode also
 * run before this policy and win.
 */

import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class DestructiveHintAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'destructive-hint-ask';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.tool?.annotations?.destructiveHint !== true) return undefined;
    return {
      kind: 'ask',
      reasons: [
        `${context.toolCall.name} declares itself destructive (author-declared hint) — confirm before it runs.`,
      ],
      grantOptions: ['once', 'session'],
    };
  }
}
