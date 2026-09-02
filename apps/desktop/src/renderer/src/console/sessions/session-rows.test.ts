// The ordering rule, driven as a rule rather than through a rendered list.
//
// Two claims here are the list's promises to a person and neither is expressible
// as a type: that pinning changes which tier a row is in and never where it sits
// inside one, and that the tier vocabulary this module declares is the same one
// the persistence chokepoint admits — which is checked against the real validator
// rather than asserted in a comment.

import { describe, expect, it } from "vitest";

import { validatePersistedValue } from "../persistence/value-classes.js";
import {
  AUDIT_STUB_SESSION_STATES,
  SESSION_PIN_TIERS,
  compareSessionRows,
  foldIntoTiers,
  isAuditStubSession,
  type SessionListRow,
} from "./session-rows.js";

function row(overrides: Partial<SessionListRow> & { readonly sessionId: string }): SessionListRow {
  return {
    state: "active",
    touchedAtIso: "2026-01-01T10:00:00.000Z",
    participantIds: [],
    attentionSeverity: undefined,
    ...overrides,
  };
}

function orderOf(rows: readonly SessionListRow[]): readonly string[] {
  return [...rows].sort(compareSessionRows).map((sorted) => sorted.sessionId);
}

describe("the status-and-activity comparator", () => {
  it("puts a session that needs a person above one that does not", () => {
    expect(
      orderOf([
        row({ sessionId: "quiet" }),
        row({ sessionId: "blocked", attentionSeverity: "actionable" }),
        row({ sessionId: "noted", attentionSeverity: "informational" }),
      ]),
    ).toStrictEqual(["blocked", "noted", "quiet"]);
  });

  it("puts live work above settled work above an audit stub, ahead of recency", () => {
    expect(
      orderOf([
        row({ sessionId: "stub", state: "purged", touchedAtIso: "2026-01-01T12:00:00.000Z" }),
        row({ sessionId: "closed", state: "closed", touchedAtIso: "2026-01-01T11:00:00.000Z" }),
        row({ sessionId: "live", state: "active", touchedAtIso: "2026-01-01T09:00:00.000Z" }),
      ]),
    ).toStrictEqual(["live", "closed", "stub"]);
  });

  it("puts the thing you touched last first, among rows that tie on everything else", () => {
    expect(
      orderOf([
        row({ sessionId: "older", touchedAtIso: "2026-01-01T09:00:00.000Z" }),
        row({ sessionId: "newer", touchedAtIso: "2026-01-01T11:00:00.000Z" }),
      ]),
    ).toStrictEqual(["newer", "older"]);
  });

  it("sorts a row with no timestamp last rather than guessing one for it", () => {
    expect(
      orderOf([
        row({ sessionId: "untimed", touchedAtIso: undefined }),
        row({ sessionId: "ancient", touchedAtIso: "1999-01-01T00:00:00.000Z" }),
      ]),
    ).toStrictEqual(["ancient", "untimed"]);
  });

  it("breaks a total tie on the identifier, so two renders agree", () => {
    expect(
      orderOf([row({ sessionId: "session-b" }), row({ sessionId: "session-a" })]),
    ).toStrictEqual(["session-a", "session-b"]);
  });
});

describe("the two-tier fold", () => {
  const rows = [
    row({ sessionId: "alpha", touchedAtIso: "2026-01-01T09:00:00.000Z" }),
    row({ sessionId: "bravo", touchedAtIso: "2026-01-01T11:00:00.000Z" }),
    row({ sessionId: "charlie", touchedAtIso: "2026-01-01T10:00:00.000Z" }),
  ];

  it("puts an unpinned row in the back tier without anybody writing that down", () => {
    const fold = foldIntoTiers(rows, {});
    expect(fold.front).toStrictEqual([]);
    expect(fold.back.map((placed) => placed.sessionId)).toStrictEqual([
      "bravo",
      "charlie",
      "alpha",
    ]);
    expect(fold.back.every((placed) => placed.tier === "back")).toBe(true);
  });

  it("does not bump a re-pinned row to the top of its tier", () => {
    // The whole point of the rule: a pinned list ordered by pin time is a second
    // inbox. `alpha` is the oldest row and stays last inside the front tier.
    const fold = foldIntoTiers(rows, { alpha: "front", bravo: "front" });
    expect(fold.front.map((placed) => placed.sessionId)).toStrictEqual(["bravo", "alpha"]);
    expect(fold.back.map((placed) => placed.sessionId)).toStrictEqual(["charlie"]);
  });

  it("negative control: the comparator is what orders a tier, not insertion order", () => {
    // Without this, the case above would pass over a fold that simply kept the
    // order the pin map was written in.
    const fold = foldIntoTiers([...rows].reverse(), { alpha: "front", bravo: "front" });
    expect(fold.front.map((placed) => placed.sessionId)).toStrictEqual(["bravo", "alpha"]);
  });
});

describe("audit stubs", () => {
  it("names exactly the two states that are retention records", () => {
    expect([...AUDIT_STUB_SESSION_STATES]).toStrictEqual(["purge_requested", "purged"]);
    expect(isAuditStubSession("purged")).toBe(true);
    expect(isAuditStubSession("purge_requested")).toBe(true);
  });

  it("fails closed on a state it has never seen, and on none at all", () => {
    expect(isAuditStubSession("active")).toBe(false);
    expect(isAuditStubSession("something-new")).toBe(false);
    expect(isAuditStubSession(undefined)).toBe(false);
  });
});

describe("the tier vocabulary and the store that has to accept it", () => {
  it("is admitted, member for member, by the real persistence validator", () => {
    for (const tier of SESSION_PIN_TIERS) {
      expect(validatePersistedValue("pin", { "session-a": tier })).toBeUndefined();
    }
  });

  it("negative control: a third tier is refused at the chokepoint", () => {
    // Without this, the case above would pass over a validator that admitted
    // anything, and the agreement it claims to check would be vacuous.
    const refusal = validatePersistedValue("pin", { "session-a": "middle" });
    expect(refusal?.code).toBe("value-shape-invalid");
  });
});
