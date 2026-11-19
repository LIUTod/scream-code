/**
 * Model-written session titles.
 *
 * A session used to be titled with the first prompt, verbatim. That names a
 * session after how its person opens a conversation ("你好", "hi", "继续"),
 * so the session list fills with identical titles nobody can tell apart.
 *
 * Now the first prompt is only a provisional title (set in
 * `SessionAPIImpl.updatePromptMetadata`, so the list is never blank). When a
 * main-agent turn completes, the model reads a short excerpt of the
 * conversation — the opening request, the latest requests, the latest reply —
 * and names the task. A greeting or a request too vague to name gets no title,
 * and the next completed turn tries again, up to {@link MAX_ATTEMPTS} turns.
 * Once a title is written the session keeps it; a title the person set
 * (`/title`) is never touched.
 *
 * The call goes to the housekeeping model when one is configured, else to the
 * session model, with thinking off and a small excerpt, so it costs a few
 * hundred tokens once per session. It is best-effort: any failure leaves the
 * provisional title and counts as an attempt.
 */

import type { ContentPart, Message, ProviderRequestAuth, ThinkingEffort } from '@scream-code/ltod';

import type { Agent } from '#/agent';
import { resolveHousekeeping } from '#/agent/compaction/full';
import { isRealUserPrompt } from '#/agent/context/identity';
import type { ContextMessage } from '#/agent/context/types';

import type { Session, SessionMeta } from './index';

/** Set in `metadata.custom` once the model has named the session. */
export const TITLE_SOURCE_KEY = 'titleSource';
/**
 * Requests spent so far without a title, in `metadata.custom`. Persisted, not
 * kept in memory: a session that stays small talk would otherwise get a fresh
 * {@link MAX_ATTEMPTS} every time it is reopened.
 */
export const TITLE_ATTEMPTS_KEY = 'titleAttempts';

/** Completed turns to try before leaving the provisional title in place. */
const MAX_ATTEMPTS = 4;
const MAX_TITLE_CHARS = 60;
/** Per-part budget of the excerpt the model sees. */
const EXCERPT_CHARS = 600;

export const TITLE_SYSTEM_PROMPT = [
  'You name coding-assistant sessions so a person can find them later in a list.',
  'Write a title of 3-8 words (Chinese: 4-16 characters) for the task the conversation is working on.',
  'Output exactly one line: the title inside <title></title>, or <title/> when there is no task to name yet.',
  '',
  'Rules:',
  '- Name the goal, using the key words the person used (the feature, file, error, or topic).',
  '- Write it in the language the person writes in.',
  '- Answer <title/> for greetings, thanks, small talk, or requests too vague to name ("hi", "你好", "continue", "fix this").',
  '- Prefer the opening request, unless later requests clearly moved to a different task.',
  '- No quotes, no trailing punctuation, no explanation.',
].join('\n');

const TITLE_RE = /<title>([\s\S]*?)<\/title>|<title\s*\/>/i;

/**
 * Parse the model's answer. `null` means "nothing to name yet" (`<title/>` or
 * an empty title); `undefined` means the answer was not in the asked format.
 */
export function parseTitleAnswer(text: string): string | null | undefined {
  const match = TITLE_RE.exec(text);
  if (match === null) return undefined;
  const title = normalizeTitle(match[1] ?? '');
  return title.length === 0 ? null : title;
}

export function normalizeTitle(raw: string): string {
  let title = raw.replaceAll(/\s+/g, ' ').trim();
  // Trailing punctuation and wrapping quotes, in either order ("「标题」。").
  for (let pass = 0; pass < 2; pass++) {
    title = title.replace(/[。．.!！?？,，;；:：、]+$/u, '').trim();
    title = title.replaceAll(/^["'“”‘’「」『』《》`]+|["'“”‘’「」『』《》`]+$/g, '').trim();
  }
  const chars = Array.from(title);
  return chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join('').trim() : title;
}

function textOf(message: Message): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('')}…` : text;
}

/**
 * The excerpt the model titles: the opening request, up to two latest
 * requests, and the latest reply. Undefined when no request is in history.
 */
export function buildTitleExcerpt(history: readonly ContextMessage[]): string | undefined {
  // The person's own prompts. isRealUserPrompt also counts a message with no
  // origin (history written before origins were recorded); a slash command's
  // rendered skill body is not their words, so it is left out.
  const prompts = history
    .filter((message) => isRealUserPrompt(message) && message.origin?.kind !== 'skill_activation')
    .map(textOf)
    .filter((text) => text.length > 0);
  if (prompts.length === 0) return undefined;
  const reply = history.findLast((message) => message.role === 'assistant' && textOf(message).length > 0);

  const lines = [`<opening_request>\n${clip(prompts[0]!)}\n</opening_request>`];
  const latest = prompts.slice(1).slice(-2);
  if (latest.length > 0) {
    lines.push(`<latest_requests>\n${latest.map(clip).join('\n---\n')}\n</latest_requests>`);
  }
  if (reply !== undefined) lines.push(`<latest_reply>\n${clip(textOf(reply))}\n</latest_reply>`);
  return lines.join('\n');
}

function isCustomTitle(metadata: SessionMeta): boolean {
  if (metadata.isCustomTitle) return true;
  return typeof (metadata as SessionMeta & { customTitle?: unknown }).customTitle === 'string';
}

/** Whether the session should still get a model-written title. */
export function wantsModelTitle(metadata: SessionMeta): boolean {
  if (isCustomTitle(metadata)) return false;
  const custom = metadata.custom ?? {};
  if (custom[TITLE_SOURCE_KEY] === 'model') return false;
  // A background job's runs are listed under the job, not by title.
  if (custom['source'] === 'job') return false;
  return true;
}

export class SessionAutoTitle {
  private inFlight = false;
  /** Set by {@link dispose}: the session is closing, nothing more is written. */
  private disposed = false;
  private abort: AbortController | undefined;
  private subscribedTo: Agent | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly session: Session) {}

  /**
   * Called on every main-agent prompt: (re)attach to the current main agent
   * (a resume builds a new one) so its completed turns are seen.
   */
  watch(): void {
    if (this.disposed || !wantsModelTitle(this.session.metadata) || this.attemptsUsed() >= MAX_ATTEMPTS) return;
    const main = this.session.agents.get('main');
    if (main === undefined || main === this.subscribedTo) return;
    this.unsubscribe?.();
    this.subscribedTo = main;
    this.unsubscribe = main.eventBus.subscribe('turn.ended', (event) => {
      if (event.type === 'turn.ended' && event.reason === 'completed') void this.tryTitle(main);
    });
  }

  /**
   * The session is closing (or being deleted): stop watching and cancel a
   * request in flight. Its answer must never be written — the metadata write
   * recreates the session directory, so a late title would bring a deleted
   * session back as a shell.
   */
  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.stopWatching();
  }

  private stopWatching(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscribedTo = undefined;
  }

  private async tryTitle(agent: Agent): Promise<void> {
    if (this.inFlight || this.disposed) return;
    if (this.attemptsUsed() >= MAX_ATTEMPTS || !wantsModelTitle(this.session.metadata)) {
      this.stopWatching();
      return;
    }
    const excerpt = buildTitleExcerpt(agent.context.history);
    if (excerpt === undefined) return;
    this.inFlight = true;
    const abort = new AbortController();
    this.abort = abort;
    try {
      // Counted before the request, while the session is surely live (a write
      // after close would recreate a deleted session's directory, see dispose).
      await this.countAttempt();
      if (this.disposed) return;
      const title = await generateTitle(agent, excerpt, abort.signal);
      // Closed meanwhile, or renamed by the person while the model answered.
      if (this.disposed || title === null || title === undefined || !wantsModelTitle(this.session.metadata)) {
        return;
      }
      await this.applyTitle(title);
      this.stopWatching();
    } catch (error) {
      if (!this.disposed) this.session.log.warn('session title generation failed', { error });
    } finally {
      this.inFlight = false;
      this.abort = undefined;
    }
  }

  private attemptsUsed(): number {
    const used = this.session.metadata.custom?.[TITLE_ATTEMPTS_KEY];
    return typeof used === 'number' && Number.isFinite(used) ? used : 0;
  }

  private async countAttempt(): Promise<void> {
    this.session.metadata = {
      ...this.session.metadata,
      custom: { ...this.session.metadata.custom, [TITLE_ATTEMPTS_KEY]: this.attemptsUsed() + 1 },
    };
    await this.session.writeMetadata();
  }

  private async applyTitle(title: string): Promise<void> {
    this.session.metadata = {
      ...this.session.metadata,
      title,
      isCustomTitle: false,
      custom: { ...this.session.metadata.custom, [TITLE_SOURCE_KEY]: 'model' },
    };
    await this.session.writeMetadata();
    await this.session.rpc.emitEvent({
      type: 'session.meta.updated',
      agentId: 'main',
      title,
      patch: { title, isCustomTitle: false },
    });
  }
}

/**
 * One title request, on the housekeeping model when configured, else on the
 * session model. Thinking off first (a provider whose model always thinks
 * degrades `off` to its lowest effort itself); an endpoint that still refuses
 * gets one retry at the session's thinking level, as compaction uses.
 */
async function generateTitle(
  agent: Agent,
  excerpt: string,
  signal: AbortSignal,
): Promise<string | null | undefined> {
  if (!agent.config.hasModel) return undefined;
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: excerpt }], toolCalls: [] }];
  const housekeeping = resolveHousekeeping(agent);
  const request = (thinking: ThinkingEffort) => {
    const send = (auth: ProviderRequestAuth | undefined) => {
      const provider = (housekeeping?.provider ?? agent.config.provider).withThinking(thinking);
      return agent.generate(provider, TITLE_SYSTEM_PROMPT, [], messages, undefined, {
        signal,
        ...(auth === undefined ? {} : { auth }),
      });
    };
    // Session model: no auth here, the generate wrapper resolves the session
    // alias's own. Housekeeping model: explicit empty auth or its own wrapper —
    // see the same branch in compaction/full.ts.
    if (housekeeping === undefined) return send(undefined);
    return housekeeping.authRequest === undefined ? send({}) : housekeeping.authRequest(send);
  };
  let response;
  try {
    response = await request('off');
  } catch (error) {
    const fallback = agent.config.thinkingLevel;
    if (signal.aborted || fallback === 'off') throw error;
    response = await request(fallback);
  }
  if (response.usage !== null) agent.usage.record(housekeeping?.modelName ?? agent.config.model, response.usage);
  const text = response.message.content.map((part: ContentPart) => (part.type === 'text' ? part.text : '')).join('');
  return parseTitleAnswer(agent.deobfuscateInboundText(text));
}
