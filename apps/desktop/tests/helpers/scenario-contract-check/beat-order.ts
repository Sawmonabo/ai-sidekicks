// Where a beat sits: in the tick order the clock reaches it in, and in the log position the store
// reads it at.

import type { ScenarioContractDefect } from "./scenario-contract-defect.js";
import { BASE_STATE_CURSOR } from "@renderer/store/session/session-state.js";
import type { Scenario } from "../../../fixtures/scenario.js";

/**
 * The log position a scenario's first beat occupies.
 *
 * One past the position the fixture's session read answers at, derived from `BASE_STATE_CURSOR`:
 * the store's reconciler counts the rows between its re-based cursor and the first delivery it
 * admits, so a scenario opening anywhere else is one whose opening rows the store believes it lost.
 */
const FIRST_LOG_POSITION = BASE_STATE_CURSOR + 1;

/**
 * Beats scripted out of the order the clock reaches them in, or out of the log position the store
 * reads them at.
 *
 * The tick: `beats` is an ordered script, and the engine consumes the contiguous prefix that has
 * fallen due, so an entry whose `atMs` is earlier than the one before it is delivered in a
 * different order than written. Nondecreasing, not strictly increasing, since beats sharing a tick
 * are ordinary and their array order is the order a subscriber receives them. The defect costs a
 * late delivery, but the screenshot and endurance tiers pin frames at an exact tick.
 *
 * The position: `session.subscribe` represents the whole log and the fixture's snapshot starts at
 * cursor zero, so the store's reconciler reads a jump as a gap and a step backwards as a
 * divergence. Either sends it into degradation and repair, where it can drop later rows, while
 * every per-beat schema parse passes. Each `sequence` is therefore its predecessor's plus one,
 * and two beats at one tick still take two positions. The first beat must take the position
 * right after the snapshot's cursor, which contiguity between beats cannot check.
 */
export function findBeatOrderDefects(scenario: Scenario): readonly ScenarioContractDefect[] {
  const defects: ScenarioContractDefect[] = [];
  for (const [beatIndex, beat] of scenario.beats.entries()) {
    const previousBeat = scenario.beats[beatIndex - 1];
    const subject = `beat ${String(beatIndex)} (${beat.event.kind})`;
    if (previousBeat === undefined) {
      if (beat.event.sequence !== FIRST_LOG_POSITION) {
        defects.push({
          scenarioId: scenario.id,
          subject,
          reason:
            `it opens the script at log position ${String(beat.event.sequence)}, and a session's ` +
            `first delivered position is ${String(FIRST_LOG_POSITION)}. The fixture's session read ` +
            "answers at cursor zero and `session.subscribe` represents the whole log, so the store " +
            "counts every position between the two as missing and enters degradation and repair — " +
            "where it can drop later rows — before the second beat is even due. Number the beats " +
            `from ${String(FIRST_LOG_POSITION)}.`,
        });
      }
      continue;
    }
    if (previousBeat.atMs > beat.atMs) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          `it is due at ${String(beat.atMs)}ms, before the beat in front of it at ` +
          `${String(previousBeat.atMs)}ms. The engine consumes beats in array order as the ` +
          "frozen clock reaches them, so this one is delivered later than it is scripted for. " +
          "Order the beats by `atMs`, or change the tick this beat is due at.",
      });
    }
    const expectedSequence = previousBeat.event.sequence + 1;
    if (beat.event.sequence !== expectedSequence) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          `it is at log position ${String(beat.event.sequence)}, and the beat in front of it is ` +
          `at ${String(previousBeat.event.sequence)}, so this script ` +
          `${beat.event.sequence > expectedSequence ? "skips a position" : "steps backwards"}. ` +
          "The store reconciles a subscription against the whole log from cursor zero, so it " +
          "reads that as a real gap or a real divergence, enters degradation and repair, and " +
          `can drop later rows. Number the beats contiguously — this one is ${String(expectedSequence)}.`,
      });
    }
  }
  return defects;
}
