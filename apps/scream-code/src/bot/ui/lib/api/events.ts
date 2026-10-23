import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { Message, ServerEvent } from "../../../shared/contracts";
import { getBotClient } from "./client";
import { fenceTranscript, stampTranscript, upsertLiveMessage } from "./message-state";
import { queryKeys } from "./queries";
import type { BotConnectionState } from "./transport";
import type { BotClient } from "../client";

interface ConnectionObservable {
  getConnectionState(): BotConnectionState;
  subscribeConnectionState(listener: () => void): () => void;
}

function observesConnection(client: BotClient): client is BotClient & ConnectionObservable {
  return "getConnectionState" in client && typeof client.getConnectionState === "function" &&
    "subscribeConnectionState" in client && typeof client.subscribeConnectionState === "function";
}

const LOCAL_CONNECTION: BotConnectionState = { status: "local", error: null, retryInMs: null };
const localConnection = () => LOCAL_CONNECTION;
const noConnectionSubscription = () => () => {};

/** Mock/local clients stay local; an HTTP connection never pretends to be healthy. */
export function useBotConnectionState(): BotConnectionState {
  const client = getBotClient();
  const observable = observesConnection(client) ? client : undefined;
  return useSyncExternalStore(
    observable ? (listener) => observable.subscribeConnectionState(listener) : noConnectionSubscription,
    observable ? () => observable.getConnectionState() : localConnection,
    localConnection,
  );
}

const RESYNC_DOMAINS = [
  "bots", "bot", "threads", "messages", "runs", "inbox", "handoffs",
  "rooms", "room-messages", "room-runs", "activity", "files", "file",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function eventMessage(event: ServerEvent, existing: Message[] | undefined): { message: Message; version?: number } | undefined {
  if (event.threadId === undefined) return undefined;
  const data = record(event.data);
  if (data === undefined) return undefined;
  const version = typeof data["version"] === "number" && Number.isSafeInteger(data["version"]) && data["version"] >= 0
    ? data["version"] : undefined;
  const value = record(data["message"]) ?? (event.type === "message.created" ? data : undefined);
  if (value !== undefined && typeof value["id"] === "string" && value["threadId"] === event.threadId &&
    typeof value["content"] === "string" && ["assistant", "user", "system"].includes(String(value["role"]))) {
    return { message: value as unknown as Message, ...(version === undefined ? {} : { version }) };
  }
  // The in-memory client emits cumulative text. Keep its existing public event contract.
  if (event.type === "assistant.delta" && typeof data["messageId"] === "string" && typeof data["content"] === "string") {
    const previous = existing?.find((message) => message.id === data["messageId"]);
    const message: Message = {
      ...previous, id: data["messageId"], threadId: event.threadId,
      role: "assistant", content: data["content"], createdAt: previous?.createdAt ?? null,
    };
    return { message, ...(version === undefined ? {} : { version }) };
  }
  return undefined;
}

/** Apply a transport event without tying tests or non-React consumers to a mounted hook. */
/** Streaming replies inside a room, kept out of the persisted transcript. */
export interface RoomDraft {
  readonly botId: string;
  readonly messageId: string;
  readonly content: string;
}

const roomDrafts = new Map<string, Map<string, RoomDraft>>();
const roomDraftListeners = new Set<(roomId: string, drafts: RoomDraft[]) => void>();

function emitRoomDrafts(roomId: string): void {
  const drafts = [...(roomDrafts.get(roomId)?.values() ?? [])];
  for (const listener of roomDraftListeners) listener(roomId, drafts);
}

export function getRoomDrafts(roomId: string): RoomDraft[] {
  return [...(roomDrafts.get(roomId)?.values() ?? [])];
}

export function onRoomDrafts(
  listener: (roomId: string, drafts: RoomDraft[]) => void,
): () => void {
  roomDraftListeners.add(listener);
  return () => { roomDraftListeners.delete(listener); };
}

export function clearRoomDrafts(roomId: string): void {
  if (!roomDrafts.delete(roomId)) return;
  emitRoomDrafts(roomId);
}

function setRoomDraft(roomId: string, draft: RoomDraft): void {
  const byBot = roomDrafts.get(roomId) ?? new Map<string, RoomDraft>();
  byBot.set(draft.botId, draft);
  roomDrafts.set(roomId, byBot);
  emitRoomDrafts(roomId);
}

function clearRoomDraft(roomId: string, botId: string): void {
  const byBot = roomDrafts.get(roomId);
  if (byBot === undefined || !byBot.delete(botId)) return;
  emitRoomDrafts(roomId);
}

export function applyBotEvent(queryClient: QueryClient, event: ServerEvent): void {
  const invalidate = (key: readonly unknown[]) => { void queryClient.invalidateQueries({ queryKey: key }); };
  if (event.type === "resync") {
    for (const [key, existing] of queryClient.getQueriesData<Message[]>({ queryKey: ["messages"] })) {
      const fenced = fenceTranscript(existing, event.epoch);
      if (fenced === undefined || fenced === existing) continue;
      const stored = queryClient.setQueryData<Message[]>(key, fenced);
      if (stored !== undefined) stampTranscript(stored, fenced);
    }
    for (const domain of RESYNC_DOMAINS) invalidate([domain]);
    return;
  }
  if (event.threadId !== undefined && ["assistant.delta", "message.created", "tool.updated"].includes(event.type)) {
    const key = queryKeys.messages(event.threadId);
    const update = eventMessage(event, queryClient.getQueryData<Message[]>(key));
    if (update !== undefined) {
      let reduced: Message[] | undefined;
      const stored = queryClient.setQueryData<Message[]>(key, (existing) => {
        reduced = upsertLiveMessage(existing, update.message, update.version, event.epoch);
        return reduced;
      });
      // React Query can structurally share a new array before messagesQuery mounts.
      // Tag the actual stored result as well, not only the reducer's input array.
      if (stored !== undefined && reduced !== undefined) stampTranscript(stored, reduced);
      if (event.type === "assistant.delta") return;
    }
  }
  if (event.type === "room.delta" && event.roomId !== undefined) {
    const data = record(event.data);
    if (data !== undefined && typeof data["botId"] === "string" && typeof data["content"] === "string") {
      setRoomDraft(event.roomId, {
        botId: data["botId"],
        messageId: typeof data["messageId"] === "string" ? data["messageId"] : "",
        content: data["content"],
      });
    }
    // Streaming must not refetch the whole room on every delta.
    return;
  }
  if (event.type === "room.message" && event.roomId !== undefined) {
    const data = record(event.data);
    if (data !== undefined && typeof data["speakerId"] === "string") {
      clearRoomDraft(event.roomId, data["speakerId"]);
    }
  }
  if (event.roomId !== undefined) {
    invalidate(queryKeys.roomMessages(event.roomId));
    invalidate(queryKeys.roomRuns(event.roomId));
    invalidate(queryKeys.rooms());
  }
  if (event.botId !== undefined) {
    invalidate(queryKeys.bot(event.botId));
    invalidate(queryKeys.threads(event.botId));
    invalidate(["files", event.botId]);
    invalidate(["file", event.botId]);
  }
  if (event.threadId !== undefined) invalidate(queryKeys.messages(event.threadId));
  if (event.type === "bot.updated" || event.type === "thread.updated") invalidate(queryKeys.bots());
  if (["run.updated", "tool.updated", "approval.requested", "approval.decided", "question.requested", "question.answered", "handoff.updated", "bot.updated"].includes(event.type)) {
    invalidate(queryKeys.inbox());
    invalidate(["runs"]);
    invalidate(["activity"]);
    invalidate(queryKeys.handoffs());
  }
}

/** Live patches plus structural refetches; the polling fallback remains enabled. */
export function useBotEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => getBotClient().subscribe((event) => { applyBotEvent(queryClient, event); }), [queryClient]);
}
