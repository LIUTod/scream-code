import type { Agent } from '../..';
import { matchPermissionRule } from '../matches-rule';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Hosts that may receive data even after the session read private data from
 * outside the workspace. Merged (union) with the user's configured
 * `permission.egressAllowlist`.
 */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'wikipedia.org',
  'localhost',
  '127.0.0.1',
  '[::1]',
];

export interface PrivateReadEgressAssessment {
  /** Reason to surface on the approval prompt or the deny record. */
  readonly reason: string;
  /** False when no destination could be recognized in the call. */
  readonly targetKnown: boolean;
}

/**
 * Shared guard condition: returns an assessment when this call would move
 * private-read data to a destination that is not allowlisted, undefined when
 * the call is clean (or not an egress call at all).
 *
 * Two callers keep the same semantics:
 * - `PrivateReadEgressAskPermissionPolicy` — prompt the user (once or
 *   session), even in auto/yolo mode;
 * - bot mode — deny instead, because no human is there to answer a prompt.
 *
 * Fail-closed details:
 * - a candidate private read that has not settled yet counts as taint: every
 *   call in one tool batch is authorized before any result is finalized, so
 *   a same-batch `[Read /tmp/secret, Bash(curl …)]` must not slip through;
 * - every destination found in the call must be allowlisted — one unknown
 *   host in a command is enough to ask;
 * - a command whose destination cannot be extracted counts as unrecognized,
 *   never as allowlisted.
 */
export function assessPrivateReadEgress(
  agent: Agent,
  context: PermissionPolicyContext,
): PrivateReadEgressAssessment | undefined {
  const permission = agent.permission;
  if (permission.taintedPrivateReads.length === 0 && !permission.hasPendingPrivateReads()) {
    return undefined;
  }
  const hosts = egressHosts(context);
  if (hosts === undefined) return undefined;
  if (hasMatchingSessionGrant(agent, context)) return undefined;
  if (hosts.length === 0) {
    return { reason: egressReason(undefined), targetKnown: false };
  }
  const allowlist = egressAllowlist(agent);
  const blocked = hosts.find((host) => !isAllowedEgressHost(host, allowlist));
  if (blocked === undefined) return undefined;
  return { reason: egressReason(blocked), targetKnown: true };
}

/**
 * Once the session has successfully read data from outside the workspace,
 * sending anything to a host outside the allowlist asks first — the data may
 * have come from a private file, and an unrecognized destination cannot be
 * assumed safe.
 *
 * The chain position is the mechanism (see `createPermissionDecisionPolicies`):
 * the policy sits after `collaboration-auto-approve` and before
 * `auto-mode-approve`, so it fires even in unattended auto mode; the allowlist,
 * not the chain, is what keeps ordinary auto-mode work quiet. It sits before
 * `session-approval-history` as well, so only a memorized grant that matches
 * this exact call can silence it.
 *
 * Egress detection is deliberately narrow (MVP): `FetchURL` and the shell
 * download/remote verbs in `Bash`. Known blind spots, kept here so the next
 * batch starts from the list: egress through python, RunScript or MCP tools;
 * shell reads without a read verb or without an absolute path — `cd / && cat
 * .env`, `curl -d @file`, `-T`, `dd`; `WebSearch`/`PaperSearch` are not judged
 * as egress either, so a tainted session still reaches the network through
 * them (consistent with the allowlist being about hosts, registered as an
 * observation); and encoding tricks that hide a host or a path from the
 * command text.
 */
export class PrivateReadEgressAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'private-read-egress-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const assessment = assessPrivateReadEgress(this.agent, context);
    if (assessment === undefined) return;
    return {
      kind: 'ask',
      reason: {
        private_read_egress: true,
        target_known: assessment.targetKnown,
      },
      reasons: [assessment.reason],
      grantOptions: ['once', 'session'],
    };
  }
}

/** Built-in hosts plus the configured ones; configuration only widens. */
function egressAllowlist(agent: Agent): readonly string[] {
  const configured = agent.screamConfig?.permission?.egressAllowlist;
  if (configured === undefined || configured.length === 0) return DEFAULT_EGRESS_ALLOWLIST;
  return [...DEFAULT_EGRESS_ALLOWLIST, ...configured];
}

/** A memorized approve-for-session grant that matches this call wins. */
function hasMatchingSessionGrant(agent: Agent, context: PermissionPolicyContext): boolean {
  return agent.permission.sessionApprovalRulePatterns.some(
    (pattern) =>
      matchPermissionRule({
        rule: {
          decision: 'allow',
          scope: 'session-runtime',
          pattern,
          reason: 'approve for session',
        },
        toolName: context.toolCall.name,
        execution: context.execution,
      }) !== undefined,
  );
}

/**
 * Destinations this call sends to, or undefined when the call is not egress:
 *
 * - `FetchURL` — the URL argument; an unparsable URL yields no destination
 *   (unrecognized).
 * - `Bash` — a download/remote verb (curl, wget, nc, netcat, ssh, scp,
 *   rsync, telnet) marks the call as egress; every host the command spells
 *   out is collected, so a second URL cannot hide behind an allowlisted one.
 */
function egressHosts(context: PermissionPolicyContext): string[] | undefined {
  if (context.toolCall.name === 'FetchURL') {
    const url = (context.args as { url?: unknown } | undefined)?.url;
    if (typeof url !== 'string') return undefined;
    const host = hostFromUrl(url);
    return host === undefined ? [] : [host];
  }
  if (context.toolCall.name === 'Bash') {
    const command = (context.args as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') return undefined;
    if (!EGRESS_COMMAND_PATTERN.test(command)) return undefined;
    return hostsFromCommand(command);
  }
  return undefined;
}

/**
 * Shell download/remote verbs. Shared with the private-read taint scan
 * (`permission/index.ts`): an egress command reads local files through upload
 * flags (`-d @file`, `-T`) without any read verb, so it must not be filtered
 * out by that scan's read-verb gate.
 */
export const EGRESS_COMMAND_PATTERN = /\b(curl|wget|nc|netcat|ssh(?!-)|scp|rsync|telnet)\b/;

/**
 * Authority of a URL. The character class stops at `/`, `#`, `?`, quotes,
 * backticks and whitespace, so a fragment or a path cannot extend the
 * authority into a different host.
 */
const URL_AUTHORITY = /https?:\/\/([^\s/'"`#?]+)/gi;

/** `user@host` (ssh/scp style). */
const USER_HOST = /[\w.-]+@([A-Za-z0-9][A-Za-z0-9.-]*)/g;

/** `host:path` remote targets (scp/rsync style). */
const HOST_PATH = /(?:^|\s)([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}):\S/g;

function hostsFromCommand(command: string): string[] {
  // Only hosts are ever surfaced: credentials, ports, paths and query
  // strings stay out of the reason text.
  const hosts = new Set<string>();
  for (const match of command.matchAll(URL_AUTHORITY)) {
    const host = hostFromAuthority(match[1] ?? '');
    if (host !== undefined) hosts.add(host);
  }
  for (const match of command.matchAll(USER_HOST)) {
    const host = match[1]?.toLowerCase();
    if (host !== undefined && host.length > 0) hosts.add(host);
  }
  for (const match of command.matchAll(HOST_PATH)) {
    const host = match[1]?.toLowerCase();
    if (host !== undefined && host.length > 0) hosts.add(host);
  }
  return [...hosts];
}

function hostFromUrl(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.length > 0 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function hostFromAuthority(authority: string): string | undefined {
  // Userinfo ends at the first `@`; a later `@` is part of the authority and
  // must not be treated as the credential separator.
  const withoutUser = authority.slice(authority.indexOf('@') + 1);
  if (withoutUser.startsWith('[')) {
    const end = withoutUser.indexOf(']');
    return end === -1 ? undefined : withoutUser.slice(0, end + 1).toLowerCase();
  }
  const host = withoutUser.split(':')[0]?.toLowerCase();
  return host !== undefined && host.length > 0 ? host : undefined;
}

/**
 * Case-insensitive exact match; a `*.` entry also covers its apex
 * (`*.example.com` matches `example.com` and `a.example.com`).
 */
function isAllowedEgressHost(host: string, allowlist: readonly string[]): boolean {
  const normalized = host.toLowerCase();
  return allowlist.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (candidate.length === 0) return false;
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(2);
      return normalized === suffix || normalized.endsWith(`.${suffix}`);
    }
    return normalized === candidate;
  });
}

function egressReason(host: string | undefined): string {
  const destination = host ?? 'an unrecognized destination';
  return `private data was read outside the workspace in this session; sending it to ${destination} needs your confirmation`;
}
