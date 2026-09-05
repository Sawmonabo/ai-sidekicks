// The goal event's payload readings and the bounds a goal is refused against.
//
// WHY HERE AND NOT BESIDE THE FOLD. `session.goalUpdate` and its two events carry
// payloads `@ai-sidekicks/contracts` does not publish, so there is no registered
// shape for the projection to narrow against and the reading has to be written.
// Written where it is READ it would put a validator inside a view family, which is
// what `apps/desktop/eslint.config.mjs` forbids: a surface that can import a
// validator can write a second, different reading of a seam that already has one. So
// the reading lives at the bridge boundary beside the stream projection, and the fold
// above consumes ANSWERS rather than schemas — `undefined` for a payload that does
// not carry the member, never a parse result a caller re-reads.
//
// The bounds travel with the reading rather than staying in the approvals subtree
// because they are the DAEMON's bounds, quoted so the field refuses on the same rule
// the wire does; a bound restated above the validator that spends it is the second
// copy this module exists to prevent.
//
// The day the corpus registers these payloads, the schemas below become imports from
// the contracts package and nothing above this module changes.

import { z } from "zod";

import { EVENT_ENVELOPE_SEQUENCE_MAX } from "@ai-sidekicks/contracts";

/**
 * The shortest a session goal may be.
 *
 * One rather than zero is what makes "an update with no goal is malformed" true at
 * the type level: clearing is a different operation, and an empty-text update is
 * never treated as one.
 */
export const SESSION_GOAL_MIN_LENGTH = 1;

/**
 * The longest a session goal may be.
 *
 * The daemon's own bound, restated so the field refuses on the same rule rather than
 * truncating and sending something the participant did not write.
 */
export const SESSION_GOAL_MAX_LENGTH = 4096;

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
const sessionGoalTextSchema = z
  .string()
  .min(SESSION_GOAL_MIN_LENGTH)
  .max(SESSION_GOAL_MAX_LENGTH)
  .refine((text) => text.trim().length > 0)
  .refine((text) => !text.includes(NUL_CODE_POINT));

/**
 * Whether the console will send this draft at all.
 *
 * A BOOLEAN and not a parse result, because the caller is an editor deciding whether
 * its confirm control is live. Handing back the parse would hand a view family a
 * validator's error object, which is the reading this module exists to keep in one
 * place — and the text a caller sends is the text it holds, never a value this module
 * rewrote.
 */
export function isSendableGoalText(text: string): boolean {
  return sessionGoalTextSchema.safeParse(text).success;
}

const goalPayloadSchema = z.object({ goal: z.object({ text: z.string() }) });

/** The goal text a goal payload carries, or `undefined` for one that carries none. */
export function readGoalPayloadText(payload: unknown): string | undefined {
  const parsed = goalPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.goal.text : undefined;
}

/**
 * The origin keys the accepting daemon stamps on every goal payload.
 *
 * `originNodeId` is the daemon that accepted the mutation and `originSeq` is that
 * daemon's own per-session append position for the event — the durable pair the event
 * taxonomy puts on both goal payloads. They are read through a schema rather than off
 * the record by hand because the projected payload is `unknown` at this boundary: a
 * hand-shaped read would take a string sequence, a fractional one, or an empty node id
 * as an order and rank on it.
 *
 * `originSeq` takes the envelope sequence's own injectivity ceiling, imported from the
 * contract rather than restated, so a value a fold could not tell apart from its
 * neighbour is not read as an order at all.
 */
export interface GoalOriginKeys {
  readonly originNodeId: string;
  readonly originSeq: number;
}

const goalOriginKeysSchema = z.object({
  originNodeId: z.string().min(1),
  originSeq: z.number().int().nonnegative().max(EVENT_ENVELOPE_SEQUENCE_MAX),
});

/**
 * The origin keys a goal payload carries, or `undefined` for one appended before them.
 *
 * A payload that does not carry the pair is not an error — an event written before the
 * keys existed carries neither — and such an event folds through the envelope-ordered
 * slot instead.
 */
export function readGoalOriginKeys(payload: unknown): GoalOriginKeys | undefined {
  const parsed = goalOriginKeysSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
