import type { Agent } from '../..';
import type { PermissionPolicy } from '../types';
import { AskModeGuardDenyPermissionPolicy } from './ask-mode-guard-deny';
import { AutoModeApprovePermissionPolicy } from './auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from './auto-mode-ask-user-question-deny';
import { BotModePermissionPolicy } from './bot-mode-permission';
import { CapabilityGuardDenyPermissionPolicy } from './capability-guard-deny';
import { DefaultToolApprovePermissionPolicy } from './default-tool-approve';
import { DestructiveHintAskPermissionPolicy } from './destructive-hint-ask';
import { ExitPlanModeReviewAskPermissionPolicy } from './exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicy } from './fallback-ask';
import {
  CwdOutsideFileWriteAskPermissionPolicy,
  GitControlPathAccessAskPermissionPolicy,
  SensitiveFileAccessAskPermissionPolicy,
} from './file-access-ask';
import { GitCwdWriteApprovePermissionPolicy } from './git-cwd-write-approve';
import { ManagePluginReadOnlyApprovePermissionPolicy } from './manage-plugin-read-only-approve';
import { PlanModeGuardDenyPermissionPolicy } from './plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicy } from './plan-mode-tool-approve';
import { PreToolCallHookPermissionPolicy } from './pre-tool-call-hook';
import { PrivateReadEgressAskPermissionPolicy } from './private-read-egress-ask';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import {
  UserConfiguredAllowPermissionPolicy,
  UserConfiguredAskPermissionPolicy,
  UserConfiguredDenyPermissionPolicy,
} from './user-configured-rules';
import { WarningsAskPermissionPolicy } from './warnings-ask';
import { CollaborationAutoApprovePermissionPolicy } from './collaboration-auto-approve';
import { YoloModeApprovePermissionPolicy } from './yolo-mode-approve';
import { WolfPackModeApprovePermissionPolicy } from './wolfpack-mode-approve';

/** Permission policies run in order; the first non-undefined result wins. */
export function createPermissionDecisionPolicies(agent: Agent): readonly PermissionPolicy[] {
  return [
    // PreToolUse hook returned a block → deny.
    new PreToolCallHookPermissionPolicy(agent),
    // Restricted capability contract (read-only/read-write/execute) → deny any
    // tool the mode does not permit. Runs before every approve policy so no
    // user allow-rule, session grant or yolo/wolfpack mode can widen a
    // contract the parent set at spawn (inert for `all`).
    new CapabilityGuardDenyPermissionPolicy(agent),
    // auto mode + AskUserQuestion → deny.
    new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
    // plan mode: Write/Edit outside the plan file, or TaskStop → deny.
    new PlanModeGuardDenyPermissionPolicy(agent),
    // ask mode: mutating tools (Bash/Write/Edit/Cron/TaskStop/MCP) → deny.
    new AskModeGuardDenyPermissionPolicy(agent),
    // User-configured deny rule matches → deny.
    new UserConfiguredDenyPermissionPolicy(agent),
    // bot mode (unattended): reversible allowlist auto-approves; everything
    // else is denied and parked. Sits after user deny rules so an explicit
    // user deny always wins.
    new BotModePermissionPolicy(agent),
    // Coordination tools (ContactParent/ReportFinding/SendSubagentMessage) are
    // conversation, not mutation — never block them on an approval prompt.
    new CollaborationAutoApprovePermissionPolicy(),
    // auto mode → approve (any auto-mode block must be a deny rule above this).
    // Order invariant: every ask policy lives below this line (the chain is
    // first-match-wins) — auto is a blanket-approve contract, so an ask below
    // it would contradict the mode the user selected.
    new AutoModeApprovePermissionPolicy(agent),
    // yolo mode → approve every tool operation. Order invariant: every
    // tool-operation ask lives below this line (the chain is first-match-wins)
    // — yolo is the pass-through sibling of auto that keeps the agent's
    // questions and plan reviews. ExitPlanMode is exempt inside the policy, so
    // plan decisions still reach the review below.
    new YoloModeApprovePermissionPolicy(agent),
    // The session read private data from outside the workspace and this call
    // sends data out → ask. Order invariant: this line MUST stay between
    // `yolo-mode-approve` and `warnings-ask` (the chain is first-match-wins).
    // Above yolo → yolo would stop to ask; below `warnings-ask` → a
    // dangerous-command prompt could replace the egress check for a command
    // that matches both.
    new PrivateReadEgressAskPermissionPolicy(agent),
    // Dangerous shell commands → ask, once or for the session. Order invariant:
    // this line MUST stay between `yolo-mode-approve` and
    // `session-approval-history` (the chain is first-match-wins). Above yolo →
    // yolo would stop to ask; below session history → any matching grant —
    // a blanket `Bash` grant included — would silence the warning before this
    // policy can require the identical rule.
    new WarningsAskPermissionPolicy(agent),
    // Approve-for-session memorized rule matches → approve. Runs before user-configured ask rules so an in-session grant beats a still-matching ask rule on later calls.
    new SessionApprovalHistoryPermissionPolicy(agent),
    // User-configured ask rule matches → ask.
    new UserConfiguredAskPermissionPolicy(agent),
    // User-configured allow rule matches → approve.
    new UserConfiguredAllowPermissionPolicy(agent),
    // ExitPlanMode with active plan_review + non-empty plan + non-auto → ask
    // (tracks plan_submitted/plan_resolved itself). Sits after
    // `session-approval-history` on purpose: an ExitPlanMode already approved
    // for the session is reused without re-prompting, and auto never reaches
    // it (`auto-mode-approve` above takes over; the policy self-gates on auto).
    new ExitPlanModeReviewAskPermissionPolicy(agent),
    // EnterPlanMode, Write/Edit on the plan file, or ExitPlanMode with no actionable plan_review → approve.
    new PlanModeToolApprovePermissionPolicy(agent),
    // Access touches a sensitive file (.env, SSH key, credentials) → ask.
    new SensitiveFileAccessAskPermissionPolicy(agent),
    // Access touches .git or a git control-dir path → ask.
    new GitControlPathAccessAskPermissionPolicy(agent),
    // Write target is outside cwd → ask. Reads and searches outside cwd are allowed without prompting.
    new CwdOutsideFileWriteAskPermissionPolicy(agent),
    // WolfPack mode active → approve.
    new WolfPackModeApprovePermissionPolicy(agent),
    // Tool author declared the call destructive (unverified hint) → ask. Sits above the
    // default-approve list so a helper that declares itself destructive still asks; auto/
    // yolo approve earlier in the chain and user/session grants run above this point.
    new DestructiveHintAskPermissionPolicy(),
    // Tool is in the default-approve list (read-only / UI helpers) → approve.
    new DefaultToolApprovePermissionPolicy(),
    // ManagePlugin's read-only actions (list/info/check/marketplace) → approve. Mutating
    // actions decide nothing here and keep falling through to the approval prompt.
    new ManagePluginReadOnlyApprovePermissionPolicy(),
    // Write/Edit on POSIX paths inside cwd inside a git work tree → approve.
    new GitCwdWriteApprovePermissionPolicy(agent),
    // Nothing matched → ask.
    new FallbackAskPermissionPolicy(),
  ];
}
