import type { Bot, BotStatus } from "../../../shared/contracts";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const STATUS_KEYS: Record<BotStatus, "status.error" | "status.idle" | "status.needs_you" | "status.paused" | "status.working"> = {
  error: "status.error",
  idle: "status.idle",
  needs_you: "status.needs_you",
  paused: "status.paused",
  working: "status.working",
};

export function StatusDot({
  status,
  className,
}: {
  status: BotStatus;
  className?: string;
}) {
  const tone =
    status === "working"
      ? "bg-brand"
      : status === "needs_you"
        ? "bg-warning"
        : status === "error"
          ? "bg-destructive"
          : status === "paused"
            ? "bg-muted-foreground/40"
            : "";
  if (!tone) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar",
        tone,
        status === "working" ? "animate-pulse" : "",
        className,
      )}
    />
  );
}

export function StatusPill({ bot }: { bot: Bot }) {
  const { t } = useI18n();
  const label = bot.paused ? t("status.paused") : t(STATUS_KEYS[bot.status]);
  const tone =
    bot.status === "needs_you"
      ? "border-warning/30 bg-warning/10 text-warning"
      : bot.status === "working"
        ? "border-brand/30 bg-brand/10 text-brand"
        : bot.status === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted/60 text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          bot.status === "needs_you"
            ? "bg-warning"
            : bot.status === "working"
              ? "bg-brand animate-pulse"
              : bot.status === "error"
                ? "bg-destructive"
                : "bg-muted-foreground/50",
        )}
      />
      {label}
    </span>
  );
}

export function attentionSummary(bot: Bot): string {
  const parts: string[] = [];
  if (bot.needsYou > 0) {
    parts.push(`${bot.needsYou} waiting on you`);
  }
  if (bot.unread > 0) parts.push(`${bot.unread} unread`);
  return parts.join(" · ");
}
