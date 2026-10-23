import { IconCornerDownLeft, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { botsQuery, roomsQuery } from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";
import { rememberActiveBot } from "@/lib/session";
import { cn } from "@/lib/utils";

type Command = {
  id: string;
  label: string;
  hint: string;
  run: () => void;
};

/**
 * Cmd+K, kept small: jump to a Bot, a room, the inbox or settings.
 *
 * It is a navigation aid rather than a command language for now; the entries are the same places
 * the rail already lists, which is exactly what makes it worth opening.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bots = useQuery(botsQuery());
  const rooms = useQuery(roomsQuery());
  const navigate = useNavigate();
  const { t } = useI18n();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const close = () => onOpenChange(false);
    return [
      {
        hint: t("app.inbox"),
        id: "inbox",
        label: t("palette.goTo", { name: t("app.inbox") }),
        run: () => {
          close();
          void navigate({ to: "/inbox" });
        },
      },
      ...(bots.error ? [] : bots.data ?? []).map((bot) => ({
        hint: bot.title || t("app.bots"),
        id: `bot-${bot.id}`,
        label: t("palette.open", { name: bot.name }),
        run: () => {
          close();
          rememberActiveBot(bot.id);
          void navigate({ params: { botId: bot.id }, to: "/bots/$botId" });
        },
      })),
      ...(rooms.error ? [] : rooms.data ?? []).map((room) => ({
        hint: t("app.rooms"),
        id: `room-${room.id}`,
        label: t("palette.openRoom", { name: room.name }),
        run: () => {
          close();
          void navigate({
            params: { roomId: room.id },
            to: "/rooms/$roomId",
          });
        },
      })),
      {
        hint: t("app.settings"),
        id: "settings",
        label: t("palette.goTo", { name: t("app.settings") }),
        run: () => {
          close();
          void navigate({ to: "/settings" });
        },
      },
    ];
  }, [bots.data, bots.error, navigate, onOpenChange, rooms.data, rooms.error, t]);

  const visible = commands.filter((command) =>
    `${command.label} ${command.hint}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  const activeIndex = Math.min(active, Math.max(0, visible.length - 1));
  const error = bots.error ?? rooms.error;
  const loading = bots.isPending || rooms.isPending;

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t("palette.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("palette.description")}</DialogDescription>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <IconSearch className="size-4 text-muted-foreground" />
          <input
            aria-activedescendant={visible.length > 0 ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={open}
            aria-label={t("palette.search")}
            autoFocus
            role="combobox"
            className="h-11 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive(visible.length ? (activeIndex + 1) % visible.length : 0);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(visible.length ? (activeIndex - 1 + visible.length) % visible.length : 0);
              } else if (event.key === "Enter") {
                event.preventDefault();
                visible[activeIndex]?.run();
              }
            }}
            placeholder={t("palette.search")}
            value={query}
          />
        </div>
        {loading ? <p className="px-3 py-2 text-muted-foreground text-xs" role="status">{t("common.loading")}</p> : null}
        {error ? (
          <div className="px-3 py-2 text-destructive text-xs" role="alert">
            <p>{t("common.loadFailed")} {error.message}</p>
            <Button className="mt-2" onClick={() => { void bots.refetch(); void rooms.refetch(); }} size="sm" variant="outline">{t("common.retry")}</Button>
          </div>
        ) : null}
        <div aria-label={t("palette.title")} className="max-h-[320px] overflow-y-auto p-1.5" id={listId} ref={listRef} role="listbox">
          {visible.length === 0 ? (
            !loading && !error ? <p className="px-3 py-6 text-center text-muted-foreground text-sm">{t("palette.noMatches", { query: query.trim() })}</p> : null
          ) : (
            visible.map((command, index) => (
              <button
                aria-selected={index === activeIndex}
                id={`${listId}-${index}`}
                role="option"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                  index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                )}
                key={command.id}
                onClick={command.run}
                onMouseEnter={() => setActive(index)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {command.hint}
                </span>
                {index === activeIndex ? (
                  <IconCornerDownLeft className="size-3.5 text-muted-foreground" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
