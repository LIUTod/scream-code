import {
  IconChevronDown,
  IconInbox,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { BotSettingsSheet } from "@/components/agents/bot-settings-sheet";
import { StatusPill } from "@/components/bots/status";
import { Composer } from "@/components/chat/composer";
import { Transcript } from "@/components/chat/transcript";
import { RecoveryCard } from "@/components/chat/recovery-card";
import { DetailPanel } from "@/components/layout/detail-panel";
import { useShell } from "@/components/layout/shell-context";
import { RightDrawer } from "@/components/shell/right-drawer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getBotClient } from "@/lib/api/client";
import {
  deleteBotThread,
  type DeleteThreadOperation,
  finishThreadDeletion,
} from "@/lib/delete-thread";
import { useI18n } from "@/lib/i18n";
import {
  botQuery,
  inboxQuery,
  queryKeys,
  threadsQuery,
  runsQuery,
} from "@/lib/api/queries";
import { forgetDeletedBot, rememberActiveBot } from "@/lib/session";

export function Cockpit(props: {
  botId: string;
  threadId?: string;
  drawerOpen: boolean;
  onDrawerChange: (open: boolean) => void;
}) {
  return <BotCockpit key={props.botId} {...props} />;
}

function BotCockpit({
  botId,
  threadId,
  onDrawerChange,
  drawerOpen,
}: {
  botId: string;
  threadId?: string;
  drawerOpen: boolean;
  onDrawerChange: (open: boolean) => void;
}) {
  const bot = useQuery(botQuery(botId));
  const threads = useQuery(threadsQuery(botId));
  const inbox = useQuery(inboxQuery());
  const runs = useQuery(runsQuery(botId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const { openRail } = useShell();
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const thread = threadId
    ? threads.data?.find((candidate) => candidate.id === threadId)
    : threads.data?.[0];

  useEffect(() => {
    if (bot.data) rememberActiveBot(bot.data.id);
  }, [bot.data]);

  // A successful null response confirms deletion; a network error does not.
  useEffect(() => {
    if (!bot.isSuccess || bot.data !== null) return;
    forgetDeletedBot(botId, queryClient);
    const path = router.state.location.pathname;
    const botPath = `/bots/${encodeURIComponent(botId)}`;
    if (path === botPath || path.startsWith(`${botPath}/`)) {
      void navigate({ to: "/" });
    }
  }, [bot.isSuccess, bot.data, botId, navigate, queryClient, router]);

  const threadIdForRead = thread?.id;
  const threadUnread = thread?.unread ?? 0;
  useEffect(() => {
    if (!threadIdForRead || threadUnread === 0) return;
    void getBotClient().markThreadRead(threadIdForRead);
  }, [threadIdForRead, threadUnread]);

  const createThread = useMutation({
    mutationFn: (operationBotId: string) => getBotClient().createThread(operationBotId),
    onSuccess: async (created, operationBotId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.threads(operationBotId) });
      const path = router.state.location.pathname;
      const botPath = `/bots/${encodeURIComponent(operationBotId)}`;
      if (path !== botPath && !path.startsWith(`${botPath}/`)) return;
      await navigate({
        params: { botId: operationBotId, threadId: created.id },
        to: "/bots/$botId/threads/$threadId",
      });
    },
  });

  const deleteThread = useMutation({
    mutationFn: (operation: DeleteThreadOperation) =>
      deleteBotThread(getBotClient(), operation),
    onSuccess: (deleted) => finishThreadDeletion(queryClient, deleted, {
      getPathname: () => router.state.location.pathname,
      navigateToBot: (operationBotId) =>
        navigate({ params: { botId: operationBotId }, to: "/bots/$botId" }),
    }),
  });

  const setPaused = useMutation({
    mutationFn: (operation: { botId: string; paused: boolean }) =>
      getBotClient().setPaused(operation.botId, operation.paused),
    onSuccess: (_updated, operation) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bot(operation.botId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots() });
    },
  });

  const waiting =
    (inbox.data?.approvals.filter(
      (approval) => approval.botId === botId && approval.status === "pending" && approval.expiresAt > Date.now(),
    ).length ?? 0) +
    (inbox.data?.questions.filter(
      (question) => question.botId === botId && question.status === "pending",
    ).length ?? 0);

  const mobileNavigation = <Button aria-label={t("cockpit.openNav")} className="lg:hidden" onClick={openRail} size="sm" variant="outline">{t("cockpit.openNav")}</Button>;
  if (bot.isPending) {
    return <div className="flex flex-1 flex-col items-center justify-center gap-3">{mobileNavigation}<p role="status">{t("common.loading")}</p></div>;
  }

  if (bot.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        {mobileNavigation}
        <p className="text-destructive text-sm" role="alert">{bot.error.message}</p>
        <Button onClick={() => void bot.refetch()} size="sm" variant="outline">{t("common.retry")}</Button>
      </div>
    );
  }

  if (bot.data === null || !bot.data) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-destructive text-sm" role="alert">{t("cockpit.missing")}</p>
      </div>
    );
  }

  const current = bot.data;

  return (
    <>
      <div className="flex min-h-0 w-full min-w-0 flex-1 *:min-w-0 *:flex-1">
        <DetailPanel
          detail={<RightDrawer bot={current} threadId={thread?.id} />}
          onClose={() => onDrawerChange(false)}
          open={drawerOpen}
          title={<span className="font-medium text-[13px]">{t("cockpit.details")}</span>}
          detailWidth={330}
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:px-4">
              <Button
                aria-label={t("cockpit.openNav")}
                className="lg:hidden"
                onClick={openRail}
                size="icon-sm"
                variant="ghost"
              >
                <IconLayoutSidebar className="size-4.5" />
              </Button>
              <AbstractAvatar
                name={current.name}
                seed={current.avatarSeed}
                size={28}
              />
              <div className="min-w-0 max-w-[45%]">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-[14px]">
                    {current.name}
                  </span>
                  <StatusPill bot={current} />
                </div>
                <p className="hidden truncate font-mono text-[10.5px] text-muted-foreground xl:block">
                  {thread?.workspace ?? current.workspace}
                </p>
              </div>
              <div className="ml-1 flex min-w-0 flex-1 items-center">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button className="w-full justify-between" size="sm" variant="ghost" />}
                  >
                    <span className="min-w-0 flex-1 truncate text-left text-[12.5px] text-muted-foreground">
                      {thread?.title ?? t("cockpit.noThread")}
                    </span>
                    <IconChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    {(threads.data ?? []).map((entry) => (
                      <DropdownMenuItem
                        key={entry.id}
                        render={
                          <Link
                            params={{ botId, threadId: entry.id }}
                            to="/bots/$botId/threads/$threadId"
                          />
                        }
                      >
                        <span className="truncate">{entry.title}</span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={thread === undefined || deleteThread.isPending}
                      onClick={() => {
                        if (thread === undefined) return;
                        if (window.confirm(t("thread.deleteConfirm"))) {
                          deleteThread.mutate({ botId, threadId: thread.id });
                        }
                      }}
                    >
                      <IconTrash />
                      {t("thread.delete")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={createThread.isPending}
                      onClick={() => createThread.mutate(botId)}
                    >
                      <IconPlus />
                      {t("cockpit.newConversation")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  aria-label={current.paused ? t("cockpit.resumeBot") : t("cockpit.pauseBot")}
                  disabled={setPaused.isPending}
                  onClick={() => setPaused.mutate({ botId: current.id, paused: !current.paused })}
                  size="icon-sm"
                  variant="ghost"
                >
                  {current.paused ? (
                    <IconPlayerPlay className="size-4" />
                  ) : (
                    <IconPlayerPause className="size-4" />
                  )}
                </Button>
                <Button
                  aria-label={t("cockpit.newConversation")}
                  disabled={createThread.isPending}
                  onClick={() => createThread.mutate(botId)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <IconPlus className="size-4" />
                </Button>
                <Link
                  aria-label={t("cockpit.inbox")}
                  className="relative hidden items-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:inline-flex"
                  to="/inbox"
                >
                  <IconInbox className="size-4.5" />
                  {waiting > 0 ? (
                    <span className="absolute -top-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full bg-warning text-[9px] font-semibold text-background">
                      {waiting}
                    </span>
                  ) : null}
                </Link>
                <Button
                  aria-label={t("cockpit.details")}
                  onClick={() => onDrawerChange(!drawerOpen)}
                  size="icon-sm"
                  variant={drawerOpen ? "secondary" : "ghost"}
                >
                  <IconLayoutSidebarRight className="size-4.5" />
                </Button>
                <Button
                  aria-label={t("cockpit.botSettings")}
                  onClick={() => setSettingsOpen(true)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <IconSettings className="size-4.5" />
                </Button>
              </div>
            </header>

            {[createThread.error, deleteThread.error, setPaused.error].filter(Boolean).map((error, index) => (
              <p className="px-4 py-2 text-destructive text-xs" key={index} role="alert">{error?.message}</p>
            ))}
            {current.paused ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-[12.5px] text-muted-foreground">
                <IconPlayerPause className="size-3.5" />
                {t("composer.paused", { name: current.name })}
              </div>
            ) : null}

            {thread ? (
              <>
                <Transcript bot={current} threadId={thread.id} />
                {runs.data?.find((run) => run.id === thread.blockedByRunId) ? (
                  <RecoveryCard key={thread.blockedByRunId} run={runs.data.find((run) => run.id === thread.blockedByRunId)!} />
                ) : null}
                <Composer bot={current} threadId={thread.id} />
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-muted-foreground text-sm">
                <p role={threads.isError ? "alert" : undefined}>{threads.isPending ? t("common.loading") : threads.error?.message ?? t("cockpit.noThread")}</p>
                {threads.isError ? <Button variant="outline" onClick={() => void threads.refetch()}>{t("common.retry")}</Button> : null}
                {!threads.isPending ? <Button disabled={createThread.isPending} onClick={() => createThread.mutate(botId)}>{t("cockpit.newConversation")}</Button> : null}
              </div>
            )}
          </div>
        </DetailPanel>
      </div>
      <BotSettingsSheet
        bot={current}
        onClose={() => setSettingsOpen(false)}
        onDeleted={(deletedBotId) => {
          const path = router.state.location.pathname;
          const botPath = `/bots/${encodeURIComponent(deletedBotId)}`;
          if (path === botPath || path.startsWith(`${botPath}/`)) void navigate({ to: "/" });
        }}
        open={settingsOpen}
      />
    </>
  );
}
