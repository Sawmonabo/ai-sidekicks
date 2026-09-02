// What the attention plane may say, and what it must refuse to say.
//
// Two properties here are copy-and-contract properties no type would catch. The
// closed sets are COUNTED rather than described, because the design's claim is
// about a number ("`trigger` at exactly six values … Six is closed"); and the
// narrowing is driven with values that are almost right, because the failure mode
// is an item rendered as a trigger it does not carry.

import { describe, expect, it } from "vitest";

import { ATTENTION_SEVERITIES, ATTENTION_TRIGGERS, type AttentionItem } from "../bridge/index.js";
import {
  AttentionPlane,
  READS_NO_ATTENTION_PROJECTION,
  narrowAttentionItem,
  narrowAttentionProjection,
} from "./attention-plane.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
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

describe("an optional member that is present and unreadable", () => {
  // The defect this covers is silent by construction: a producer that TRIED to say
  // something the boundary could not read is otherwise indistinguishable from one
  // that said nothing, and both optional members here carry meaning in absence — no
  // `resolvedAt` is "still outstanding", no `runId` is "the whole session".

  for (const [description, malformed] of [
    ["an empty string", ""],
    ["a number", 42],
    ["a null", null],
  ] as const) {
    it(`drops an item whose \`resolvedAt\` is ${description}`, () => {
      expect(narrowAttentionItem({ ...item(), resolvedAt: malformed })).toBeUndefined();
    });

    it(`drops an item whose \`runId\` is ${description}`, () => {
      expect(narrowAttentionItem({ ...item(), runId: malformed })).toBeUndefined();
    });
  }

  it("admits an item that omits them, because absence is the meaningful value", () => {
    // The negative control for all six above: without it they would pass over a
    // narrowing that rejected every item carrying neither member, which is every
    // session-scoped item the projection sends.
    const narrowed = narrowAttentionItem(item());
    expect(narrowed).not.toBeUndefined();
    expect(narrowed?.resolvedAt).toBeUndefined();
    expect(narrowed?.runId).toBeUndefined();
  });

  it("admits a VALID one and the fold then reads it as resolved", () => {
    // The other half of the control: the rejection above is about the value being
    // unreadable, not about the member being present at all.
    const resolvedAt = "2026-01-01T10:05:00.000Z";
    const narrowed = narrowAttentionItem({ ...item(), resolvedAt, runId: "run-7" });
    expect(narrowed).toStrictEqual({ ...item(), runId: "run-7", resolvedAt });
    expect(new AttentionPlane(narrowed === undefined ? [] : [narrowed]).liveItems).toStrictEqual(
      [],
    );
  });

  it("counts a rejected optional member as a drop, so the center reports it", () => {
    const narrowed = narrowAttentionProjection([item(), { ...item(), resolvedAt: "" }]);
    expect(narrowed.items).toHaveLength(1);
    expect(narrowed.droppedCount).toBe(1);
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
