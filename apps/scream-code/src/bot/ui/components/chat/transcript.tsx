import { useQuery } from "@tanstack/react-query";
import type { Bot, Message } from "../../../shared/contracts";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { ToolLine } from "@/components/channels/tool-line";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { inboxQuery, messagesQuery, runsQuery } from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { HandoffCard } from "./handoff-card";
import { QuestionCard } from "@/components/approvals/question-card";
import { ToolActivity } from "./tool-activity";
import { MessageBody } from "./message-body";

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

function TypingDots() {
  const { t } = useI18n();
  return (
    <span aria-label={t("transcript.working")} className="flex items-center gap-1 py-1.5">
      {[0, 1, 2].map((index) => (
        <span
          className="typing-dot size-1.5 rounded-full bg-muted-foreground"
          key={index}
          style={{ animationDelay: `${index * 0.15}s` }}
        />
      ))}
    </span>
  );
}

function MessageRow({ bot, message }: { bot: Bot; message: Message }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center py-1">
        <p className="max-w-[90%] text-center text-[11.5px] text-muted-foreground/80">
          {message.content}
        </p>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[13.5px] text-secondary-foreground leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 gap-2.5">
      <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-[12.5px]">{bot.name}</span>
          {/* Hydrated history carries no wall clock; 0 means "unknown", not 1970. */}
          {message.createdAt !== null && message.createdAt > 0 ? (
            <time className="text-[11px] text-muted-foreground">
              {clock.format(message.createdAt)}
            </time>
          ) : null}
        </div>
        {message.content ? <MessageBody className="mt-1" content={message.content} /> : null}
        {message.toolCalls?.length ? <ToolActivity calls={message.toolCalls} /> : null}
        {message.handoff ? <HandoffCard handoff={message.handoff} /> : null}
      </div>
    </div>
  );
}

export function Transcript({
  bot,
  threadId,
}: {
  bot: Bot;
  threadId: string;
}) {
  const messages = useQuery(messagesQuery(threadId));
  const inbox = useQuery(inboxQuery());
  const runs = useQuery(runsQuery(bot.id));
  const { t } = useI18n();
  const approvals = (inbox.data?.approvals ?? []).filter(
    (approval) => approval.threadId === threadId,
  );
  const questions = (inbox.data?.questions ?? []).filter(
    (question) => question.threadId === threadId,
  );
  const items = messages.data ?? [];
  // A new Bot's thread opens with a system line naming its workspace. That is not a conversation,
  // so it does not earn the empty state's absence.
  const hasConversation = items.some((message) => message.role !== "system");
  const last = items.at(-1);
  const threadRuns = (runs.data ?? []).filter((run) => run.threadId === threadId);
  const activeRun = threadRuns.find((run) => run.status === "running" || run.status === "waiting_user");
  const lastRun = threadRuns.toSorted((a, b) => b.startedAt - a.startedAt)[0];
  const streaming = activeRun?.status === "running" && (
    !last || last.role !== "assistant" ||
    (!last.content.trim() && !last.toolCalls?.some((call) => call.status === "running"))
  );

  return (
    <MessageScrollerProvider key={`${bot.id}:${threadId}`}>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport className="px-4 md:px-8">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl py-7">
            {!hasConversation && !activeRun && !messages.isPending && !messages.isError ? (
              <div className="flex flex-col items-center gap-3 py-20 text-center">
                <AbstractAvatar
                  name={bot.name}
                  seed={bot.avatarSeed}
                  size={44}
                />
                <div>
                  <p className="font-medium text-[15px]">
                    {t("transcript.start", { name: bot.name })}
                  </p>
                  <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
                    {bot.title} · {bot.workspace}
                  </p>
                </div>
              </div>
            ) : null}
            {items.filter((message) => message.role !== "assistant" || message.content.length > 0 || (message.toolCalls?.length ?? 0) > 0 || message.handoff !== undefined).map((message) => (
              <MessageScrollerItem key={message.id}>
                <MessageRow bot={bot} message={message} />
              </MessageScrollerItem>
            ))}
            {streaming ? (
              <MessageScrollerItem>
                <div className="flex gap-2.5">
                  <AbstractAvatar
                    name={bot.name}
                    seed={bot.avatarSeed}
                    size={26}
                  />
                  <TypingDots />
                </div>
              </MessageScrollerItem>
            ) : null}
            {questions.map((question) => (
              <MessageScrollerItem key={question.id}>
                <QuestionCard botName={bot.name} question={question} />
              </MessageScrollerItem>
            ))}
            {approvals.map((approval) => (
              <MessageScrollerItem key={approval.id}>
                <ApprovalCard approval={approval} botName={bot.name} />
              </MessageScrollerItem>
            ))}
            {lastRun && (lastRun.error || lastRun.status === "interrupted") ? (
              <MessageScrollerItem>
                <p className="whitespace-pre-wrap break-words text-xs text-destructive" role="alert">{t(lastRun.status === "interrupted" ? "transcript.interrupted" : lastRun.status === "cancelled" ? "run.cancelled" : "transcript.runFailed")}{lastRun.error ? `: ${lastRun.error}` : ""}</p>
              </MessageScrollerItem>
            ) : null}
            {messages.isError ? (
              <MessageScrollerItem>
                <div className="text-xs text-destructive" role="alert">
                  <p>{t("transcript.loadFailed")}: {messages.error.message}</p>
                  <button className="mt-1 underline underline-offset-2" disabled={messages.isFetching} onClick={() => { void messages.refetch(); }} type="button">{t("transcript.retry")}</button>
                </div>
              </MessageScrollerItem>
            ) : null}
            {inbox.isError ? <MessageScrollerItem><p className="text-xs text-destructive" role="alert">{inbox.error.message}</p></MessageScrollerItem> : null}
            {messages.isPending ? (
              <MessageScrollerItem>
                <ToolLine label={t("transcript.loading")} running />
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
