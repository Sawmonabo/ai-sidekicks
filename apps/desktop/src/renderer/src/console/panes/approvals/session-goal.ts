// The session goal: where the current one comes from, what a valid one is, and the
// two operations that may change it.
//
// `Spec-023 §Console Design (Meridian)` §7.11 makes the goal a PROJECTION of the
// event log — there is no separate goal store, and the current goal is whatever the
// latest goal event says. So the fold below reads the store's timeline rather than
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
 * Fold the log's goal events into the current goal.
 *
 * Reads EVERY goal event and ranks them, because arrival order is not authorship
 * order. A relayed event is appended to this timeline when it reaches this node, so
 * its local `sequence` records when it arrived here and not when it was written: a
 * delayed update can land after one authored later and overwrite it, and a clear can
 * lose to an update it preceded. A fold that stopped at the newest local position
 * would answer with whichever event happened to arrive last.
 *
 * The ranking is the wire's `occurredAt`, newest wins, with the session's own local
 * `sequence` breaking an exact-instant tie — a real order the store maintains rather
 * than one this module invented, and the same two-clause rule the composer's rate
 * readings already rank on. BOTH kinds compete in the one ranking, so a clear newer
 * than an update wins and an update newer than a clear wins.
 *
 * There is no event-id tiebreak below the instant. The corpus's cross-origin rule
 * breaks an identical instant on the envelope's `id`, and the store's projected
 * event shape (`ConsoleSessionEvent`) carries no `id` — a fact about what this
 * renderer is handed, not a deferral. Local `sequence` is the order it does carry.
 *
 * An unparseable `occurredAt` never beats a parseable one: letting an unreadable
 * stamp overwrite a reading the console knows is real is the direction that loses
 * information, so the fold fails closed toward the readable event.
 */
export function foldSessionGoal(timeline: readonly ConsoleSessionEvent[]): SessionGoalProjection {
  let winner: ConsoleSessionEvent | undefined;
  for (const entry of timeline) {
    if (!GOAL_EVENT_KINDS.has(entry.kind)) {
      continue;
    }
    if (winner === undefined || supersedes(entry, winner)) {
      winner = entry;
    }
  }
  if (winner === undefined || winner.kind === SESSION_GOAL_CLEARED_EVENT_KIND) {
    return { status: "none" };
  }
  const parsed = goalPayloadSchema.safeParse(winner.payload);
  return parsed.success ? { status: "set", text: parsed.data.goal.text } : { status: "unreadable" };
}

/**
 * Whether one goal event is a later reading of the register than another.
 *
 * Both `occurredAt` values are ISO-8601 on the wire, so both ordinarily parse; a
 * candidate whose stamp does not answers `false` and keeps the held event, and a
 * candidate whose stamp does parse displaces a held one whose does not. Two
 * unreadable stamps carry no order at all, so the held reading stands.
 */
function supersedes(candidate: ConsoleSessionEvent, held: ConsoleSessionEvent): boolean {
  const candidateInstant = Date.parse(candidate.occurredAt);
  const heldInstant = Date.parse(held.occurredAt);
  if (Number.isNaN(candidateInstant)) {
    return false;
  }
  if (Number.isNaN(heldInstant)) {
    return true;
  }
  if (candidateInstant === heldInstant) {
    return candidate.sequence > held.sequence;
  }
  return candidateInstant > heldInstant;
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
