import { IconArrowRight, IconCommand } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { StatusPill } from "@/components/bots/status";
import { Button } from "@/components/ui/button";
import { botsQuery } from "@/lib/api/queries";
import { LangToggle, useI18n } from "@/lib/i18n";
import { readActiveBot, rememberActiveBot } from "@/lib/session";
import { shellRoute } from "./shell";

export const indexRoute = createRoute({
  component: Landing,
  getParentRoute: () => shellRoute,
  path: "/",
});

function Landing() {
  const bots = useQuery(botsQuery());
  const navigate = useNavigate();
  const { t } = useI18n();
  const active = readActiveBot();
  const target = bots.data?.find((bot) => bot.id === active);

  // Reopening the workbench resumes the Bot that was last on screen.
  if (target) {
    return <Navigate params={{ botId: target.id }} replace to="/bots/$botId" />;
  }

  return (
    <div className="relative flex min-h-0 flex-1 justify-center overflow-y-auto px-5 py-10 md:px-8 md:py-14">
      <div className="absolute top-4 right-4">
        <LangToggle />
      </div>
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3.5">
          <AgentOrb
            colors={{
              bg: "#0b1f1e",
              c1: "#3fb8a8",
              c2: "#0f766e",
              c3: "#134e4a",
              c4: "#99f6e4",
            }}
            size="52px"
            state="idle"
          />
          <div>
            <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.16em]">
              {t("landing.kicker")}
            </p>
            <h1 className="font-semibold text-2xl tracking-tight">
              {t("landing.title")}
            </h1>
          </div>
        </div>

        <p className="mt-4 max-w-prose text-[13.5px] text-muted-foreground leading-relaxed">
          {t("landing.body")}
        </p>

        <div className="mt-8 grid gap-2 sm:grid-cols-2">
          {(bots.data ?? []).map((bot) => (
            <button
              className="group flex items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-foreground/20"
              key={bot.id}
              onClick={() => {
                rememberActiveBot(bot.id);
                void navigate({
                  params: { botId: bot.id },
                  to: "/bots/$botId",
                });
              }}
              type="button"
            >
              <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={34} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium text-[13.5px]">
                    {bot.name}
                  </span>
                  <StatusPill bot={bot} />
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                  {bot.title ? `${bot.title} · ` : ""}
                  {bot.workspace}
                </span>
              </span>
              <IconArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </button>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button
            disabled={!bots.data?.length}
            onClick={() => {
              const first = bots.data?.[0];
              if (!first) return;
              rememberActiveBot(first.id);
              void navigate({ params: { botId: first.id }, to: "/bots/$botId" });
            }}
          >
            {t("landing.open", { name: bots.data?.[0]?.name ?? t("landing.openFallback") })}
            <IconArrowRight className="size-3.5" />
          </Button>
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <IconCommand className="size-3.5" />
            {t("landing.command")}
          </span>
        </div>
      </div>
    </div>
  );
}
