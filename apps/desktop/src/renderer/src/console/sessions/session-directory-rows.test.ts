// The merge and the absence, driven directly.
//
// Both are pure, and both decide something a component would otherwise decide
// inside a render where it could only be observed through markup. The absence in
// particular is the one place this destination can overclaim — reporting "there are
// none" for a question nobody put — so it is asserted here over every state the
// read can be in, with the row count deliberately absent from the input.

import { describe, expect, it } from "vitest";

import type { SessionDirectoryState } from "../frame/session-directory.js";
import {
  SESSIONS_ABSENCE_KINDS,
  mergeSessionRows,
  sessionsAbsenceKindFor,
  withAttentionSeverity,
} from "./session-directory-rows.js";
import type { SessionListRow } from "./session-rows.js";

const REFUSED_DIRECTORY: SessionDirectoryState = {
  status: "unavailable",
  refusal: {
    status: "unavailable",
    code: "wire-unregistered",
    origin: "growth-port",
    detail: "Not checked — the session directory read is not registered yet.",
    operationId: "sessionList",
    slateRow: "session-directory-read",
    owningDocument: "Spec-002",
  },
};

function servedDirectory(sessionIds: readonly string[]): SessionDirectoryState {
  return {
    status: "served",
    sessions: sessionIds.map((sessionId) => ({ sessionId, state: "active" })),
  };
}

function projectedRow(overrides: Partial<SessionListRow> & { sessionId: string }): SessionListRow {
  return {
    state: "active",
    touchedAtIso: "2026-01-01T10:00:00.000Z",
    participantIds: [],
    attentionSeverity: undefined,
    ...overrides,
  };
}

describe("sessionsAbsenceKindFor — the read decides, not the row count", () => {
  it("maps each of the three read states to its own kind", () => {
    expect(sessionsAbsenceKindFor({ status: "reading" })).toBe("not-loaded");
    expect(sessionsAbsenceKindFor(servedDirectory([]))).toBe("empty");
    expect(sessionsAbsenceKindFor(REFUSED_DIRECTORY)).toBe("not-checked");
  });

  it("never answers `empty` for a refused read", () => {
    // The negative control for the claim this surface must never make: a refused
    // directory reported as `empty` is "there are no sessions on this node", which
    // is a fact nobody established.
    expect(sessionsAbsenceKindFor(REFUSED_DIRECTORY)).not.toBe("empty");
  });

  it("answers inside its own declared set and nowhere else", () => {
    for (const directory of [
      { status: "reading" } as const,
      servedDirectory([]),
      REFUSED_DIRECTORY,
    ]) {
      expect(SESSIONS_ABSENCE_KINDS).toContain(sessionsAbsenceKindFor(directory));
    }
  });
});

describe("mergeSessionRows — two sources, neither dropped", () => {
  it("puts the node's sessions first and appends what only this window holds", () => {
    const rows = mergeSessionRows({
      directory: servedDirectory(["session-node"]),
      windowSessionIds: ["session-local"],
      projectedRows: [],
    });

    expect(rows.map((row) => row.sessionId)).toStrictEqual(["session-node", "session-local"]);
  });

  it("names a session once when both sources hold it", () => {
    const rows = mergeSessionRows({
      directory: servedDirectory(["session-both"]),
      windowSessionIds: ["session-both"],
      projectedRows: [projectedRow({ sessionId: "session-both" })],
    });

    expect(rows).toHaveLength(1);
  });

  it("lets the projection describe a row the directory could only name", () => {
    const rows = mergeSessionRows({
      directory: servedDirectory(["session-a"]),
      windowSessionIds: [],
      projectedRows: [
        projectedRow({ sessionId: "session-a", participantIds: ["participant-one"] }),
      ],
    });

    expect(rows[0]?.touchedAtIso).toBe("2026-01-01T10:00:00.000Z");
    expect(rows[0]?.participantIds).toStrictEqual(["participant-one"]);
  });

  it("keeps the node's lifecycle state where the projection has none", () => {
    // A store that has seen no session event carries no state, and the node's
    // answer is a fact this console did establish — dropping it would render a
    // session whose state the console knew as one whose state it did not.
    const rows = mergeSessionRows({
      directory: servedDirectory(["session-a"]),
      windowSessionIds: [],
      projectedRows: [projectedRow({ sessionId: "session-a", state: undefined })],
    });

    expect(rows[0]?.state).toBe("active");
  });

  it("still lists what this window holds when the directory was refused", () => {
    const rows = mergeSessionRows({
      directory: REFUSED_DIRECTORY,
      windowSessionIds: ["session-local"],
      projectedRows: [],
    });

    expect(rows.map((row) => row.sessionId)).toStrictEqual(["session-local"]);
  });

  it("lists nothing from a directory that has not answered", () => {
    expect(
      mergeSessionRows({
        directory: { status: "reading" },
        windowSessionIds: [],
        projectedRows: [],
      }),
    ).toStrictEqual([]);
  });
});

describe("withAttentionSeverity — one projection over every row", () => {
  it("stamps a row the projection mentioned and leaves the rest undefined", () => {
    const stamped = withAttentionSeverity(
      [projectedRow({ sessionId: "session-a" }), projectedRow({ sessionId: "session-b" })],
      (sessionId) => (sessionId === "session-a" ? "actionable" : undefined),
    );

    expect(stamped[0]?.attentionSeverity).toBe("actionable");
    // Undefined and not "clear": a row the projection did not mention is a row it
    // said nothing about, which the ordering rule reads differently.
    expect(stamped[1]?.attentionSeverity).toBeUndefined();
  });
});
