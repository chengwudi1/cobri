import { describe, expect, it } from "vitest";
import { inferSuggestionTargets, suggestionBucket } from "./suggestions-config.js";

describe("inferSuggestionTargets", () => {
  it("maps role suffixes from spawn keys regardless of display names", () => {
    const targets = inferSuggestionTargets([
      {
        id: "bot-chief",
        name: "Coordinator",
        color: "#111111",
        spawnKey: "team:chief",
      },
      { id: "bot-mail", name: "Post", color: "#222222", spawnKey: "team:inbox" },
      { id: "bot-days", name: "Plan", color: "#333333", spawnKey: "team:calendar" },
    ]);

    expect(targets?.primary.id).toBe("bot-chief");
    expect(targets?.inbox?.id).toBe("bot-mail");
    expect(targets?.calendar?.id).toBe("bot-days");
  });

  it("treats the onboarding first bot as the primary role", () => {
    expect(
      inferSuggestionTargets([
        { id: "bot-first", name: "Chief", color: "#111111", spawnKey: "onboarding:first" },
      ])?.primary.id,
    ).toBe("bot-first");
  });

  it("returns no targets when a space has no primary role", () => {
    expect(
      inferSuggestionTargets([
        { id: "bot-inbox", name: "收件箱", color: "#111111", spawnKey: "team:inbox" },
        { id: "bot-custom", name: "Custom", color: "#222222", spawnKey: null },
      ]),
    ).toBeNull();
  });
});

describe("suggestionBucket", () => {
  it("uses the space-local day at a UTC boundary", () => {
    expect(suggestionBucket(new Date("2026-10-29T16:30:00Z"), "Asia/Shanghai")).toBe("2026-10-30");
  });
});
