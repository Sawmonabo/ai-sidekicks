// What one row of the all-sessions list IS, and the order the rows come in.
//
// The all-sessions list answers "what am I in the middle of" in one screen, ordered so
// the thing you touched last is where you left it. That rule is an ordering, and an
// ordering is a pure function — so it lives here rather than inside a component,
// where it could not be driven without a DOM and where a second view wanting the
// same order would copy it.
//
// FOUR RULES, IN PRECEDENCE ORDER, AND WHY EACH ONE IS WHERE IT IS
//
//   1. **Attention severity.** A session that needs a person outranks one that
//      does not. The severity is READ from the attention projection and never
//      counted here: `store/attention/attention-summary.ts` is its one source, and a
//      list that recounted it would be a second verdict about the same session,
//      free to disagree with the one the notification center renders. A row the
//      projection did not mention carries none, which is not the same as carrying
//      "clear".
//   2. **Lifecycle rank.** Live work outranks settled work outranks an audit stub.
//      A closed session that saw activity a minute ago is still less interesting
//      than an active one that has been quiet for an hour, which is why this sits
//      above recency rather than below it.
//   3. **Recency.** Newest `touchedAt` first — the sentence the design opens with.
//      A row the wire gave no timestamp sorts after every row that has one, because
//      guessing a time for it would put it somewhere it did not earn.
//   4. **Identifier.** The deterministic tiebreak, so two rows that tie on
//      everything else do not swap places between renders.
//
// A PIN LIFTS A ROW ABOVE THE UNPINNED ONES, NEVER WITHIN THE PINNED. Nothing in the
// comparator reads the pin; the same comparator orders each group, so re-pinning does
// not bump a row to the top of the pinned rows, which would make a pinned list a second
// inbox.

import type { SessionState, AttentionSeverity } from "@ai-sidekicks/contracts";
import { compareInstants, parseInstant } from "@renderer/lib/instant.js";

/**
 * The two states that are audit stubs rather than sessions a person can work in.
 *
 * Typed as a subset of the wire union rather than as loose strings, so a rename in
 * `packages/contracts` fails here at compile time. Saying how long they are kept is
 * not this list's job; what this list owes them is to render them and offer nothing.
 */
export const AUDIT_STUB_SESSION_STATES: readonly SessionState[] = ["purge_requested", "purged"];

/**
 * One row.
 *
 * `state` is the wire's own string and stays one: it is rendered verbatim, never
 * re-parsed into a richer value, and `undefined` where the wire named none. There
 * is deliberately no `title` — `SessionSnapshot` carries no name column, so an
 * unnamed session renders by its identifier and its users and never by an invented
 * one.
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

/** True when the state is one a person can do nothing with. Fail-closed on `undefined`. */
export function isAuditStubSession(state: string | undefined): boolean {
  return state !== undefined && (AUDIT_STUB_SESSION_STATES as readonly string[]).includes(state);
}

/** The ordinary status-and-activity comparator. Applies inside each group. */
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
  // Newest first, unknown last, through the console's one reading of a wire
  // timestamp — a missing or unreadable stamp sorts below every real instant
  // instead of landing in 1970 among sessions genuinely untouched since, and it
  // does so in BOTH directions, which a numeric sentinel cannot.
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

/**
 * Order rows for the list: pinned rows first, each group by the ordinary comparator.
 *
 * A row is pinned when the pin map holds an entry for it; an unpinned row has no record.
 */
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
 * Lifecycle rank, low sorts first.
 *
 * A total function over any string the wire can send, including one this console
 * has never seen: an unrecognized state ranks with the settled group rather than
 * with the live one, which is the fail-closed direction — it under-promises about
 * a session the console cannot classify instead of promoting it past sessions it
 * can.
 */
function lifecycleRank(state: string | undefined): number {
  if (isAuditStubSession(state)) {
    return 2;
  }
  return state === "active" || state === "provisioning" ? 0 : 1;
}

/** Attention rank, low sorts first. Read from the projection; never computed. */
function attentionRank(severity: AttentionSeverity | undefined): number {
  if (severity === "actionable") {
    return 0;
  }
  return severity === "informational" ? 1 : 2;
}
