import type {
  Approval,
  ApprovalResponse,
  AuditEntry,
  Bot,
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
  TranscriptSnapshot,
  UpdateBotInput,
} from "../../../shared/contracts";
import type { BotClient, FileEntry, Inbox, RecoveryDecision } from "../client";
import { transcriptGeneration, versionTranscript } from "./message-state";
import { BotSseParser, StreamProtocolError, retryDelay, type BotConnectionState, type BotConnectionStatus, type SseFrame } from "./transport";

interface ServerFileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir";
  readonly size: number;
}

interface ServerFileList {
  readonly path: string;
  readonly entries: readonly ServerFileEntry[];
}

interface ServerFileContent {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

/** REST + SSE transport for the Bot gateway. */
export class HttpBotClient implements BotClient {
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly connectionListeners = new Set<() => void>();
  private connection: BotConnectionState = { status: "disconnected", error: null, retryInMs: null };
  private controller: AbortController | undefined;
  private cursor: string | undefined;
  private requestSequence = 0;
  private acceptedEpoch: string | undefined;
  private epochBarrier = 0;
  private readonly retiredEpochs = new Set<string>();

  constructor(private readonly baseUrl = "") {}

  getConnectionState = (): BotConnectionState => this.connection;

  subscribeConnectionState = (listener: () => void): (() => void) => {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  };

  private setConnection(status: BotConnectionStatus, error: string | null = null, retryInMs: number | null = null): void {
    this.connection = { status, error, retryInMs };
    for (const listener of this.connectionListeners) listener();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body.error?.message !== undefined) message = body.error.message;
      } catch {
        // Keep the status fallback when the body is not JSON.
      }
      throw new Error(message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.controller === undefined) {
      const controller = new AbortController();
      this.controller = controller;
      void this.pump(controller);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.controller?.abort();
      this.controller = undefined;
      this.setConnection("disconnected");
    };
  }

  /**
   * Epochs are opaque, not lexically ordered. Only a request started after the last
   * epoch acceptance may introduce an unknown epoch. Fence ALL requests already in
   * flight at that acceptance, including requests that have not returned once yet.
   * A rejected concurrent restart is rediscovered by the next poll/reconnect.
   */
  private acceptEpoch(epoch: string, requestSequence: number): number | undefined {
    if (epoch === this.acceptedEpoch) return transcriptGeneration(epoch);
    if (this.retiredEpochs.has(epoch) || requestSequence <= this.epochBarrier) return undefined;
    if (this.acceptedEpoch !== undefined) this.retiredEpochs.add(this.acceptedEpoch);
    this.acceptedEpoch = epoch;
    this.epochBarrier = this.requestSequence;
    return transcriptGeneration(epoch);
  }

  private dispatchFrame(frame: SseFrame, requestSequence: number): void {
    if (frame.id === "") this.cursor = undefined;
    if (frame.data === "" || frame.event === "ping") {
      if (frame.id !== undefined && frame.id !== "") this.cursor = frame.id;
      return;
    }
    let value: unknown;
    try { value = JSON.parse(frame.data); }
    catch { throw new StreamProtocolError("Invalid JSON in event stream"); }
    if (typeof value !== "object" || value === null) throw new StreamProtocolError("Invalid event stream frame");
    const record = value as Record<string, unknown>;
    if (typeof record["epoch"] !== "string" || !/^[^\s:]+$/.test(record["epoch"]) ||
      !Number.isSafeInteger(record["seq"]) || (record["seq"] as number) < 0) {
      throw new StreamProtocolError("Event stream frame is missing its epoch/sequence watermark");
    }
    const expectedId = `${record["epoch"]}:${String(record["seq"])}`;
    if (frame.id !== undefined && frame.id !== "" && frame.id !== expectedId) {
      throw new StreamProtocolError("Event stream cursor does not match its watermark");
    }
    const changedEpoch = this.acceptedEpoch !== undefined && this.acceptedEpoch !== record["epoch"];
    if (this.acceptEpoch(record["epoch"], requestSequence) === undefined) {
      throw new Error("Stale event stream epoch; reconnecting");
    }
    if (frame.event === "snapshot") {
      // Snapshot carries a checkpoint, not a partial replacement for all query domains.
      this.emit({ ...record, type: "resync", data: { reason: "snapshot" } } as unknown as ServerEvent);
    } else {
      if (typeof record["type"] !== "string") throw new StreamProtocolError("Event stream frame has no event type");
      if (["assistant.delta", "message.created", "tool.updated"].includes(record["type"])) {
        const data = record["data"];
        const version = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["version"] : undefined;
        if (!Number.isSafeInteger(version) || (version as number) < 0) {
          throw new StreamProtocolError("Transcript event is missing its projection version");
        }
      }
      if (changedEpoch && record["type"] !== "resync") {
        this.emit({ ...record, type: "resync", data: { reason: "epoch_mismatch" } } as unknown as ServerEvent);
      }
      this.emit(value as ServerEvent);
    }
    // Advance only after consumers have observed the frame. Blank id explicitly resets it.
    if (frame.id !== "") this.cursor = frame.id ?? expectedId;
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async pump(controller: AbortController): Promise<void> {
    const signal = controller.signal;
    let failures = 0;
    while (!signal.aborted) {
      this.setConnection(failures === 0 ? "connecting" : "reconnecting");
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let healthy = false;
      try {
        const requestSequence = ++this.requestSequence;
        const response = await fetch(`${this.baseUrl}/api/events`, {
          headers: {
            accept: "text/event-stream",
            ...(this.cursor === undefined ? {} : { "Last-Event-ID": this.cursor }),
          },
          signal,
        });
        if (signal.aborted) { await response.body?.cancel(); return; }
        if (!response.ok) {
          await response.body?.cancel();
          const message = `Event stream failed (${response.status})`;
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new StreamProtocolError(message);
          }
          throw new Error(message);
        }
        if (response.body === null || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
          await response.body?.cancel();
          throw new StreamProtocolError("Expected a text/event-stream response");
        }
        reader = response.body.getReader();
        const parser = new BotSseParser((frame) => {
          if (signal.aborted) return;
          this.dispatchFrame(frame, requestSequence);
          // A successful frame/heartbeat establishes health, unlike a bare HTTP 200.
          healthy = true;
        });
        this.setConnection("connected");
        const cancel = () => { void reader?.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          while (!signal.aborted) {
            const result = await reader.read();
            if (result.done) break;
            parser.push(result.value);
          }
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        if (signal.aborted) return;
        throw new Error("Event stream disconnected");
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof StreamProtocolError) {
          this.setConnection("error", message);
          return;
        }
        if (healthy) failures = 0;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
        failures += 1;
        this.setConnection("offline", message, delay);
        await retryDelay(signal, delay);
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    }
  }

  async listBots(): Promise<Bot[]> {
    const bots = await this.request<readonly Bot[]>("/api/bots");
    return [...bots];
  }

  async getBot(botId: string): Promise<Bot | undefined> {
    const bots = await this.listBots();
    return bots.find((bot) => bot.id === botId);
  }

  createBot(input: CreateBotInput): Promise<Bot> {
    return this.request<Bot>("/api/bots", { method: "POST", body: JSON.stringify(input) });
  }

  async updateBot(botId: string, input: UpdateBotInput): Promise<Bot> {
    // PATCH acknowledges the saved Bot and reports SDK apply state separately.
    const result = await this.request<{ readonly bot: Bot; readonly config: unknown }>(`/api/bots/${encodeURIComponent(botId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return result.bot;
  }

  async deleteBot(botId: string): Promise<void> {
    await this.request<void>(`/api/bots/${encodeURIComponent(botId)}`, { method: "DELETE" });
  }

  setPaused(botId: string, paused: boolean): Promise<Bot> {
    return this.request<Bot>(
      `/api/bots/${encodeURIComponent(botId)}/${paused ? "pause" : "resume"}`,
      { method: "POST" },
    );
  }

  async listThreads(botId: string): Promise<Thread[]> {
    const threads = await this.request<readonly Thread[]>(
      `/api/bots/${encodeURIComponent(botId)}/threads`,
    );
    return [...threads];
  }

  createThread(botId: string, input?: CreateThreadInput): Promise<Thread> {
    return this.request<Thread>(`/api/bots/${encodeURIComponent(botId)}/threads`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request<void>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    });
  }

  async listMessages(threadId: string): Promise<Message[]> {
    const requestSequence = ++this.requestSequence;
    // REST wire DTO includes the same required hub epoch as SSE, even without a
    // working event connection. BotClient continues to expose Message[] only.
    const snapshot = await this.request<TranscriptSnapshot & { readonly epoch: string }>(`/api/threads/${encodeURIComponent(threadId)}/messages`);
    if (snapshot.threadId !== threadId || typeof snapshot.epoch !== "string" || !/^[^\s:]+$/.test(snapshot.epoch) ||
      !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 || !Array.isArray(snapshot.messages)) {
      throw new Error("Invalid transcript snapshot");
    }
    const generation = this.acceptEpoch(snapshot.epoch, requestSequence);
    if (generation === undefined) throw new Error("Stale transcript epoch");
    return versionTranscript([...snapshot.messages], snapshot.version, generation);
  }

  prompt(threadId: string, input: PromptInput): Promise<{ runId: string }> {
    return this.request<{ runId: string }>(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async interrupt(threadId: string): Promise<void> {
    await this.request<void>(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, {
      method: "POST",
    });
  }

  async cancelRun(runId: string): Promise<void> {
    await this.request<Run>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  }

  async recoverRun(runId: string, decision: RecoveryDecision): Promise<{ runId?: string }> {
    const result = await this.request<{ readonly run: Run; readonly retryRun: Run | null }>(
      `/api/runs/${encodeURIComponent(runId)}/recovery`,
      { method: "POST", body: JSON.stringify({ decision }) },
    );
    return result.retryRun === null ? {} : { runId: result.retryRun.id };
  }

  async markThreadRead(threadId: string): Promise<void> {
    await this.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ unread: false }),
    });
  }

  async listRuns(botId?: string): Promise<Run[]> {
    const query = botId === undefined ? "" : `?botId=${encodeURIComponent(botId)}`;
    const runs = await this.request<readonly Run[]>(`/api/runs${query}`);
    return [...runs];
  }

  async listInbox(): Promise<Inbox> {
    const inbox = await this.request<{
      readonly approvals: readonly Approval[];
      readonly questions: readonly Question[];
      readonly handoffs: readonly Handoff[];
    }>("/api/inbox");
    return {
      approvals: inbox.approvals,
      questions: inbox.questions,
      handoffs: inbox.handoffs ?? [],
    };
  }

  async listHandoffs(
    options: { readonly botId?: string; readonly threadId?: string; readonly limit?: number } = {},
  ): Promise<Handoff[]> {
    const query = new URLSearchParams();
    if (options.botId !== undefined) query.set("botId", options.botId);
    if (options.threadId !== undefined) query.set("threadId", options.threadId);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const handoffs = await this.request<readonly Handoff[]>(`/api/handoffs${suffix}`);
    return [...handoffs];
  }

  async decideApproval(approvalId: string, response: ApprovalResponse): Promise<void> {
    await this.request<void>(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      body: JSON.stringify(response),
    });
  }

  async answerQuestion(questionId: string, response: QuestionResponse): Promise<void> {
    await this.request<void>(`/api/questions/${encodeURIComponent(questionId)}`, {
      method: "POST",
      body: JSON.stringify(response),
    });
  }

  async listRooms(): Promise<Room[]> {
    const rooms = await this.request<readonly Room[]>("/api/rooms");
    return [...rooms];
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.request<void>(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
  }

  async createRoom(input: CreateRoomInput): Promise<Room> {
    return this.request<Room>("/api/rooms", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listRoomMessages(roomId: string): Promise<RoomMessage[]> {
    const result = await this.request<{ readonly messages: readonly RoomMessage[]; readonly runs: readonly Run[] }>(
      `/api/rooms/${encodeURIComponent(roomId)}/messages`,
    );
    return [...result.messages];
  }

  async listRoomRuns(roomId: string): Promise<Run[]> {
    // Room messages and attributed runs share one server envelope, while the
    // BotClient boundary keeps both query results as arrays.
    const result = await this.request<{ readonly messages: readonly RoomMessage[]; readonly runs: readonly Run[] }>(
      `/api/rooms/${encodeURIComponent(roomId)}/messages`,
    );
    return [...result.runs];
  }

  async promptRoom(roomId: string, text: string, requestKey?: string): Promise<void> {
    await this.request<{ runId: string }>(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, ...(requestKey === undefined ? {} : { requestKey }) }),
    });
  }

  async listFiles(botId: string, path?: string, threadId?: string): Promise<{ path: string; entries: FileEntry[] }> {
    const query = new URLSearchParams();
    if (path !== undefined) query.set("path", path);
    if (threadId !== undefined) query.set("threadId", threadId);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const result = await this.request<ServerFileList>(`/api/bots/${encodeURIComponent(botId)}/files${suffix}`);
    return {
      path: result.path,
      entries: result.entries.map((entry) => ({
        path: entry.path,
        kind: entry.type === "dir" ? "directory" : "file",
        size: entry.size,
      })),
    };
  }

  async readFile(botId: string, path: string, threadId?: string): Promise<ServerFileContent> {
    const query = new URLSearchParams({ path });
    if (threadId !== undefined) query.set("threadId", threadId);
    return this.request<ServerFileContent>(`/api/bots/${encodeURIComponent(botId)}/files?${query.toString()}`);
  }

  async listActivity(botId?: string): Promise<AuditEntry[]> {
    if (botId === undefined) {
      const bots = await this.listBots();
      const entries = await Promise.all(
        bots.map((bot) =>
          this.request<readonly AuditEntry[]>(`/api/bots/${encodeURIComponent(bot.id)}/audit`),
        ),
      );
      return entries.flat().toSorted((a, b) => b.createdAt - a.createdAt);
    }
    const entries = await this.request<readonly AuditEntry[]>(
      `/api/bots/${encodeURIComponent(botId)}/audit`,
    );
    return [...entries];
  }
}
