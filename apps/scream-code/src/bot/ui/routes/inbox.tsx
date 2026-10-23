import { IconArrowUpRight, IconLayoutSidebar } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { HandoffCard } from "@/components/chat/handoff-card";
import { QuestionCard } from "@/components/approvals/question-card";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { botsQuery, inboxQuery } from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";
import { shellRoute } from "./shell";

export const inboxRoute = createRoute({
  component: InboxPage,
  getParentRoute: () => shellRoute,
  path: "/inbox",
});

function InboxPage() {
  const inbox = useQuery(inboxQuery());
  const bots = useQuery(botsQuery());
  const botOf = (botId: string) => bots.data?.find((bot) => bot.id === botId);
  const approvals = inbox.data?.approvals ?? [];
  const questions = inbox.data?.questions ?? [];
  const handoffs = inbox.data?.handoffs ?? [];
  const waiting = approvals.length + questions.length;
  const { t } = useI18n();

  return (
    <PageShell
      description={t("inbox.description")}
      title={t("inbox.title")}
    >
      <PageSection
        title={
          waiting > 0
            ? t("inbox.needsYouCount", { count: waiting })
            : t("inbox.needsYou")
        }
      >
        {waiting === 0 ? (
          <PageEmpty>{t("inbox.empty")}</PageEmpty>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {questions.map((question) => {
              const bot = botOf(question.botId);
              if (!bot) return null;
              return (
                <div key={question.id}>
                  <ThreadLink
                    botId={bot.id}
                    botName={bot.name}
                    threadId={question.threadId}
                  />
                  <QuestionCard botName={bot.name} question={question} />
                </div>
              );
            })}
            {approvals.map((approval) => {
              const bot = botOf(approval.botId);
              if (!bot) return null;
              return (
                <div key={approval.id}>
                  <ThreadLink
                    botId={bot.id}
                    botName={bot.name}
                    threadId={approval.threadId}
                  />
                  <ApprovalCard approval={approval} botName={bot.name} />
                </div>
              );
            })}
          </div>
        )}
      </PageSection>

      <PageSection
        description={t("inbox.handoffsDescription")}
        title={t("inbox.handoffs")}
      >
        {handoffs.length === 0 ? (
          <PageEmpty>{t("inbox.noHandoffs")}</PageEmpty>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            {handoffs.map((handoff) => (
              <HandoffCard handoff={handoff} key={handoff.id} />
            ))}
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

function ThreadLink({
  botId,
  botName,
  threadId,
}: {
  botId: string;
  botName: string;
  threadId: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between px-1 pb-1">
      <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
        {botName}
      </span>
      <Link
        className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
        params={{ botId, threadId }}
        to="/bots/$botId/threads/$threadId"
      >
        {t("inbox.openThread")}
        <IconArrowUpRight className="size-3" />
      </Link>
    </div>
  );
}
