// A shipped scenario, playing frames its author did not write.
//
// A MODULE OF ITS OWN RATHER THAN A RESIDENT OF `call-plane/bridge.test-support.ts`. That module
// builds a bridge and drives it; this one composes a `ConsoleScenario` value and touches
// no bridge, no engine, and no port — different noun, and the file it would have joined
// is already past the length this package allows.
//
// WHY A SUITE NEEDS ONE. Some readings are only reachable from a room that has been TOLD
// something its author did not write — a membership revoked mid-playback, a transition
// whose payload names another session. A scenario is DATA, so the honest way to reach
// those is to play the frame and let the fixture read it, rather than to reach past the
// engine and call a fold directly: a case that called the fold would pass against a
// fixture that had wired it to nothing.

import type { ConsoleScenario } from "../../scenario-runtime/index.js";

/** One frame a suite appends to a shipped script: the kind, and what it carries. */
export interface AppendedScenarioFrame {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The tick spacing and identifier range appended frames take.
 *
 * A range no shipped scenario writes, so a frame a suite appended is distinguishable from
 * one an author wrote — the discipline `channel-lifecycle.ts` already keeps for
 * the frames it publishes.
 */
const APPENDED_FRAME_STEP_MS = 20;
const APPENDED_FRAME_EVENT_ID_PREFIX = "019bf1c7-1111-7000-8000-";
const APPENDED_FRAME_INSTANT_ISO = "2026-01-01T10:06:00.000Z";

/**
 * That scenario, with these frames playing past every beat its own script plays.
 *
 * THE NUMBERING IS THE PART THAT IS EASY TO GET QUIETLY WRONG, which is why two suites
 * share one composer rather than each appending by hand. `scenario-engine.ts` releases
 * the CONTIGUOUS due prefix of the beats array, so an appended frame has to sit last in
 * tick order as well as last in the array; and `store/session/sequence-reconciler.ts` drops a
 * repeated position as a duplicate and records a skipped one as a gap, so the positions
 * have to continue the script's own line rather than restart it.
 *
 * The ENVELOPE names the scenario's own session, because that is what "this playback was
 * told" means — a frame delivered on another session is a different fixture question and
 * reaches a store through no subscription this one holds. What the PAYLOAD names is the
 * caller's, which is exactly the disagreement one of the two suites is about.
 */
export function scenarioAlsoPlaying(
  scenario: ConsoleScenario,
  frames: readonly AppendedScenarioFrame[],
): ConsoleScenario {
  const lastBeatAtMs = scenario.beats.reduce((latest, beat) => Math.max(latest, beat.atMs), 0);
  const lastSequence = scenario.beats.reduce(
    (highest, beat) => Math.max(highest, beat.event.sequence),
    0,
  );
  return {
    ...scenario,
    beats: [
      ...scenario.beats,
      ...frames.map((frame, frameIndex) => ({
        atMs: lastBeatAtMs + APPENDED_FRAME_STEP_MS * (frameIndex + 1),
        event: {
          id: `${APPENDED_FRAME_EVENT_ID_PREFIX}${String(frameIndex).padStart(12, "0")}`,
          sessionId: scenario.sessionId,
          sequence: lastSequence + 1 + frameIndex,
          kind: frame.kind,
          occurredAt: APPENDED_FRAME_INSTANT_ISO,
          payload: frame.payload,
        },
      })),
    ],
  };
}
