// The merge and the absence, driven directly. The absence is where the destination could
// overclaim "there are none" for a question nobody put, so it is asserted over every read
// state, with the row count deliberately absent from the input.

import { describe, expect, it } from "vitest";

import type { SessionDirectoryState } from "@renderer/store/session-directory/session-directory.js";
import { mergeSessionRows } from "./session-directory-rows.js";
import type { SessionListRow } from "./session-rows.js";

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
    userIds: [],
    ...overrides,
  };
}

describe("mergeSessionRows — two sources, neither dropped", () => {
  it("puts the daemon's sessions first and appends what only this window holds", () => {
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
});
