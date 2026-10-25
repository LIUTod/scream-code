import { beforeEach, describe, expect, it } from "vitest";

import type { Attachment } from "../../../src/bot/shared/contracts";
import { DraftStore, draftKey } from "../../../src/bot/ui/lib/draft";
import { markRoomRead, roomIsUnread } from "../../../src/bot/ui/lib/room-read";

const attachment: Attachment = {
  id: "a1",
  name: "notes.txt",
  path: ".scream-attachments/11111111-1111-1111-1111-111111111111-notes.txt",
  size: 5,
  mime: "text/plain",
};

describe("DraftStore attachments", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("keeps the attached files on retry, including after a reload", () => {
    const store = new DraftStore(() => sessionStorage);
    const request = store.begin("bot", "thread", "read this", false, "queue", true, [attachment]);
    expect(request?.attachments).toEqual([attachment]);
    store.finish(request!, "network down");

    // A reload reads the retry back from storage.
    const reloaded = new DraftStore(() => sessionStorage);
    expect(reloaded.get(draftKey("bot", "thread")).retry?.attachments).toEqual([attachment]);
    const retried = reloaded.retry("bot", "thread", false);
    expect(retried?.attachments).toEqual([attachment]);
  });

  it("drops malformed stored attachments instead of throwing", () => {
    sessionStorage.setItem(
      `scream.bot.draft.v2:${draftKey("bot", "thread")}`,
      JSON.stringify({
        value: "",
        retry: {
          id: "r1",
          text: "hi",
          restore: "hi",
          mode: "queue",
          attachments: [{ id: "x" }, null, attachment],
        },
      }),
    );
    const store = new DraftStore(() => sessionStorage);
    expect(store.get(draftKey("bot", "thread")).retry?.attachments).toEqual([attachment]);
  });
});

describe("room read watermark", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const room = (overrides: Partial<Parameters<typeof roomIsUnread>[0]> = {}) => ({
    id: "room-1",
    name: "crew",
    leadBotId: null,
    memberIds: [],
    createdAt: 1,
    lastMessage: "done",
    lastMessageAt: Date.now() - 1_000,
    lastSpeakerKind: "bot" as const,
    ...overrides,
  });

  it("flags a room whose last word came from a Bot after the watermark", () => {
    expect(roomIsUnread(room())).toBe(true);
    markRoomRead("room-1");
    expect(roomIsUnread(room())).toBe(false);
    // A later Bot message re-lights the dot.
    expect(roomIsUnread(room({ lastMessageAt: Date.now() + 10_000 }))).toBe(true);
  });

  it("never flags the person's own last message", () => {
    expect(roomIsUnread(room({ lastSpeakerKind: "user" }))).toBe(false);
  });
});
