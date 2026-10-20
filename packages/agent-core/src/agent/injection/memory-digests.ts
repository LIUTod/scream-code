import type { DigestKind, MemoryDigest } from '@scream-code/memory';

import { isRealUserPrompt } from '../context';
import type { ContextMessage } from '../context/types';
import { DynamicInjector } from './injector';

const MEMORY_DIGEST_VARIANT = 'memory_digests';
const DIGEST_HEADER = 'MEMORY DIGESTS (from /dream):';
/** `preference` digests belong to the /like channel and are never injected here. */
const INJECTABLE_KINDS: readonly DigestKind[] = ['fact', 'procedure', 'pitfall'];
// Rank over the whole injectable set, then take the top K: capping first would
// hide a relevant card merely because it was confirmed longer ago.
const CANDIDATE_LIMIT = 200;
const INJECT_TOP_K = 5;
const MAX_LINES = 40;
const MAX_TOTAL_CHARS = 4000;
/** One line per card; bound it well below the total budget so 5 cards always fit. */
const MAX_STATEMENT_CHARS = 600;
const FRESHNESS_HALF_LIFE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

interface RankedDigest {
  digest: MemoryDigest;
  relevance: number;
  score: number;
}

interface RenderedInjection {
  text: string;
  ids: string[];
}

/**
 * Injects the top consolidated memory cards produced by /dream.
 *
 * Fires when a new user prompt arrives and the rendered block changed since
 * the last injection (session start, post-compaction, after /dream). An
 * unchanged block is not repeated; when the previous reminder leaves the
 * context (compaction/undo/clear) the block is restored.
 *
 * Cards are ranked by relevance × freshness: a card scoped to the session's
 * project outranks global cards, and `last_confirmed_at` decays with a 90-day
 * half-life. Cards scoped to other projects are not injected. Only one line
 * per card is rendered, truncated to keep the whole block within its budget.
 */
export class MemoryDigestInjector extends DynamicInjector {
  protected override readonly injectionVariant = MEMORY_DIGEST_VARIANT;
  private lastInjectedText: string | null = null;
  private pendingHitIds: string[] = [];

  override async inject(): Promise<void> {
    this.pendingHitIds = [];
    const historyBefore = this.agent.context.history.length;
    await super.inject();
    // A successful injection appends exactly one context message. Without that
    // growth (no cards, unchanged text) there is nothing to account as a hit.
    if (this.agent.context.history.length <= historyBefore) return;
    const ids = this.pendingHitIds;
    if (ids.length === 0) return;
    const store = this.agent.memoStore;
    if (store === undefined) return;
    void store.touchDigestHits(ids).catch(() => {});
  }

  protected override async getInjection(): Promise<string | undefined> {
    // Memory is main-agent-only (the store is global); child agents would
    // otherwise carry dead weight and, worse, bump hit counters that drive
    // dormancy and eviction.
    if (this.agent.type !== 'main') return undefined;
    // A compaction can remap the recorded index onto a different (or dropped)
    // message, and `injectedAt === 0` is also legitimate for an injection that
    // landed at the start of an empty history — so verify the message itself.
    if (this.injectedAt !== null) {
      const message = this.agent.context.history[this.injectedAt];
      const stillPresent =
        message !== undefined &&
        message.content.some(
          (block) => block.type === 'text' && block.text.includes('MEMORY DIGESTS (from /dream):'),
        );
      if (!stillPresent) this.injectedAt = null;
    }
    if (this.injectedAt !== null && !this.hasNewUserPromptSince(this.injectedAt)) {
      return undefined;
    }
    const store = this.agent.memoStore;
    if (store === undefined) return undefined;

    let candidates: MemoryDigest[];
    try {
      candidates = await store.listDigests({
        status: 'active',
        kinds: [...INJECTABLE_KINDS],
        limit: CANDIDATE_LIMIT,
      });
    } catch (error) {
      this.agent.log.warn('memory digest injection skipped: listing digests failed', error);
      return undefined;
    }

    const selected = rankDigests(
      candidates.filter((digest) => INJECTABLE_KINDS.includes(digest.kind)),
      this.agent.config.cwd,
      Date.now(),
    ).slice(0, INJECT_TOP_K);

    const rendered = renderInjection(selected);
    if (rendered === undefined) return undefined;
    if (this.injectedAt !== null && rendered.text === this.lastInjectedText) return undefined;
    this.lastInjectedText = rendered.text;
    this.pendingHitIds = rendered.ids;
    return rendered.text;
  }

  private hasNewUserPromptSince(from: number): boolean {
    const history: readonly ContextMessage[] = this.agent.context.history;
    for (let i = from; i < history.length; i++) {
      const message = history[i];
      if (message !== undefined && isRealUserPrompt(message)) return true;
    }
    return false;
  }
}

/**
 * Relevance 2 = scoped to this project, 1 = global, 0 = another project
 * (filtered out — the store is shared across work dirs).
 */
function relevanceFor(digest: MemoryDigest, cwd: string): number {
  if (digest.appliesTo === undefined || digest.appliesTo.trim().length === 0) return 1;
  return pathMatchesProject(digest.appliesTo, cwd) ? 2 : 0;
}

function pathMatchesProject(appliesTo: string, cwd: string): boolean {
  const project = normalizePath(appliesTo);
  const current = normalizePath(cwd);
  if (project.length === 0 || current.length === 0) return false;
  return (
    current === project ||
    current.startsWith(`${project}/`) ||
    project.startsWith(`${current}/`)
  );
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '');
}

/** `0.5 ** (daysSince(lastConfirmedAt) / 90)`; future timestamps count as fresh. */
function freshness(lastConfirmedAt: number, now: number): number {
  const days = Math.max(0, now - lastConfirmedAt) / DAY_MS;
  return 0.5 ** (days / FRESHNESS_HALF_LIFE_DAYS);
}

function rankDigests(
  digests: readonly MemoryDigest[],
  cwd: string,
  now: number,
): MemoryDigest[] {
  return digests
    .map((digest): RankedDigest => {
      const relevance = relevanceFor(digest, cwd);
      return {
        digest,
        relevance,
        score: relevance * freshness(digest.lastConfirmedAt, now),
      };
    })
    .filter((entry) => entry.relevance > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        b.digest.lastConfirmedAt - a.digest.lastConfirmedAt ||
        a.digest.id.localeCompare(b.digest.id),
    )
    .map((entry) => entry.digest);
}

function renderInjection(digests: readonly MemoryDigest[]): RenderedInjection | undefined {
  const lines: string[] = [DIGEST_HEADER];
  const ids: string[] = [];
  let chars = DIGEST_HEADER.length;

  for (const digest of digests) {
    const line = renderLine(digest);
    if (line === undefined) continue;
    if (lines.length + 1 > MAX_LINES) break;
    const nextChars = chars + 1 + line.length;
    if (nextChars > MAX_TOTAL_CHARS) break;
    lines.push(line);
    ids.push(digest.id);
    chars = nextChars;
  }

  if (ids.length === 0) return undefined;
  return { text: lines.join('\n'), ids };
}

function renderLine(digest: MemoryDigest): string | undefined {
  const statement = digest.statement.replaceAll(/\s+/g, ' ').trim();
  if (statement.length === 0) return undefined;
  const prefix = `- [${digest.kind} · 更新于 ${formatMonth(digest.updatedAt)}] `;
  // Slice by code points: cutting a surrogate pair would emit a lone surrogate.
  const points = Array.from(statement);
  const clipped =
    points.length > MAX_STATEMENT_CHARS
      ? `${points.slice(0, MAX_STATEMENT_CHARS - 1).join('')}…`
      : statement;
  return `${prefix}${clipped}`;
}

function formatMonth(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().slice(0, 7);
}
