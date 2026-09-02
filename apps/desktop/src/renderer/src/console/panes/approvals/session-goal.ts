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
 * Walks BACKWARDS and stops at the first goal event, because the fold's answer is
 * "whatever the latest one says" and reading the whole log to answer it would cost
 * the length of the session on every render.
 */
export function foldSessionGoal(timeline: readonly ConsoleSessionEvent[]): SessionGoalProjection {
  for (let position = timeline.length - 1; position >= 0; position -= 1) {
    const entry = timeline[position];
    if (entry === undefined) {
      continue;
    }
    if (entry.kind === "session.goal_cleared") {
      return { status: "none" };
    }
    if (entry.kind !== "session.goal_updated") {
      continue;
    }
    const parsed = goalPayloadSchema.safeParse(entry.payload);
    return parsed.success
      ? { status: "set", text: parsed.data.goal.text }
      : { status: "unreadable" };
  }
  return { status: "none" };
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
