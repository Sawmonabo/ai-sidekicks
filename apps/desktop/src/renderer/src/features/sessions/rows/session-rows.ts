// What one row of the all-sessions list is, and the order rows come in. The order is a pure
// function so it can be tested without a DOM and shared by any second view.
//
// Rules, in precedence order:
//   1. Attention severity: a session that needs a person outranks one that does not. It is read
//      from `store/attention/attention-summary.ts`, never recounted here, so the list cannot
//      disagree with the notification center. A row the projection did not mention has none,
//      which is not "clear".
//   2. Lifecycle rank: live work outranks settled work outranks an audit stub. It sits above
//      recency, so a recently closed session still ranks below a quiet active one.
//   3. Recency: newest `touchedAt` first; a row with no timestamp sorts after every row with one.
//   4. Identifier: a deterministic tiebreak so tied rows do not swap between renders.
//
// A pin lifts a row above the unpinned ones, never within the pinned: the comparator does not
// read the pin, so re-pinning does not bump a row to the top.

import type { SessionState, AttentionSeverity } from "@ai-sidekicks/contracts";
import { compareInstants, parseInstant } from "@renderer/lib/instant.js";

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
  /** From the attention projection. `undefined` means the projection said nothing. */
  readonly attentionSeverity: AttentionSeverity | undefined;
}

/** True when the state is an audit stub, one a person can do nothing with. False on `undefined`. */
export function isAuditStubSession(state: string | undefined): boolean {
  return state !== undefined && (AUDIT_STUB_SESSION_STATES as readonly string[]).includes(state);
}

/** The status-and-activity comparator; applies inside each pinned group. */
export function compareSessionRows(left: SessionListRow, right: SessionListRow): number {
  const byAttention =
    attentionRank(left.attentionSeverity) - attentionRank(right.attentionSeverity);
  if (byAttention !== 0) {
    return byAttention;
  }
  const byLifecycle = lifecycleRank(left.state) - lifecycleRank(right.state);
  if (byLifecycle !== 0) {
    return byLifecycle;
  }
  // Newest first. A missing or unreadable stamp sorts below every real instant in both
  // directions, which a numeric sentinel cannot do.
  const byRecency = compareInstants(
    parseInstant(left.touchedAtIso ?? ""),
    parseInstant(right.touchedAtIso ?? ""),
    "newest-first",
  );
  if (byRecency !== 0) {
    return byRecency;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

/** Orders rows for the list: pinned rows first, each group by the ordinary comparator. */
export function orderSessionRows(
  rows: readonly SessionListRow[],
  pinned: Readonly<Record<string, unknown>>,
): readonly SessionListRow[] {
  const pinnedRows = rows
    .filter((row) => Object.hasOwn(pinned, row.sessionId))
    .sort(compareSessionRows);
  const otherRows = rows
    .filter((row) => !Object.hasOwn(pinned, row.sessionId))
    .sort(compareSessionRows);
  return [...pinnedRows, ...otherRows];
}

/**
 * Lifecycle rank, low sorts first. An unrecognized wire state ranks with the settled group,
 * so a session the console cannot classify is never promoted past ones it can.
 */
function lifecycleRank(state: string | undefined): number {
  if (isAuditStubSession(state)) {
    return 2;
  }
  return state === "active" || state === "provisioning" ? 0 : 1;
}

/** Attention rank, low sorts first. */
function attentionRank(severity: AttentionSeverity | undefined): number {
  if (severity === "actionable") {
    return 0;
  }
  return severity === "informational" ? 1 : 2;
}
