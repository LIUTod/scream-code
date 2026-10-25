import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Run } from "../../../shared/contracts";
import { Button } from "@/components/ui/button";
import { getBotClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries";
import type { RecoveryDecision } from "@/lib/client";
import { useI18n } from "@/lib/i18n";

/** Interrupted work is never silently replayed: the person chooses the next action. */
export function RecoveryCard({ run, roomId }: { run: Run; roomId?: string }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const recover = useMutation({
    retry: false,
    mutationFn: (operation: { runId: string; botId: string; threadId: string; decision: RecoveryDecision }) =>
      getBotClient().recoverRun(operation.runId, operation.decision),
    onSuccess: async (_result, operation) => {
      await Promise.all([
        queries.invalidateQueries({ queryKey: queryKeys.runs(operation.botId) }),
        queries.invalidateQueries({ queryKey: queryKeys.threads(operation.botId) }),
        queries.invalidateQueries({ queryKey: queryKeys.messages(operation.threadId) }),
        ...(roomId === undefined
          ? []
          : [queries.invalidateQueries({ queryKey: queryKeys.roomMessages(roomId) })]),
        queries.invalidateQueries({ queryKey: queryKeys.inbox() }),
        queries.invalidateQueries({ queryKey: queryKeys.bots() }),
      ]);
    },
  });
  const choose = (decision: RecoveryDecision) => {
    if (recover.isPending || recover.isSuccess || run.status !== "interrupted" || run.recoveryDecision) return;
    recover.mutate({ runId: run.id, botId: run.botId, threadId: run.threadId, decision });
  };
  const disabled = recover.isPending || recover.isSuccess || run.status !== "interrupted" || Boolean(run.recoveryDecision);
  return (
    <section className="mx-4 mb-3 rounded-xl border border-warning/40 bg-warning/5 p-3" aria-label={t("recovery.title")}>
      <h2 className="font-medium text-sm">{t("recovery.title")}</h2>
      <p className="mt-1 text-muted-foreground text-xs">{t("recovery.description")}</p>
      {run.error ? <p className="mt-1 break-words text-xs">{run.error}</p> : null}
      {recover.error ? <p className="mt-2 text-destructive text-xs" role="alert">{t("recovery.failed")} {recover.error.message}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={disabled} size="sm" onClick={() => choose("continue_queue")}>{t("recovery.continue")}</Button>
        <Button disabled={disabled} size="sm" variant="outline" onClick={() => {
          if (!disabled && window.confirm(t("recovery.retryConfirm"))) choose("retry");
        }}>{t("recovery.retry")}</Button>
        <Button disabled={disabled} size="sm" variant="ghost" onClick={() => choose("cancel_queue")}>{t("recovery.cancel")}</Button>
      </div>
    </section>
  );
}
