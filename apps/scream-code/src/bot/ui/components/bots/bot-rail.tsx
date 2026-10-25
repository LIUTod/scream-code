import {
  IconHash,
  IconInbox,
  IconLayoutSidebar,
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
import { shortcutLabel } from "@/lib/platform";
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
  collapsed = false,
  onNavigate,
  onNewBot,
  onOpenPalette,
  onToggleCollapsed,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
  onNewBot: () => void;
  onOpenPalette: () => void;
  onToggleCollapsed?: () => void;
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
      <div className={cn("flex h-14 shrink-0 items-center gap-2", collapsed ? "justify-center px-2" : "px-3")}>
        <Link
          aria-label="Scream"
          className="flex min-w-0 items-center gap-2 rounded-md"
          onClick={onNavigate}
          to="/"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary font-bold text-[13px] text-primary-foreground">
            S
          </span>
          {collapsed ? null : (
            <span className="truncate font-semibold text-[15px] tracking-tight">
              Scream
            </span>
          )}
        </Link>
        {collapsed ? null : (
          <button
            aria-label={t("app.search")}
            className="ml-auto flex items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={onOpenPalette}
            type="button"
          >
            {shortcutLabel("K")}
          </button>
        )}
        {onToggleCollapsed === undefined ? null : (
          <button
            aria-label={collapsed ? t("app.expandRail") : t("app.collapseRail")}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
              collapsed ? "" : "ml-0.5",
            )}
            onClick={onToggleCollapsed}
            title={collapsed ? t("app.expandRail") : t("app.collapseRail")}
            type="button"
          >
            <IconLayoutSidebar className="size-4" />
          </button>
        )}
      </div>

      <div className={cn("shrink-0 px-2 pb-1", collapsed && "hidden")}>
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
          className={cn(rowClass, "mt-1", collapsed && "justify-center px-0")}
          onClick={onNavigate}
          title={t("app.inbox")}
          to="/inbox"
        >
          <span className="relative">
            <IconInbox className="size-4.5 text-muted-foreground" stroke={1.8} />
            {collapsed && waiting > 0 ? (
              <span className="absolute -top-1 -right-1 size-2 rounded-full bg-warning ring-2 ring-sidebar" />
            ) : null}
          </span>
          {collapsed ? null : <span className="text-sm">{t("app.inbox")}</span>}
          {waiting > 0 && !collapsed ? (
            <span className="ml-auto rounded-full bg-warning/15 px-1.5 font-medium text-[11px] text-warning tabular-nums">
              {waiting}
            </span>
          ) : null}
        </Link>

        {collapsed ? <div className="my-2 h-px bg-sidebar-border/70" /> : null}
        {collapsed ? null : <SectionLabel
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
        </SectionLabel>}
        <ul className="flex flex-col gap-0.5">
          {visibleBots.map((bot) => (
            <li className="group/row relative" key={bot.id}>
              <Link
                activeProps={{ className: "bg-sidebar-accent" }}
                className={cn(rowClass, collapsed ? "justify-center px-0" : "pr-9")}
                onClick={() => {
                  rememberActiveBot(bot.id);
                  onNavigate?.();
                }}
                params={{ botId: bot.id }}
                title={collapsed ? bot.name : undefined}
                to="/bots/$botId"
              >
                <span className="relative shrink-0">
                  <AbstractAvatar
                    emoji={bot.avatarEmoji}
                    hue={bot.accentHue}
                    name={bot.name}
                    seed={bot.avatarSeed}
                    size={32}
                  />
                  <StatusDot status={bot.status} />
                  {collapsed && (bot.unread > 0 || bot.needsYou > 0) ? (
                    <span
                      aria-label={t("app.unread", { count: bot.unread + bot.needsYou })}
                      className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-brand ring-2 ring-sidebar"
                    />
                  ) : null}
                </span>
                <span className={cn("flex min-w-0 flex-1 flex-col leading-tight", collapsed && "hidden")}>
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
                {bot.needsYou > 0 && !collapsed ? (
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
                className={cn(
                  "absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-100 transition-opacity pointer-fine:opacity-0 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100 disabled:opacity-40",
                  collapsed && "hidden",
                )}
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

        {collapsed ? <div className="my-2 h-px bg-sidebar-border/70" /> : null}
        {collapsed ? null : <SectionLabel
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
        </SectionLabel>}
        <ul className="flex flex-col gap-0.5">
          {visibleRooms.map((room) => {
            const members = room.memberIds
              .map((memberId) => bots.data?.find((bot) => bot.id === memberId))
              .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot))
              .map((bot) => ({
                name: bot.name,
                seed: bot.avatarSeed,
                emoji: bot.avatarEmoji,
                hue: bot.accentHue,
              }));
            const unread = roomIsUnread(room);
            return (
              <li key={room.id}>
                <Link
                  activeProps={{ className: "bg-sidebar-accent" }}
                  className={cn(rowClass, collapsed && "justify-center px-0")}
                  onClick={onNavigate}
                  params={{ roomId: room.id }}
                  title={collapsed ? room.name : undefined}
                  to="/rooms/$roomId"
                >
                  {members.length > 0 ? (
                    <AvatarStack people={members} size={32} />
                  ) : (
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                      <IconHash className="size-4" stroke={1.8} />
                    </span>
                  )}
                  <span className={cn("flex min-w-0 flex-1 flex-col leading-tight", collapsed && "hidden")}>
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

      <div className={cn("flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2 py-2", collapsed && "justify-center")}>
        <Link
          activeProps={{ className: "bg-sidebar-accent" }}
          className={cn(rowClass, collapsed ? "px-1.5" : "flex-1")}
          onClick={onNavigate}
          title={t("app.settings")}
          to="/settings"
        >
          <IconSettings className="size-4.5 text-muted-foreground" stroke={1.8} />
          {collapsed ? null : <span className="text-[13px]">{t("app.settings")}</span>}
        </Link>
        {collapsed ? null : <LangToggle />}
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
