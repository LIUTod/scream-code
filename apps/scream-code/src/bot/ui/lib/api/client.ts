import type { BotClient } from "../client";
import { MockBotClient } from "../mock/mock-client";
import { HttpBotClient } from "./http-client";

const useMock = import.meta.env["VITE_BOT_MOCK"] === "1";

let client: BotClient = useMock ? new MockBotClient() : new HttpBotClient();

/**
 * The one place the UI asks for its transport. Swapping in the HTTP/SSE implementation is a change
 * to this module and nothing else.
 */
export function getBotClient(): BotClient {
  return client;
}

export function setBotClient(next: BotClient): void {
  client = next;
}
