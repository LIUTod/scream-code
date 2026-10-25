import {
  IconCommand,
  IconHash,
  IconInbox,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AvatarStack } from "@/components/agents/avatar-stack";
import { NewRoomSheet } from "@/components/agents/new-room-sheet";
import { StatusDot } from "@/components/bots/status";
import { Button } from "@/components/ui/button";
import { getBotClient } from "@/lib/api/client";
import { botsQuery, inboxQuery, queryKeys, roomsQuery } from "@/lib/api/queries";
import { LangToggle, useI18n } from "@/lib/i18n";
import { relativeTime } from "@/lib/relative-time";
import { roomIsUnread } from "@/lib/room-read";
import { forgetDeletedBot, rememberActiveBot } from "@/lib/session";
import { readTheme, type Theme, writeTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

function SectionLabel({
  action,
  children,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 mb-1 flex h-7 items-center justify-between px-2">
      <span className="font-medium text-[11px] text-muted-foreground/80 uppercase tracking-[0.14em]">
        {children}
      </span>
      {action}
    </div>
  );
}

const rowClass =
  "group flex min-h-[50px] items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-sidebar-accent/70";

const rowTitle = "truncate text-[13px] leading-5";
const rowPreview = "truncate text-[12px] leading-4 text-muted-foreground";
const rowTime = "shrink-0 text-[11px] text-muted-foreground/70 tabular-nums";

export function BotRail({
  onNavigate,
  onNewBot,
  onOpenPalette,
}: {
  onNavigate?: () => void;
  onNewBot: () => void;
  onOpenPalette: () => void;
}) {
  const bots = useQuery(botsQuery());
  const rooms = useQuery(roomsQuery());
  const inbox = useQuery(inboxQuery());
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visibleBots = useMemo(
    () =>
      needle.length === 0
        ? (bots.data ?? [])
        : (bots.data ?? []).filter(
            (bot) =>
              bot.name.toLowerCase().includes(needle) ||
              bot.title.toLowerCase().includes(needle) ||
              (bot.lastMessage ?? "").toLowerCase().includes(needle),
          ),
    [bots.data, needle],
  );
  const visibleRooms = useMemo(
    () =>
      needle.length === 0
        ? (rooms.data ?? [])
        : (rooms.data ?? []).filter(
            (room) =>
              room.name.toLowerCase().includes(needle) ||
              (room.lastMessage ?? "").toLowerCase().includes(needle),
          ),
    [needle, rooms.data],
  );
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [roomOpen, setRoomOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { botId?: string };
  const removeBot = useMutation({
    mutationFn: (id: string) => getBotClient().deleteBot(id),
    onSuccess: async (_data, id) => {
      forgetDeletedBot(id, queryClient);

      // Leave the deleted Bot's route after its cache is safe: a live observer
      // on a query that has just 404'd would otherwise surface a query error.
      if (params.botId === id) await navigate({ to: "/" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.bots() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.inbox() });
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    },
  });
  const waiting =
    (inbox.data?.approvals.length ?? 0) + (inbox.data?.questions.length ?? 0);

  const cycleTheme = () => {
    const next: Theme =
      theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    writeTheme(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <Link
          className="flex min-w-0 items-center gap-2 rounded-md"
          onClick={onNavigate}
          to="/"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary font-bold text-[13px] text-primary-foreground">
            S
          </span>
          <span className="truncate font-semibold text-[15px] tracking-tight">
            Scream
          </span>
        </Link>
        <button
          aria-label={t("app.search")}
          className="ml-auto flex items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onOpenPalette}
          type="button"
        >
          <IconCommand className="size-3.5" />
          K
        </button>
      </div>

      <div className="shrink-0 px-2 pb-1">
        <label className="flex h-9 items-center gap-2 rounded-lg bg-background/60 px-2.5 ring-1 ring-border/70 focus-within:ring-foreground/20">
          <IconSearch className="size-3.5 text-muted-foreground" stroke={1.8} />
          <input
            aria-label={t("app.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("app.searchPlaceholder")}
            type="search"
            value={query}
          />
        </label>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <Link
          activeProps={{ className: "bg-sidebar-accent" }}
          className={cn(rowClass, "mt-1")}
          onClick={onNavigate}
          to="/inbox"
        >
          <IconInbox className="size-4.5 text-muted-foreground" stroke={1.8} />
          <span className="text-sm">{t("app.inbox")}</span>
          {waiting > 0 ? (
            <span className="ml-auto rounded-full bg-warning/15 px-1.5 font-medium text-[11px] text-warning tabular-nums">
              {waiting}
            </span>
          ) : null}
        </Link>

        <SectionLabel
          action={
            <button
              aria-label={t("app.newBot")}
              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              onClick={onNewBot}
              type="button"
            >
              <IconPlus className="size-4" />
            </button>
          }
        >
          {t("app.bots")}
        </SectionLabel>
        <ul className="flex flex-col gap-0.5">
          {visibleBots.map((bot) => (
            <li className="group/row relative" key={bot.id}>
              <Link
                activeProps={{ className: "bg-sidebar-accent" }}
                className={cn(rowClass, "pr-9")}
                onClick={() => {
                  rememberActiveBot(bot.id);
                  onNavigate?.();
                }}
                params={{ botId: bot.id }}
                to="/bots/$botId"
              >
                <span className="relative shrink-0">
                  <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={32} />
                  <StatusDot status={bot.status} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="flex items-baseline gap-1.5">
                    <span
                      className={cn(
                        rowTitle,
                        "min-w-0 flex-1",
                        bot.paused ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {bot.name}
                    </span>
                    {bot.lastMessageAt ? (
                      <span className={rowTime}>
                        {relativeTime(new Date(bot.lastMessageAt).toISOString())}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className={cn(rowPreview, "min-w-0 flex-1")}>
                      {bot.lastMessage ?? bot.title}
                    </span>
                    {bot.unread > 0 ? (
                      <span
                        aria-label={t("app.unread", { count: bot.unread })}
                        className="size-1.5 shrink-0 rounded-full bg-brand"
                      />
                    ) : null}
                  </span>
                </span>
                {bot.needsYou > 0 ? (
                  <span
                    aria-label={t("app.waiting", { count: bot.needsYou })}
                    className="rounded-full bg-warning/15 px-1.5 py-0.5 font-medium text-[10px] text-warning tabular-nums"
                  >
                    {bot.needsYou}
                  </span>
                ) : null}
              </Link>
              <button
                aria-label={t("bot.delete", { name: bot.name })}
                className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-100 transition-opacity pointer-fine:opacity-0 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100 disabled:opacity-40"
                disabled={removeBot.isPending}
                onClick={() => {
                  if (!window.confirm(t("bot.deleteConfirm", { name: bot.name }))) return;
                  removeBot.mutate(bot.id);
                }}
                title={t("bot.delete", { name: bot.name })}
                type="button"
              >
                <IconTrash className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>

        <SectionLabel
          action={
            <Button
              aria-label={t("room.new")}
              onClick={() => setRoomOpen(true)}
              size="icon-sm"
              variant="ghost"
            >
              <IconPlus />
            </Button>
          }
        >
          {t("app.rooms")}
        </SectionLabel>
        <ul className="flex flex-col gap-0.5">
          {visibleRooms.map((room) => {
            const members = room.memberIds
              .map((memberId) => bots.data?.find((bot) => bot.id === memberId))
              .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot))
              .map((bot) => ({ name: bot.name, seed: bot.avatarSeed }));
            const unread = roomIsUnread(room);
            return (
              <li key={room.id}>
                <Link
                  activeProps={{ className: "bg-sidebar-accent" }}
                  className={rowClass}
                  onClick={onNavigate}
                  params={{ roomId: room.id }}
                  to="/rooms/$roomId"
                >
                  {members.length > 0 ? (
                    <AvatarStack people={members} size={32} />
                  ) : (
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                      <IconHash className="size-4" stroke={1.8} />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="flex items-baseline gap-1.5">
                      <span className={cn(rowTitle, "min-w-0 flex-1")}>{room.name}</span>
                      {room.lastMessageAt ? (
                        <span className={rowTime}>
                          {relativeTime(new Date(room.lastMessageAt).toISOString())}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className={cn(rowPreview, "min-w-0 flex-1")}>
                        {room.lastMessage ?? t("app.noMessages")}
                      </span>
                      {unread ? (
                        <span
                          aria-label={t("app.unreadRoom", { name: room.name })}
                          className="size-1.5 shrink-0 rounded-full bg-brand"
                        />
                      ) : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
          {visibleRooms.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-muted-foreground">
              {needle.length > 0 ? t("app.noMatches") : t("app.noRooms")}
            </p>
          ) : null}
        </ul>
      </nav>

      <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2 py-2">
        <Link
          activeProps={{ className: "bg-sidebar-accent" }}
          className={cn(rowClass, "flex-1")}
          onClick={onNavigate}
          to="/settings"
        >
          <IconSettings className="size-4.5 text-muted-foreground" stroke={1.8} />
          <span className="text-[13px]">{t("app.settings")}</span>
        </Link>
        <LangToggle />
        <Button
          aria-label={t("app.theme", { theme })}
          onClick={cycleTheme}
          size="icon-sm"
          variant="ghost"
        >
          {theme === "dark" ? (
            <IconMoon className="size-4" />
          ) : (
            <IconSun className="size-4" />
          )}
        </Button>
      </div>
      <NewRoomSheet onOpenChange={setRoomOpen} open={roomOpen} />
    </div>
  );
}
