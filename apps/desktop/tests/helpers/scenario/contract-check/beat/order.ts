// Where a beat sits: in the tick order the clock reaches it in, and in the log position the store
// reads it at.

import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/id";

import type { ScenarioContractDefect } from "../defect.js";
import type { Scenario } from "#fixtures/scenario.js";

/**
 * The log position a scenario's first beat occupies: one past the start of the log, where the
 * daemon numbers a session's first event. A scenario opening anywhere else numbers its log unlike
 * the daemon, and a read that resumes inside it would name positions its rows do not hold.
 */
const FIRST_LOG_POSITION = START_OF_LOG_POSITION + 1;

/**
 * Beats scripted out of the order the clock reaches them in, or out of the log position the store
 * reads them at.
 *
 * The tick: `beats` is an ordered script, and the engine consumes the contiguous prefix that has
 * fallen due, so an entry whose `atMs` is earlier than the one before it is delivered in a
 * different order than written. Nondecreasing, not strictly increasing, since beats sharing a tick
 * are ordinary and their array order is the order a subscriber receives them. The defect costs a
 * late delivery, but the endurance tier pins frames at an exact tick.
 *
 * The position: `session.subscribe` represents the whole log, so the store's reconciler reads a
 * jump between two beats as a gap and a step backwards as a divergence. Either sends it into
 * degradation and repair, where it can drop later rows, while every per-beat schema parse passes.
 * Each `sequence` is therefore its predecessor's plus one, and two beats at one tick still take two
 * positions. The first beat must take the daemon's first position, which contiguity between beats
 * cannot check.
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
            `it opens the script at log position ${String(beat.event.sequence)}, and the ` +
            `daemon numbers a session's first event ${String(FIRST_LOG_POSITION)}, one past ` +
            "the start of the log. A read that resumes inside this script names positions its " +
            `rows do not hold. Number the beats from ${String(FIRST_LOG_POSITION)}.`,
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
          "The store reconciles a subscription against the whole log, so it " +
          "reads that as a real gap or a real divergence, enters degradation and repair, and " +
          `can drop later rows. Number the beats contiguously ` +
          `— this one is ${String(expectedSequence)}.`,
      });
    }
  }
  return defects;
}
