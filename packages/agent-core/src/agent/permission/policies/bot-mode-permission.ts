import { basename, join, normalize, sep } from 'node:path';
import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Tools whose effects are reversible within the workspace (safe to run
 * unattended in bot mode): reads, in-workspace edits, lookups, planning,
 * coordination requests. Everything outside this allowlist is denied in bot
 * mode (fail-closed) — no ask prompt can reach a human who is not there.
 */
const REVERSIBLE_TOOLS = new Set([
  'Read',
  'ReadGroup',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
  'MemoryLookup',
  'MemoryWrite',
  'MemoryEdit',
  'MemoryConsolidatePlan',
  'MemoryConsolidateApply',
  'KnowledgeLookup',
  'TodoList',
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
  'CronCreate',
  'CronList',
  'CronDelete',
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
 * `sort` (-o writes files) are intentionally absent. */
const READONLY_BASH =
  /^(git\s+(status|diff|log|show|rev-parse|ls-files)\b|ls|cat|head|tail|grep|echo|pwd|which|wc|uniq|date|printf|tr|cut|jq|node\s+(-v|--version)|python3?\s+(-V|--version)|npm\s+ls|pnpm\s+ls)(\s+[^&|;<>$`(){}[\]\\\n]*)?$/;

/** Bash commands with consequences that cannot be safely undone unattended. */
const DANGEROUS_BASH =
  /\b(rm\s+-rf|git\s+push|git\s+reset\s+--hard|npm\s+(publish|unpublish|install\s+-g)|pnpm\s+(publish|add\s+-g)|yarn\s+(publish|global)|chmod|chown|sudo|kill\s+-9|pkill|curl\s+[^|]*\s+-o|wget\s+[^|]*\s+-O|dd\s+|mkfs|shutdown|reboot)\b/;

/**
 * Bot mode (unattended): reversible actions auto-approve; everything else is
 * denied and parked — the loop must not block on a human who is absent.
 */
export class BotModePermissionPolicy implements PermissionPolicy {
  readonly name = 'bot-mode-permission';

  constructor(private readonly agent: Agent) {}

  private static readonly SENSITIVE_WRITE =
    /(^|[/\\])(\.env(\.|$)|.*\.(pem|key|p12)(\.|$)|credential|token|secret|authorized_keys|id_rsa|id_ed25519|bash_history|zsh_history)/i;

  private isAllowedWritePath(rawPath: string): boolean {
    if (rawPath.trim().length === 0) return false;
    // `~` expands to the user home in the Write tool — reject rather than
    // approximate, so a "looks workspace-relative" path cannot land outside.
    if (rawPath.startsWith('~')) return false;
    const cwd = this.agent.config?.cwd ?? '.';
    const resolved = rawPath.startsWith('/') ? rawPath : join(cwd, rawPath);
    const norm = normalize(resolved);
    const normCwd = normalize(cwd);
    // Separator boundary: `/work-evil` must not pass as inside `/work`.
    if (norm !== normCwd && !norm.startsWith(normCwd.endsWith(sep) ? normCwd : normCwd + sep)) {
      return false;
    }
    if (BotModePermissionPolicy.SENSITIVE_WRITE.test(basename(norm))) return false;
    return true;
  }

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'bot') return;
    const tool = context.toolCall.name;
    if (tool === 'Bash') {
      const command = (context.args as { command?: string } | undefined)?.command ?? '';
      if (READONLY_BASH.test(command)) {
        return { kind: 'approve', reason: { reason: 'bot: read-only command' } };
      }
      if (DANGEROUS_BASH.test(command)) {
        return { kind: 'deny', reason: { reason: 'bot: irreversible command parked for human review' } };
      }
      return { kind: 'deny', reason: { reason: 'bot: command not in the reversible allowlist' } };
    }
    if (tool === 'Write' || tool === 'Edit') {
      const path = (context.args as { path?: string } | undefined)?.path ?? '';
      if (!this.isAllowedWritePath(path)) {
        return {
          kind: 'deny',
          reason: { reason: `bot: write to '${path}' is outside the workspace or targets a sensitive file` },
        };
      }
      return { kind: 'approve', reason: { reason: 'bot: in-workspace reversible edit' } };
    }
    if (REVERSIBLE_TOOLS.has(tool)) {
      return { kind: 'approve', reason: { reason: 'bot: reversible tool' } };
    }
    return { kind: 'deny', reason: { reason: `bot: tool '${tool}' not in the reversible allowlist` } };
  }
}
