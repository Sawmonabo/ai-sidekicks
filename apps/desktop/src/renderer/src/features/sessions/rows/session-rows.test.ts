// The ordering rule, driven as a rule rather than through a rendered list.

import { describe, expect, it } from "vitest";

import { compareSessionRows, isAuditStubSession, type SessionListRow } from "./session-rows.js";

function row(overrides: Partial<SessionListRow> & { readonly sessionId: string }): SessionListRow {
  return {
    state: "active",
    touchedAtIso: "2026-01-01T10:00:00.000Z",
    userIds: [],
    attentionSeverity: undefined,
    ...overrides,
  };
}

function orderOf(rows: readonly SessionListRow[]): readonly string[] {
  return [...rows].sort(compareSessionRows).map((sorted) => sorted.sessionId);
}

describe("the status-and-activity comparator", () => {
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
});

describe("audit stubs", () => {
  it("fails closed on a state it has never seen, and on none at all", () => {
    expect(isAuditStubSession("active")).toBe(false);
    expect(isAuditStubSession("something-new")).toBe(false);
    expect(isAuditStubSession(undefined)).toBe(false);
  });
});
