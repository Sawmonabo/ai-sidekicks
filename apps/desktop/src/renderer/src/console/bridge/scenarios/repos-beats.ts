// The repos scenario's beat envelope: everything every beat carries, written once.
//
// Split out of `repos.ts` on that file's own seam — see `repos-fixture-data.ts`'s
// header for why the scenario divides into a cast, a script, and the answers a call
// gets. This module is the third division's missing half: the script stayed in
// `repos.ts`, where the ORDER and the reason for it belong, and the ENVELOPE every
// scripted beat repeated came here.
//
// WHY AN ENVELOPE IS WORTH A MODULE. Twenty-two beats each restated the session id,
// the actor, and an ISO instant, and the last of those was the sharp one: every
// beat's `occurredAt` was a hand-written second spelling of its own `atMs`, so a beat
// whose tick moved and whose stamp did not would place one event at two times and
// nothing would have caught it. `scenarioInstant` derives the stamp from the tick, so
// there is one clock and one place to read it.
//
// It is also what keeps a wire rename cheap. `actorId` is the envelope's member and
// appears exactly once below, so a rename of it edits one line rather than one line
// per beat — which is what the rename from `actorParticipantId` cost.
//
// AND IT IS WHERE THE EVENT'S OWN ID COMES FROM. The canonical envelope names the row
// as well as its position, so every beat carries one; deriving it from `sequence`
// here keeps the two facts that must agree in one place, exactly as `occurredAt` is
// derived from `atMs`. A hand-written id per beat would be a second numbering of the
// log, and two numberings of one thing is what this module exists to prevent.
//
// WHAT THIS DELIBERATELY DOES NOT OWN. The `payload` is passed through untouched.
// Each family's payload is a different registered shape and `repos.ts` transcribes
// each one verbatim from the spec that declares it; an envelope that reached into a
// payload to fill in a member would be inventing wire content, which is the one thing
// a fixture may never do.

import type { ScenarioBeat } from "../scenario-runtime/scenario.js";

import { SESSION_ID } from "./repos-fixture-data.js";

/**
 * The event-row id for one log position.
 *
 * UUID-shaped for `repos-fixture-data.ts`'s reason — every identifier this scenario
 * puts on the wire is a value the wire can carry — and drawn from the same
 * `9f2c4a10-…` family, in a block no entity in the cast occupies. The position is the
 * variable part, so a beat's row id and its log position cannot disagree.
 */
function reposEventId(sequence: number): string {
  return `9f2c4a10-0000-4000-8000-0001${String(sequence).padStart(8, "0")}`;
}

/**
 * The instant the scenario's own clock starts at.
 *
 * Every beat's `atMs` is measured from here and every `occurredAt` is derived from
 * it, so the scenario has one start and not one per file.
 */
export const REPOS_SCENARIO_STARTED_AT_ISO = "2026-01-01T09:05:00.000Z";

// ONE INSTANT WRITTEN TWICE, BUILT RATHER THAN PARSED. The scenario's base is a
// fixture's own decision and not a wire reading, so composing it from its parts is
// exact; reading it back through a parser would make every beat derived from it assert
// against whatever that parser answered, and the console's one reader of a wire stamp
// is the thing the cases built on this base are measuring. The two spellings are
// asserted equal by `repos.test.ts`, so the pair cannot drift.
const REPOS_SCENARIO_STARTED_AT_MILLISECONDS = Date.UTC(2026, 0, 1, 9, 5, 0);

/**
 * The wire stamp for one tick of scenario time.
 *
 * `toISOString` always renders milliseconds, so a tick lands on the same string a
 * daemon would have sent — which is what lets the stamp be derived rather than
 * transcribed beside the tick it is supposed to agree with.
 */
export function scenarioInstant(atMs: number): string {
  return new Date(REPOS_SCENARIO_STARTED_AT_MILLISECONDS + atMs).toISOString();
}

/** One scripted beat, as `repos.ts` states it: when, where in the sequence, and what. */
export interface ReposBeatScript {
  /** Milliseconds from scenario start. The beat's wire stamp is derived from this. */
  readonly atMs: number;
  /** Monotonic position in the session's log. */
  readonly sequence: number;
  /** The registered event type, wire-verbatim. */
  readonly kind: string;
  /**
   * The participant the event is attributed to.
   *
   * Omitted where the DAEMON made the move — a participant id on a system transition
   * would attribute the daemon's decision to a person.
   */
  readonly actorId?: string;
  /** The registered family payload, transcribed verbatim by the caller. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Wrap one scripted beat in the envelope every beat in this scenario shares. */
export function reposBeat(script: ReposBeatScript): ScenarioBeat {
  return {
    atMs: script.atMs,
    event: {
      id: reposEventId(script.sequence),
      sessionId: SESSION_ID,
      sequence: script.sequence,
      kind: script.kind,
      occurredAt: scenarioInstant(script.atMs),
      ...(script.actorId === undefined ? {} : { actorId: script.actorId }),
      payload: script.payload,
    },
  };
}
