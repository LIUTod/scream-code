import { IconArrowUp, IconHash, IconLayoutSidebar, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DraftStore, draftKey, type DraftRequest } from "@/lib/draft";

// Separate ownership from Bot/thread drafts; accepted requests stay server-owned.
const roomDrafts = new DraftStore(() => undefined);
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import { MessageBody } from "@/components/chat/message-body";
import { clearRoomDrafts, getRoomDrafts, onRoomDrafts, type RoomDraft } from "@/lib/api/events";
import { useShell } from "@/components/layout/shell-context";
import { getBotClient } from "@/lib/api/client";
import {
  botsQuery,
  queryKeys,
  roomMessagesQuery,
  roomRunsQuery,
  roomsQuery,
} from "@/lib/api/queries";
import { relativeTime } from "@/lib/relative-time";
import { useI18n } from "@/lib/i18n";
import { shellRoute } from "./shell";

export const roomRoute = createRoute({
  component: RoomPage,
  getParentRoute: () => shellRoute,
  path: "/rooms/$roomId",
});

function RoomPage() {
  const { roomId } = roomRoute.useParams();
  return <RoomView key={roomId} roomId={roomId} />;
}

function RoomView({ roomId }: { roomId: string }) {
  const shell = useShell();
  const navigate = useNavigate();
  const rooms = useQuery(roomsQuery());
  const bots = useQuery(botsQuery());
  const messages = useQuery(roomMessagesQuery(roomId));
  const runs = useQuery(roomRunsQuery(roomId));
  const [drafts, setDrafts] = useState<RoomDraft[]>(() => getRoomDrafts(roomId));
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    setDrafts(getRoomDrafts(roomId));
    setPending(null);
    return onRoomDrafts((changed, list) => {
      if (changed === roomId) setDrafts(list);
    });
  }, [roomId]);
  // The optimistic bubble disappears as soon as the server echo arrives.
  useEffect(() => {
    if (pending === null) return;
    if (messages.data?.some((row) => row.speakerKind === "user" && row.content === pending)) {
      setPending(null);
    }
  }, [messages.data, pending]);
  // If a stream is missed (disconnect), drop live drafts once nothing runs.
  useEffect(() => {
    const active = (runs.data ?? []).some(
      (run) => run.status === "queued" || run.status === "running" || run.status === "waiting_user",
    );
    if (!active && drafts.length > 0) clearRoomDrafts(roomId);
  }, [drafts.length, roomId, runs.data]);
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const key = draftKey("room", roomId);
  const draft = useSyncExternalStore(roomDrafts.subscribe, () => roomDrafts.get(key));
  const value = draft.value;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const room = rooms.data?.find((candidate) => candidate.id === roomId);
  const members = (room?.memberIds ?? [])
    .map((memberId) => bots.data?.find((bot) => bot.id === memberId))
    .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot));
  const lead = members.find((bot) => bot.id === room?.leadBotId);

  const remove = useMutation({
    mutationFn: () => getBotClient().deleteRoom(roomId),
    onSuccess: async () => {
      queryClient.setQueryData(queryKeys.rooms(), (current: typeof rooms.data) => current?.filter((entry) => entry.id !== roomId));
      await navigate({ to: "/" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.rooms() });
    },
  });
  const send = useMutation({
    retry: false,
    mutationFn: (request: DraftRequest) => getBotClient().promptRoom(request.threadId, request.text, request.id),
    onSuccess: (_result, request) => {
      roomDrafts.finish(request);
      void queryClient.invalidateQueries({ queryKey: queryKeys.roomMessages(request.threadId) });
    },
    onError: (error, request) => { setPending(null); roomDrafts.finish(request, error.message || t("composer.sendFailed")); },
  });

  const submit = () => {
    const request = roomDrafts.begin("room", roomId, value, false);
    if (request) {
      setPending(request.text);
      send.mutate(request);
    }
  };

  if (!room) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
        <Button className="lg:hidden" onClick={shell.openRail} variant="outline">{t("cockpit.openNav")}</Button>
        <p role={rooms.error ? "alert" : undefined}>{rooms.isPending ? t("room.loading") : rooms.error?.message ?? t("room.missing")}</p>
        {rooms.error ? <Button onClick={() => void rooms.refetch()}>{t("common.retry")}</Button> : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <Button aria-label={t("cockpit.openNav")} className="lg:hidden" onClick={shell.openRail} size="icon-sm" variant="ghost"><IconLayoutSidebar className="size-4" /></Button>
        <IconHash className="size-4 text-muted-foreground" />
        <h1 className="font-medium text-[14px]">{room.name}</h1>
        <div className="ml-1 flex items-center">
          {members.map((member, index) => (
            <span
              className={index > 0 ? "-ml-1.5 rounded-full ring-2 ring-background" : ""}
              key={member.id}
              title={member.name}
            >
              <AbstractAvatar
                name={member.name}
                seed={member.avatarSeed}
                size={22}
              />
            </span>
          ))}
        </div>
        <Button
          aria-label={t("room.delete")}
          className="ml-auto"
          onClick={() => {
            if (!window.confirm(t("room.deleteConfirm"))) return;
            if (!remove.isPending) remove.mutate();
          }}
          size="icon-sm"
          variant="ghost"
        >
          <IconTrash />
        </Button>
        <p className="text-[11.5px] text-muted-foreground">
          {lead ? t("room.lead", { name: lead.name }) : t("room.noLead")} · {t("room.shared")}
        </p>
      </header>

      {messages.error ? <div role="alert" className="flex items-center gap-2 px-4 py-2 text-destructive text-xs">{t("common.loadFailed")} {messages.error.message}<Button onClick={() => void messages.refetch()} size="sm" variant="ghost">{t("common.retry")}</Button></div> : null}
      {messages.isPending ? <p className="p-4 text-muted-foreground text-sm">{t("common.loading")}</p> : null}
      {remove.error ? <p className="p-4 text-destructive text-xs" role="alert">{remove.error.message}</p> : null}
      {(runs.data ?? []).filter((run) => run.status !== "done" && run.status !== "cancelled").length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-muted-foreground text-[11.5px]">
          {(runs.data ?? [])
            .filter((run) => run.status !== "done" && run.status !== "cancelled")
            .map((run) => (
              <span className="rounded-full bg-muted px-2 py-0.5" key={run.id}>
                {bots.data?.find((bot) => bot.id === run.botId)?.name ?? run.botId}: {t(`run.${run.status}`)}
              </span>
            ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-7">
          {(messages.data ?? []).map((message) => {
            if (message.speakerKind === "system") {
              return (
                <p
                  className="text-center text-[11.5px] text-muted-foreground/80"
                  key={message.id}
                >
                  {message.content}
                </p>
              );
            }
            const speaker = bots.data?.find(
              (bot) => bot.id === message.speakerId,
            );
            const isUser = message.speakerKind === "user";
            return (
              <div
                className={isUser ? "flex justify-end" : "flex min-w-0 gap-2.5"}
                key={message.id}
              >
                {!isUser && speaker ? (
                  <AbstractAvatar
                    name={speaker.name}
                    seed={speaker.avatarSeed}
                    size={26}
                  />
                ) : null}
                <div className={isUser ? "max-w-[85%]" : "min-w-0 flex-1"}>
                  <div
                    className={
                      isUser
                        ? "flex items-baseline justify-end gap-2"
                        : "flex items-baseline gap-2"
                    }
                  >
                    <span className="font-medium text-[12.5px]">
                      {isUser ? t("room.you") : (speaker?.name ?? t("room.bot"))}
                    </span>
                    {message.via === "handoff" ? (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t("room.viaHandoff")}
                      </span>
                    ) : null}
                    <time className="text-[11px] text-muted-foreground">
                      {message.createdAt > 0 ? relativeTime(new Date(message.createdAt).toISOString()) : t("common.unknownTime")}
                    </time>
                  </div>
                  {isUser ? <p className="mt-1 rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">{message.content}</p> : <MessageBody content={message.content} className="mt-1" />}
                </div>
              </div>
            );
          })}
          {pending !== null ? (
            <div className="flex justify-end opacity-70" key="pending-user">
              <div className="max-w-[85%]">
                <div className="flex items-baseline justify-end gap-2">
                  <span className="font-medium text-[12.5px]">{t("room.you")}</span>
                  <span className="text-[11px] text-muted-foreground">{t("room.sending")}</span>
                </div>
                <p className="mt-1 rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">{pending}</p>
              </div>
            </div>
          ) : null}
          {drafts.map((live) => (
            <div className="flex min-w-0 gap-2.5" key={`live-${live.botId}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-[12.5px]">{bots.data?.find((bot) => bot.id === live.botId)?.name ?? t("room.bot")}</span>
                  <span className="animate-pulse text-[11px] text-muted-foreground">{t("room.replying")}</span>
                </div>
                <MessageBody content={live.content} className="mt-1 opacity-80" />
              </div>
            </div>
          ))}
          {drafts.length === 0 && (send.isPending || (runs.data ?? []).some((run) => run.status === "queued" || run.status === "running" || run.status === "waiting_user")) ? (
            <p className="flex items-center gap-2 py-2 text-muted-foreground text-xs" role="status">
              <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
              {t("room.waiting")}
            </p>
          ) : null}
          {messages.data?.length === 0 && pending === null && drafts.length === 0 ? (
            <p className="py-16 text-center text-muted-foreground text-sm">
              {t("room.empty")}
            </p>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-4 pb-4 md:px-8 md:pb-5">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:border-foreground/20">
          <textarea
            aria-label={t("room.messageAria", { room: room.name })}
            className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[13.5px] outline-none placeholder:text-muted-foreground"
            onChange={(event) => { roomDrafts.edit(key, event.target.value); }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={t("room.placeholder", {
              room: room.name,
              bot: members[0]?.name ?? t("room.bot"),
            })}
            ref={textarea}
            rows={1}
            value={value}
          />
          <Button
            aria-label={t("room.send")}
            disabled={!value.trim() || draft.pending !== null || draft.retry !== null}
            onClick={submit}
            size="icon-sm"
          >
            <IconArrowUp className="size-4" />
          </Button>
        </div>
        {draft.retry ? <section aria-label={t("composer.unconfirmedText")} className="mt-2 rounded-lg border border-border p-2 text-xs">
          <p role="status">{t("composer.unconfirmed")}</p>
          <pre className="my-2 whitespace-pre-wrap break-words">{draft.retry.restore}</pre>
          <Button disabled={draft.pending !== null} onClick={() => {
            const request = roomDrafts.retry("room", roomId, false);
            if (request) {
              setPending(request.text);
              send.mutate(request);
            }
          }} size="sm" variant="outline">{t("composer.retryRequest")}</Button>
        </section> : null}
        {draft.error ? <p className="mt-2 text-destructive text-xs" role="alert">{draft.error}</p> : null}
      </div>
    </div>
  );
}
