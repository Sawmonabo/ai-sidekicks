// What one row of the all-sessions list is, and the order rows come in: pinned rows first,
// then the order the rows arrived in, the daemon's own first. A row's state never moves it, so a
// session that finishes under the pointer stays where the pointer is.

import type { SessionState } from "@ai-sidekicks/contracts";

// The state of a session whose deletion has started. Typed against the wire union so a rename in
// `packages/contracts` fails here.
const DELETING_SESSION_STATE: SessionState = "purge_requested";

/**
 * One row. `state` is the wire's own string, rendered verbatim. There is no `title`:
 * `SessionSnapshot` carries no name, so a row renders by its identifier and users and never by an
 * invented name.
 */
export interface SessionListRow {
  readonly sessionId: string;
  /** Wire-verbatim lifecycle state, or `undefined` where the wire named none. */
  readonly state: string | undefined;
  /** ISO-8601 of the newest event that touched the session, wire-verbatim. */
  readonly touchedAtIso: string | undefined;
  /** Users the app has seen in this session, in the order it saw them. */
  readonly userIds: readonly string[];
}

/** True when the session is being deleted, so the list offers no way to open it. */
export function isSessionBeingDeleted(state: string | undefined): boolean {
  return state === DELETING_SESSION_STATE;
}

/**
 * Orders rows for the list: pinned rows first, and each part in the order it was handed in.
 *
 * @consumedBy the sessions list
 */
export function orderSessionRows(
  rows: readonly SessionListRow[],
  pinned: Readonly<Record<string, unknown>>,
): readonly SessionListRow[] {
  const pinnedRows = rows.filter((row) => Object.hasOwn(pinned, row.sessionId));
  const otherRows = rows.filter((row) => !Object.hasOwn(pinned, row.sessionId));
  return [...pinnedRows, ...otherRows];
}
