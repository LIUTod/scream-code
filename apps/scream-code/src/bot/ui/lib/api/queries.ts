import { queryOptions } from "@tanstack/react-query";
import type { Message } from "../../../shared/contracts";
import { getBotClient } from "./client";
import { reconcileTranscript } from "./message-state";

const client = () => getBotClient();

export const queryKeys = {
  activity: (botId?: string) => ["activity", botId ?? "all"] as const,
  bot: (botId: string) => ["bot", botId] as const,
  bots: () => ["bots"] as const,
  file: (botId: string, path: string, threadId?: string) => ["file", botId, path, threadId ?? "bot"] as const,
  files: (botId: string, path?: string, threadId?: string) => ["files", botId, path ?? "", threadId ?? "bot"] as const,
  handoffs: () => ["handoffs"] as const,
  inbox: () => ["inbox"] as const,
  messages: (threadId: string) => ["messages", threadId] as const,
  roomMessages: (roomId: string) => ["room-messages", roomId] as const,
  roomRuns: (roomId: string) => ["room-runs", roomId] as const,
  rooms: () => ["rooms"] as const,
  runs: (botId?: string) => ["runs", botId ?? "all"] as const,
  threads: (botId: string) => ["threads", botId] as const,
};

export const botsQuery = () =>
  queryOptions({
    queryFn: () => client().listBots(),
    queryKey: queryKeys.bots(),
    refetchInterval: 2_000,
  });

export const botQuery = (botId: string) =>
  queryOptions({
    queryFn: async () => (await client().getBot(botId)) ?? null,
    queryKey: queryKeys.bot(botId),
    retry: false,
  });

export const threadsQuery = (botId: string) =>
  queryOptions({
    queryFn: () => client().listThreads(botId),
    queryKey: queryKeys.threads(botId),
    refetchInterval: 2_000,
  });

export const messagesQuery = (threadId: string) =>
  queryOptions({
    queryFn: () => client().listMessages(threadId),
    queryKey: queryKeys.messages(threadId),
    structuralSharing: (existing: unknown, incoming: unknown) => reconcileTranscript(existing as Message[] | undefined, incoming as Message[]),
    refetchInterval: 1_000,
  });

export const inboxQuery = () =>
  queryOptions({
    queryFn: () => client().listInbox(),
    queryKey: queryKeys.inbox(),
    refetchInterval: 2_000,
  });

export const runsQuery = (botId?: string) =>
  queryOptions({
    queryFn: () => client().listRuns(botId),
    queryKey: queryKeys.runs(botId),
    refetchInterval: 2_000,
  });

export const roomsQuery = () =>
  queryOptions({
    queryFn: () => client().listRooms(),
    queryKey: queryKeys.rooms(),
    refetchInterval: 2_000,
  });

export const roomMessagesQuery = (roomId: string) =>
  queryOptions({
    queryFn: () => client().listRoomMessages(roomId),
    queryKey: queryKeys.roomMessages(roomId),
    refetchInterval: 1_000,
  });

export const roomRunsQuery = (roomId: string) =>
  queryOptions({
    queryFn: () => client().listRoomRuns(roomId),
    queryKey: queryKeys.roomRuns(roomId),
    refetchInterval: 1_000,
  });

export const filesQuery = (botId: string, path?: string, threadId?: string) =>
  queryOptions({
    queryFn: () => client().listFiles(botId, path, threadId),
    queryKey: queryKeys.files(botId, path, threadId),
  });

export const fileQuery = (botId: string, path: string, threadId?: string) =>
  queryOptions({
    queryFn: () => client().readFile(botId, path, threadId),
    queryKey: queryKeys.file(botId, path, threadId),
  });

export const activityQuery = (botId?: string) =>
  queryOptions({
    queryFn: () => client().listActivity(botId),
    queryKey: queryKeys.activity(botId),
  });
