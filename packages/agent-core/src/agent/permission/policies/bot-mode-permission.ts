import { basename, normalize, relative, resolve } from 'pathe';

import { isPathInside } from '#/utils/path-safety';

import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import {
  actionKey,
  addApprovalItem,
  alwaysActionKey,
  addQuestionItem,
  readApprovedActions,
  readSessionApprovedActions,
} from '../../../session/inbox';
import { JobStore } from '../../../jobs/store';
import { assessPrivateReadEgress } from './private-read-egress-ask';

/**
 * Tools whose effects are reversible within the workspace (safe to run
 * unattended in bot mode): reads, in-workspace edits, lookups, planning,
 * coordination requests. Everything outside this allowlist is denied in bot
 * mode (fail-closed) — no ask prompt can reach a human who is not there.
 *
 * This list is intentionally separate from `#/tools/tool-catalog`: bot mode
 * answers "what is reversible unattended", not "what is read-only /
 * executable", so the two classifications must not be merged.
 */
const REVERSIBLE_TOOLS = new Set([
  'Read',
  'ReadGroup',
  'ReadMediaFile',
  'Glob',
  'Grep',
  // Structural search: read-only like Grep (AstEdit, its writing sibling,
  // stays out).
  'AstGrep',
  'WebSearch',
  'PaperSearch',
  'FetchURL',
  // Memory reads only. MemoryWrite / MemoryEdit / MemoryConsolidateApply are
  // left out on purpose: a memo is injected into every later session, so an
  // unattended write is the one "reversible" edit that persists an injected
  // instruction past this session with nobody there to notice.
  'MemoryLookup',
  'MemoryConsolidatePlan',
  'KnowledgeLookup',
  'TodoList',
  // Opening a deferred tool group declares tools and runs nothing; each tool
  // in it still passes this policy on its own. Without it, every allowlisted
  // tool that lives in a group (memory, knowledge, goal, cron lookups) could
  // never be reached unattended.
  'DiscoverTools',
  // Scheduling, including repeating tasks and follow-ups a fired turn sets
  // itself: bot mode exists to run without a person, so an agent that cannot
  // come back to its own work would defeat it. The user owns that trade-off by
  // choosing bot mode; tasks stay in the session, are deletable, recurring ones
  // expire after 7 days, and every fired turn runs under this same policy.
  'CronCreate',
  'CronList',
  'CronDelete',
  // Background tasks, for the same reason: standing work that must go on
  // without the person. What a task the agent makes may do is bounded by the
  // store (repeats at most every 15 minutes, at most 20 on, switched off after
  // 10 failed runs), and every run is bot mode again. Deleting is judged in
  // `decide`: only a task the agent made goes without the person.
  'JobCreate',
  'JobList',
  'TaskList',
  'TaskOutput',
  'ContactParent',
  'ReportFinding',
  'SendSubagentMessage',
  'Agent',
  'WolfPack',
  'CreateGoal',
  'GetGoal',
  'UpdateGoal',
  'WriteGoalNote',
  'Write',
  'Edit',
  'LSP',
  'InspectOwnAssets',
]);

/** Bash commands that only inspect state. The argument class excludes shell
 * metacharacters (`& | ; > < $ \` ( ) { } \\` and newlines) so command
 * substitution, backticks, chaining, redirection and newline injection cannot
 * ride along on an allowlisted head word. Mutable git subcommands
 * (branch/tag/config/remote/stash/symbolic-ref), `find` (-exec/-delete) and
 * `sort` (-o writes files) are intentionally absent. Word separators are
 * space/tab only: `\s` also matches a newline, so `ls\nrm -rf /` would otherwise
 * read as one allowlisted command with an argument. */
const READONLY_BASH =
  /^(git[ \t]+(status|diff|log|show|rev-parse|ls-files)\b|ls|cat|head|tail|grep|echo|pwd|which|wc|uniq|date|printf|tr|cut|jq|node[ \t]+(-v|--version)|python3?[ \t]+(-V|--version)|npm[ \t]+ls|pnpm[ \t]+ls)([ \t]+[^&|;<>$`(){}[\]\\\n]*)?$/;

/** Bash commands with consequences that cannot be safely undone unattended. */
const DANGEROUS_BASH =
  /\b(rm\s+-rf|git\s+push|git\s+reset\s+--hard|npm\s+(publish|unpublish|install\s+-g)|pnpm\s+(publish|add\s+-g)|yarn\s+(publish|global)|chmod|chown|sudo|kill\s+-9|pkill|curl\s+[^|]*\s+-o|wget\s+[^|]*\s+-O|dd\s+|mkfs|shutdown|reboot)\b/;

/** Test/build/lint commands: they reproduce a result from the workspace and are
 * the only non-read-only commands bot mode approves. The script head is pinned
 * to five names, so `pnpm run publish` or a free-form script cannot ride along
 * on the runner. Separators and arguments use the same space/tab-only class as
 * `READONLY_BASH`, so a newline, a metacharacter or shell substitution cannot
 * smuggle in a second command; `tsc -p` is limited to that class for the same
 * reason. */
const REVERSIBLE_BASH =
  /^(?:pnpm[ \t]+(?:test|lint|build|typecheck|check)|(?:npm|yarn)[ \t]+test|(?:pnpm|npm|yarn)[ \t]+run[ \t]+(?:test|lint|build|typecheck|check)(?::[a-z-]+)?|node[ \t]+--test|vitest[ \t]+run|tsc[ \t]+--noEmit(?:[ \t]+-p[ \t]+[^&|;<>$`(){}[\]\\\n]+)?|eslint|oxlint)(?:[ \t]+[^&|;<>$`(){}[\]\\\n]*)?$/;

/**
 * Bot mode (unattended): reversible actions auto-approve; everything else is
 * denied and parked — the loop must not block on a human who is absent.
 */
export class BotModePermissionPolicy implements PermissionPolicy {
  readonly name = 'bot-mode-permission';

  constructor(private readonly agent: Agent) {}

  private static readonly SENSITIVE_WRITE =
    /(^|[/\\])(\.env(\.|$)|.*\.(pem|key|p12)(\.|$)|credential|token|secret|authorized_keys|id_rsa|id_ed25519|bash_history|zsh_history)/i;

  /**
   * `.git` is a privilege boundary: anything under `.git/hooks` becomes code
   * that git executes later, outside every policy this file enforces. Matched
   * case-insensitively because macOS and Windows resolve `.GIT` to `.git`.
   */
  private static hasGitSegment(rawPath: string): boolean {
    return rawPath.split(/[/\\]+/).some((segment) => segment.toLowerCase() === '.git');
  }

  /**
   * Paths whose content runs *later, outside bot mode*: git hook managers,
   * CI definitions (which run with repository secrets), editor tasks, direnv.
   * A bot edit there is not reversible within the session — it executes when a
   * human commits, CI picks the branch up, or someone opens the folder.
   */
  private static readonly DEFERRED_EXEC_SEGMENTS = new Set([
    '.husky',
    '.githooks',
    '.github',
    '.gitlab',
    '.circleci',
    '.buildkite',
    '.vscode',
    '.idea',
    '.devcontainer',
  ]);

  private static readonly DEFERRED_EXEC_FILES = new Set([
    '.envrc',
    '.gitlab-ci.yml',
    '.pre-commit-config.yaml',
    '.lefthook.yml',
    'lefthook.yml',
    'azure-pipelines.yml',
    'jenkinsfile',
  ]);

  private static isDeferredExecPath(rawPath: string): boolean {
    const segments = rawPath
      .split(/[/\\]+/)
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.toLowerCase());
    const last = segments.at(-1);
    return (
      segments.some((segment) => BotModePermissionPolicy.DEFERRED_EXEC_SEGMENTS.has(segment)) ||
      (last !== undefined && BotModePermissionPolicy.DEFERRED_EXEC_FILES.has(last))
    );
  }

  private isAllowedWritePath(rawPath: string): boolean {
    if (rawPath.trim().length === 0) return false;
    // `~` expands to the user home in the Write tool — reject rather than
    // approximate, so a "looks workspace-relative" path cannot land outside.
    if (rawPath.startsWith('~')) return false;
    if (BotModePermissionPolicy.hasGitSegment(rawPath)) return false;
    const cwd = this.agent.config?.cwd ?? '.';
    // Judged on the part of the path BELOW the workspace: a project checked out
    // under e.g. `~/.vscode/extensions/…` or `~/.idea/…` must not have every
    // write refused because of where it lives.
    if (BotModePermissionPolicy.isDeferredExecPath(relative(cwd, resolve(cwd, rawPath)))) return false;
    // Absolute, drive-qualified (`C:\...`) and UNC paths are judged as
    // written; anything else is resolved against the workspace, on component
    // boundaries so `/work-evil` cannot pass as inside `/work`.
    if (!isPathInside(cwd, rawPath)) return false;
    // The final component decides the sensitive-file call, and appending the
    // workspace in front of a relative path never changes it.
    if (BotModePermissionPolicy.SENSITIVE_WRITE.test(basename(normalize(rawPath)))) return false;
    return true;
  }

  /**
   * Bot mode's decision, plus the inbox: an exact action the person approved
   * (once, or always) goes through; a refusal of the main agent is also put in
   * the "waiting for you" inbox — an action for approval, a question for an
   * answer — and the model is told so, and to carry on with the rest.
   */
  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'bot') return;
    const tool = context.toolCall.name;
    const home = this.agent.screamHomeDir;
    const result = this.decide(context);
    // What the person approved only matters for an action bot mode would
    // refuse, so the approval files are read for refusals alone, not on the
    // many calls that pass anyway.
    if (result?.kind !== 'deny') return result;
    const key = actionKey(tool, context.args);
    if (tool !== 'AskUserQuestion' && this.approvedByPerson(key, tool, context.args, home)) {
      return { kind: 'approve', reason: { reason: 'bot: approved by the person' } };
    }
    const sessionId = this.agent.sessionId;
    if (home === undefined || sessionId === undefined || this.agent.type !== 'main') {
      return result;
    }
    const workDir = this.agent.config?.cwd ?? '.';
    try {
      if (tool === 'AskUserQuestion') {
        const questions = (context.args as { questions?: { question?: unknown; options?: { label?: unknown }[] }[] } | undefined)
          ?.questions;
        const text = (value: unknown): string => (typeof value === 'string' ? value : '');
        const item = addQuestionItem(home, {
          sessionId,
          workDir,
          items: (questions ?? []).map((q) => ({
            question: text(q.question),
            options: (q.options ?? []).map((o) => text(o.label)),
          })),
        });
        return {
          ...result,
          message:
            `Nobody is here to answer right now, so your question was sent to the person (inbox ${item.id}). ` +
            'Do not wait for it: decide what you safely can, carry on with the rest, and list what depends on the answer. ' +
            'Their answer arrives later as a message in this session.',
        };
      }
      const item = addApprovalItem(home, {
        sessionId,
        workDir,
        tool,
        action: describeAction(tool, context.args),
        key,
        alwaysKey: alwaysActionKey(tool, context.args),
        reason: String(result.reason?.['reason'] ?? 'bot mode'),
      });
      return {
        ...result,
        message:
          `Refused in bot mode (${String(result.reason?.['reason'] ?? 'not reversible')}). It is waiting for the person's approval (inbox ${item.id}). ` +
          'Do not retry it now and do not work around it: carry on with the rest of the work and list it in your final report. ' +
          'If they approve, you will be asked to do exactly this again, and it will be allowed once.',
      };
    } catch {
      // The inbox is a convenience; a refusal must never fail over it.
      return result;
    }
  }

  /** Approved once (in memory), always (exact or general key), or for this session. */
  private approvedByPerson(key: string, tool: string, args: unknown, home: string | undefined): boolean {
    if (this.agent.permission.consumeOneShotApproval(key)) return true;
    if (home === undefined) return false;
    const always = readApprovedActions(home);
    if (always.has(key) || always.has(alwaysActionKey(tool, args))) return true;
    const sessionId = this.agent.sessionId;
    return sessionId !== undefined && readSessionApprovedActions(home, sessionId).has(key);
  }

  private decide(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const tool = context.toolCall.name;
    if (tool === 'Bash') {
      const command = (context.args as { command?: string } | undefined)?.command ?? '';
      // Irreversible first: an allowlisted head word must never outrank a
      // destructive payload in the same simple command.
      if (DANGEROUS_BASH.test(command)) {
        return { kind: 'deny', reason: { reason: 'bot: irreversible command, needs the person' } };
      }
      if (READONLY_BASH.test(command)) {
        return { kind: 'approve', reason: { reason: 'bot: read-only command' } };
      }
      if (REVERSIBLE_BASH.test(command)) {
        return { kind: 'approve', reason: { reason: 'bot: reversible test/build command' } };
      }
      return { kind: 'deny', reason: { reason: 'bot: command not in the reversible allowlist' } };
    }
    if (tool === 'Write' || tool === 'Edit') {
      const path = (context.args as { path?: string } | undefined)?.path ?? '';
      if (!this.isAllowedWritePath(path)) {
        return {
          kind: 'deny',
          reason: {
            reason: `bot: write to '${path}' is outside the workspace, targets a sensitive file, or lands where code runs later (git hooks, CI, editor tasks)`,
          },
        };
      }
      return { kind: 'approve', reason: { reason: 'bot: in-workspace reversible edit' } };
    }
    if (tool === 'JobDelete') {
      // A task the agent made may go again unattended; one the person set up
      // in /jobs is theirs, and its runs and notes cannot be brought back, so
      // deleting it waits for their approval (refused here, so it lands in
      // the inbox like any other refusal).
      const id = (context.args as { id?: unknown } | undefined)?.id;
      const home = this.agent.screamHomeDir;
      const job = typeof id === 'string' && home !== undefined ? new JobStore(home).get(id) : undefined;
      if (job === undefined || job.createdBy === 'agent') {
        return { kind: 'approve', reason: { reason: 'bot: deleting a task the agent made' } };
      }
      return { kind: 'deny', reason: { reason: 'bot: deleting a task the person set up needs their approval' } };
    }
    if (tool === 'AskUserQuestion') {
      // Nobody is there to answer: a question would hold the run until someone
      // came back (the terminal UI waits on its dialog indefinitely). Bot mode
      // exists to keep going, so the agent decides and moves on.
      return {
        kind: 'deny',
        reason: { reason: 'bot: unattended, nobody to answer' },
        message:
          'AskUserQuestion is unavailable in bot mode: nobody is here to answer. Decide yourself — ' +
          'pick the safest reasonable option, note the assumption, and keep working. If something truly ' +
          'only the user can settle, skip that part, finish the rest, and list it in your final report.',
      };
    }
    if (REVERSIBLE_TOOLS.has(tool)) {
      // Unattended mode must not let private-read data leave the machine: no
      // prompt can reach a human here, so a hit is parked (deny) instead of
      // waiting on the approval timeout. The egress guard is shared with the
      // ask policy so both paths agree on what counts as egress.
      if (assessPrivateReadEgress(this.agent, context) !== undefined) {
        return {
          kind: 'deny',
          reason: { reason: 'bot: egress after private read blocked (unattended)' },
        };
      }
      return { kind: 'approve', reason: { reason: 'bot: reversible tool' } };
    }
    return { kind: 'deny', reason: { reason: `bot: tool '${tool}' not in the reversible allowlist` } };
  }
}

/** One line saying what the action is, for the person reading the inbox. */
function describeAction(tool: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  if (tool === 'Bash' && typeof record['command'] === 'string') return record['command'];
  if ((tool === 'Write' || tool === 'Edit') && typeof record['path'] === 'string') return `${tool} ${record['path']}`;
  const json = JSON.stringify(args) ?? '';
  return `${tool} ${json.length > 300 ? `${json.slice(0, 300)}…` : json}`;
}
