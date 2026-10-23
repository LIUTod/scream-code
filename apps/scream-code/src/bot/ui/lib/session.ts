import type { QueryClient } from "@tanstack/react-query";
import type { Bot } from "../../shared/contracts";
import { queryKeys } from "./api/queries";

const ACTIVE_BOT_KEY = "scream-bot-active";

export function readActiveBot(): string | null {
  return window.localStorage.getItem(ACTIVE_BOT_KEY);
}

export function rememberActiveBot(botId: string): void {
  window.localStorage.setItem(ACTIVE_BOT_KEY, botId);
}

export function forgetActiveBot(): void {
  window.localStorage.removeItem(ACTIVE_BOT_KEY);
}

/** Clear persisted and cached selection synchronously before leaving a deleted Bot. */
export function forgetDeletedBot(botId: string, queryClient: QueryClient): void {
  if (readActiveBot() === botId) forgetActiveBot();
  queryClient.removeQueries({ queryKey: queryKeys.bot(botId) });
  queryClient.setQueryData<Bot[]>(queryKeys.bots(), (current) =>
    current?.filter((bot) => bot.id !== botId),
  );
}
