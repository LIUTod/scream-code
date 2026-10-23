/**
 * Test doubles for the bot gateway. No model key, no harness: the runtime only
 * needs a session-shaped object, so prompt/turn flows are driven by the test.
 */
import type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResponse,
  ContextMessage,
  Event as SessionEvent,
  QuestionHandler,
  QuestionRequest,
  QuestionResult,
} from '@scream-code/scream-code-sdk';

import type { BotSession, BotSessionFactory } from '../../../src/bot/server/runtime';
import { BotRuntime } from '../../../src/bot/server/runtime';
import { SseHub } from '../../../src/bot/server/sse';
import { BotStore, type BotRecord, type ThreadRecord } from '../../../src/bot/server/store';

export interface Confirmation {
  readonly kind: 'approval' | 'question';
  readonly result: unknown;
}

export class FakeSession implements BotSession {
  readonly id: string;
  readonly history: ContextMessage[];
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  /** Every tool registration this session received, in order. */
  readonly registeredTools: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }[] = [];
  /** Latest runtime identity append, if the host applied one. */
  runtimeIdentity: string | undefined;
  failures: Error[] = [];
  cancelCount = 0;
  closed = false;

  /** When set, the next prompt completes by itself with this text. */
  autoText: string | undefined;
  /** Deferred decisions, so tests can answer approvals/questions out of band. */
  readonly confirmations: Confirmation[] = [];

  private listeners = new Set<(event: SessionEvent) => void>();
  private approvalHandler: ApprovalHandler | undefined;
  private questionHandler: QuestionHandler | undefined;
  private turnId = 0;
  private nextMessageId = 1;

  constructor(id: string, history: ContextMessage[] = []) {
    this.id = id;
    this.history = history.map((message,index) => ({...message,id:message.id ?? `m${index+1}`}));
    this.nextMessageId = Math.max(0,...this.history.map((message) => Number(message.id?.slice(1)) || 0))+1;
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  setQuestionHandler(handler: QuestionHandler | undefined): void {
    this.questionHandler = handler;
  }

  async registerTool(payload: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }): Promise<void> {
    this.registeredTools.push(payload);
  }

  async setRuntimeSystemPrompt(prompt: {
    readonly replace?: string | undefined;
    readonly append?: string | undefined;
  }): Promise<void> {
    this.runtimeIdentity = prompt.append;
  }

  appliedModel: string | null = null;
  appliedPermission: string | null = null;
  appliedTools: readonly string[] | null = null;

  async setModel(model: string): Promise<void> {
    this.appliedModel = model;
  }

  async setThinking(level: string): Promise<void> {
    this.appliedThinking = level;
  }

  appliedThinking: string | null = null;

  async setPermission(mode: 'manual' | 'yolo' | 'auto' | 'ask' | 'bot'): Promise<void> {
    this.appliedPermission = mode;
  }

  async setActiveTools(names: readonly string[]): Promise<void> {
    this.appliedTools = names;
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    this.turnId += 1;
    this.history.push(contextMessage('user', input, { id: `m${this.nextMessageId++}` }));
    this.emit({ type: 'turn.started', sessionId: this.id, agentId: 'main', turnId: this.turnId, origin: { kind:'user' } });
    if (this.autoText !== undefined) {
      const text = this.autoText;
      this.autoText = undefined;
      this.complete(text);
      return;
    }
    // SDK prompt acknowledges scheduling; turn completion is a separate event.
  }

  async steer(input: string): Promise<void> {
    this.steers.push(input);
    this.history.push(contextMessage('user', input,{id:`m${this.nextMessageId++}`}));
  }

  async cancel(): Promise<void> {
    this.cancelCount += 1;
    this.emit({ type: 'turn.ended', sessionId: this.id, agentId: 'main', turnId: this.turnId, reason: 'cancelled' });
  }

  async getContext(): Promise<{ readonly history: readonly ContextMessage[] }> {
    return { history: this.history };
  }

  async listBackgroundTasks(): Promise<readonly unknown[]> {
    return [];
  }

  async listCronTasks(): Promise<readonly unknown[]> {
    return [];
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Finish the active turn with optional assistant text. */
  delta(text: string): void {
    this.emit({ type: 'assistant.delta', sessionId: this.id, agentId: 'main', turnId: this.turnId, delta: text });
  }

  complete(text = ''): void {
    if (text.length > 0) {
      this.emit({ type: 'assistant.delta', sessionId: this.id, agentId: 'main', turnId: this.turnId, delta: text });
      this.history.push(contextMessage('assistant', text, { id: `m${this.nextMessageId++}` }));
    }
    this.emit({ type: 'turn.ended', sessionId: this.id, agentId: 'main', turnId: this.turnId, reason: 'completed' });
  }

  fail(error: Error): void {
    this.failures.push(error);
    this.emit({
      type: 'turn.ended',
      sessionId: this.id,
      agentId: 'main',
      turnId: this.turnId,
      reason: 'failed',
      error: { name: 'Error', code: 'internal', message: error.message, retryable:false },
    });
  }

  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    if (this.approvalHandler === undefined) {
      return Promise.reject(new Error('no approval handler installed'));
    }
    return Promise.resolve(this.approvalHandler(request)).then((result) => {
      this.confirmations.push({ kind: 'approval', result });
      return result;
    });
  }

  requestQuestion(request: QuestionRequest): Promise<QuestionResult> {
    if (this.questionHandler === undefined) {
      return Promise.reject(new Error('no question handler installed'));
    }
    return Promise.resolve(this.questionHandler(request)).then((result) => {
      this.confirmations.push({ kind: 'question', result });
      return result;
    });
  }

  emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class FakeSessionFactory implements BotSessionFactory {
  readonly sessions = new Map<string, FakeSession>();
  readonly openCalls: string[] = [];

  async open(_bot: BotRecord, thread: ThreadRecord): Promise<FakeSession> {
    this.openCalls.push(thread.id);
    const existing = this.sessions.get(thread.id);
    if (existing !== undefined) return existing;
    const session = new FakeSession(thread.coreSessionId ?? `fake_core_${thread.id}`);
    this.sessions.set(thread.id, session);
    return session;
  }

  sessionFor(threadId: string): FakeSession {
    const session = this.sessions.get(threadId);
    if (session === undefined) throw new Error(`No fake session for thread ${threadId}`);
    return session;
  }
}

export interface RuntimeFixture {
  readonly store: BotStore;
  readonly hub: SseHub;
  readonly factory: FakeSessionFactory;
  readonly runtime: BotRuntime;
}

export function createRuntimeFixture(
  options: { readonly approvalTimeoutMs?: number; readonly questionTimeoutMs?: number; readonly idleMinutes?: number; readonly now?: () => number } = {},
): RuntimeFixture {
  const store = new BotStore(':memory:');
  store.open();
  const hub = new SseHub();
  const factory = new FakeSessionFactory();
  const runtime = new BotRuntime({
    store,
    hub,
    sessions: factory,
    idleMinutes: options.idleMinutes,
    now: options.now,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 200,
    questionTimeoutMs: options.questionTimeoutMs ?? 200,
  });
  runtime.start();
  return { store, hub, factory, runtime };
}

export function contextMessage(
  role: 'user' | 'assistant' | 'system' | 'tool',
  text: string,
  extra: Partial<ContextMessage> = {},
): ContextMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
    ...extra,
  } as ContextMessage;
}

export function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId: 'call_1',
    toolName: 'Bash',
    action: 'run a shell command',
    display: { kind: 'generic', summary: 'rm -rf build' },
    reasons: ['writes outside the workspace'],
    grantOptions: ['once', 'session'],
    ...overrides,
  } as ApprovalRequest;
}

export function questionRequest(): QuestionRequest {
  return {
    toolCallId: 'call_q1',
    questions: [
      {
        question: 'Which environment?',
        header: 'Target',
        options: [{ label: 'staging' }, { label: 'production', description: 'careful' }],
      },
      {
        question: 'Which checks?',
        multiSelect: true,
        options: [{ label: 'unit' }, { label: 'e2e' }],
      },
    ],
  };
}
