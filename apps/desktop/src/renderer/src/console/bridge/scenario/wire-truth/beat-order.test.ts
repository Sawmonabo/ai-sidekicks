// The ordering leg: where a beat sits in the tick order the clock reaches it in, and
// in the log position the store reconciles against.
//
// Beside the aggregate entry for the reason its sibling run-beat file is: the cases
// drive `findScenarioWireTruthDefects`, which is the surface every scenario is
// measured through. Both halves of the rule are here — the position a script OPENS
// at, which needs a real multi-beat script to be shifted as a whole, and the tick and
// contiguity claims over a beat and the one in front of it.
//
// EVERY CASE IS BUILT FROM A SHIPPED SCRIPT, on the sibling file's precedent: what a
// case varies is the one member it is about, and every other member is one the seat
// board already carries and the predicate already accepts.

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "../first-run.js";
import { FLAGSHIP_SCENARIO } from "../flagship/flagship.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario, ScenarioBeat } from "../runtime/vocabulary.js";

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

describe("scenario wire truth — a beat and the beat in front of it", () => {
  /**
   * The flagship's opening PAIR as a script of its own, each beat revised by index.
   *
   * Two beats is the smallest script the tick and contiguity claims are stated over —
   * both are about a beat and its predecessor — and taking the seat board's own first
   * two means every member a case does not touch is one the predicate already accepts,
   * so a case that reports one defect reports it for the reason the case is about.
   */
  function openingPairScenario(
    scenarioId: string,
    revise: (beat: ScenarioBeat, beatIndex: number) => ScenarioBeat,
  ): ConsoleScenario {
    const openingPair = FLAGSHIP_SCENARIO.beats.slice(0, 2);
    if (openingPair.length < 2) {
      throw new Error(
        "the flagship scenario plays fewer than two beats, so there is no pair to order",
      );
    }
    return { ...FLAGSHIP_SCENARIO, id: scenarioId, beats: openingPair.map(revise) };
  }

  /** One beat, due at a different tick. */
  function dueAt(beat: ScenarioBeat, atMs: number): ScenarioBeat {
    return { ...beat, atMs };
  }

  /** One beat, at a different log position. */
  function atLogPosition(beat: ScenarioBeat, sequence: number): ScenarioBeat {
    return { ...beat, event: { ...beat.event, sequence } };
  }

  it("reports a beat due before the beat in front of it", () => {
    // `beats` is an ordered script and the engine consumes the contiguous prefix that
    // has fallen due, so an entry written behind a later-due one is delivered later
    // than the tick it names — and the screenshot and endurance tiers pin frames by
    // advancing to an exact tick.
    const defects = findScenarioWireTruthDefects([
      openingPairScenario("is-due-out-of-order", (beat, beatIndex) =>
        dueAt(beat, beatIndex === 0 ? 200 : 20),
      ),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("beat 1 ");
    expect(defects[0]?.reason).toContain("before the beat in front of it");
  });

  it("accepts two beats at one tick that still take two log positions", () => {
    // The two claims pulled apart. Sharing a tick is ordinary — an event and the
    // transition it triggers land together, so the tick rule is nondecreasing rather
    // than strictly increasing — and it does NOT make them share a position, so a rule
    // that relaxed contiguity for equal ticks would let the gap below back in through
    // the door this case guards.
    expect(
      findScenarioWireTruthDefects([
        openingPairScenario("shares-one-tick", (beat) => dueAt(beat, 40)),
      ]),
    ).toStrictEqual([]);
  });

  it("reports a beat that skips a log position", () => {
    // Every per-beat parse passes: both positions are ones an event can occupy. What
    // fails is the store, which reconciles `session.subscribe` against the whole log
    // from cursor zero, reads the jump as a real gap, and enters degradation and
    // repair — where it can drop later rows — over a script the author meant as an
    // ordinary session.
    const defects = findScenarioWireTruthDefects([
      openingPairScenario("skips-a-position", (beat, beatIndex) =>
        beatIndex === 1 ? atLogPosition(beat, beat.event.sequence + 1) : beat,
      ),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("beat 1 ");
    expect(defects[0]?.reason).toContain("skips a position");
  });

  it("reports a beat that steps backwards in the log", () => {
    // The other direction, and the louder one: the reconciler reads it as a divergence
    // rather than a gap. Reported separately because the two produce different store
    // behaviour and a scenario author fixes them differently — which is why the two
    // cases assert the two REASONS and not merely that something was reported.
    //
    // Both beats sit at the opening position rather than at the second and the first,
    // so the script still opens where a session's first delivery has to open and the
    // only thing wrong is the second beat's position.
    const openingPosition = FLAGSHIP_SCENARIO.beats[0]?.event.sequence;
    if (openingPosition === undefined) {
      throw new Error("the flagship scenario plays no beats, so it opens at no position");
    }
    const defects = findScenarioWireTruthDefects([
      openingPairScenario("steps-backwards", (beat, beatIndex) =>
        beatIndex === 1 ? atLogPosition(beat, openingPosition) : beat,
      ),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("beat 1 ");
    expect(defects[0]?.reason).toContain("steps backwards");
  });

  it("negative control: the opening pair the seat board ships is clean", () => {
    // Without it every case above would hold over a rule that reported every pair, and
    // no scenario could be scripted at all.
    expect(
      findScenarioWireTruthDefects([openingPairScenario("the-shipped-pair", (beat) => beat)]),
    ).toStrictEqual([]);
  });
});
