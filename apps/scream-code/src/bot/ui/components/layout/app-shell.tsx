import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BotRail } from "@/components/bots/bot-rail";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { ShellProvider } from "@/components/layout/shell-context";
import { CommandPalette } from "@/components/shell/command-palette";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { useBotConnectionState, useBotEvents } from "@/lib/api/events";
import { useI18n } from "@/lib/i18n";
import { rememberActiveBot } from "@/lib/session";

/**
 * The workbench frame: one rail, one pane, and the two global overlays (new Bot, command menu).
 *
 * One viewport, never scrolls; the transcript and the drawers scroll inside it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  useBotEvents();
  const connection = useBotConnectionState();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [railOpen, setRailOpen] = useState(false);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const rail = (
    <BotRail
      onNavigate={() => setRailOpen(false)}
      onNewBot={() => {
        setRailOpen(false);
        setNewBotOpen(true);
      }}
      onOpenPalette={() => {
        setRailOpen(false);
        setPaletteOpen(true);
      }}
    />
  );

  return (
    <ShellProvider value={{ openRail: () => setRailOpen(true) }}>
      <div className="flex h-svh overflow-hidden bg-background">
        <aside className="hidden w-[272px] shrink-0 border-sidebar-border border-r bg-sidebar lg:block">
          {rail}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {connection.status !== "connected" && connection.status !== "local" ? (
            <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-1 text-muted-foreground text-xs" role="status" title={connection.error ?? undefined}>
              {t(`connection.${connection.status}`)}
              {connection.retryInMs !== null ? ` · ${t("connection.retryIn", { seconds: Math.ceil(connection.retryInMs / 1000) })}` : null}
              {connection.error ? ` — ${connection.error}` : null}
            </div>
          ) : null}
          {children}
        </main>
      </div>

      <Sheet onOpenChange={setRailOpen} open={railOpen}>
        <SheetContent
          className="w-[84vw] max-w-[320px] gap-0 bg-sidebar p-0"
          side="left"
        >
          <SheetTitle className="sr-only">{t("cockpit.openNav")}</SheetTitle>
          {rail}
        </SheetContent>
      </Sheet>

      <NewBotSheet
        onClose={() => setNewBotOpen(false)}
        onCreated={(bot) => {
          setNewBotOpen(false);
          rememberActiveBot(bot.id);
          void navigate({ params: { botId: bot.id }, to: "/bots/$botId" });
        }}
        open={newBotOpen}
      />

      <CommandPalette onOpenChange={setPaletteOpen} open={paletteOpen} />
    </ShellProvider>
  );
}
