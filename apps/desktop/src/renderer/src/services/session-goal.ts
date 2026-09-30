// The session goal: where the current one comes from.
//
// The session goal is a PROJECTION of the event log — an accepted update emits
// `session.goal_updated` carrying the canonical goal, there is no separate goal store,
// and the current goal is whatever the latest goal event says. So the fold below reads
// the store's timeline rather than holding a copy: a card that kept its own last-known
// goal would be a second source of truth for a value the log already orders, and it
// would show a goal the daemon never appended.
//
// NOTHING HERE IS OPTIMISTIC. Delivery is all-or-nothing across every live binding
// and the event commits only after all of them acknowledge, so the fold stays on
// the prior goal until the event lands.
//
// IT LIVES IN `services/` BECAUSE MORE THAN ONE FEATURE READS THE GOAL, and features
// may not import one another. Every input this module has sits below that: the goal
// payload schema `@ai-sidekicks/contracts` registers, `lib/`'s instant comparison, and
// the store's event type. So callers take the fold from this module rather than each
// folding the timeline their own way, which would be a second projection of one log.

import { SessionGoalUpdatedPayloadSchema } from "@ai-sidekicks/contracts";

import { compareInstants, parseInstant } from "@renderer/lib/instant.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/** The two projection sources, wire-verbatim. */
export const SESSION_GOAL_EVENT_KINDS = ["session.goal_updated", "session.goal_cleared"] as const;

/** The same closed set as a lookup, so the fold tests membership once per entry. */
const GOAL_EVENT_KINDS: ReadonlySet<string> = new Set<string>(SESSION_GOAL_EVENT_KINDS);

/** The clearing arm, derived rather than restated, so the two kinds are declared once. */
const [, SESSION_GOAL_CLEARED_EVENT_KIND] = SESSION_GOAL_EVENT_KINDS;

/**
 * Which log entry a goal projection was read from.
 *
 * The projection is recomputed whenever the timeline grows — every `usage.*` beat,
 * every run transition — and a consumer that watched the projection OBJECT would see
 * a change on each of them. So the reading carries the identity of the entry it was
 * read from, and a consumer keys on that: it moves when, and only when, a different
 * goal event wins the fold. The identity is the winner's envelope `id`, which is the
 * same on every node the event reaches.
 *
 * It is deliberately NOT the goal's text: a goal re-set to the text it already had
 * is still a new act by a user, and a consumer told otherwise would treat it
 * as though nothing had happened.
 */
const EVENT_REVISION_PREFIX = "e:";

/** The revision of a session no goal event has ever named. Not the prefix's shape. */
const UNSET_GOAL_REVISION = "unset";

/** The current goal, as the log says it is, and which entry says it. */
export type SessionGoalProjection =
  | { readonly status: "none"; readonly revision: string }
  | { readonly status: "set"; readonly text: string; readonly revision: string }
  /** A goal event landed and its payload did not carry a readable goal. */
  | { readonly status: "unreadable"; readonly revision: string };

/**
 * Fold the log's goal events into the current goal.
 *
 * Reads EVERY goal event and ranks them, because arrival order is not authorship
 * order. A relayed event is appended to this timeline when it reaches this node, so
 * its local `sequence` records when it arrived here and not when it was written —
 * and a fold that ranked on local position would answer with whichever event
 * happened to arrive last, and would answer differently on every node. So the
 * ranking is the envelope's: `occurredAt`, tie-broken by envelope `id`. BOTH kinds
 * compete in the one ranking, so a clear newer than an update wins and an update
 * newer than a clear wins.
 *
 * Local `sequence` is read NOWHERE in the ranking. Two nodes handed the same goal
 * events in different arrival orders therefore settle on the same goal, which is
 * the property the fold exists to have.
 *
 * An unparseable `occurredAt` never beats a parseable one: letting an unreadable
 * stamp overwrite a reading the console knows is real is the direction that loses
 * information, so the comparator fails closed toward the readable event, and two
 * unreadable stamps still settle on `id` rather than on who arrived first.
 */
export function foldSessionGoal(timeline: readonly ProjectedSessionEvent[]): SessionGoalProjection {
  let winner: ProjectedSessionEvent | undefined;
  for (const entry of timeline) {
    if (!GOAL_EVENT_KINDS.has(entry.kind)) {
      continue;
    }
    if (winner === undefined || compareByEnvelope(entry, winner) > 0) {
      winner = entry;
    }
  }
  if (winner === undefined) {
    return { status: "none", revision: UNSET_GOAL_REVISION };
  }
  const revision = `${EVENT_REVISION_PREFIX}${winner.id}`;
  if (winner.kind === SESSION_GOAL_CLEARED_EVENT_KIND) {
    return { status: "none", revision };
  }
  const payload = SessionGoalUpdatedPayloadSchema.safeParse(winner.payload);
  return payload.success
    ? { status: "set", text: payload.data.goal.text, revision }
    : { status: "unreadable", revision };
}

/**
 * The comparator — envelope `occurredAt`, then envelope `id`. Total and
 * order-independent, which is what makes two nodes agree.
 *
 * Both `occurredAt` values are ISO-8601 on the wire, so both ordinarily parse; one
 * that does not ranks below one that does, and two that do not fall through to `id`
 * rather than to arrival.
 */
function compareByEnvelope(left: ProjectedSessionEvent, right: ProjectedSessionEvent): number {
  const leftInstant = parseInstant(left.occurredAt);
  const rightInstant = parseInstant(right.occurredAt);
  const leftIsReadable = leftInstant.kind !== "malformed";
  const rightIsReadable = rightInstant.kind !== "malformed";
  // The one place this comparator disagrees with the shared order, and it disagrees
  // on purpose: `compareInstants` ranks a malformed stamp LAST in either direction,
  // which is right for a list a person reads and wrong for a fold that must not let
  // an unreadable stamp overwrite a reading the console knows is real.
  if (leftIsReadable !== rightIsReadable) {
    return leftIsReadable ? 1 : -1;
  }
  const ranked = compareInstants(leftInstant, rightInstant, "oldest-first");
  if (ranked !== 0) {
    return ranked;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id > right.id ? 1 : -1;
}
