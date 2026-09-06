// The ordering leg: where a beat sits in the log the store reconciles against.
//
// Beside the aggregate entry for the reason its sibling run-beat file is: the cases
// drive `findScenarioWireTruthDefects`, which is the surface every scenario is
// measured through. The tick half of the same rule is covered by the architecture
// tier's own controls, which pin exact defect counts over synthetic scenarios; what
// is here is the half those controls could not carry — the position a script OPENS
// at, which needs a real multi-beat script to be shifted as a whole.

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "./first-run.js";
import { FLAGSHIP_SCENARIO } from "./flagship.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario } from "../scenario-runtime/scenario.js";

describe("scenario wire truth — the log position a scenario opens at", () => {
  /** The flagship's beats, every position shifted by the same amount. */
  function scenarioOpeningAt(scenarioId: string, firstPosition: number): ConsoleScenario {
    const openingBeat = FLAGSHIP_SCENARIO.beats[0];
    if (openingBeat === undefined) {
      throw new Error("the flagship scenario plays no beats, so there is nothing to shift");
    }
    const shift = firstPosition - openingBeat.event.sequence;
    return {
      ...FLAGSHIP_SCENARIO,
      id: scenarioId,
      beats: FLAGSHIP_SCENARIO.beats.map((beat) => ({
        ...beat,
        event: { ...beat.event, sequence: beat.event.sequence + shift },
      })),
    };
  }

  it("reports a single-beat scenario that opens anywhere but the first position", () => {
    // The case contiguity could never reach: with one beat there is no pair to
    // compare, so the old walk skipped it entirely and a script opening at 2 shipped
    // green while the store read position 1 as a row it had lost.
    const openingBeat = FIRST_RUN_SCENARIO.beats[0];
    if (openingBeat === undefined) {
      throw new Error("the first-run scenario plays no beats, so there is nothing to shift");
    }
    const defects = findScenarioWireTruthDefects([
      {
        ...FIRST_RUN_SCENARIO,
        id: "opens-at-two-with-one-beat",
        beats: [{ ...openingBeat, event: { ...openingBeat.event, sequence: 2 } }],
      },
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe("beat 0 (session.created)");
    expect(defects[0]?.reason).toContain("opens the script at log position 2");
  });

  it("reports a contiguous multi-beat scenario that starts late, naming its first beat", () => {
    // Contiguous throughout, so every pair-wise check passes and the only thing
    // wrong is where the run begins — which is the subject the defect has to name,
    // because shifting the whole script is the fix and beat 1 is not the culprit.
    const defects = findScenarioWireTruthDefects([scenarioOpeningAt("opens-at-three", 3)]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe("beat 0 (session.created)");
    expect(defects[0]?.reason).toContain("first delivered position is 1");
  });

  it("negative control: the same script opening at the first position is clean", () => {
    // Without it both cases above would hold over a rule that reported every opening
    // beat, and no scenario could be scripted at all. The shift is a no-op here, so
    // what is measured is the position and nothing else about the beats.
    expect(findScenarioWireTruthDefects([scenarioOpeningAt("opens-at-one", 1)])).toStrictEqual([]);
  });
});
