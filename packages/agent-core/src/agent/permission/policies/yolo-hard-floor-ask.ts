import * as os from 'node:os';
import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { Agent } from '../..';
import type { PathClass } from '../../../tools/policies/path-access';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { writeFileAccesses } from './file-access-ask';
import { assessPrivateReadEgress } from './private-read-egress-ask';

type PersistenceKind = 'git_control_write' | 'shell_rc_write' | 'startup_persistence_write';

// ---------------------------------------------------------------------------
// Persistence targets as FILE paths (Write / Edit / NotebookEdit accesses)
// ---------------------------------------------------------------------------

/** Home-relative shell startup files: code every future shell runs. */
const HOME_SHELL_FILES: readonly string[] = [
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.config/fish/config.fish',
];
const HOME_SHELL_DIRS: readonly string[] = ['.config/fish/conf.d'];

/** User-level git config: hooks path, pager, editor, ssh command, credential helper … all run as code. */
const HOME_GIT_FILES: readonly string[] = ['.gitconfig', '.config/git/config'];

/**
 * Other places a write keeps running after the session: ssh login hooks and
 * keys, and per-user launch / autostart entries.
 */
const HOME_STARTUP_FILES: readonly string[] = [
  '.ssh/authorized_keys',
  '.ssh/authorized_keys2',
  '.ssh/rc',
  '.ssh/config',
  '.ssh/environment',
];
const HOME_STARTUP_DIRS: readonly string[] = [
  'Library/LaunchAgents',
  '.config/systemd/user',
  '.config/autostart',
];
const SYSTEM_STARTUP_DIRS: readonly string[] = ['/Library/LaunchAgents', '/Library/LaunchDaemons'];

// ---------------------------------------------------------------------------
// Persistence targets as Bash TEXT (Bash reports no structured file accesses)
// ---------------------------------------------------------------------------

/**
 * Mentions that mark git control data: hook and config files, and the config
 * keys whose value git later runs as a command (`core.hooksPath`,
 * `core.fsmonitor`, `core.pager`, `core.sshCommand`, `core.editor`,
 * `credential.helper`, `diff.external`, filter/merge drivers, `!` aliases).
 */
const GIT_CONTROL_MENTION =
  /(?:\.git[\\/]+(?:hooks|config)\b|(?:^|[\s'"=/~])\.gitconfig\b|\.config[\\/]+git[\\/]+config\b|\bcore\.(?:hooksPath|fsmonitor|pager|sshCommand|editor|askPass)\b|\bcredential\.helper\b|\bdiff\.external\b|\bgpg\.program\b|\bsequence\.editor\b|\b(?:filter|merge|diff)\.[\w-]+\.(?:clean|smudge|process|driver|textconv|command)\b|\balias\.[\w-]+\s+['"]?!)/i;

const SHELL_RC_MENTION =
  /(?:(?:^|[\s'"=/~])\.(?:bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zshenv|zprofile|zlogin|zlogout)\b|fish[\\/]+(?:config\.fish|conf\.d\b))/i;

const STARTUP_MENTION =
  /(?:\bauthorized_keys2?\b|\.ssh[\\/]+(?:rc|config|environment)\b|Library[\\/]+Launch(?:Agents|Daemons)\b|systemd[\\/]+user\b|\.config[\\/]+autostart\b|\bcrontab\b|\blaunchctl\s+(?:load|bootstrap|submit)\b)/i;

const BASH_TARGETS: ReadonlyArray<{ kind: PersistenceKind; mention: RegExp }> = [
  { kind: 'git_control_write', mention: GIT_CONTROL_MENTION },
  { kind: 'shell_rc_write', mention: SHELL_RC_MENTION },
  { kind: 'startup_persistence_write', mention: STARTUP_MENTION },
];

/**
 * Redirects that write nowhere: stderr merges (`2>&1`, `>&2`) and anything sent
 * to /dev/null. Agents append them to read-only commands all the time
 * (`cat ~/.zshrc 2>/dev/null`), and they must not count as writes.
 */
const BENIGN_REDIRECT = /\d*>&\d+|&?\d*>>?\s*\/dev\/null\b/g;

// ---------------------------------------------------------------------------
// "Is this Bash command clearly a read?"
//
// The floor used to ask only when it recognised a WRITE verb (`tee`, `cp`,
// `sed -i` …). That list can never be complete — `curl -o ~/.zshrc`,
// `wget -O`, `python -c`, `awk -i inplace` all slipped through. So it is turned
// around: a command that mentions a persistence target passes only when every
// segment is a command known to read. Anything else asks, so a writer nobody
// thought of is stopped by default. The mention gate keeps this rare: it
// applies only to commands that name a hook, a git config key, a startup file …
// ---------------------------------------------------------------------------

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'cat', 'tac', 'nl', 'less', 'more', 'head', 'tail', 'bat',
  'ls', 'll', 'la', 'dir', 'tree', 'stat', 'file', 'du', 'df',
  'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'diff', 'cmp', 'comm', 'cut', 'tr', 'jq', 'strings', 'hexdump', 'od',
  'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum',
  'echo', 'printf', 'test', '[', '[[',
  'realpath', 'readlink', 'basename', 'dirname',
  'which', 'type', 'whereis', 'pwd', 'cd', 'true', 'false',
  'source', '.',
]);

/** Prefixes that run the next word: `sudo cat x`, `FOO=1 cat x`, `env cat x`. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'sudo', 'env', 'command', 'builtin', 'time', 'nice', 'nohup',
]);

/** `find` writes through these actions. */
const FIND_WRITES = /\s-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)\b/;

const QUOTED_OR_WORD = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;

/**
 * Options git accepts between `git` and the subcommand: `-C dir`, `-c k=v`,
 * `--git-dir=…` / `--git-dir …`, valueless flags such as `--no-pager`.
 * `git -C repo config …` is how agents usually spell it, and an exact
 * `git config` match used to wave it through.
 */
const GIT_GLOBAL_OPTION =
  String.raw`(?:-[Cc]\s+${QUOTED_OR_WORD}|--(?:git-dir|work-tree|namespace|super-prefix|config-env|exec-path)(?:=|\s+)${QUOTED_OR_WORD}|--[A-Za-z][\w-]*(?:=${QUOTED_OR_WORD})?|-[pPh])`;
const GIT_CONFIG = new RegExp(String.raw`\bgit(?:\s+${GIT_GLOBAL_OPTION})*\s+config\b`);
const GIT_READ_SUBCOMMAND = new RegExp(
  String.raw`\bgit(?:\s+${GIT_GLOBAL_OPTION})*\s+(?:status|log|diff|show|ls-files|rev-parse|check-ignore|blame|grep|cat-file|ls-tree|describe|rev-list|shortlog|var|add|commit)\b`,
);
const GIT_CONFIG_READ =
  /\s(?:--get(?:-all|-regexp|-urlmatch|-color(?:bool)?)?|--list|-l|--show-origin|--show-scope)\b/;

/** `crontab -l` only prints; every other form installs or removes a table. */
const CRONTAB_READ = /\s-l\b/;

function commandBase(token: string): string {
  const unquoted = token.replaceAll(/^["']|["']$/g, '');
  return unquoted.slice(unquoted.lastIndexOf('/') + 1);
}

function isReadOnlySegment(segment: string): boolean {
  const text = segment.trim();
  if (text === '') return true;
  // A nested command (`$(…)`, backticks, `<(…)`) can write whatever the outer
  // word looks like it does.
  if (/\$\(|`|[<>]\(/.test(text)) return false;

  const tokens = text.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i += 1;
      continue;
    }
    if (COMMAND_WRAPPERS.has(commandBase(token))) {
      i += 1;
      while ((tokens[i] ?? '').startsWith('-')) i += 1;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return true; // only assignments: nothing runs

  const command = commandBase(tokens[i] ?? '');
  if (command === 'git') {
    return (
      GIT_READ_SUBCOMMAND.test(text) || (GIT_CONFIG.test(text) && GIT_CONFIG_READ.test(text))
    );
  }
  if (command === 'crontab') return CRONTAB_READ.test(text);
  if (command === 'find') return !FIND_WRITES.test(text);
  return READ_ONLY_COMMANDS.has(command);
}

/**
 * Whether a command that names a persistence target may write it: any
 * redirect that is not a no-op, or any segment that is not clearly a read.
 * Judged per segment, so `git config --list; git config core.hooksPath ./evil`
 * is not waved through on the strength of its first half.
 */
function mayWritePersistenceTarget(command: string): boolean {
  const effective = command.replaceAll(BENIGN_REDIRECT, ' ');
  if (effective.includes('>')) return true;
  return effective.split(/[;&|\n]+/).some((segment) => !isReadOnlySegment(segment));
}

/**
 * The yolo hard floor: the few operations that still ask in yolo, the
 * startup-default mode, because their damage outlives the session and an
 * injected instruction (from a fetched page, an MCP result, a file) is
 * enough to trigger them:
 *
 * - **private-read egress** — the session read data from outside the
 *   workspace, and this call sends to a host outside the egress allowlist
 *   (same assessment, allowlist and session grant as
 *   `private-read-egress-ask`);
 * - **git control writes** — any write under a `.git` directory or to the
 *   user-level git config, or a Bash command that may write hooks or a git
 *   config key git later runs as a command;
 * - **shell startup files** — `~/.zshrc`, `~/.bashrc`, `~/.bash_logout`, fish
 *   `conf.d` and friends;
 * - **other startup persistence** — `~/.ssh/authorized_keys` / `rc` / `config`,
 *   LaunchAgents / LaunchDaemons, systemd user units, autostart entries, and
 *   installing a crontab.
 *
 * The Bash side is a best-effort text heuristic (Bash reports no structured
 * file accesses, and a path can be assembled at run time); it errs towards
 * asking, never towards approving an unrecognised command.
 *
 * Order invariant: this policy MUST sit directly above `yolo-mode-approve`
 * (the chain is first-match-wins) — below it, yolo would approve first. It is
 * inert outside yolo: ask/bot deny these calls already, auto is a
 * blanket-approve contract by definition.
 *
 * Persistence asks offer `once` only: they are rare, and a session grant
 * would not be consulted here anyway (session history sits below yolo).
 */
export class YoloHardFloorAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'yolo-hard-floor-ask';

  constructor(
    private readonly agent: Agent,
    private readonly homeDir: () => string = os.homedir,
  ) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'yolo') return;

    const egress = assessPrivateReadEgress(this.agent, context);
    if (egress !== undefined) {
      return {
        kind: 'ask',
        reason: { yolo_hard_floor: 'private_read_egress', target_known: egress.targetKnown },
        reasons: [egress.reason],
        grantOptions: ['once', 'session'],
      };
    }

    const persistence = this.persistenceTarget(context);
    if (persistence !== undefined) {
      return {
        kind: 'ask',
        reason: { yolo_hard_floor: persistence.kind },
        reasons: [persistence.reason],
        grantOptions: ['once'],
      };
    }
    return undefined;
  }

  private persistenceTarget(
    context: PermissionPolicyContext,
  ): { kind: PersistenceKind; reason: string } | undefined {
    if (context.toolCall.name === 'Bash') {
      const command = (context.args as { command?: unknown } | undefined)?.command;
      if (typeof command !== 'string') return undefined;
      for (const { kind, mention } of BASH_TARGETS) {
        const match = mention.exec(command);
        if (match === null || !mayWritePersistenceTarget(command)) continue;
        return { kind, reason: persistenceReason(kind, match[0].trim(), true) };
      }
      return undefined;
    }

    const pathClass = this.agent.jian.pathClass();
    for (const access of writeFileAccesses(context)) {
      const kind = this.persistenceKindForPath(access.path, pathClass);
      if (kind !== undefined) {
        return { kind, reason: persistenceReason(kind, access.path, false) };
      }
    }
    return undefined;
  }

  private persistenceKindForPath(target: string, pathClass: PathClass): PersistenceKind | undefined {
    if (hasGitSegment(target)) return 'git_control_write';

    const caseFold = pathClass === 'win32' || process.platform === 'darwin';
    const fold = (value: string): string => (caseFold ? value.toLowerCase() : value);

    const relative = this.homeRelative(target, pathClass);
    if (relative !== undefined) {
      const rel = fold(relative);
      if (matchesPath(rel, HOME_GIT_FILES, [], fold)) return 'git_control_write';
      if (matchesPath(rel, HOME_SHELL_FILES, HOME_SHELL_DIRS, fold)) return 'shell_rc_write';
      if (matchesPath(rel, HOME_STARTUP_FILES, HOME_STARTUP_DIRS, fold)) {
        return 'startup_persistence_write';
      }
    }
    if (pathClass !== 'win32') {
      const normalized = fold(posixPath.normalize(target));
      if (matchesPath(normalized, [], SYSTEM_STARTUP_DIRS, fold)) return 'startup_persistence_write';
    }
    return undefined;
  }

  /** `target` relative to the home directory, `/`-separated; undefined when outside it. */
  private homeRelative(target: string, pathClass: PathClass): string | undefined {
    const home = this.homeDir();
    if (home.length === 0) return undefined;
    const mod = pathClass === 'win32' ? win32Path : posixPath;
    const relative = mod.relative(home, target);
    if (relative === '' || mod.isAbsolute(relative)) return undefined;
    const segments = relative.split(/[\\/]+/);
    if (segments[0] === '..') return undefined;
    return segments.join('/');
  }
}

function matchesPath(
  target: string,
  files: readonly string[],
  dirs: readonly string[],
  fold: (value: string) => string,
): boolean {
  return (
    files.some((file) => target === fold(file)) ||
    dirs.some((dir) => target.startsWith(`${fold(dir)}/`))
  );
}

/** Case-insensitive: macOS and Windows resolve `.GIT` to `.git`. */
function hasGitSegment(target: string): boolean {
  return target.split(/[\\/]+/).some((segment) => segment.toLowerCase() === '.git');
}

function persistenceReason(kind: PersistenceKind, target: string, heuristic: boolean): string {
  const verb = heuristic ? 'May write' : 'Writes';
  switch (kind) {
    case 'git_control_write': {
      return (
        `${verb} git control data (${target}). Git hooks and config run as code on later git ` +
        'commands, outside this session — confirm even in yolo mode.'
      );
    }
    case 'shell_rc_write': {
      return (
        `${verb} a shell startup file (${target}). It runs in every future shell — confirm even ` +
        'in yolo mode.'
      );
    }
    case 'startup_persistence_write': {
      return (
        `${verb} an entry that keeps running or grants access after this session (${target}) — ` +
        'ssh keys and hooks, launch agents, systemd units, autostart or a crontab. Confirm even ' +
        'in yolo mode.'
      );
    }
  }
}
