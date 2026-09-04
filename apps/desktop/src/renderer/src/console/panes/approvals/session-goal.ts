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

import { z } from "zod";
import { EVENT_ENVELOPE_SEQUENCE_MAX } from "@ai-sidekicks/contracts";

import { callDaemon, type ConsoleBridge } from "../../bridge/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import { SESSION_GOAL_MAX_LENGTH, SESSION_GOAL_MIN_LENGTH } from "./approvals-bounds.js";

/** Set the goal. Carries the goal; an absent one is malformed, not a clear. */
export const SESSION_GOAL_UPDATE_METHOD = "session.goalUpdate";

/** Clear the goal. The distinct operation, never an update with empty text. */
export const SESSION_GOAL_CLEAR_METHOD = "session.goalClear";

/** The two projection sources, wire-verbatim. */
export const SESSION_GOAL_EVENT_KINDS = ["session.goal_updated", "session.goal_cleared"] as const;

/** The same closed set as a lookup, so the fold tests membership once per entry. */
const GOAL_EVENT_KINDS: ReadonlySet<string> = new Set<string>(SESSION_GOAL_EVENT_KINDS);

/** The clearing arm, derived rather than restated, so the two kinds are declared once. */
const [, SESSION_GOAL_CLEARED_EVENT_KIND] = SESSION_GOAL_EVENT_KINDS;

/** The code point the bound rejects, written as an escape so no file carries one. */
const NUL_CODE_POINT = "\u0000";

/**
 * What a valid goal is, refused client-side on the daemon's own rule.
 *
 * A `refine` rather than `trim().min(1)` because the value SENT is what the
 * participant typed: trimming before validating would silently send text they did
 * not write, and the console never rewrites a bounded field to make it fit. The NUL
 * rejection is explicit for the same reason — a control character that survived to
 * the daemon would come back as a refusal a person cannot act on.
 */
export const sessionGoalTextSchema: z.ZodType<string> = z
  .string()
  .min(SESSION_GOAL_MIN_LENGTH)
  .max(SESSION_GOAL_MAX_LENGTH)
  .refine((text) => text.trim().length > 0, { message: "A goal cannot be blank." })
  .refine((text) => !text.includes(NUL_CODE_POINT), {
    message: "A goal cannot contain a NUL character.",
  });

/** The current goal, as the log says it is. */
export type SessionGoalProjection =
  | { readonly status: "none" }
  | { readonly status: "set"; readonly text: string }
  /** A goal event landed and its payload did not carry a readable goal. */
  | { readonly status: "unreadable" };

const goalPayloadSchema = z.object({ goal: z.object({ text: z.string() }) });

/**
 * The origin keys the accepting daemon stamps on every goal payload.
 *
 * `originNodeId` is the daemon that accepted the mutation and `originSeq` is that
 * daemon's own per-session append position for the event — the durable pair the
 * event taxonomy puts on both goal payloads. They are read through a schema rather
 * than off the record by hand because the projected payload is `unknown` at this
 * boundary: a hand-shaped read would take a string sequence, a fractional one, or
 * an empty node id as an order and rank on it.
 *
 * `originSeq` takes the envelope sequence's own injectivity ceiling, imported from
 * the contract rather than restated, so a value this fold could not tell apart from
 * its neighbour is not read as an order at all.
 *
 * A payload that does not carry the pair parses `false` here. That is not an error
 * — an event appended before the keys existed carries neither — and such an event
 * folds through the single envelope-ordered slot below.
 */
const goalOriginKeysSchema = z.object({
  originNodeId: z.string().min(1),
  originSeq: z.number().int().nonnegative().max(EVENT_ENVELOPE_SEQUENCE_MAX),
});

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
  if (winner === undefined || winner.kind === SESSION_GOAL_CLEARED_EVENT_KIND) {
    return { status: "none" };
  }
  const parsed = goalPayloadSchema.safeParse(winner.payload);
  return parsed.success ? { status: "set", text: parsed.data.goal.text } : { status: "unreadable" };
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
    const originKeys = goalOriginKeysSchema.safeParse(entry.payload);
    if (!originKeys.success) {
      if (unkeyedCandidate === undefined || compareByEnvelope(entry, unkeyedCandidate) > 0) {
        unkeyedCandidate = entry;
      }
      continue;
    }
    const { originNodeId, originSeq } = originKeys.data;
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
  const leftInstant = Date.parse(left.occurredAt);
  const rightInstant = Date.parse(right.occurredAt);
  const leftIsReadable = !Number.isNaN(leftInstant);
  const rightIsReadable = !Number.isNaN(rightInstant);
  if (leftIsReadable !== rightIsReadable) {
    return leftIsReadable ? 1 : -1;
  }
  if (leftIsReadable && rightIsReadable && leftInstant !== rightInstant) {
    return leftInstant > rightInstant ? 1 : -1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id > right.id ? 1 : -1;
}

/** Set the session's goal. */
export async function updateSessionGoal(
  bridge: ConsoleBridge,
  sessionId: string,
  text: string,
): Promise<void> {
  await callDaemon(bridge, SESSION_GOAL_UPDATE_METHOD, { sessionId, goal: { text } });
}

/** Clear the session's goal. The distinct operation. */
export async function clearSessionGoal(bridge: ConsoleBridge, sessionId: string): Promise<void> {
  await callDaemon(bridge, SESSION_GOAL_CLEAR_METHOD, { sessionId });
}
