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
// It is also what keeps a wire rename cheap. `actorParticipantId` is the envelope's
// member and appears exactly once below, so a rename of it edits one line rather than
// one line per beat.
//
// WHAT THIS DELIBERATELY DOES NOT OWN. The `payload` is passed through untouched.
// Each family's payload is a different registered shape and `repos.ts` transcribes
// each one verbatim from the spec that declares it; an envelope that reached into a
// payload to fill in a member would be inventing wire content, which is the one thing
// a fixture may never do.

import type { ScenarioBeat } from "../scenario.js";

import { SESSION_ID } from "./repos-fixture-data.js";

/**
 * The instant the scenario's own clock starts at.
 *
 * Every beat's `atMs` is measured from here and every `occurredAt` is derived from
 * it, so the scenario has one start and not one per file.
 */
export const REPOS_SCENARIO_STARTED_AT_ISO = "2026-01-01T09:05:00.000Z";

const REPOS_SCENARIO_STARTED_AT_MILLISECONDS = Date.parse(REPOS_SCENARIO_STARTED_AT_ISO);

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
  readonly actorParticipantId?: string;
  /** The registered family payload, transcribed verbatim by the caller. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Wrap one scripted beat in the envelope every beat in this scenario shares. */
export function reposBeat(script: ReposBeatScript): ScenarioBeat {
  return {
    atMs: script.atMs,
    event: {
      sessionId: SESSION_ID,
      sequence: script.sequence,
      kind: script.kind,
      occurredAt: scenarioInstant(script.atMs),
      ...(script.actorParticipantId === undefined
        ? {}
        : { actorParticipantId: script.actorParticipantId }),
      payload: script.payload,
    },
  };
}
