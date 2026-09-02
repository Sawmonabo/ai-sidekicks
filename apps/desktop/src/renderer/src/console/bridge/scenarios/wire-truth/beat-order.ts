// Where a beat sits: in the tick order the clock reaches it in, and in the log
// position the store reads it at.

import type { ScenarioWireTruthDefect } from "./defect.js";
import type { ConsoleScenario } from "../../scenario.js";

/**
 * The log position a scenario's first beat occupies.
 *
 * One past the position the fixture's own session read answers at —
 * `fixture-session-snapshot.ts` establishes every scenario's base state at
 * `BASE_STATE_CURSOR`, which is zero, and the store's reconciler counts the rows
 * between the cursor it was re-based to and the first delivery it admits. So a
 * scenario opening anywhere else is not a scenario numbered differently: it is one
 * whose opening rows the store believes it lost.
 */
const FIRST_LOG_POSITION = 1;

/**
 * Beats scripted out of the order the clock reaches them in, or out of the log
 * position the store reads them at.
 *
 * TWO CLAIMS, ONE WALK, because both are about a beat and the beat in front of it
 * and neither is about anything else.
 *
 * **The tick.** `beats` is an ORDERED script, not a set: the engine advances a
 * frozen clock and consumes the contiguous prefix that has fallen due, so an entry
 * whose `atMs` is earlier than the entry in front of it is a beat the author wrote
 * in one order and the clock delivers in another. Nondecreasing rather than strictly
 * increasing, because beats sharing a tick are ordinary — a session event and the
 * run transition it triggers land together, and their array order is the order they
 * reach a subscriber in. The engine no longer duplicates or drops a beat over this,
 * so the defect costs a late delivery rather than a corrupted stream; it is still
 * reported, because the screenshot and endurance tiers pin frames by advancing to an
 * exact tick.
 *
 * **The position.** `sequence` is the log position, and unlike `atMs` it is not a
 * scheduling convenience the store tolerates: `session.subscribe` represents the
 * whole log, the fixture's snapshot starts at cursor zero, and the store's own
 * reconciler reads a jump as a real GAP and a step backwards as a real DIVERGENCE.
 * Either one puts it into degradation and repair — where it can drop later rows —
 * over a script the author meant as an ordinary session, while every per-beat schema
 * parse passes and this suite stays green. So the rule here is strictly contiguous:
 * each beat's `sequence` is its predecessor's plus one. Two beats at one TICK still
 * take two positions, which is why this claim is not the tick claim relaxed by one.
 *
 * **And the position the FIRST beat takes**, which contiguity alone cannot reach:
 * a rule stated only over a beat and the one in front of it says nothing about the
 * beat that has none, so a script opening at 2 — and a single-beat script opening
 * anywhere at all — passed while the store read the position it never received as a
 * real gap and degraded on the first delivery. The missing half is the same fact the
 * paragraph above already rests on, applied one row earlier: the snapshot answers at
 * cursor zero, so the first row the reconciler admits has to be the one immediately
 * after it. That is a fact about the base state rather than a convention, which is
 * why the constant above carries the module that establishes it.
 *
 * NO INTENT MARKER IS DECLARED, and that is a finding rather than an omission: the
 * two shipped scenarios run 1..8 and 1..1, so nothing in the tree scripts a gap, a
 * regression, or a late opening on purpose and a marker minted here would be a field
 * ahead of its only reader. A family branch whose repair or degradation scenario
 * needs one adds it in the swap that needs it, as a declared per-scenario field this
 * walk reads — never as a silent pass.
 */
export function findBeatOrderDefects(
  scenario: ConsoleScenario,
): readonly ScenarioWireTruthDefect[] {
  const defects: ScenarioWireTruthDefect[] = [];
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
