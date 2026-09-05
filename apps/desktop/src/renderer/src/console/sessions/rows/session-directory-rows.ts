// What the all-sessions destination may list, composed from the two sources that
// can honestly answer "which sessions are there".
//
// TWO SETS, AND NEITHER SUBSUMES THE OTHER
//
// The node's directory is the growth port's `sessionList` read — the daemon's own
// answer, and the only one that can name a session this window has never opened.
// The window's own set is `SessionStoreRegistry`, which names every session this
// renderer holds a store for and nothing else. A session created a moment ago is on
// the second and not yet on the first; a session six other windows are working in is
// on the first and never on the second. Dropping either would make a real session
// vanish from a list a person is reading to find it.
//
// So the two are merged rather than chosen between, directory first, and the rows
// the local store can describe in full — lifecycle state, when it was last touched,
// who is in it — overwrite the thin directory row for the same session rather than
// appearing beside it.
//
// THE ABSENCE FOLLOWS THE READ, NEVER THE ROW COUNT
//
// An empty list has three different causes and they are three different sentences.
// A read in flight is `not-loaded`. A read that came back with no rows is `empty` —
// the node was asked and it has none. A read the port refused is `not-checked`, and
// the console must not report "there are none" for a question it never put. Deciding
// this from `rows.length === 0` collapses all three, which is exactly the conflation
// `Spec-023 §Console Design (Meridian)` rule 8's five kinds of nothing exist to
// prevent — so the decision is a function of the directory state and the row count
// cannot reach it.

import type { SessionDirectoryState } from "../../frame/session-directory.js";
import type { AttentionSeverity } from "../../bridge/index.js";
import type { SessionListRow } from "./session-rows.js";

/**
 * The kind of nothing the destination renders when it has no row.
 *
 * A subset of the primitive's five kinds, declared as its own closed set because
 * only three of them are reachable here: nothing on this surface errors, and
 * nothing on it is filtered.
 */
export const SESSIONS_ABSENCE_KINDS = ["not-loaded", "empty", "not-checked"] as const;

/** One of the three. Derived from the enumeration, never restated beside it. */
export type SessionsAbsenceKind = (typeof SESSIONS_ABSENCE_KINDS)[number];

/**
 * Which absence a directory state means.
 *
 * Total over the three states rather than defaulting, so a fourth state added to the
 * read would fail to compile here instead of silently landing in whichever arm the
 * `else` happened to be.
 */
export function sessionsAbsenceKindFor(directory: SessionDirectoryState): SessionsAbsenceKind {
  switch (directory.status) {
    case "reading":
      return "not-loaded";
    case "served":
      return "empty";
    case "unavailable":
      return "not-checked";
  }
}

/** What a caller hands in for the sessions only this window can describe. */
export interface SessionRowSources {
  /** The node's answer, whatever it was. */
  readonly directory: SessionDirectoryState;
  /** Every session this window holds a store for, in open order. */
  readonly windowSessionIds: readonly string[];
  /** The rows the local projection can describe in full, in any order. */
  readonly projectedRows: readonly SessionListRow[];
}

/**
 * The rows to list, directory first and this window's own appended.
 *
 * Attention is deliberately NOT read here: it is one projection for the whole
 * destination and it is applied once, over the merged list, by the caller. Reading
 * it per source would give a directory row and a projected row for one session two
 * severities, and the row that survived the merge would decide which a person saw.
 */
export function mergeSessionRows(sources: SessionRowSources): readonly SessionListRow[] {
  const rowsBySessionId = new Map<string, SessionListRow>();
  if (sources.directory.status === "served") {
    for (const summary of sources.directory.sessions) {
      rowsBySessionId.set(summary.sessionId, {
        sessionId: summary.sessionId,
        state: summary.state,
        touchedAtIso: undefined,
        participantIds: [],
        attentionSeverity: undefined,
      });
    }
  }
  for (const sessionId of sources.windowSessionIds) {
    if (!rowsBySessionId.has(sessionId)) {
      rowsBySessionId.set(sessionId, {
        sessionId,
        state: undefined,
        touchedAtIso: undefined,
        participantIds: [],
        attentionSeverity: undefined,
      });
    }
  }
  for (const projected of sources.projectedRows) {
    const directoryRow = rowsBySessionId.get(projected.sessionId);
    rowsBySessionId.set(projected.sessionId, {
      ...projected,
      // The directory's lifecycle state stands in where the projection has none: a
      // store that has seen no session event carries no state, and the node's answer
      // is a fact this console did establish.
      state: projected.state ?? directoryRow?.state,
    });
  }
  return [...rowsBySessionId.values()];
}

/**
 * Stamp each row with what the attention projection says about it.
 *
 * Separate from the merge because it is the SECOND read this destination performs
 * and it applies to every row regardless of which source produced it. A row the
 * projection did not mention carries `undefined`, which is not the same as carrying
 * "clear" — the ordering rule reads it that way and the row renders no badge.
 */
export function withAttentionSeverity(
  rows: readonly SessionListRow[],
  severityFor: (sessionId: string) => AttentionSeverity | undefined,
): readonly SessionListRow[] {
  return rows.map((row) => ({ ...row, attentionSeverity: severityFor(row.sessionId) }));
}
