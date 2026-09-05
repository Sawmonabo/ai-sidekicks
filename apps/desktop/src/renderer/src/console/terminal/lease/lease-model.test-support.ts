// The two participants and the two event builders every lease suite shares.
//
// The directory's one home for both, and it has to be one: the reader, the fold, the
// line, and the acquisition rule all name the same two participants, and every suite
// that drives the reader or the fold authors a `pty.control_changed` event. Written
// per suite, the cast came out under three spellings for two identities — one file's
// `OTHER` was the neighbouring file's `HOLDER` — and the builder came out twice with
// different signatures, which on this fold is exactly the distinction under test: the
// malformed-shape cases are only meaningful against a builder whose default IS well
// formed.
//
// TWO BUILDERS AND ONE IMPLEMENTATION. The reader's suites hand a payload straight in,
// because what they are about is a payload this build cannot read; the fold's hand in
// the members of a well-formed transition. So the structured one is expressed over the
// raw one rather than beside it, and there is a single answer to what an event's id,
// session, and instant look like.

import { TERMINAL_SCENARIO_CAST } from "../../bridge/scenarios/terminal.js";
import type { ConsoleSessionEvent } from "../../store/index.js";
import { TERMINAL_LEASE_EVENT_KIND } from "./lease-transition.js";

/**
 * Two participants, taken from the scenario rather than written down.
 *
 * The fold treats a participant id as an opaque string, so a readable placeholder
 * would pass every case — and would be the one participant id in this family that no
 * daemon could ever emit, sitting beside beats the scenario deliberately moved onto
 * wire-declared UUIDs. Reading them off the join log keeps the family's fixtures saying
 * one thing about what a participant id is.
 */
export const VIEWER_PARTICIPANT: string = TERMINAL_SCENARIO_CAST.owner;
export const OTHER_PARTICIPANT: string = TERMINAL_SCENARIO_CAST.collaborator;

/**
 * A `pty.control_changed` carrying exactly the payload a case hands it.
 *
 * The reader's shape: its suites are about payloads this build cannot read, so the
 * member set is the case's to decide and an absent payload is one of the cases.
 */
export function leaseEventWithPayload(
  sequence: number,
  payload: Record<string, unknown> | undefined,
  actorId: string | undefined = OTHER_PARTICIPANT,
): ConsoleSessionEvent {
  return {
    // Distinct per position, and readable rather than UUID-shaped: the fold reads this
    // member for nothing, so `store/failure-modes.test-support.ts`'s spelling is the
    // one to match. The participant ids above are the opposite case — those reach a
    // surface, which is why they are read off the scenario's wire-declared cast.
    id: `event-${String(sequence)}`,
    sessionId: "session-terminal",
    sequence,
    kind: TERMINAL_LEASE_EVENT_KIND,
    occurredAt: `2026-01-01T16:40:0${String(sequence % 10)}.000Z`,
    ...(actorId === undefined ? {} : { actorId }),
    ...(payload === undefined ? {} : { payload }),
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
  holderParticipantId: string | null,
  previousHolderParticipantId: string | null = null,
  actorId: string | undefined = holderParticipantId ?? undefined,
): ConsoleSessionEvent {
  return leaseEventWithPayload(
    sequence,
    { holderParticipantId, previousHolderParticipantId, reason },
    actorId,
  );
}
