// What one row of the all-sessions list IS, and the order the rows come in.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list: "Answer 'what am I in
// the middle of' in one screen, ordered so the thing you touched last is where you
// left it." That sentence is an ordering, and an ordering is a pure function — so
// it lives here rather than inside a component, where it could not be driven
// without a DOM and where a second surface wanting the same order would copy it.
//
// FOUR RULES, IN PRECEDENCE ORDER, AND WHY EACH ONE IS WHERE IT IS
//
//   1. **Attention severity.** A session that needs a person outranks one that
//      does not. The severity is READ from the attention projection and never
//      counted here: `notifications/attention-plane.ts` is its one source, and a
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
// PIN CHANGES THE TIER, NEVER THE POSITION. "Re-pinning does not bump a row to the
// top of its tier, because a pinned list ordered by pin time is a second inbox."
// Nothing in the comparator reads the pin, and the fold below applies the same
// comparator inside each tier — which is what makes that promise structural rather
// than a habit.

import type { SessionState } from "@ai-sidekicks/contracts";

import type { AttentionSeverity } from "../bridge/index.js";

/**
 * The two tiers the list folds into. Closed, declared once, union derived.
 *
 * The persistence chokepoint admits exactly these two literals for the `pin`
 * value class, and that agreement is CHECKED in this module's tests rather than
 * asserted in a comment — the store's validator is an independent admission gate,
 * so a tier added here without one added there is refused at the write instead of
 * silently persisting.
 */
export const SESSION_PIN_TIERS = ["front", "back"] as const;

/** One tier. Derived from the enumeration, never restated beside it. */
export type SessionPinTier = (typeof SESSION_PIN_TIERS)[number];

/**
 * The tier a row falls into when nobody has pinned it.
 *
 * The back tier is the DEFAULT rather than a third state, which is what keeps the
 * list at two tiers and one divider. It also decides what the row menu offers: a
 * separate "unpin" beside "move to the back tier" would be two controls for one
 * outcome, so moving a row back is what unpinning means and the persisted map
 * holds only the exceptions.
 */
export const DEFAULT_SESSION_PIN_TIER: SessionPinTier = "back";

/**
 * The two states that are audit stubs rather than sessions a person can work in.
 *
 * Typed as a subset of the wire union rather than as loose strings, so a rename in
 * `packages/contracts` fails here at compile time. Chapter 13 owns the retention
 * read-out; what this list owes them is to render them and offer nothing.
 */
export const AUDIT_STUB_SESSION_STATES: readonly SessionState[] = ["purge_requested", "purged"];

/**
 * One row.
 *
 * `state` is the wire's own string and stays one: it is rendered verbatim, never
 * re-parsed into a richer value, and `undefined` where the wire named none. There
 * is deliberately no `title` — `SessionSnapshot` carries `config` and `metadata`
 * bags and no name column, so an unnamed session renders by its identifier and its
 * participants and never by an invented one.
 */
export interface SessionListRow {
  readonly sessionId: string;
  /** Wire-verbatim lifecycle state, or `undefined` where the wire named none. */
  readonly state: string | undefined;
  /** ISO-8601 of the newest event that touched the session, wire-verbatim. */
  readonly touchedAtIso: string | undefined;
  /** Participants the console has seen in this session, in the order it saw them. */
  readonly participantIds: readonly string[];
  /** From the attention projection. `undefined` means the projection said nothing. */
  readonly attentionSeverity: AttentionSeverity | undefined;
}

/** True when the state is one a person can do nothing with. Fail-closed on `undefined`. */
export function isAuditStubSession(state: string | undefined): boolean {
  return state !== undefined && (AUDIT_STUB_SESSION_STATES as readonly string[]).includes(state);
}

/**
 * Lifecycle rank, low sorts first.
 *
 * A total function over any string the wire can send, including one this console
 * has never seen: an unrecognised state ranks with the settled group rather than
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

/**
 * Recency, as a comparable number. Newest first, unknown last.
 *
 * A missing or unparseable timestamp answers `-Infinity` rather than `0`, so it
 * sorts after every real instant instead of landing in 1970 among sessions that
 * genuinely have not been touched since.
 */
function touchedAtRank(touchedAtIso: string | undefined): number {
  if (touchedAtIso === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  const milliseconds = Date.parse(touchedAtIso);
  return Number.isNaN(milliseconds) ? Number.NEGATIVE_INFINITY : milliseconds;
}

/** The ordinary status-and-activity comparator. Applies inside each tier. */
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
  const byRecency = touchedAtRank(right.touchedAtIso) - touchedAtRank(left.touchedAtIso);
  if (byRecency !== 0) {
    return byRecency;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

/**
 * A row that has been placed in a tier.
 *
 * The tier travels ON the row rather than beside it in a map the renderer looks
 * into, for two reasons: the row's own control needs it, and a row whose tier
 * changed then has a new identity, which is what lets the list memoise a row and
 * still re-render exactly the one that moved.
 */
export interface PlacedSessionRow extends SessionListRow {
  readonly tier: SessionPinTier;
}

/** The list, folded into its two tiers. Each tier is already ordered. */
export interface SessionTierFold {
  readonly front: readonly PlacedSessionRow[];
  readonly back: readonly PlacedSessionRow[];
}

/**
 * Fold rows into the two tiers.
 *
 * The pin map is read as a total function through the default, so a row nobody has
 * touched has a tier without anybody having written one down. Both tiers are sorted
 * by the same comparator, which is the whole of "inside each tier the ordinary
 * status-and-activity comparator applies".
 */
export function foldIntoTiers(
  rows: readonly SessionListRow[],
  tierBySessionId: Readonly<Record<string, SessionPinTier>>,
): SessionTierFold {
  const front: PlacedSessionRow[] = [];
  const back: PlacedSessionRow[] = [];
  for (const row of rows) {
    const tier = tierBySessionId[row.sessionId] ?? DEFAULT_SESSION_PIN_TIER;
    (tier === "front" ? front : back).push({ ...row, tier });
  }
  return {
    front: front.sort(compareSessionRows),
    back: back.sort(compareSessionRows),
  };
}
