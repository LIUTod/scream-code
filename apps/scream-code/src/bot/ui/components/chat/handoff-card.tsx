import { IconArrowUpRight, IconArrowsExchange } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Handoff } from "../../../shared/contracts";
import { Button } from "@/components/ui/button";
import { botsQuery } from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<Handoff["status"], string> = {
  awaiting_relay: "border-warning/30 bg-warning/10 text-warning",
  cancelled: "border-border bg-muted/60 text-muted-foreground",
  delivered: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  interrupted: "border-warning/30 bg-warning/10 text-warning",
  queued: "border-border bg-muted/60 text-muted-foreground",
  refused: "border-warning/30 bg-warning/10 text-warning",
  running: "border-brand/30 bg-brand/10 text-brand",
};

const STATUS_KEYS: Record<
  Handoff["status"],
  | "handoff.awaiting_relay"
  | "handoff.cancelled"
  | "handoff.delivered"
  | "handoff.failed"
  | "handoff.interrupted"
  | "handoff.queued"
  | "handoff.refused"
  | "handoff.running"
> = {
  awaiting_relay: "handoff.awaiting_relay",
  cancelled: "handoff.cancelled",
  delivered: "handoff.delivered",
  failed: "handoff.failed",
  interrupted: "handoff.interrupted",
  queued: "handoff.queued",
  refused: "handoff.refused",
  running: "handoff.running",
};

/** The one row that says work left this thread, and where it went. */
export function HandoffCard({ handoff }: { handoff: Handoff }) {
  const bots = useQuery(botsQuery());
  const navigate = useNavigate();
  const { t } = useI18n();
  const to = bots.data?.find((bot) => bot.id === handoff.toBotId);
  const canOpen = Boolean(handoff.toThreadId);

  return (
    <div className="mt-2 rounded-xl border border-border bg-card p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <IconArrowsExchange className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[13px]">
              {t("handoff.handedTo", { name: to?.name ?? t("handoff.anotherBot") })}
            </span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                STATUS_TONE[handoff.status],
              )}
            >
              {t(STATUS_KEYS[handoff.status])}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {relativeTime(new Date(handoff.createdAt).toISOString())}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">
            {handoff.task}
          </p>
          {handoff.error ? (
            <p className="mt-1 text-destructive text-xs">{handoff.error}</p>
          ) : null}
          {handoff.status === "delivered" ? (
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              {t("handoff.deliveredNote", { name: to?.name ?? t("handoff.anotherBot") })}
            </p>
          ) : null}
        </div>
        {canOpen && to ? (
          <Button
            onClick={() =>
              void navigate({
                params: { botId: to.id, threadId: handoff.toThreadId ?? "" },
                to: "/bots/$botId/threads/$threadId",
              })
            }
            size="sm"
            variant="outline"
          >
            {t("landing.open", { name: to.name })}
            <IconArrowUpRight className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
