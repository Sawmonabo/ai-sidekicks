// What one row of the all-sessions list is, what it draws at an instant, and the order rows come
// in: pinned rows first, then the order the rows arrived in, the daemon's own first. A row's state
// never moves it, so a session that finishes under the pointer stays where the pointer is.

import {
  sessionActivityAsOf,
  sessionActivityLapsesAt,
} from "@ai-sidekicks/contracts/session/activity";
import type { SessionActivity, SessionListEntry } from "@ai-sidekicks/contracts/session/directory";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";

import { ageChangesAt } from "#renderer/lib/wire/figures.js";

// The state of a session whose deletion has started. Typed against the wire union so a rename in
// `packages/contracts` fails here.
const DELETING_SESSION_STATE: SessionState = "purgeRequested";

/**
 * One row. `state` is the wire's own string, read as words on the row. A row is titled from what
 * the daemon's list carries and never by an invented title.
 */
export interface SessionListRow {
  readonly sessionId: string;
  /**
   * The session's name as the daemon's list names it, or `undefined` while the session is
   * untitled or the list does not name it yet.
   */
  readonly name: string | undefined;
  /** The list's preview of the first message, titling a row the list carries no name for. */
  readonly firstMessagePreview: string | undefined;
  /** The session's shape as the list carries it, or `undefined` for a row the list lacks. */
  readonly shape: SessionShape | undefined;
  /** The wire's lifecycle state, or `undefined` where the wire named none. */
  readonly state: string | undefined;
  /**
   * The activity word the daemon's list last published and when it renewed it, read through
   * `sessionActivityAsOf` before it is drawn; `undefined` for a row the list lacks.
   */
  readonly listedActivity: Pick<SessionListEntry, "activity" | "activityRenewedAt"> | undefined;
  /**
   * ISO-8601 of the newest event that touched the session, as the wire sends it; the row draws it
   * on the machine's clock, with this instant on hover.
   */
  readonly touchedAtIso: string | undefined;
  /** Users the app has seen in this session, in the order it saw them. */
  readonly userIds: readonly string[];
}

/** True when the session is being deleted, so the list offers no way to open it. */
export function isSessionBeingDeleted(state: string | undefined): boolean {
  return state === DELETING_SESSION_STATE;
}

/**
 * The activity a row draws at `nowMilliseconds`, aged so a session whose renewals stopped draws
 * idle; `undefined` for a row the daemon's list lacks.
 */
export function drawnSessionActivityOf(
  row: SessionListRow,
  nowMilliseconds: number,
): SessionActivity | undefined {
  const { listedActivity } = row;
  return listedActivity === undefined
    ? undefined
    : sessionActivityAsOf(
        listedActivity.activity,
        listedActivity.activityRenewedAt,
        nowMilliseconds,
      );
}

/**
 * The first instant after `nowMilliseconds` at which any of `rows` would draw differently: its
 * age reading the next count, or its activity lapsing to idle. `Infinity` when none will.
 */
export function sessionRowsChangeAt(
  rows: readonly SessionListRow[],
  nowMilliseconds: number,
): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.touchedAtIso !== undefined) {
      earliest = Math.min(earliest, ageChangesAt(row.touchedAtIso, nowMilliseconds));
    }
    if (row.listedActivity !== undefined) {
      const lapsesAt = sessionActivityLapsesAt(
        row.listedActivity.activity,
        row.listedActivity.activityRenewedAt,
      );
      // A lapse already past is drawn already; only one still ahead wakes the list.
      if (lapsesAt > nowMilliseconds) {
        earliest = Math.min(earliest, lapsesAt);
      }
    }
  }
  return earliest;
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
