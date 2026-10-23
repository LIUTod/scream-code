import { IconShieldCheck, IconShieldQuestion } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval, ApprovalDecision } from "../../../shared/contracts";
import { Button } from "@/components/ui/button";
import { getBotClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";
import { relativeTime } from "@/lib/relative-time";

function actionTitle(
  approval: Approval,
  botName: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const tool = approval.toolName.toLowerCase();
  if (/bash|shell|exec/.test(tool)) return t("approval.command", { name: botName });
  if (/write|edit|patch/.test(tool)) return t("approval.changeFile", { name: botName });
  return t("approval.useTool", { name: botName, tool: approval.toolName });
}

/** A decision only the person can make, drawn where the Bot stopped. */
export function ApprovalCard({
  approval,
  botName,
}: {
  approval: Approval;
  botName: string;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const decide = useMutation({
    mutationFn: (decision: ApprovalDecision) =>
      getBotClient().decideApproval(approval.id, { decision }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages(approval.threadId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots() });
    },
  });

  const expired = approval.expiresAt < Date.now();

  return (
    <div className="mt-3 rounded-xl border border-warning/35 bg-warning/[0.05] p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-warning/15 text-warning">
          <IconShieldQuestion className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[13px]">{actionTitle(approval, botName, t)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("approval.asked", { time: relativeTime(new Date(approval.createdAt).toISOString()) })}
            {expired ? ` · ${t("approval.expired")}` : ""}
          </p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/70 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed">
            {approval.action}
          </pre>
          {approval.reasons.length ? (
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
              {approval.reasons.map((reason) => (
                <li className="flex items-center gap-1" key={reason}>
                  <span aria-hidden className="size-1 rounded-full bg-muted-foreground/50" />
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
          {decide.error ? (
            <p className="mt-2 text-destructive text-xs" role="alert">
              {decide.error.message}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Button
              disabled={decide.isPending || expired}
              onClick={() => decide.mutate("allow_once")}
              size="sm"
            >
              <IconShieldCheck className="size-3.5" />
              {t("approval.allowOnce")}
            </Button>
            {approval.grantOptions.includes("session") ? (
              <Button
                disabled={decide.isPending || expired}
                onClick={() => decide.mutate("allow_session")}
                size="sm"
                variant="outline"
              >
                {t("approval.allowSession")}
              </Button>
            ) : null}
            <Button
              disabled={decide.isPending || expired}
              onClick={() => decide.mutate("deny")}
              size="sm"
              variant="ghost"
            >
              {t("approval.deny")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
