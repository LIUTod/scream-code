import { describe, expect, it } from "vitest";

import { applyMention, filterMentions, mentionTokenAt } from "../../../src/bot/ui/lib/mention";

describe("mentionTokenAt", () => {
  it("finds an empty token right after @", () => {
    expect(mentionTokenAt("@", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("reads the query up to the caret", () => {
    expect(mentionTokenAt("hi @Re", 6)).toEqual({ query: "Re", start: 3, end: 6 });
  });

  it("ignores an @ that is glued to a word", () => {
    expect(mentionTokenAt("mail@host", 9)).toBeNull();
  });

  it("ignores a token once whitespace separates it from the caret", () => {
    expect(mentionTokenAt("@Scream hello", 13)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the token and appends a trailing space", () => {
    expect(applyMention("@", { query: "", start: 0, end: 1 }, "Scream")).toEqual({
      value: "@Scream ",
      caret: 8,
    });
  });

  it("keeps the text that follows the token", () => {
    const token = mentionTokenAt("hey @Re  check logs", 7);
    expect(token).not.toBeNull();
    expect(applyMention("hey @Re  check logs", token!, "Research")).toEqual({
      value: "hey @Research check logs",
      caret: 14,
    });
  });
});

describe("filterMentions", () => {
  const people = [{ name: "Scream" }, { name: "Research" }, { name: "researcher" }];

  it("lists everyone for an empty query", () => {
    expect(filterMentions(people, "").map((person) => person.name)).toEqual([
      "Scream",
      "Research",
      "researcher",
    ]);
  });

  it("ranks prefix matches ahead of substring matches", () => {
    expect(filterMentions(people, "res").map((person) => person.name)).toEqual([
      "Research",
      "researcher",
    ]);
  });

  it("is case-insensitive", () => {
    expect(filterMentions(people, "SCRE").map((person) => person.name)).toEqual(["Scream"]);
  });
});
