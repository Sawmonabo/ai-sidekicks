// What the attention plane may say, and what it must refuse to say.
//
// Two properties here are copy-and-contract properties no type would catch. The
// closed sets are COUNTED rather than described, because the design's claim is
// about a number ("`trigger` at exactly six values … Six is closed"); and the
// narrowing is driven with values that are almost right, because the failure mode
// is an item rendered as a trigger it does not carry.

import { describe, expect, it } from "vitest";

import {
  ATTENTION_SEVERITIES,
  ATTENTION_TRIGGERS,
  AttentionPlane,
  READS_NO_ATTENTION_PROJECTION,
  narrowAttentionItem,
  narrowAttentionProjection,
  type ConsoleAttentionItem,
} from "./attention-plane.js";

function item(overrides: Partial<ConsoleAttentionItem> = {}): ConsoleAttentionItem {
  return {
    id: "attention-1",
    sessionId: "session-a",
    trigger: "pending_approval",
    severity: "actionable",
    summary: "An approval is waiting.",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("the closed vocabularies", () => {
  it("carries exactly six triggers and exactly two severities", () => {
    expect(ATTENTION_TRIGGERS).toHaveLength(6);
    expect(ATTENTION_SEVERITIES).toHaveLength(2);
  });

  it("names the six the design names, and no seventh", () => {
    expect([...ATTENTION_TRIGGERS]).toStrictEqual([
      "pending_approval",
      "pending_input",
      "run_completed",
      "run_failed",
      "invite_received",
      "mention",
    ]);
  });
});

describe("the boundary narrowing", () => {
  it("admits a whole item", () => {
    expect(narrowAttentionItem({ ...item(), runId: "run-7", resolvedAt: undefined })).toStrictEqual(
      { ...item(), runId: "run-7" },
    );
  });

  it("drops an item whose trigger is outside the closed six", () => {
    expect(narrowAttentionItem({ ...item(), trigger: "pending_review" })).toBeUndefined();
  });

  it("drops an item whose severity is outside the closed two", () => {
    expect(narrowAttentionItem({ ...item(), severity: "critical" })).toBeUndefined();
  });

  it("drops an item missing the canonical reference it points at", () => {
    const { sourceEventId: _omitted, ...withoutSource } = item();
    expect(narrowAttentionItem(withoutSource)).toBeUndefined();
  });

  it("negative control: the same item WITH those members narrows", () => {
    // Without this, every case above would pass over a narrowing that returned
    // `undefined` unconditionally.
    expect(narrowAttentionItem(item())).not.toBeUndefined();
  });

  it("counts what it dropped rather than hiding it", () => {
    const narrowed = narrowAttentionProjection([item(), { nonsense: true }, "not an object"]);
    expect(narrowed.items).toHaveLength(1);
    expect(narrowed.droppedCount).toBe(2);
  });
});

describe("the fold over one read", () => {
  it("drops a resolved item, because it is not waiting on anybody", () => {
    const plane = new AttentionPlane([
      item({ id: "live" }),
      item({ id: "done", resolvedAt: "2026-01-01T10:05:00.000Z" }),
    ]);
    expect(plane.liveItems.map((live) => live.id)).toStrictEqual(["live"]);
  });

  it("splits a session on the axis suppression keys on", () => {
    const plane = new AttentionPlane([
      item({ id: "one" }),
      item({ id: "two", severity: "informational", trigger: "run_completed" }),
    ]);
    const [group] = plane.groups;
    expect(group?.actionable.map((entry) => entry.id)).toStrictEqual(["one"]);
    expect(group?.informational.map((entry) => entry.id)).toStrictEqual(["two"]);
    expect(plane.hasActionable).toBe(true);
  });

  it("reads a session's severity off the projection and answers nothing for one it never mentioned", () => {
    const plane = new AttentionPlane([item({ sessionId: "session-a" })]);
    expect(plane.severityFor("session-a")).toBe("actionable");
    // Not "informational" and not a cleared marker: the projection said nothing
    // about this session, which is a different fact from saying it is clear.
    expect(plane.severityFor("session-b")).toBeUndefined();
  });

  it("negative control: a session with only informational items is not reported actionable", () => {
    const plane = new AttentionPlane([
      item({ sessionId: "session-c", severity: "informational", trigger: "mention" }),
    ]);
    expect(plane.severityFor("session-c")).toBe("informational");
    expect(plane.hasActionable).toBe(false);
  });
});

describe("the reader that ships today", () => {
  it("answers 'nothing was read' rather than an empty projection", async () => {
    // The distinction the whole surface rests on: `undefined` is "no question was
    // put", and `[]` would be "the daemon has nothing for you".
    await expect(READS_NO_ATTENTION_PROJECTION()).resolves.toBeUndefined();
  });
});
