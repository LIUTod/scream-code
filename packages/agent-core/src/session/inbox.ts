/**
 * The "waiting for you" inbox: what unattended work could not decide alone.
 *
 * In bot mode nobody is there to approve an irreversible action or to answer
 * a question. Instead of only refusing (and hoping the final report is read),
 * the refusal also lands here — `<home>/host/inbox/<id>.json` — and the
 * background host pushes it to the person's chat. They answer from the phone
 * or the terminal:
 *
 * - approve once: the run is told to do it now, and permission lets exactly
 *   that action through once (see {@link actionKey});
 * - allow for this session: the same, and the exact action goes through for
 *   the rest of that session (`session-approvals.json`);
 * - always allow: the same, and the exact action is remembered for unattended
 *   runs from now on (`approved-actions.json`);
 * - reject: the run is told not to;
 * - "I did it myself": for what only the person can do (a password, a second
 *   factor, a payment) — the run is told it is done;
 * - an answer, for a question;
 * - save or drop, for memories an unattended run wants to keep: they stay out
 *   of every later session until the person saves them.
 *
 * Nothing waits meanwhile: the run carries on with the rest. An item nobody
 * answers within 24 hours expires and is reported in the daily brief.
 *
 * One file per item; the core writes new items, the host and the person's
 * answers update them, each by atomic rename.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sharedMemoStore, type MemoryMemo } from '@scream-code/memory';

export const INBOX_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** Memories to save are not pushed anywhere, so they wait longer: a week. */
export const MEMORY_ITEM_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export type InboxDecision = 'approve' | 'session' | 'always' | 'reject' | 'did-it' | 'answer';

export interface InboxItem {
  readonly id: string;
  readonly kind: 'approval' | 'question' | 'memory';
  readonly sessionId: string;
  readonly workDir: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: 'pending' | 'decided' | 'delivered' | 'expired';
  /** Approval: the tool, a one-line description of the action, the exact key, why it was stopped. */
  readonly approval?: {
    readonly tool: string;
    readonly action: string;
    readonly key: string;
    /** What "always allow" remembers (see `alwaysActionKey`); the exact key when absent. */
    readonly alwaysKey?: string;
    readonly reason: string;
  };
  /** Memory: what an unattended run learned, kept here until the person saves it. */
  readonly memories?: readonly MemoryMemo[];
  /** Question: the question texts and their option labels. */
  readonly question?: { readonly items: readonly { readonly question: string; readonly options: readonly string[] }[] };
  readonly decision?: InboxDecision;
  readonly answer?: string;
  readonly decidedAt?: number;
  /** Whether the person was told about it (pushed to the chat). */
  readonly notified?: boolean;
  /** The chat it was pushed to: only a reply there can answer it. */
  readonly notifiedTo?: string;
  /** Whether the host has seen it (logged it, raised a system notification). */
  readonly announced?: boolean;
}

export function inboxDir(screamHomeDir: string): string {
  return join(screamHomeDir, 'host', 'inbox');
}

function itemPath(screamHomeDir: string, id: string): string {
  return join(inboxDir(screamHomeDir), `${id}.json`);
}

function writeItem(screamHomeDir: string, item: InboxItem): void {
  mkdirSync(inboxDir(screamHomeDir), { recursive: true });
  const path = itemPath(screamHomeDir, item.id);
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(item, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * The identity of one exact action: the tool and its arguments, key order
 * ignored. An approval reaches only the action it was given for — a
 * different command, path or argument is a different key.
 */
export function actionKey(tool: string, args: unknown): string {
  return createHash('sha256').update(`${tool}\0${stableJson(args)}`).digest('hex').slice(0, 32);
}

/**
 * The key "always allow" remembers. Usually the exact action; but a branch a
 * background job made (`scream/<job>/<date-time>`) has a new name every run,
 * so "always allow `git push origin scream/…`" would never match again. Such
 * names count as one: `scream/*`.
 */
export function alwaysActionKey(tool: string, args: unknown): string {
  const command = (args as { command?: unknown } | undefined)?.command;
  if (tool !== 'Bash' || typeof command !== 'string') return actionKey(tool, args);
  const general = command.replaceAll(/scream\/[\w.-]+\/[\w.-]+/g, 'scream/*');
  return actionKey(tool, { ...(args as Record<string, unknown>), command: general });
}

export function readInboxItem(screamHomeDir: string, id: string): InboxItem | undefined {
  try {
    return JSON.parse(readFileSync(itemPath(screamHomeDir, id), 'utf8')) as InboxItem;
  } catch {
    return undefined;
  }
}

export function listInbox(screamHomeDir: string): InboxItem[] {
  let names: string[];
  try {
    names = readdirSync(inboxDir(screamHomeDir));
  } catch {
    return [];
  }
  const items: InboxItem[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const item = readInboxItem(screamHomeDir, name.slice(0, -'.json'.length));
    if (item !== undefined) items.push(item);
  }
  return items.toSorted((a, b) => a.createdAt - b.createdAt);
}

/**
 * Put an approval in the inbox, or return the pending one already there for
 * the same action of the same session (a model retrying the refused call must
 * not fill the inbox with copies).
 */
export function addApprovalItem(
  screamHomeDir: string,
  input: {
    sessionId: string;
    workDir: string;
    tool: string;
    action: string;
    key: string;
    alwaysKey?: string;
    reason: string;
  },
  now: number = Date.now(),
): InboxItem {
  const existing = listInbox(screamHomeDir).find(
    (item) =>
      item.status === 'pending' && item.sessionId === input.sessionId && item.approval?.key === input.key,
  );
  if (existing !== undefined) return existing;
  const item: InboxItem = {
    id: `inbox-${randomBytes(3).toString('hex')}`,
    kind: 'approval',
    sessionId: input.sessionId,
    workDir: input.workDir,
    createdAt: now,
    expiresAt: now + INBOX_EXPIRY_MS,
    status: 'pending',
    approval: {
      tool: input.tool,
      action: input.action.slice(0, 500),
      key: input.key,
      ...(input.alwaysKey === undefined || input.alwaysKey === input.key ? {} : { alwaysKey: input.alwaysKey }),
      reason: input.reason,
    },
  };
  writeItem(screamHomeDir, item);
  return item;
}

export function addQuestionItem(
  screamHomeDir: string,
  input: {
    sessionId: string;
    workDir: string;
    items: readonly { question: string; options: readonly string[] }[];
  },
  now: number = Date.now(),
): InboxItem {
  const item: InboxItem = {
    id: `inbox-${randomBytes(3).toString('hex')}`,
    kind: 'question',
    sessionId: input.sessionId,
    workDir: input.workDir,
    createdAt: now,
    expiresAt: now + INBOX_EXPIRY_MS,
    status: 'pending',
    question: { items: input.items.map((q) => ({ question: q.question, options: [...q.options] })) },
  };
  writeItem(screamHomeDir, item);
  return item;
}

/**
 * Record the person's decision on a pending item. Returns the updated item,
 * or undefined when there is no such pending item (answered already, expired).
 */
export function decideInboxItem(
  screamHomeDir: string,
  id: string,
  decision: InboxDecision,
  answer?: string,
  now: number = Date.now(),
): InboxItem | undefined {
  const item = readInboxItem(screamHomeDir, id);
  if (item?.status !== 'pending') return undefined;
  if (now > item.expiresAt) {
    writeItem(screamHomeDir, { ...item, status: 'expired' });
    return undefined;
  }
  if (item.kind === 'question' && decision !== 'answer') return undefined;
  if (item.kind === 'approval' && decision === 'answer') return undefined;
  if (item.kind === 'memory' && decision !== 'approve' && decision !== 'reject') return undefined;
  if (item.kind === 'question' && decision === 'session') return undefined;
  const next: InboxItem = {
    ...item,
    status: 'decided',
    decision,
    decidedAt: now,
    ...(answer === undefined ? {} : { answer: answer.slice(0, 4_000) }),
  };
  writeItem(screamHomeDir, next);
  if (decision === 'always' && item.approval !== undefined) {
    rememberApprovedAction(screamHomeDir, item.approval.alwaysKey ?? item.approval.key);
  }
  if (decision === 'session' && item.approval !== undefined) {
    rememberSessionAction(screamHomeDir, item.sessionId, item.approval.key);
  }
  return next;
}

/** Memories an unattended run wants to keep: they wait here, not in the memory store. */
export function addMemoryItem(
  screamHomeDir: string,
  input: { sessionId: string; workDir: string; memories: readonly MemoryMemo[] },
  now: number = Date.now(),
): InboxItem {
  const item: InboxItem = {
    id: `inbox-${randomBytes(3).toString('hex')}`,
    kind: 'memory',
    sessionId: input.sessionId,
    workDir: input.workDir,
    createdAt: now,
    expiresAt: now + MEMORY_ITEM_EXPIRY_MS,
    status: 'pending',
    memories: [...input.memories],
  };
  writeItem(screamHomeDir, item);
  return item;
}

/** Save the memories of an approved memory item to the store; resolves with how many were saved. */
export async function saveInboxMemories(screamHomeDir: string, item: InboxItem): Promise<number> {
  const store = sharedMemoStore(screamHomeDir);
  await store.init();
  let saved = 0;
  for (const memo of item.memories ?? []) {
    if (store.existsBySourceAndNeed(memo.sourceSessionId, memo.userNeed, memo.approach)) continue;
    await store.append(memo);
    saved += 1;
  }
  return saved;
}

/**
 * Change an item only if it is still in status `expected`, read fresh from
 * disk: whoever holds an older copy (a sweep that awaited a chat push) must
 * not write back over a decision made meanwhile. Returns the written item,
 * or undefined when the item moved on.
 */
export function patchInboxItem(
  screamHomeDir: string,
  id: string,
  expected: InboxItem['status'],
  patch: Partial<Pick<InboxItem, 'status' | 'notified' | 'notifiedTo' | 'announced'>>,
): InboxItem | undefined {
  const current = readInboxItem(screamHomeDir, id);
  if (current?.status !== expected) return undefined;
  const next: InboxItem = { ...current, ...patch };
  writeItem(screamHomeDir, next);
  return next;
}

// ─── Always-allowed actions ───────────────────────────────────────────────

function approvedActionsPath(screamHomeDir: string): string {
  return join(screamHomeDir, 'host', 'approved-actions.json');
}

/** Exact actions the person chose "always allow" for, in unattended runs. */
export function readApprovedActions(screamHomeDir: string): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(readFileSync(approvedActionsPath(screamHomeDir), 'utf8')) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

function sessionApprovalsPath(screamHomeDir: string): string {
  return join(screamHomeDir, 'host', 'session-approvals.json');
}

function readSessionApprovalFile(screamHomeDir: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(readFileSync(sessionApprovalsPath(screamHomeDir), 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** Exact actions the person allowed for the rest of one session. */
export function readSessionApprovedActions(screamHomeDir: string, sessionId: string): ReadonlySet<string> {
  const keys = readSessionApprovalFile(screamHomeDir)[sessionId];
  return new Set(Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []);
}

function rememberSessionAction(screamHomeDir: string, sessionId: string, key: string): void {
  const all = readSessionApprovalFile(screamHomeDir);
  all[sessionId] = [...new Set([...(all[sessionId] ?? []), key])];
  mkdirSync(join(screamHomeDir, 'host'), { recursive: true });
  const path = sessionApprovalsPath(screamHomeDir);
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

function rememberApprovedAction(screamHomeDir: string, key: string): void {
  const keys = new Set([...readApprovedActions(screamHomeDir), key]);
  mkdirSync(join(screamHomeDir, 'host'), { recursive: true });
  const path = approvedActionsPath(screamHomeDir);
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify([...keys], null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}
