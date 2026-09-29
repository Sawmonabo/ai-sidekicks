// The two users and the two event builders every lease suite shares.
//
// The directory's one home for both, and it has to be one: the reader, the fold, the
// line, and the acquisition rule all name the same two users, and every suite
// that drives the reader or the fold authors a `pty.control_changed` event. Written
// per suite, the cast came out under three spellings for two identities — one file's
// `OTHER` was the neighboring file's `HOLDER` — and the builder came out twice with
// different signatures, which on this fold is exactly the distinction under test: the
// malformed-shape cases are only meaningful against a builder whose default IS well
// formed.
//
// TWO BUILDERS AND ONE IMPLEMENTATION. The reader's suites hand a payload straight in,
// because what they are about is a payload this build cannot read; the fold's hand in
// the members of a well-formed transition. So the structured one is expressed over the
// raw one rather than beside it, and there is a single answer to what an event's id,
// session, and instant look like.

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { TERMINAL_SCENARIO_ROLES } from "../../../../../../fixtures/scenarios/terminal-lease.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { TERMINAL_LEASE_EVENT_KIND } from "./lease-transition.js";

/**
 * Two users, taken from the scenario rather than written down.
 *
 * The fold treats a user id as an opaque string, so a readable placeholder
 * would pass every case — and would be the one user id in the terminal tests that no
 * daemon could ever emit, sitting beside beats the scenario deliberately moved onto
 * wire-declared UUIDs. Reading them off the join log keeps the terminal tests' fixtures saying
 * one thing about what a user id is.
 */
export const THIS_DEVICE_ID: string = TERMINAL_SCENARIO_ROLES.owner;
export const OTHER_DEVICE_ID: string = TERMINAL_SCENARIO_ROLES.otherDevice;

/**
 * A `pty.control_changed` carrying exactly the payload a case hands it.
 *
 * The reader's shape: its suites are about payloads this build cannot read, so the
 * member set is the case's to decide and an absent payload is one of the cases.
 */
export function leaseEventWithPayload(
  sequence: number,
  payload: Record<string, unknown> | undefined,
  actorId: string | undefined = OTHER_DEVICE_ID,
): ProjectedSessionEvent {
  return {
    // The console's one admitted-event builder, plus the member it does not take: the
    // actor a lease move is attributed to. Spread over it rather than spelled again, on
    // `store/session/failure-modes.test-support.ts`'s precedent.
    ...eventOfKind("session-terminal", TERMINAL_LEASE_EVENT_KIND, sequence, payload),
    ...(actorId === undefined ? {} : { actorId }),
  };
}

/**
 * A well-formed transition, from the members a caller means to vary.
 *
 * The fold's shape, and the default that makes the malformed cases mean something:
 * a caller changing one member is changing one member of an event the reader accepts.
 */
export function transitionEvent(
  sequence: number,
  reason: string,
  holderUserId: string | null,
  previousHolderUserId: string | null = null,
  actorId: string | undefined = holderUserId ?? undefined,
): ProjectedSessionEvent {
  return leaseEventWithPayload(sequence, { holderUserId, previousHolderUserId, reason }, actorId);
}
