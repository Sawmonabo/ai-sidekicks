// What the all-sessions destination may list, merged from two sources: the daemon's directory
// (the only one that can name a session this window never opened) and `SessionStoreRegistry`
// (every session this window holds a store for, including one created a moment ago). Neither
// subsumes the other, so they are merged, directory first, and a row the local store can describe
// in full replaces the thin directory row for the same session.
//
// The absence follows the read, never the row count: a read in flight is `not-loaded`, a read
// that returned no rows is `empty`. Deciding from `rows.length === 0` would conflate them.

import type { SessionDirectoryState } from "@renderer/store/session-directory/session-directory.js";
import type { SessionListRow } from "./session-rows.js";

/** The kind of nothing the destination renders when it has no row: two of the five kinds. */
export type SessionListNothingKind = "not-loaded" | "empty";

/** What a caller hands in for the sessions only this window can describe. */
export interface SessionRowSources {
  /** The daemon's answer, whatever it was. */
  readonly directory: SessionDirectoryState;
  /** Every session this window holds a store for, in open order. */
  readonly windowSessionIds: readonly string[];
  /** The rows the local projection can describe in full, in any order. */
  readonly projectedRows: readonly SessionListRow[];
}

/**
 * Which absence a directory state means. Total, so a new state fails to compile here.
 *
 * @consumedBy the sessions list's absence line, which takes its kind from the directory read
 */
export function sessionListNothingKindFor(
  directory: SessionDirectoryState,
): SessionListNothingKind {
  switch (directory.status) {
    case "reading":
      return "not-loaded";
    case "served":
      return "empty";
  }
}

/**
 * The rows to list, directory first and this window's own appended.
 *
 * Attention is not read here: the caller applies it once over the merged list, so two rows
 * for one session never carry two severities.
 */
export function mergeSessionRows(sources: SessionRowSources): readonly SessionListRow[] {
  const rowsBySessionId = new Map<string, SessionListRow>();
  if (sources.directory.status === "served") {
    for (const summary of sources.directory.sessions) {
      rowsBySessionId.set(summary.sessionId, {
        sessionId: summary.sessionId,
        state: summary.state,
        touchedAtIso: undefined,
        userIds: [],
      });
    }
  }
  for (const sessionId of sources.windowSessionIds) {
    if (!rowsBySessionId.has(sessionId)) {
      rowsBySessionId.set(sessionId, {
        sessionId,
        state: undefined,
        touchedAtIso: undefined,
        userIds: [],
      });
    }
  }
  for (const projected of sources.projectedRows) {
    const directoryRow = rowsBySessionId.get(projected.sessionId);
    rowsBySessionId.set(projected.sessionId, {
      ...projected,
      // A store that has seen no session event has no state; the daemon's answer stands in.
      state: projected.state ?? directoryRow?.state,
    });
  }
  return [...rowsBySessionId.values()];
}
