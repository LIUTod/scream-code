import {
  IconArrowLeft,
  IconCheck,
  IconFileText,
  IconFolder,
  IconPlayerPlay,
  IconShieldQuestion,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Bot, Run } from "../../../shared/contracts";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { QuestionCard } from "@/components/approvals/question-card";
import { Button } from "@/components/ui/button";
import {
  activityQuery,
  botsQuery,
  fileQuery,
  filesQuery,
  inboxQuery,
  runsQuery,
} from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { activityRows, fileBreadcrumbs, fileName } from "./drawer-state";

type Tab = "activity" | "approvals" | "files";

const TABS: { id: Tab; key: "cockpit.activity" | "cockpit.approvals" | "cockpit.files" }[] = [
  { id: "activity", key: "cockpit.activity" },
  { id: "approvals", key: "cockpit.approvals" },
  { id: "files", key: "cockpit.files" },
];

function runLabel(status: Run["status"], t: ReturnType<typeof useI18n>["t"]): string {
  switch (status) {
    case "cancelled":
      return t("run.cancelled");
    case "done":
      return t("run.done");
    case "failed":
      return t("run.failed");
    case "interrupted":
      return t("run.interrupted");
    case "queued":
      return t("run.queued");
    case "running":
      return t("run.running");
    case "waiting_user":
      return t("run.waiting_user");
  }
}

function auditLabel(action: string, t: ReturnType<typeof useI18n>["t"]): string {
  const labels: Record<string, string> = {
    "approval.decided": t("audit.approvalDecided"),
    "approval.expired": t("audit.approvalExpired"),
    "approval.requested": t("audit.approvalRequested"),
    "bot.created": t("audit.botCreated"),
    "bot.deleted": t("audit.botDeleted"),
    "bot.paused": t("audit.botPaused"),
    "bot.resumed": t("audit.botResumed"),
    "bot.updated": t("audit.botUpdated"),
    "message.prompted": t("audit.messagePrompted"),
    "question.answered": t("audit.questionAnswered"),
    "question.expired": t("audit.questionExpired"),
    "question.requested": t("audit.questionRequested"),
    "run.cancelled": t("run.cancelled"),
    "run.done": t("audit.runDone"),
    "run.error": t("run.failed"),
    "run.failed": t("audit.runFailed"),
    "run.interrupted": t("audit.runInterrupted"),
    "run.started": t("audit.runStarted"),
    "thread.created": t("audit.threadCreated"),
  };
  return labels[action] ?? action.replaceAll(".", " ");
}

function decisionLabel(decision: string, t: ReturnType<typeof useI18n>["t"]): string {
  switch (decision) {
    case "queued": case "running": case "waiting_user": case "done":
    case "failed": case "cancelled": case "interrupted":
      return runLabel(decision, t);
    case "allow_once": return t("approval.allowOnce");
    case "allow_session": return t("approval.allowSession");
    case "deny": return t("approval.deny");
    case "expired": return t("approval.expired");
    case "answered": return t("audit.questionAnswered");
    default: return decision;
  }
}

function actorLabel(actor: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (actor === "person") return t("actor.person");
  if (actor === "system") return t("actor.system");
  return actor;
}

const RUN_TONE: Record<Run["status"], string> = {
  cancelled: "text-muted-foreground",
  done: "text-success",
  failed: "text-destructive",
  interrupted: "text-warning",
  queued: "text-muted-foreground",
  running: "text-brand",
  waiting_user: "text-warning",
};

function QueryNotice({ error, retry, message }: {
  error?: Error | null;
  retry?: () => void;
  message?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="px-3 py-3 text-xs" role={error ? "alert" : "status"}>
      <p className={error ? "text-destructive" : "text-muted-foreground"}>
        {message ?? t(error ? "common.loadFailed" : "common.loading")}
      </p>
      {error ? <p className="mt-1 break-words text-destructive">{error.message}</p> : null}
      {error && retry ? (
        <Button className="mt-2" onClick={retry} size="sm" variant="outline">{t("common.retry")}</Button>
      ) : null}
    </div>
  );
}

function SourceLink({ botId, threadId, label }: { botId: string; threadId?: string | null; label: string }) {
  const style = "break-all text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";
  return threadId ? (
    <Link className={style} params={{ botId, threadId }} to="/bots/$botId/threads/$threadId">{label}</Link>
  ) : (
    <Link className={style} params={{ botId }} to="/bots/$botId">{label}</Link>
  );
}

function ActivityTab({ bot }: { bot: Bot }) {
  const runs = useQuery(runsQuery(bot.id));
  const activity = useQuery(activityQuery(bot.id));
  const bots = useQuery(botsQuery());
  const { t } = useI18n();
  const rows = activityRows(runs.data ?? [], activity.data ?? []);
  const error = runs.error ?? activity.error;
  const pending = runs.isPending || activity.isPending;

  return (
    <>
      {error ? <QueryNotice error={error} retry={() => { void runs.refetch(); void activity.refetch(); }} /> : null}
      {pending ? <QueryNotice /> : null}
      {!error && !pending && rows.length === 0 ? (
        <p className="px-3 py-6 text-muted-foreground text-sm">{t("drawer.empty")}</p>
      ) : null}
      <ol className="flex flex-col gap-0.5 px-2 pb-6">
        {rows.map((row) => {
          const botId = row.kind === "run" ? row.run.botId : row.entry.botId;
          const threadId = row.kind === "run" ? row.run.threadId : row.entry.threadId;
          const roomId = row.roomId;
          const sourceName = bots.data?.find((entry) => entry.id === botId)?.name ?? (botId === bot.id ? bot.name : botId);
          return (
            <li className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50" key={row.id}>
              <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted", row.kind === "run" ? RUN_TONE[row.run.status] : "text-muted-foreground")}>
                {row.kind === "run" ? (
                  row.run.status === "done" ? <IconCheck className="size-3" /> :
                    row.run.status === "failed" || row.run.status === "interrupted" ? <IconX className="size-3" /> :
                      <IconPlayerPlay className="size-2.5" />
                ) : <span aria-hidden className="size-1.5 rounded-full bg-current" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-all text-[12.5px]">
                  {row.kind === "run" ? `${t("drawer.run", { id: row.run.id })} · ${runLabel(row.run.status, t)}` : auditLabel(row.entry.action, t)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {row.kind === "audit" ? `${bots.data?.find((entry) => entry.id === row.entry.actor)?.name ?? actorLabel(row.entry.actor, t)} · ` : ""}
                  {row.at === null ? t("common.unknownTime") : <time dateTime={new Date(row.at).toISOString()}>{relativeTime(new Date(row.at).toISOString())}</time>}
                </p>
                {botId ? <SourceLink botId={botId} threadId={threadId} label={`${sourceName}${threadId ? ` · ${t("drawer.thread", { id: threadId })}` : ""}`} /> : null}
                {roomId ? <Link className="ml-2 text-[11px] underline" params={{ roomId }} to="/rooms/$roomId">#{roomId}</Link> : null}
                {row.error ? <p className="mt-1 whitespace-pre-wrap break-words text-destructive text-xs">{row.error}</p> : null}
                {row.kind === "audit" && row.entry.decision ? <p className="text-[11px] text-muted-foreground">{decisionLabel(row.entry.decision, t)}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function ApprovalsTab({ bot }: { bot: Bot }) {
  const inbox = useQuery(inboxQuery());
  const { t } = useI18n();
  const approvals = (inbox.data?.approvals ?? []).filter(
    (approval) => approval.botId === bot.id && approval.status === "pending" && approval.expiresAt > Date.now(),
  );
  const questions = (inbox.data?.questions ?? []).filter(
    (question) => question.botId === bot.id && question.status === "pending",
  );
  if (inbox.isPending) return <QueryNotice />;
  if (inbox.error) return <QueryNotice error={inbox.error} retry={() => { void inbox.refetch(); }} />;
  if (!approvals.length && !questions.length) {
    return (
      <p className="px-3 py-6 text-muted-foreground text-sm">
        {t("drawer.notWaiting", { name: bot.name })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 px-2 pb-6">
      {questions.map((question) => (
        <div key={question.id}>
          <SourceLink botId={bot.id} threadId={question.threadId} label={t("inbox.openThread")} />
          <QuestionCard botName={bot.name} question={question} />
        </div>
      ))}
      {approvals.map((approval) => (
        <div key={approval.id}>
          <SourceLink botId={bot.id} threadId={approval.threadId} label={t("inbox.openThread")} />
          <ApprovalCard approval={approval} botName={bot.name} />
        </div>
      ))}
    </div>
  );
}

function FilesTab({ bot, threadId }: { bot: Bot; threadId?: string }) {
  const { t } = useI18n();
  const [directory, setDirectory] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const root = useQuery(filesQuery(bot.id, undefined, threadId));
  const files = useQuery(filesQuery(bot.id, directory, threadId));
  const content = useQuery({
    ...fileQuery(bot.id, selected ?? "", threadId),
    enabled: selected !== null,
  });
  const currentPath = files.data?.path ?? directory ?? root.data?.path;
  const crumbs = root.data && currentPath ? fileBreadcrumbs(root.data.path, currentPath) : [];
  const parent = crumbs.at(-2)?.path;
  const openDirectory = (path: string) => { setSelected(null); setDirectory(path); };
  const refresh = () => {
    void files.refetch();
    if (selected !== null) void content.refetch();
  };
  const metadata = files.data?.entries.find((entry) => entry.path === selected);

  return (
    <div className="flex min-h-0 flex-col pb-6">
      <div className="flex flex-wrap items-center gap-1 px-2 py-1">
        {selected !== null ? (
          <Button onClick={() => setSelected(null)} size="sm" variant="ghost"><IconArrowLeft className="size-3.5" />{t("drawer.files")}</Button>
        ) : parent ? (
          <Button onClick={() => openDirectory(parent)} size="sm" variant="ghost"><IconArrowLeft className="size-3.5" />{t("files.parent")}</Button>
        ) : null}
        <Button className="ml-auto" disabled={files.isFetching || (selected !== null && content.isFetching)} onClick={refresh} size="sm" variant="ghost">{t("files.refresh")}</Button>
      </div>
      {crumbs.length > 0 ? (
        <nav aria-label={t("files.path")} className="flex flex-wrap items-center gap-1 px-3 pb-2 font-mono text-[11px] text-muted-foreground">
          {crumbs.map((crumb, index) => (
            <span className="min-w-0 break-all" key={crumb.path}>
              {index > 0 ? <span aria-hidden className="px-1">/</span> : null}
              <button aria-current={index === crumbs.length - 1 ? "location" : undefined} className="text-left hover:text-foreground hover:underline" onClick={() => openDirectory(crumb.path)} title={crumb.path} type="button">{index === 0 ? t("files.root") : crumb.label}</button>
            </span>
          ))}
        </nav>
      ) : null}
      {currentPath ? <p className="break-all px-3 pb-2 font-mono text-[11px] text-muted-foreground">{currentPath}</p> : null}
      {selected !== null ? (
        <>
          <p className="break-all px-3 pb-2 font-mono text-[11.5px]">{content.data?.path ?? selected}{metadata?.size !== null && metadata?.size !== undefined ? <span className="ml-2 text-muted-foreground">{metadata.size} B</span> : null}</p>
          {content.isFetching ? <QueryNotice /> : null}
          {content.error ? <QueryNotice error={content.error} message={t("files.readFailed")} retry={() => { void content.refetch(); }} /> : null}
          {content.data ? (
            <>
              {content.data.truncated ? <p className="px-3 pb-2 text-warning text-xs" role="status">{t("files.truncated")}</p> : null}
              <pre className="mx-2 overflow-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed">{content.data.content}</pre>
            </>
          ) : null}
        </>
      ) : (
        <>
          {files.isFetching ? <QueryNotice /> : null}
          {files.error || root.error ? <QueryNotice error={files.error ?? root.error} message={t("files.listFailed")} retry={() => { void root.refetch(); void files.refetch(); }} /> : null}
          {!files.error && !root.error && !files.isPending && files.data?.entries.length === 0 ? <p className="px-3 py-4 text-muted-foreground text-sm">{t("drawer.emptyWorkspace")}</p> : null}
          <ul className="flex flex-col gap-px px-2">
            {(files.data?.entries ?? []).map((entry) => (
              <li key={entry.path}>
                <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60" onClick={() => entry.kind === "directory" ? openDirectory(entry.path) : setSelected(entry.path)} title={entry.path} type="button">
                  {entry.kind === "directory" ? <IconFolder className="size-4 shrink-0 text-muted-foreground" /> : <IconFileText className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{fileName(entry.path)}</span>
                  {entry.size !== null && entry.kind === "file" ? <span className="text-[10px] text-muted-foreground tabular-nums">{entry.size} B</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The right-hand pane: what the Bot did, what it needs, and what it can see. */
export function RightDrawer({ bot, threadId }: { bot: Bot; threadId?: string }) {
  const [tab, setTab] = useState<Tab>("activity");
  const inbox = useQuery(inboxQuery());
  const { t } = useI18n();
  const waiting =
    (inbox.error ? 0 : inbox.data?.approvals.filter((approval) => approval.botId === bot.id && approval.status === "pending" && approval.expiresAt > Date.now()).length ?? 0) +
    (inbox.error ? 0 : inbox.data?.questions.filter((question) => question.botId === bot.id && question.status === "pending").length ?? 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        {TABS.map((entry) => (
          <button
            aria-pressed={tab === entry.id}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors",
              tab === entry.id
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={entry.id}
            onClick={() => setTab(entry.id)}
            type="button"
          >
            {entry.id === "approvals" ? (
              <IconShieldQuestion className="size-3.5" />
            ) : null}
            {t(entry.key)}
            {entry.id === "approvals" && waiting > 0 ? (
              <span className="rounded-full bg-warning/15 px-1 text-[10px] text-warning tabular-nums">
                {waiting}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "activity" ? <ActivityTab bot={bot} /> : null}
        {tab === "approvals" ? <ApprovalsTab bot={bot} /> : null}
        {tab === "files" ? <FilesTab bot={bot} key={`${bot.id}:${threadId ?? "bot"}`} threadId={threadId} /> : null}
      </div>
    </div>
  );
}
