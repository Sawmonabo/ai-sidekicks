// What one row of the all-sessions list is, and the order rows come in: pinned rows first,
// then the order the rows arrived in, the node's own first. A row's state never moves it, so a
// session that finishes under the pointer stays where the pointer is.

import type { SessionState } from "@ai-sidekicks/contracts";

/**
 * The two states that are audit stubs rather than sessions a person can work in. Typed as a
 * subset of the wire union so a rename in `packages/contracts` fails here. The list renders
 * them and offers no action.
 */
export const AUDIT_STUB_SESSION_STATES: readonly SessionState[] = ["purge_requested", "purged"];

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
  /** Users the console has seen in this session, in the order it saw them. */
  readonly userIds: readonly string[];
}

/** True when the state is an audit stub, one a person can do nothing with. False on `undefined`. */
export function isAuditStubSession(state: string | undefined): boolean {
  return state !== undefined && (AUDIT_STUB_SESSION_STATES as readonly string[]).includes(state);
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
