/**
 * What the workbench asks of its data source.
 *
 * The gateway implements this over REST + SSE. Until it exists, `MockBotClient` implements it in
 * memory. Components only ever see this interface, so swapping the transport is one file.
 */
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
  UpdateBotInput,
} from "../../shared/contracts";

export interface FileEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number | null;
}

export interface FileListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
}

export interface FilePreview {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export type RecoveryDecision = "continue_queue" | "retry" | "cancel_queue";

export interface Inbox {
  readonly approvals: readonly Approval[];
  readonly questions: readonly Question[];
  readonly handoffs: readonly Handoff[];
}

export interface BotClient {
  subscribe(listener: (event: ServerEvent) => void): () => void;

  listBots(): Promise<Bot[]>;
  getBot(botId: string): Promise<Bot | undefined>;
  createBot(input: CreateBotInput): Promise<Bot>;
  updateBot(botId: string, input: UpdateBotInput): Promise<Bot>;
  deleteBot(botId: string): Promise<void>;
  setPaused(botId: string, paused: boolean): Promise<Bot>;

  listThreads(botId: string): Promise<Thread[]>;
  createThread(botId: string, input?: CreateThreadInput): Promise<Thread>;
  deleteThread(threadId: string): Promise<void>;
  listMessages(threadId: string): Promise<Message[]>;
  prompt(threadId: string, input: PromptInput): Promise<{ runId: string }>;
  interrupt(threadId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  recoverRun(runId: string, decision: RecoveryDecision): Promise<{ runId?: string }>;
  markThreadRead(threadId: string): Promise<void>;

  listRuns(botId?: string): Promise<Run[]>;
  listInbox(): Promise<Inbox>;
  listHandoffs(options?: {
    readonly botId?: string;
    readonly threadId?: string;
    readonly limit?: number;
  }): Promise<Handoff[]>;
  decideApproval(approvalId: string, response: ApprovalResponse): Promise<void>;
  answerQuestion(questionId: string, response: QuestionResponse): Promise<void>;

  listRooms(): Promise<Room[]>;
  deleteRoom(roomId: string): Promise<void>;
  createRoom(input: CreateRoomInput): Promise<Room>;
  listRoomMessages(roomId: string): Promise<RoomMessage[]>;
  listRoomRuns(roomId: string): Promise<Run[]>;
  promptRoom(roomId: string, text: string, requestKey?: string): Promise<void>;

  listFiles(botId: string, path?: string, threadId?: string): Promise<FileListing>;
  readFile(botId: string, path: string, threadId?: string): Promise<FilePreview>;
  listActivity(botId?: string): Promise<AuditEntry[]>;
}
