/**
 * In-memory preview transport, selected only by explicit VITE_BOT_MOCK=1.
 * Events and inbox decisions are simulated; no tools run and no security approval is granted.
 * Nothing here reaches the network or reads the filesystem.
 */
import type {
  Approval,
  ApprovalResponse,
  Attachment,
  AuditEntry,
  Bot,
  BotStatus,
  CreateBotInput,
  CreateRoomInput,
  CreateThreadInput,
  Handoff,
  Message,
  PromptInput,
  Question,
  QuestionResponse,
  Room,
  RoomMessage,
  Run,
  ServerEvent,
  Thread,
  ToolCall,
  UpdateBotInput,
} from "../../../shared/contracts";
import type {
  BotClient,
  FileEntry,
  FileListing,
  FilePreview,
  Inbox,
  RecoveryDecision,
} from "../client";

type MutableBot = { -readonly [K in keyof Bot]: Bot[K] };
type MutableThread = { -readonly [K in keyof Thread]: Thread[K] };
type MutableRun = { -readonly [K in keyof Run]: Run[K] };
type MutableApproval = { -readonly [K in keyof Approval]: Approval[K] };
type MutableQuestion = { -readonly [K in keyof Question]: Question[K] };
type MutableHandoff = { -readonly [K in keyof Handoff]: Handoff[K] };
type MutableToolCall = { -readonly [K in keyof ToolCall]: ToolCall[K] };
type MutableMessage = {
  -readonly [K in keyof Message]: K extends "toolCalls"
    ? MutableToolCall[] | undefined
    : K extends "handoff"
      ? MutableHandoff | undefined
      : Message[K];
};
type MutableRoom = { -readonly [K in keyof Room]: Room[K] };
type MutableRoomMessage = { -readonly [K in keyof RoomMessage]: RoomMessage[K] };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type PromptPlan = "approval" | "handoff" | "question" | "plain";

/** A deterministic watermark for local preview events; it is not a server epoch. */
const PREVIEW_EPOCH = "mock-preview";

function planFor(text: string): PromptPlan {
  const normalized = text.toLowerCase();
  if (/hand ?off|delegate|research/.test(normalized)) return "handoff";
  if (/approve|command|shell|test|run\b|build/.test(normalized)) return "approval";
  if (/ask me|question|clarify|need to know/.test(normalized)) return "question";
  return "plain";
}

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function normaliseWorkspace(workspace: string): string {
  return workspace.trim().replace(/\/+$/, "") || "~";
}

export class MockBotClient implements BotClient {
  private bots: MutableBot[] = [];
  private threads: MutableThread[] = [];
  private messages: MutableMessage[] = [];
  private runs: MutableRun[] = [];
  private approvals: MutableApproval[] = [];
  private questions: MutableQuestion[] = [];
  private handoffs: MutableHandoff[] = [];
  private rooms: MutableRoom[] = [];
  private roomMessages: MutableRoomMessage[] = [];
  private audit: AuditEntry[] = [];
  private files = new Map<string, { entry: FileEntry; content: string }[]>();
  private listeners = new Set<(event: ServerEvent) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private runInputs = new Map<string, PromptInput>();
  private promptRequests = new Map<string, { body: string; runId: string }>();
  private roomRequests = new Map<string, string>();
  private threadRoots = new Map<string, string>();
  private scheduledRuns = new Set<string>();
  private readonly epoch = `${PREVIEW_EPOCH}:${id("epoch")}`;
  private seq = 0;

  constructor() {
    this.seed();
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- bots

  async listBots(): Promise<Bot[]> {
    const lastOf = (botId: string): MutableMessage | undefined => {
      const threadIds = this.threads
        .filter((thread) => thread.botId === botId && thread.archivedAt === null)
        .map((thread) => thread.id);
      return this.messages
        .filter((message) => threadIds.includes(message.threadId) && message.role !== "system")
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        .at(-1);
    };
    return [...this.bots]
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
      .map((bot) => {
        const last = lastOf(bot.id);
        return {
          ...bot,
          lastMessage: last?.content ?? null,
          lastMessageAt: last?.createdAt ?? null,
        };
      });
  }

  async getBot(botId: string): Promise<Bot | undefined> {
    return this.bots.find((bot) => bot.id === botId);
  }

  async createBot(input: CreateBotInput): Promise<Bot> {
    const now = Date.now();
    const bot: MutableBot = {
      avatarSeed: input.name,
      id: id("bot"),
      lastActiveAt: now,
      model: input.model,
      name: input.name.trim(),
      needsYou: 0,
      paused: false,
      permission: input.permission ?? "bot",
      rolePrompt: input.rolePrompt ?? "",
      status: "idle",
      thinking: input.thinking,
      title: input.title?.trim() || "Bot",
      toolPolicy: input.toolPolicy ?? {},
      unread: 0,
      workspace: normaliseWorkspace(input.workspace),
    };
    this.bots.push(bot);
    const thread = this.addThread(bot, "New conversation");
    this.addMessage(thread.id, "system", `Workspace: ${bot.workspace}`);
    this.record({
      action: "bot.created",
      actor: "you",
      botId: bot.id,
      decision: null,
      initiator: "person",
      threadId: null,
    });
    this.emitForBot(bot.id);
    return bot;
  }

  async updateBot(botId: string, input: UpdateBotInput): Promise<Bot> {
    const bot = this.requireBot(botId);
    if (input.name !== undefined) bot.name = input.name;
    if (input.title !== undefined) bot.title = input.title;
    if (input.rolePrompt !== undefined) bot.rolePrompt = input.rolePrompt;
    if (input.workspace !== undefined) {
      bot.workspace = normaliseWorkspace(input.workspace);
    }
    if (input.model !== undefined) bot.model = input.model;
    if (input.thinking !== undefined) bot.thinking = input.thinking;
    if (input.permission !== undefined) bot.permission = input.permission;
    if (input.toolPolicy !== undefined) bot.toolPolicy = input.toolPolicy;
    if (input.paused !== undefined) bot.paused = input.paused;
    this.refreshBot(bot);
    this.emitForBot(botId);
    if (!bot.paused) this.scheduleBot(bot.id);
    return bot;
  }

  async deleteBot(botId: string): Promise<void> {
    if (this.bots.length <= 1) {
      throw new Error("The workbench needs at least one Bot.");
    }
    this.bots = this.bots.filter((bot) => bot.id !== botId);
    const threadIds = new Set(
      this.threads.filter((thread) => thread.botId === botId).map((t) => t.id),
    );
    this.threads = this.threads.filter((thread) => thread.botId !== botId);
    this.messages = this.messages.filter(
      (message) => !threadIds.has(message.threadId),
    );
    this.approvals = this.approvals.filter(
      (approval) => approval.botId !== botId,
    );
    this.questions = this.questions.filter(
      (question) => question.botId !== botId,
    );
    this.runs = this.runs.filter((run) => run.botId !== botId);
    for (const threadId of threadIds) this.threadRoots.delete(threadId);
    this.emitForBot(botId);
  }

  async setPaused(botId: string, paused: boolean): Promise<Bot> {
    const bot = this.requireBot(botId);
    bot.paused = paused;
    this.refreshBot(bot);
    this.record({
      action: paused ? "bot.paused" : "bot.resumed",
      actor: "you",
      botId,
      decision: null,
      initiator: "person",
      threadId: null,
    });
    this.emitForBot(botId);
    if (!paused) this.scheduleBot(botId);
    return bot;
  }

  // ------------------------------------------------------------- threads

  async listThreads(botId: string): Promise<Thread[]> {
    return this.threads
      .filter((thread) => thread.botId === botId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  async createThread(
    botId: string,
    input?: CreateThreadInput,
  ): Promise<Thread> {
    const bot = this.requireBot(botId);
    const thread = this.addThread(bot, input?.title ?? "New conversation");
    this.emitForBot(botId);
    return thread;
  }

  async deleteThread(threadId: string): Promise<void> {
    const thread = this.requireThread(threadId);
    const bot = this.requireBot(thread.botId);
    this.threads = this.threads.filter((candidate) => candidate.id !== threadId);
    this.messages = this.messages.filter((message) => message.threadId !== threadId);
    this.runs = this.runs.filter((run) => run.threadId !== threadId);
    this.approvals = this.approvals.filter((approval) => approval.threadId !== threadId);
    this.questions = this.questions.filter((question) => question.threadId !== threadId);
    this.threadRoots.delete(threadId);
    if (!this.threads.some((candidate) => candidate.botId === bot.id)) {
      this.addThread(bot, "New conversation");
    }
    this.refreshBot(bot);
    this.emitForBot(bot.id, threadId);
  }

  async listMessages(threadId: string): Promise<Message[]> {
    return this.messages
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER));
  }

  async prompt(
    threadId: string,
    input: PromptInput,
  ): Promise<{ runId: string }> {
    const thread = this.requireThread(threadId);
    const bot = this.requireBot(thread.botId);
    if (!input.text.trim()) throw new Error("Say something first.");
    const body = JSON.stringify([input.text.trim(), input.mode ?? "queue"]);
    const requestKey = input.requestKey ? JSON.stringify([threadId, input.requestKey]) : undefined;
    const previous = requestKey ? this.promptRequests.get(requestKey) : undefined;
    if (previous) {
      if (previous.body !== body) throw new Error("Request key was already used with a different prompt.");
      return { runId: previous.runId };
    }
    if (bot.paused) throw new Error(`${bot.name} is paused.`);
    const active = this.runs.find((candidate) => candidate.threadId === threadId && candidate.status === "running");
    if (input.mode === "steer" && active) {
      this.addMessage(threadId, "user", input.text.trim(), {
        ...(input.attachments === undefined || input.attachments.length === 0
          ? {}
          : { attachments: input.attachments }),
      });
      if (requestKey) this.promptRequests.set(requestKey, { body, runId: active.id });
      this.emitForBot(bot.id, threadId);
      return { runId: active.id };
    }

    const now = Date.now();
    this.addMessage(threadId, "user", input.text.trim(), {
      ...(input.attachments === undefined || input.attachments.length === 0
        ? {}
        : { attachments: input.attachments }),
    });
    const run: MutableRun = {
      botId: bot.id,
      endedAt: null,
      error: null,
      id: id("run"),
      kind: "prompt",
      requestKey: input.requestKey ?? null,
      startedAt: now,
      status: "queued",
      threadId,
    };
    this.runs.push(run);
    this.runInputs.set(run.id, { text: input.text.trim(), mode: input.mode ?? "queue" });
    if (requestKey) this.promptRequests.set(requestKey, { body, runId: run.id });
    this.addMessage(threadId, "user", input.text.trim());
    thread.lastActiveAt = now;
    bot.lastActiveAt = now;
    this.refreshBot(bot);
    this.emitRun(run);
    this.emitForBot(bot.id, threadId);
    this.scheduleRun(run);

    return { runId: run.id };
  }

  async interrupt(threadId: string): Promise<void> {
    const run = this.runs.find(
      (candidate) =>
        candidate.threadId === threadId &&
        (candidate.status === "running" || candidate.status === "waiting_user"),
    );
    if (!run) return;
    run.status = "interrupted";
    run.error = "Preview run stopped; choose a recovery decision before queued work continues.";
    run.endedAt = Date.now();
    this.requireThread(threadId).blockedByRunId = run.id;
    for (const message of this.messages.filter((candidate) => candidate.runId === run.id)) {
      for (const call of message.toolCalls ?? []) {
        if (call.status !== "running") continue;
        call.status = "error";
        call.error = "Preview run stopped.";
        call.endedAt = Date.now();
      }
    }
    const bot = this.requireBot(run.botId);
    for (const approval of this.approvals) {
      if (approval.runId === run.id && approval.status === "pending") {
        approval.status = "expired";
      }
    }
    for (const question of this.questions) {
      if (question.runId === run.id && question.status === "pending") {
        question.status = "expired";
      }
    }
    this.addMessage(threadId, "system", "Stopped by you.", {
      toolCalls: [],
    });
    this.refreshBot(bot);
    this.emitRun(run);
    this.emitForBot(bot.id, threadId);
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.status === "cancelled") return;
    if (run.status !== "queued") {
      throw new Error("Only queued runs can be cancelled.");
    }
    run.status = "cancelled";
    run.endedAt = Date.now();
    const bot = this.requireBot(run.botId);
    this.record({
      action: "run.cancelled",
      actor: "you",
      botId: bot.id,
      decision: "cancelled",
      initiator: "person",
      threadId: run.threadId,
    });
    this.refreshBot(bot);
    this.emitRun(run);
    this.emitForBot(bot.id, run.threadId);
  }

  async recoverRun(runId: string, decision: RecoveryDecision): Promise<{ runId?: string }> {
    const run = this.requireRun(runId);
    if (run.status !== "interrupted") {
      throw new Error("Only interrupted runs accept recovery decisions.");
    }
    if (run.recoveryDecision !== null && run.recoveryDecision !== undefined) {
      if (run.recoveryDecision !== decision) {
        throw new Error("Recovery decision already recorded.");
      }
      const retry = this.runs.find((candidate) => candidate.retryOfRunId === run.id);
      return retry === undefined ? {} : { runId: retry.id };
    }

    const input = this.runInputs.get(run.id);
    if (decision === "retry" && !input) throw new Error("This preview run has no replayable input.");
    run.recoveryDecision = decision;
    run.recoveryAt = Date.now();
    const bot = this.requireBot(run.botId);
    const thread = this.requireThread(run.threadId);
    thread.blockedByRunId = null;
    let retry: MutableRun | undefined;
    if (decision === "retry" && input) {
      retry = {
        botId: run.botId,
        endedAt: null,
        error: null,
        id: id("run"),
        kind: "prompt",
        requestKey: `retry:${run.id}`,
        retryOfRunId: run.id,
        startedAt: Date.now(),
        status: "queued",
        threadId: run.threadId,
      };
      this.runs.splice(this.runs.indexOf(run) + 1, 0, retry);
      this.runInputs.set(retry.id, input);
    } else if (decision === "cancel_queue") {
      for (const queued of this.runs) {
        if (queued.threadId !== run.threadId || queued.status !== "queued") continue;
        queued.status = "cancelled";
        queued.endedAt = Date.now();
        this.emitRun(queued);
      }
    }

    this.record({
      action: "run.recovery",
      actor: "you",
      botId: bot.id,
      decision,
      initiator: "person",
      threadId: thread.id,
    });
    this.refreshBot(bot);
    this.emitRun(run);
    if (retry !== undefined) this.emitRun(retry);
    this.emitForBot(bot.id, thread.id);
    return retry === undefined ? {} : { runId: retry.id };
  }

  async markThreadRead(threadId: string): Promise<void> {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread || thread.unread === 0) return;
    thread.unread = 0;
    const bot = this.requireBot(thread.botId);
    this.refreshBot(bot);
    this.emitForBot(bot.id, threadId);
  }

  // ---------------------------------------------------------------- runs

  async listRuns(botId?: string): Promise<Run[]> {
    return this.runs
      .filter((run) => botId === undefined || run.botId === botId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  // --------------------------------------------------------------- inbox

  async listHandoffs(
    options: { readonly botId?: string; readonly threadId?: string; readonly limit?: number } = {},
  ): Promise<Handoff[]> {
    return this.handoffs
      .filter(
        (handoff) =>
          (options.botId === undefined ||
            handoff.fromBotId === options.botId ||
            handoff.toBotId === options.botId) &&
          (options.threadId === undefined ||
            handoff.fromThreadId === options.threadId ||
            handoff.toThreadId === options.threadId),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, options.limit ?? 50);
  }

  async listInbox(): Promise<Inbox> {
    return {
      approvals: this.approvals
        .filter((approval) => approval.status === "pending")
        .sort((a, b) => b.createdAt - a.createdAt),
      handoffs: this.handoffs
        .filter(
          (handoff) =>
            handoff.status === "queued" ||
            handoff.status === "running" ||
            handoff.status === "failed",
        )
        .sort((a, b) => b.createdAt - a.createdAt),
      questions: this.questions
        .filter((question) => question.status === "pending")
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  async decideApproval(
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<void> {
    const approval = this.approvals.find(
      (candidate) => candidate.id === approvalId,
    );
    if (!approval) throw new Error("That request is no longer waiting.");
    if (approval.status !== "pending") return;
    approval.status = response.decision === "deny" ? "denied" : "approved";
    const bot = this.requireBot(approval.botId);
    const thread = this.requireThread(approval.threadId);
    const run = approval.runId
      ? this.runs.find((candidate) => candidate.id === approval.runId)
      : undefined;
    this.record({
      action: "approval.decided",
      actor: "you",
      botId: bot.id,
      decision: response.decision,
      initiator: "person",
      threadId: thread.id,
    });

    const message = this.messages.find((candidate) =>
      candidate.threadId === thread.id && (run ? candidate.runId === run.id : true) &&
      candidate.toolCalls?.some((call) => call.name === approval.toolName && call.status === "running"),
    );
    const call = message?.toolCalls?.find(
      (candidate) =>
        candidate.name === approval.toolName && candidate.status === "running",
    );

    if (response.decision === "deny") {
      if (call) {
        call.status = "error";
        call.endedAt = Date.now();
        call.error = "Denied by you.";
      }
      this.addMessage(
        thread.id,
        "assistant",
        "Understood — I left that alone. Tell me if a narrower command would work.",
      );
    } else {
      if (call) {
        call.status = "done";
        call.endedAt = Date.now();
        call.output =
          "Preview only: simulated tool output. No command ran.";
      }
      this.addMessage(
        thread.id,
        "assistant",
        "Preview decision recorded. No command executed and no security permission was granted.",
      );
    }

    if (run && this.isLive(run)) {
      run.status = "done";
      run.endedAt = Date.now();
      this.emitRun(run);
    }
    this.refreshBot(bot);
    this.emit({
      botId: bot.id,
      data: approval,
      threadId: thread.id,
      type: "approval.decided",
    });
    this.emitForBot(bot.id, thread.id);
  }

  async answerQuestion(
    questionId: string,
    response: QuestionResponse,
  ): Promise<void> {
    const question = this.questions.find(
      (candidate) => candidate.id === questionId,
    );
    if (!question) throw new Error("That question is no longer open.");
    if (question.status !== "pending") return;
    question.status = "answered";
    const bot = this.requireBot(question.botId);
    const thread = this.requireThread(question.threadId);
    const answered = Object.values(response.answers)
      .flat()
      .filter(Boolean)
      .join(", ");
    this.addMessage(
      thread.id,
      "assistant",
      `Noted: ${answered || "no preference"}. I'll go with that.`,
    );
    const run = question.runId
      ? this.runs.find((candidate) => candidate.id === question.runId)
      : undefined;
    if (run && this.isLive(run)) {
      run.status = "done";
      run.endedAt = Date.now();
      this.emitRun(run);
    }
    this.record({
      action: "question.answered",
      actor: "you",
      botId: bot.id,
      decision: answered || null,
      initiator: "person",
      threadId: thread.id,
    });
    this.refreshBot(bot);
    this.emit({
      botId: bot.id,
      data: question,
      threadId: thread.id,
      type: "question.answered",
    });
    this.emitForBot(bot.id, thread.id);
  }

  // --------------------------------------------------------------- rooms

  async listRooms(): Promise<Room[]> {
    return [...this.rooms]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((room) => {
        const last = this.roomMessages
          .filter((message) => message.roomId === room.id)
          .sort((a, b) => a.createdAt - b.createdAt)
          .at(-1);
        return {
          ...room,
          lastMessage: last?.content ?? null,
          lastMessageAt: last?.createdAt ?? null,
          lastSpeakerKind: last?.speakerKind ?? null,
        };
      });
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms = this.rooms.filter((room) => room.id !== roomId);
    this.roomMessages = this.roomMessages.filter((message) => message.roomId !== roomId);
  }

  async createRoom(input: CreateRoomInput): Promise<Room> {
    const room: MutableRoom = {
      createdAt: Date.now(),
      id: id("room"),
      leadBotId: input.leadBotId ?? input.memberIds[0] ?? null,
      memberIds: [...input.memberIds],
      name: input.name,
    };
    this.rooms.push(room);
    this.addRoomMessage(room.id, "system", "Room created.", "direct", null);
    this.emit({ data: null, roomId: room.id, type: "room.message" });
    return room;
  }

  async listRoomMessages(roomId: string): Promise<RoomMessage[]> {
    return this.roomMessages
      .filter((message) => message.roomId === roomId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async listRoomRuns(roomId: string): Promise<Run[]> {
    return this.runs.filter((run) => run.roomId === roomId);
  }

  async promptRoom(
    roomId: string,
    text: string,
    options?: { readonly requestKey?: string; readonly attachments?: readonly Attachment[] },
  ): Promise<void> {
    const requestKey = options?.requestKey;
    const room = this.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new Error("That room is gone.");
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Say something first.");
    const key = requestKey ? JSON.stringify([roomId, requestKey]) : undefined;
    const previous = key ? this.roomRequests.get(key) : undefined;
    if (previous !== undefined) {
      if (previous !== trimmed) throw new Error("Request key was already used with a different room message.");
      return;
    }
    if (key) this.roomRequests.set(key, trimmed);
    this.addRoomMessage(roomId, "user", trimmed, "direct", null, options?.attachments);
    const members = room.memberIds
      .map((memberId) => this.bots.find((bot) => bot.id === memberId))
      .filter((bot): bot is MutableBot => bot !== undefined);
    // Longest name wins, matching the gateway's whole-name mention rule.
    const named = members
      .filter((bot) => new RegExp(`(^|\\s)@${bot.name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$|\\s|[,.!?;:，。！？；：])`, "iu").test(trimmed))
      .sort((a, b) => b.name.length - a.name.length);
    const target = named[0] ?? members.find((bot) => bot.id === room.leadBotId);
    if (!target) {
      this.addRoomMessage(
        roomId,
        "system",
        "Nobody was addressed. Mention a Bot with @name, or set a lead.",
        "direct",
        null,
      );
      return;
    }
    this.after(900, () => {
      if (!this.rooms.includes(room) || !this.bots.includes(target)) return;
      this.addRoomMessage(
        roomId,
        "bot",
        `${target.name} here. The workbench is running against the mock transport; the room shares one transcript while each Bot keeps its own thread.`,
        "direct",
        target.id,
      );
    });
  }

  async uploadAttachment(_botId: string, file: File, _threadId?: string): Promise<Attachment> {
    return this.previewAttachment(file);
  }

  async uploadRoomAttachment(_roomId: string, file: File): Promise<Attachment> {
    return this.previewAttachment(file);
  }

  private previewAttachment(file: File): Attachment {
    const safe = file.name.replaceAll(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/u, "") || "file";
    return {
      id: id("attachment"),
      name: safe,
      path: `.scream-attachments/${id("file")}-${safe}`,
      size: file.size,
      mime: file.type || "application/octet-stream",
    };
  }

  // --------------------------------------------------------------- files

  async listFiles(botId: string, path?: string, threadId?: string): Promise<FileListing> {
    const { root, resolved } = this.filePath(botId, path, threadId);
    const files = this.files.get(root) ?? [];
    const entries = new Map<string, FileEntry>();
    const prefix = resolved.endsWith("/") ? resolved : `${resolved}/`;
    if (resolved !== root && !files.some(({ entry }) => `${root}/${entry.path}` === resolved && entry.kind === "directory" || `${root}/${entry.path}`.startsWith(prefix))) {
      throw new Error(`No such directory: ${resolved}`);
    }
    for (const { entry } of files) {
      const full = `${root}/${entry.path}`;
      if (!full.startsWith(prefix)) continue;
      const relative = full.slice(prefix.length);
      const name = relative.split("/")[0];
      if (!name) continue;
      const child = `${prefix}${name}`;
      entries.set(child, relative.includes("/") ? { path: child, kind: "directory", size: null } : { ...entry, path: child });
    }
    return { path: resolved, entries: [...entries.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)) };
  }

  async readFile(botId: string, path: string, threadId?: string): Promise<FilePreview> {
    const { root, resolved } = this.filePath(botId, path, threadId);
    const file = (this.files.get(root) ?? []).find(
      (candidate) => `${root}/${candidate.entry.path}` === resolved && candidate.entry.kind === "file",
    );
    if (!file) throw new Error(`No such file: ${resolved}`);
    const limit = 256 * 1024;
    const bytes = new TextEncoder().encode(file.content);
    const truncated = bytes.length > limit;
    const content = new TextDecoder().decode(bytes.subarray(0, limit), { stream: truncated });
    return { path: resolved, content, truncated };
  }

  private filePath(botId: string, path: string | undefined, threadId: string | undefined): { root: string; resolved: string } {
    const bot = this.requireBot(botId);
    const thread = threadId === undefined ? undefined : this.requireThread(threadId);
    if (thread && thread.botId !== bot.id) throw new Error("Thread does not belong to this Bot.");
    const root = thread ? this.threadRoots.get(thread.id) ?? bot.workspace : bot.workspace;
    const raw = (path || ".").replaceAll("\\", "/");
    const combined = raw.startsWith("/") || raw.startsWith("~") ? raw : `${root}/${raw}`;
    const parts: string[] = [];
    for (const part of combined.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    const resolved = `${combined.startsWith("/") ? "/" : ""}${parts.join("/")}`;
    if (resolved !== root && !resolved.startsWith(root.endsWith("/") ? root : `${root}/`)) throw new Error("Path is outside the preview workspace.");
    return { root, resolved };
  }

  // ------------------------------------------------------------ activity

  async listActivity(botId?: string): Promise<AuditEntry[]> {
    return this.audit
      .filter((entry) => botId === undefined || entry.botId === botId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);
  }

  // ------------------------------------------------------------- private

  private requireRun(runId: string): MutableRun {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
  }

  private isLive(run: MutableRun): boolean {
    return this.runs.includes(run) && (run.status === "running" || run.status === "waiting_user") &&
      this.threads.some((thread) => thread.id === run.threadId) && this.bots.some((bot) => bot.id === run.botId);
  }

  private scheduleBot(botId: string): void {
    for (const run of this.runs.filter((candidate) => candidate.botId === botId && candidate.status === "queued")) this.scheduleRun(run);
  }

  private scheduleRun(run: MutableRun): void {
    if (run.status !== "queued" || this.scheduledRuns.has(run.id)) return;
    const thread = this.threads.find((candidate) => candidate.id === run.threadId);
    const bot = this.bots.find((candidate) => candidate.id === run.botId);
    if (!thread || !bot || bot.paused || thread.blockedByRunId) return;
    const first = this.runs.find((candidate) => candidate.threadId === thread.id &&
      (candidate.status === "queued" || candidate.status === "running" || candidate.status === "waiting_user"));
    if (first !== run) return;
    this.scheduledRuns.add(run.id);
    this.after(120, () => {
      this.scheduledRuns.delete(run.id);
      if (!this.runs.includes(run) || run.status !== "queued" || !this.threads.includes(thread) || !this.bots.includes(bot) || bot.paused || thread.blockedByRunId) return;
      run.status = "running";
      run.dispatchStartedAt = Date.now();
      this.emitRun(run);
      this.respond(bot, thread, run, planFor(this.runInputs.get(run.id)?.text ?? ""));
    });
  }

  private emitRun(run: MutableRun): void {
    const thread = this.threads.find((candidate) => candidate.id === run.threadId);
    const bot = this.bots.find((candidate) => candidate.id === run.botId);
    if (!thread || !bot) return;
    thread.runStatus = this.runs.find((candidate) => candidate.threadId === thread.id &&
      (candidate.status === "running" || candidate.status === "waiting_user" || candidate.status === "queued"))?.status ?? null;
    this.refreshBot(bot);
    this.emit({ type: "run.updated", botId: bot.id, threadId: thread.id, data: run });
    this.emitForBot(bot.id, thread.id);
    this.scheduleBot(bot.id);
  }

  private afterRun(ms: number, run: MutableRun, fn: () => void): void {
    this.after(ms, () => { if (this.isLive(run)) fn(); });
  }

  private respond(
    bot: MutableBot,
    thread: MutableThread,
    run: MutableRun,
    plan: PromptPlan,
  ): void {
    if (plan === "approval") {
      this.respondWithApproval(bot, thread, run);
      return;
    }
    if (plan === "handoff") {
      this.respondWithHandoff(bot, thread, run);
      return;
    }
    if (plan === "question") {
      this.respondWithQuestion(bot, thread, run);
      return;
    }
    const message = this.addMessage(thread.id, "assistant", "");
    const answer =
      "Preview response: this conversation uses the in-memory mock transport. Messages, tools and inbox decisions are simulated. No command executes, no security permission is granted, and no files are read or written.";
    this.stream(bot, thread, run, message, answer, () => {
      run.status = "done";
      run.endedAt = Date.now();
      this.refreshBot(bot);
      this.emitForBot(bot.id, thread.id);
    });
  }

  private respondWithApproval(
    bot: MutableBot,
    thread: MutableThread,
    run: MutableRun,
  ): void {
    const toolCall: MutableToolCall = {
      args: { command: "pnpm -w run test:coverage" },
      endedAt: undefined,
      id: id("call"),
      name: "Bash",
      output: undefined,
      startedAt: Date.now(),
      status: "running",
    };
    const message = this.addMessage(thread.id, "assistant", "", {
      toolCalls: [toolCall],
    });
    this.emitForBot(bot.id, thread.id);

    message.runId = run.id;
    this.afterRun(700, run, () => {
      const approval: MutableApproval = {
        action: "pnpm -w run test:coverage",
        botId: bot.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * MINUTE,
        grantOptions: ["once", "session"],
        id: id("approval"),
        reasons: ["Preview decision only — no command executes and no security permission is granted"],
        runId: run.id,
        status: "pending",
        threadId: thread.id,
        toolName: "Bash",
      };
      this.approvals.push(approval);
      run.status = "waiting_user";
      this.emitRun(run);
      this.refreshBot(bot);
      this.record({
        action: "approval.requested",
        actor: bot.name,
        botId: bot.id,
        decision: null,
        initiator: "person",
        threadId: thread.id,
      });
      this.emit({
        botId: bot.id,
        data: approval,
        threadId: thread.id,
        type: "approval.requested",
      });
      this.emitForBot(bot.id, thread.id);
    });
  }

  private respondWithQuestion(
    bot: MutableBot,
    thread: MutableThread,
    run: MutableRun,
  ): void {
    const message = this.addMessage(thread.id, "assistant", "");
    this.stream(
      bot,
      thread,
      run,
      message,
      "Before I go further, two decisions are yours.",
      () => {
        const question: MutableQuestion = {
          botId: bot.id,
          createdAt: Date.now(),
          id: id("question"),
          items: [
            {
              allowOther: true,
              header: "Workspace",
              id: "workspace",
              multiple: false,
              options: [
                {
                  description: "Keep the bot's files beside the app.",
                  label: "Reuse ~/Projects/scream-code",
                },
                {
                  description: "A clean tree, isolated from the app.",
                  label: "Create ~/Projects/workbench",
                },
              ],
              question: "Where should the new Bot keep its files?",
            },
            {
              allowOther: true,
              header: "Permissions",
              id: "permission",
              multiple: true,
              options: [
                { label: "Read files" },
                { label: "Write files" },
                { label: "Run shell commands" },
              ],
              question: "Which activities should this preview describe?",
            },
          ],
          runId: run.id,
          status: "pending",
          threadId: thread.id,
        };
        this.questions.push(question);
        run.status = "waiting_user";
        this.refreshBot(bot);
        this.emit({
          botId: bot.id,
          data: question,
          threadId: thread.id,
          type: "question.requested",
        });
        this.emitForBot(bot.id, thread.id);
      },
    );
  }

  private respondWithHandoff(
    bot: MutableBot,
    thread: MutableThread,
    run: MutableRun,
  ): void {
    const target =
      this.bots.find((candidate) => candidate.id !== bot.id && !candidate.paused) ??
      this.bots.find((candidate) => candidate.id !== bot.id);
    if (!target) {
      this.addMessage(
        thread.id,
        "assistant",
        "There is nobody to hand this to yet. Create a second Bot first.",
      );
      run.status = "done";
      run.endedAt = Date.now();
      this.emitRun(run);
      this.refreshBot(bot);
      this.emitForBot(bot.id, thread.id);
      return;
    }
    const task =
      "Audit the shell against the plan, list the components worth vendoring, and report any dependency the package is missing.";
    const toolCall: MutableToolCall = {
      args: { bot: target.name, expecting: "A short audit", task },
      endedAt: undefined,
      id: id("call"),
      name: "message_bot",
      output: undefined,
      startedAt: Date.now(),
      status: "running",
    };
    const message = this.addMessage(thread.id, "assistant", "", {
      toolCalls: [toolCall],
    });

    message.runId = run.id;
    this.afterRun(600, run, () => {
      toolCall.status = "done";
      toolCall.endedAt = Date.now();
      toolCall.output = `Queued for ${target.name}.`;
      const handoff: MutableHandoff = {
        answer: null,
        completedAt: null,
        createdAt: Date.now(),
        error: null,
        fromBotId: bot.id,
        fromThreadId: thread.id,
        id: id("handoff"),
        status: "queued",
        task,
        toBotId: target.id,
        toThreadId: null,
      };
      this.handoffs.push(handoff);
      const updated: MutableMessage = {
        ...message,
        handoff,
      };
      Object.assign(message, updated);
      this.emit({
        botId: bot.id,
        data: handoff,
        threadId: thread.id,
        type: "handoff.updated",
      });
      this.emitForBot(bot.id, thread.id);

      this.stream(
        bot,
        thread,
        run,
        undefined,
        `Handed the audit to ${target.name}. I'll keep working here — their answer lands in their thread, and you'll see a pointer in this one.`,
        () => {
          run.status = "done";
          run.endedAt = Date.now();
          this.refreshBot(bot);
          this.emitForBot(bot.id, thread.id);
          this.after(1200, () => this.deliverHandoff(handoff, bot, target));
        },
      );
    });
  }

  private deliverHandoff(
    handoff: MutableHandoff,
    from: MutableBot,
    to: MutableBot,
  ): void {
    if (!this.bots.includes(from) || !this.bots.includes(to) || !this.threads.some((thread) => thread.id === handoff.fromThreadId)) return;
    handoff.status = "running";
    this.emit({
      botId: to.id,
      data: handoff,
      threadId: handoff.fromThreadId,
      type: "handoff.updated",
    });
    const targetThread = this.threads.find(
      (thread) => thread.botId === to.id,
    );
    if (!targetThread) {
      handoff.status = "failed";
      handoff.error = "Target has no thread.";
      this.emitForBot(from.id, handoff.fromThreadId);
      return;
    }
    handoff.toThreadId = targetThread.id;
    this.addMessage(
      targetThread.id,
      "user",
      `From ${from.name}: ${handoff.task}`,
    );
    targetThread.lastActiveAt = Date.now();
    to.lastActiveAt = Date.now();
    this.refreshBot(to);
    this.emitForBot(to.id, targetThread.id);

    this.after(2600, () => {
      if (!this.bots.includes(from) || !this.bots.includes(to) || !this.threads.includes(targetThread) || !this.threads.some((thread) => thread.id === handoff.fromThreadId)) return;
      handoff.status = "delivered";
      const answer =
        "Audit done. The shell, roster, transcript and drawers reuse the local primitives; the chat layer is ours. Two dependencies are absent from the package: `embla-carousel-react` and `@shadcn/react` — both were replaced locally rather than added.";
      handoff.answer = answer;
      handoff.completedAt = Date.now();
      this.addMessage(targetThread.id, "assistant", answer);
      targetThread.unread += 1;
      this.refreshBot(to);
      this.addMessage(
        handoff.fromThreadId,
        "system",
        `${to.name} answered. The reply stays in their thread; open ${to.name} to read it.`,
      );
      const sourceMessage = this.messages.find(
        (message) => message.handoff?.id === handoff.id,
      );
      if (sourceMessage?.handoff) {
        sourceMessage.handoff = { ...sourceMessage.handoff, status: "delivered" };
      }
      this.record({
        action: "handoff.delivered",
        actor: to.name,
        botId: to.id,
        decision: null,
        initiator: "handoff",
        threadId: targetThread.id,
      });
      this.refreshBot(from);
      this.emit({
        botId: from.id,
        data: handoff,
        threadId: handoff.fromThreadId,
        type: "handoff.updated",
      });
      this.emitForBot(to.id, targetThread.id);
      this.emitForBot(from.id, handoff.fromThreadId);
    });
  }

  private stream(
    bot: MutableBot,
    thread: MutableThread,
    run: MutableRun,
    message: MutableMessage | undefined,
    text: string,
    done: () => void,
  ): void {
    const target = message ?? this.addMessage(thread.id, "assistant", "");
    target.runId = run.id;
    let cursor = 0;
    const step = () => {
      if (!this.isLive(run) || !this.messages.includes(target)) return;
      cursor = Math.min(text.length, cursor + 3 + Math.floor(Math.random() * 4));
      target.content = text.slice(0, cursor);
      this.emit({
        botId: bot.id,
        data: { content: target.content, messageId: target.id },
        threadId: thread.id,
        type: "assistant.delta",
      });
      if (cursor < text.length) {
        this.after(16, step);
        return;
      }
      this.emitForBot(bot.id, thread.id);
      done();
      this.emitRun(run);
    };
    this.after(120, step);
  }

  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private emitForBot(botId: string, threadId?: string): void {
    this.emit({
      botId,
      data: null,
      threadId,
      type: threadId ? "thread.updated" : "bot.updated",
    });
  }

  private emit(event: Omit<ServerEvent, "epoch" | "seq">): void {
    this.seq += 1;
    // Deliver value snapshots, just as JSON transport would, rather than mutable references.
    const frame: ServerEvent = structuredClone({ ...event, epoch: this.epoch, seq: this.seq });
    for (const listener of this.listeners) listener(frame);
  }

  private record(entry: Omit<AuditEntry, "createdAt" | "id">): void {
    this.audit.push({
      ...entry,
      createdAt: Date.now(),
      id: this.audit.length + 1,
    });
  }

  private addThread(bot: MutableBot, title: string): MutableThread {
    const thread: MutableThread = {
      archivedAt: null,
      botId: bot.id,
      id: id("thread"),
      lastActiveAt: Date.now(),
      runStatus: null,
      title,
      unread: 0,
    };
    this.threads.push(thread);
    this.threadRoots.set(thread.id, bot.workspace);
    return thread;
  }

  private addMessage(
    threadId: string,
    role: Message["role"],
    content: string,
    extra?: {
      toolCalls?: MutableToolCall[];
      handoff?: MutableHandoff;
      attachments?: readonly Attachment[];
    },
  ): MutableMessage {
    const message: MutableMessage = {
      content,
      createdAt: Date.now(),
      id: id("message"),
      role,
      threadId,
      ...extra,
    };
    this.messages.push(message);
    return message;
  }

  private addRoomMessage(
    roomId: string,
    speakerKind: RoomMessage["speakerKind"],
    content: string,
    via: RoomMessage["via"],
    speakerId: string | null,
    attachments?: readonly Attachment[],
  ): MutableRoomMessage {
    const message: MutableRoomMessage = {
      answeredBy: via === "handoff" ? speakerId : null,
      content,
      createdAt: Date.now(),
      id: id("room-message"),
      roomId,
      speakerId: speakerId ?? "you",
      speakerKind,
      via,
      ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
    };
    this.roomMessages.push(message);
    this.emit({ data: message, roomId, type: "room.message" });
    return message;
  }

  private requireBot(botId: string): MutableBot {
    const bot = this.bots.find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Unknown Bot: ${botId}`);
    return bot;
  }

  private requireThread(threadId: string): MutableThread {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    return thread;
  }

  private refreshBot(bot: MutableBot): void {
    const pending =
      this.approvals.filter(
        (approval) =>
          approval.botId === bot.id && approval.status === "pending",
      ).length +
      this.questions.filter(
        (question) =>
          question.botId === bot.id && question.status === "pending",
      ).length +
      this.handoffs.filter(
        (handoff) =>
          handoff.fromBotId === bot.id &&
          (handoff.status === "queued" || handoff.status === "failed"),
      ).length;
    bot.needsYou = pending;
    bot.unread = this.threads
      .filter((thread) => thread.botId === bot.id)
      .reduce((total, thread) => total + thread.unread, 0);
    const active = this.runs.find(
      (run) =>
        run.botId === bot.id &&
        (run.status === "queued" ||
          run.status === "running" ||
          run.status === "waiting_user"),
    );
    const status: BotStatus = bot.paused
      ? "paused"
      : active
        ? active.status === "waiting_user"
          ? "needs_you"
          : "working"
        : "idle";
    bot.status = status;
  }

  // ----------------------------------------------------------------- seed

  private seed(): void {
    const now = Date.now();
    const scream: MutableBot = {
      avatarSeed: "scream",
      id: "bot-scream",
      lastActiveAt: now - 12 * MINUTE,
      model: "default",
      name: "Scream",
      needsYou: 0,
      paused: false,
      permission: "bot",
      rolePrompt:
        "You are Scream, the lead Bot of this workbench. You plan, write code, and hand specialised work to the other Bots.",
      status: "idle",
      thinking: "medium",
      title: "Lead bot",
      toolPolicy: { handoff: true },
      unread: 0,
      workspace: "~/Projects/scream-code",
    };
    const research: MutableBot = {
      avatarSeed: "research",
      id: "bot-research",
      lastActiveAt: now - 38 * MINUTE,
      model: "default",
      name: "Research",
      needsYou: 0,
      paused: false,
      permission: "bot",
      rolePrompt:
        "You are Research. You investigate, read source, and report findings with citations to files.",
      status: "idle",
      thinking: "high",
      title: "Investigator",
      toolPolicy: { handoff: false },
      unread: 0,
      workspace: "~/Projects/research",
    };
    const ops: MutableBot = {
      avatarSeed: "ops",
      id: "bot-ops",
      lastActiveAt: now - 26 * HOUR,
      model: "default",
      name: "Ops",
      needsYou: 0,
      paused: true,
      permission: "bot",
      rolePrompt:
        "You are Ops. You watch releases, run the gates, and report what is broken.",
      status: "paused",
      thinking: "low",
      title: "Release & infra",
      toolPolicy: { handoff: false },
      unread: 0,
      workspace: "~/Projects/scream-code",
    };
    this.bots.push(scream, research, ops);

    const screamThread: MutableThread = {
      archivedAt: null,
      botId: scream.id,
      id: "thread-scream-main",
      lastActiveAt: now - 12 * MINUTE,
      runStatus: null,
      title: "Workbench from plan to UI",
      unread: 0,
    };
    const researchThread: MutableThread = {
      archivedAt: null,
      botId: research.id,
      id: "thread-research-main",
      lastActiveAt: now - 38 * MINUTE,
      runStatus: null,
      title: "Vendor UI inventory",
      unread: 0,
    };
    const opsThread: MutableThread = {
      archivedAt: null,
      botId: ops.id,
      id: "thread-ops-main",
      lastActiveAt: now - 26 * HOUR,
      runStatus: null,
      title: "Release checklist",
      unread: 0,
    };
    this.threads.push(screamThread, researchThread, opsThread);
    this.threadRoots.set(screamThread.id, scream.workspace);
    this.threadRoots.set(researchThread.id, research.workspace);
    this.threadRoots.set(opsThread.id, ops.workspace);

    this.addMessage(
      screamThread.id,
      "system",
      "Mock preview only. Tools, inbox decisions and answers are simulated; no security approval is granted. Workspace: ~/Projects/scream-code.",
    ).createdAt = now - 58 * MINUTE;
    this.addMessage(
      screamThread.id,
      "user",
      "Take the workbench plan from doc to a clickable UI. Roster, chat, approvals, hand-off — all of it.",
    ).createdAt = now - 56 * MINUTE;

    const readCall = {
      args: { path: "plans/workbench.md" },
      endedAt: now - 52 * MINUTE,
      id: "call-read-plan",
      name: "Read",
      output: "358 lines — milestones M0 to M4, UI structure, vendoring rules.",
      startedAt: now - 53 * MINUTE,
      status: "done" as const,
    };
    const bashCall = {
      args: { command: "pnpm exec tsc -p src/bot/ui/tsconfig.json --noEmit" },
      endedAt: now - 44 * MINUTE,
      id: "call-tsc",
      name: "Bash",
      output: "Preview fixture: simulated typecheck output; no command ran.",
      startedAt: now - 45 * MINUTE,
      status: "done" as const,
    };
    this.addMessage(
      screamThread.id,
      "assistant",
      "Preview transcript with simulated tool results. Two sample inbox items demonstrate decision handling; neither grants permissions nor executes commands.",
      { toolCalls: [readCall, bashCall] },
    ).createdAt = now - 43 * MINUTE;

    const handoff: MutableHandoff = {
      answer: null,
      completedAt: null,
      createdAt: now - 35 * MINUTE,
      error: null,
      fromBotId: scream.id,
      fromThreadId: screamThread.id,
      id: "handoff-seed",
      status: "running",
      task: "Audit the shell and list the components that still assume a remote platform.",
      toBotId: research.id,
      toThreadId: researchThread.id,
    };
    this.handoffs.push(handoff);
    this.addMessage(
      screamThread.id,
      "assistant",
      "I asked Research to audit the shell in parallel. Their answer will land in their thread.",
      { handoff, toolCalls: [] },
    ).createdAt = now - 35 * MINUTE;

    this.addMessage(
      researchThread.id,
      "user",
      "From Scream: Audit the shell and note which pieces still assume a remote platform.",
    ).createdAt = now - 34 * MINUTE;
    this.addMessage(
      researchThread.id,
      "assistant",
      "Started the audit. The chat layer, the profile pages and the settings tabs are the parts with platform assumptions; the primitives are clean. Full report once I have read the last directory.",
    ).createdAt = now - 20 * MINUTE;
    researchThread.unread = 1;

    this.addMessage(
      opsThread.id,
      "user",
      "What is blocking the release?",
    ).createdAt = now - 27 * HOUR;
    this.addMessage(
      opsThread.id,
      "assistant",
      "Nothing blocking. The gates pass; the only open item is the soak test on the new stream.",
    ).createdAt = now - 26 * HOUR;

    const seededApproval: MutableApproval = {
      action: "pnpm -w run test:coverage",
      botId: scream.id,
      createdAt: now - 9 * MINUTE,
      expiresAt: now + 21 * MINUTE,
      grantOptions: ["once", "session"],
      id: "approval-seed",
      reasons: ["Preview decision only — no command executes and no security permission is granted"],
      runId: null,
      status: "pending",
      threadId: screamThread.id,
      toolName: "Bash",
    };
    this.approvals.push(seededApproval);

    const seededQuestion: MutableQuestion = {
      botId: scream.id,
      createdAt: now - 8 * MINUTE,
      id: "question-seed",
      items: [
        {
          allowOther: true,
          header: "Composer",
          id: "composer",
          multiple: false,
          options: [
            { label: "Send now" },
            { label: "Add to the queue" },
            { label: "Ask before sending" },
          ],
          question: "How should Enter behave in the composer?",
        },
      ],
      runId: null,
      status: "pending",
      threadId: screamThread.id,
    };
    this.questions.push(seededQuestion);

    const room: MutableRoom = {
      createdAt: now - 5 * HOUR,
      id: "room-workbench",
      leadBotId: scream.id,
      memberIds: [scream.id, research.id],
      name: "Workbench",
    };
    this.rooms.push(room);
    this.roomMessages.push(
      {
        answeredBy: null,
        content: "Room created for the workbench rollout.",
        createdAt: now - 5 * HOUR,
        id: "room-message-1",
        roomId: room.id,
        speakerId: "you",
        speakerKind: "system",
        via: "direct",
      },
      {
        answeredBy: null,
        content: "@Research how many primitives ended up local?",
        createdAt: now - 4 * HOUR,
        id: "room-message-2",
        roomId: room.id,
        speakerId: "you",
        speakerKind: "user",
        via: "direct",
      },
      {
        answeredBy: null,
        content:
          "Twenty-six. Twenty-three shared as-is, three rebuilt locally because their original packages are not dependencies here.",
        createdAt: now - 4 * HOUR + 40_000,
        id: "room-message-3",
        roomId: room.id,
        speakerId: research.id,
        speakerKind: "bot",
        via: "direct",
      },
    );

    this.files.set(scream.workspace, [
      {
        content:
          "import { StrictMode } from \"react\";\nimport { createRoot } from \"react-dom/client\";\n\ncreateRoot(document.getElementById(\"root\")!).render(<StrictMode>{/* app */}</StrictMode>);\n",
        entry: { kind: "file", path: "src/bot/ui/main.tsx", size: 212 },
      },
      {
        content:
          "export const router = createRouter({ routeTree });\n",
        entry: { kind: "file", path: "src/bot/ui/router.tsx", size: 64 },
      },
      {
        content:
          "@import \"tailwindcss\";\n\n:root {\n  --brand: oklch(0.52 0.1 186);\n}\n",
        entry: { kind: "file", path: "src/bot/ui/styles/tokens.css", size: 78 },
      },
      {
        content:
          "{\n  \"name\": \"scream-code\",\n  \"private\": true\n}\n",
        entry: { kind: "file", path: "package.json", size: 52 },
      },
      {
        content: "",
        entry: { kind: "directory", path: "src", size: null },
      },
    ]);
    this.files.set(research.workspace, [
      {
        content: "# Vendor audit\n\n- Shell: adapted\n- Chat: rewritten\n",
        entry: { kind: "file", path: "audit.md", size: 54 },
      },
    ]);

    this.audit.push(
      {
        action: "bot.created",
        actor: "you",
        botId: scream.id,
        createdAt: now - 6 * HOUR,
        decision: null,
        id: 1,
        initiator: "person",
        threadId: null,
      },
      {
        action: "handoff.queued",
        actor: "Scream",
        botId: research.id,
        createdAt: now - 35 * MINUTE,
        decision: null,
        id: 2,
        initiator: "handoff",
        threadId: researchThread.id,
      },
      {
        action: "approval.requested",
        actor: "Scream",
        botId: scream.id,
        createdAt: now - 9 * MINUTE,
        decision: null,
        id: 3,
        initiator: "person",
        threadId: screamThread.id,
      },
      {
        action: "question.requested",
        actor: "Scream",
        botId: scream.id,
        createdAt: now - 8 * MINUTE,
        decision: null,
        id: 4,
        initiator: "person",
        threadId: screamThread.id,
      },
    );

    this.refreshBot(scream);
    this.refreshBot(research);
    this.refreshBot(ops);
  }
}
