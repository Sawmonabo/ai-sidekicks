// The session goal: where the current one comes from, what a valid one is, and the
// two operations that may change it.
//
// `Spec-016 §Session Goals` makes the goal a PROJECTION of the event log — an
// accepted update emits `session.goal_updated` carrying the canonical goal, there is
// no separate goal store, and the current goal is whatever the latest goal event
// says. So the fold below reads the store's timeline rather than
// holding a copy: a card that kept its own last-known goal would be a second source
// of truth for a value the log already orders, and it would show a goal the daemon
// never appended.
//
// TWO OPERATIONS, NEVER ONE. `session.goalUpdate` sets and `session.goalClear`
// clears, and an update with no goal is malformed rather than a clear. That is why
// the schema's minimum is one character and not zero.
//
// NOTHING HERE IS OPTIMISTIC. Delivery is all-or-nothing across every live binding
// and the event commits only after all of them acknowledge, so the fold stays on
// the prior goal until the event lands. A degraded driver result is not an
// acknowledgement and takes the refusal path.

import { compareInstants, parseInstant } from "../../../core/index.js";
import {
  readGoalOriginKeys,
  readGoalPayloadText,
  type ConsoleBridge,
  type GrowthOutcome,
} from "../../../bridge/index.js";
import { type ConsoleSessionEvent } from "../../../store/index.js";

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
 * goal event wins the fold.
 *
 * The identity is the winner's own durable one, on the same two-source rule the
 * ranking uses: the `(originNodeId, originSeq)` pair the accepting daemon stamped,
 * or the envelope `id` for an event appended before those keys existed. Both are
 * global, so two nodes handed the same events answer with the same revision — the
 * property the fold already has, carried onto its identity. The two forms are
 * prefixed so neither can be read as the other, and the sequence precedes the node
 * id so the boundary between them is unambiguous however a node id is spelled.
 *
 * It is deliberately NOT the goal's text: a goal re-set to the text it already had
 * is still a new act by a participant, and a consumer told otherwise would treat it
 * as though nothing had happened.
 */
type GoalRevisionPrefix = "o:" | "e:";

const ORIGIN_KEYED_REVISION_PREFIX: GoalRevisionPrefix = "o:";
const ENVELOPE_KEYED_REVISION_PREFIX: GoalRevisionPrefix = "e:";

/** The revision of a session no goal event has ever named. Neither prefix's shape. */
const UNSET_GOAL_REVISION = "unset";

/** The current goal, as the log says it is, and which entry says it. */
export type SessionGoalProjection =
  | { readonly status: "none"; readonly revision: string }
  | { readonly status: "set"; readonly text: string; readonly revision: string }
  /** A goal event landed and its payload did not carry a readable goal. */
  | { readonly status: "unreadable"; readonly revision: string };

/** One origin's latest goal event, with the position that made it latest. */
interface OriginGoalCandidate {
  readonly event: ConsoleSessionEvent;
  readonly originSeq: number;
}

/**
 * Fold the log's goal events into the current goal.
 *
 * Reads EVERY goal event and ranks them, because arrival order is not authorship
 * order. A relayed event is appended to this timeline when it reaches this node, so
 * its local `sequence` records when it arrived here and not when it was written —
 * and a fold that ranked on local position would answer with whichever event
 * happened to arrive last, and would answer differently on every node.
 *
 * THE RANKING IS THE CORPUS'S TWO-STAGE GOAL FOLD, IN ITS TWO STAGES. Within one
 * origin daemon that daemon's own append order is authoritative, so the greatest
 * `originSeq` wins and a delayed same-origin event never displaces a newer one —
 * wall-clock plays no part there, because a clock step between two serial local
 * mutations must not invert them. Only BETWEEN different origins' winners does the
 * cross-origin comparator apply: envelope `occurredAt`, tie-broken by envelope
 * `id`. BOTH kinds compete in the one ranking, so a clear newer than an update wins
 * and an update newer than a clear wins.
 *
 * A goal event whose payload carries no origin keys — one appended before they
 * existed — cannot join an origin's register, so every such event competes for a
 * single envelope-ordered slot and that slot's holder enters the cross-origin
 * comparison as one more candidate. That is the same disposition the channel
 * directory gives a pre-extension publication, rather than a second ranking rule.
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
export function foldSessionGoal(timeline: readonly ConsoleSessionEvent[]): SessionGoalProjection {
  const winner = selectLatestGoalEvent(timeline);
  const revision = goalRevisionOf(winner);
  if (winner === undefined || winner.kind === SESSION_GOAL_CLEARED_EVENT_KIND) {
    return { status: "none", revision };
  }
  const text = readGoalPayloadText(winner.payload);
  return text === undefined
    ? { status: "unreadable", revision }
    : { status: "set", text, revision };
}

/**
 * The identity of the entry this projection was read from.
 *
 * Reads the origin keys through the same schema the ranking reads them through, so
 * a payload the fold could not rank by is not one this can key by either — the two
 * cannot come apart, which is what would happen if this read the members by hand.
 */
function goalRevisionOf(winner: ConsoleSessionEvent | undefined): string {
  if (winner === undefined) {
    return UNSET_GOAL_REVISION;
  }
  const originKeys = readGoalOriginKeys(winner.payload);
  return originKeys === undefined
    ? `${ENVELOPE_KEYED_REVISION_PREFIX}${winner.id}`
    : `${ORIGIN_KEYED_REVISION_PREFIX}${String(originKeys.originSeq)}:${originKeys.originNodeId}`;
}

/** Stage one per origin, then stage two across the origins' winners. */
function selectLatestGoalEvent(
  timeline: readonly ConsoleSessionEvent[],
): ConsoleSessionEvent | undefined {
  const latestPerOrigin = new Map<string, OriginGoalCandidate>();
  let unkeyedCandidate: ConsoleSessionEvent | undefined;
  for (const entry of timeline) {
    if (!GOAL_EVENT_KINDS.has(entry.kind)) {
      continue;
    }
    const originKeys = readGoalOriginKeys(entry.payload);
    if (originKeys === undefined) {
      if (unkeyedCandidate === undefined || compareByEnvelope(entry, unkeyedCandidate) > 0) {
        unkeyedCandidate = entry;
      }
      continue;
    }
    const { originNodeId, originSeq } = originKeys;
    const held = latestPerOrigin.get(originNodeId);
    if (held === undefined || outranksWithinOrigin(entry, originSeq, held)) {
      latestPerOrigin.set(originNodeId, { event: entry, originSeq });
    }
  }
  let winner = unkeyedCandidate;
  for (const candidate of latestPerOrigin.values()) {
    if (winner === undefined || compareByEnvelope(candidate.event, winner) > 0) {
      winner = candidate.event;
    }
  }
  return winner;
}

/**
 * Stage one: whether a candidate is a later append by the origin that stamped it.
 *
 * The origin's own sequence decides. An equal sequence is a redelivery of one
 * append rather than a second one, and the two copies are separated on the envelope
 * so the answer does not depend on which copy arrived first.
 */
function outranksWithinOrigin(
  candidate: ConsoleSessionEvent,
  candidateOriginSeq: number,
  held: OriginGoalCandidate,
): boolean {
  if (candidateOriginSeq !== held.originSeq) {
    return candidateOriginSeq > held.originSeq;
  }
  return compareByEnvelope(candidate, held.event) > 0;
}

/**
 * Stage two: the cross-origin comparator — envelope `occurredAt`, then envelope
 * `id`. Total and order-independent, which is what makes two nodes agree.
 *
 * Both `occurredAt` values are ISO-8601 on the wire, so both ordinarily parse; one
 * that does not ranks below one that does, and two that do not fall through to `id`
 * rather than to arrival.
 */
function compareByEnvelope(left: ConsoleSessionEvent, right: ConsoleSessionEvent): number {
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

/**
 * Set the session's goal.
 *
 * Through the GROWTH PORT and not `callDaemon`: `session.goalUpdate` is a registered
 * method STRING whose request and reply shapes `@ai-sidekicks/contracts` does not
 * publish, so there is nothing for the call door to parse against and the registered
 * table admits no row for it. The port refuses by name under the live bridge and says
 * that Plan-016 owes the pair.
 */
export function updateSessionGoal(
  bridge: ConsoleBridge,
  sessionId: string,
  text: string,
): Promise<GrowthOutcome<undefined>> {
  return bridge.growth.sessionGoalUpdate({ sessionId, goal: { text } });
}

/** Clear the session's goal. The distinct operation, on the same seam. */
export function clearSessionGoal(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<GrowthOutcome<undefined>> {
  return bridge.growth.sessionGoalClear({ sessionId });
}
