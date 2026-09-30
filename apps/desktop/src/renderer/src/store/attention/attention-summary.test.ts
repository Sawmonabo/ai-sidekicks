// What the attention summary may say and what it must refuse to say, driven with items whose
// order and resolution differ.

import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@ai-sidekicks/contracts";
import { AttentionSummary } from "@renderer/store/attention/attention-summary.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attention-1",
    momentId: "moment-1",
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    displayName: "Fix the login flow",
    stateWord: "Waiting on you",
    summary: "An approval is waiting.",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    bannerState: "pending",
    seen: false,
    ...overrides,
  };
}

describe("the fold over one read", () => {
  it("drops a resolved item, because it is not waiting on anybody", () => {
    const summary = new AttentionSummary([
      item({ id: "live" }),
      item({ id: "done", resolvedAt: "2026-01-01T10:05:00.000Z" }),
    ]);
    expect(summary.liveItems.map((live) => live.id)).toStrictEqual(["live"]);
  });

  it("splits a session on the axis suppression keys on", () => {
    const summary = new AttentionSummary([
      item({ id: "one" }),
      item({ id: "two", severity: "informational", trigger: "run_completed" }),
    ]);
    const [group] = summary.groups;
    expect(group?.actionable.map((entry) => entry.id)).toStrictEqual(["one"]);
    expect(group?.informational.map((entry) => entry.id)).toStrictEqual(["two"]);
    expect(summary.hasActionable).toBe(true);
  });

  it("reads a session's severity off the projection and answers nothing for one it never mentioned", () => {
    const summary = new AttentionSummary([item({ sessionId: "session-a" })]);
    expect(summary.severityFor("session-a")).toBe("actionable");
    // The projection said nothing about this session, which is not the same as clear.
    expect(summary.severityFor("session-b")).toBeUndefined();
  });

  it("negative control: a session with only informational items is not reported actionable", () => {
    const summary = new AttentionSummary([
      item({ sessionId: "session-c", severity: "informational", trigger: "run_completed" }),
    ]);
    expect(summary.severityFor("session-c")).toBe("informational");
    expect(summary.hasActionable).toBe(false);
  });
});

describe("the order the fold establishes", () => {
  // The projection states no ordering, so it may answer newest-first. These items differ only
  // in `createdAt`, so nothing but the ordering rule can separate them.
  const NEWEST_FIRST: readonly AttentionItem[] = [
    item({ id: "newer", sessionId: "session-b", createdAt: "2026-01-02T10:00:00.000Z" }),
    item({ id: "older", sessionId: "session-a", createdAt: "2026-01-01T10:00:00.000Z" }),
  ];

  it("puts the oldest live item first whatever order the projection answered in", () => {
    const summary = new AttentionSummary(NEWEST_FIRST);

    expect(summary.liveItems.map((live) => live.id)).toStrictEqual(["older", "newer"]);
  });

  it("orders the sessions by their oldest item, not by first appearance", () => {
    // Negative control: `groups` once followed the projection's insertion order, listing the
    // newer session first. `session-a` appears second in the input and must come first.
    const summary = new AttentionSummary(NEWEST_FIRST);

    expect(summary.groups.map((group) => group.sessionId)).toStrictEqual([
      "session-a",
      "session-b",
    ]);
  });

  it("keeps the projection's own order between two items stamped at one instant", () => {
    const summary = new AttentionSummary([
      item({ id: "second-in-frame", createdAt: "2026-01-01T10:00:00.000Z" }),
      item({ id: "third-in-frame", createdAt: "2026-01-01T10:00:00.000Z" }),
    ]);

    expect(summary.liveItems.map((live) => live.id)).toStrictEqual([
      "second-in-frame",
      "third-in-frame",
    ]);
  });

  it("sorts an item whose stamp no reader can parse last rather than first", () => {
    // February 30 is a stamp `Date.parse` would turn into March 2; the console's reader refuses
    // it, and a row that earned no position takes the end.
    const summary = new AttentionSummary([
      item({ id: "unreadable", createdAt: "2026-02-30T10:00:00.000Z" }),
      item({ id: "readable", createdAt: "2026-01-01T10:00:00.000Z" }),
    ]);

    expect(summary.liveItems.map((live) => live.id)).toStrictEqual(["readable", "unreadable"]);
  });
});
