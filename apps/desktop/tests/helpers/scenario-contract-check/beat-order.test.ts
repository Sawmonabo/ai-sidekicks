// The ordering leg: where a beat sits in the tick order and in the log position the store
// reconciles against.
//
// Cases drive `findScenarioContractDefects`, the one function every scenario is measured through,
// and are built from a shipped script so each varies only the member it is about.

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "../../../fixtures/scenarios/first-run.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../fixtures/scenarios/concurrent-streaming.js";
import { findScenarioContractDefects } from "./contract-check.js";
import type { Scenario, ScenarioBeat } from "../../../fixtures/scenario.js";

describe("scenario wire truth — the log position a scenario opens at", () => {
  /** The concurrent-streaming scenario's beats, every position shifted by the same amount. */
  function scenarioOpeningAt(scenarioId: string, firstPosition: number): Scenario {
    const openingBeat = CONCURRENT_STREAMING_SCENARIO.beats[0];
    if (openingBeat === undefined) {
      throw new Error(
        "the concurrent-streaming scenario plays no beats, so there is nothing to shift",
      );
    }
    const shift = firstPosition - openingBeat.event.sequence;
    return {
      ...CONCURRENT_STREAMING_SCENARIO,
      id: scenarioId,
      beats: CONCURRENT_STREAMING_SCENARIO.beats.map((beat) => ({
        ...beat,
        event: { ...beat.event, sequence: beat.event.sequence + shift },
      })),
    };
  }

  it("reports a single-beat scenario that opens anywhere but the first position", () => {
    // With one beat there is no pair to compare, so a pairwise walk would let a script opening at 2
    // ship green while the store read position 1 as a row it had lost.
    const openingBeat = FIRST_RUN_SCENARIO.beats[0];
    if (openingBeat === undefined) {
      throw new Error("the first-run scenario plays no beats, so there is nothing to shift");
    }
    const defects = findScenarioContractDefects([
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
    // Contiguous throughout, so only the opening is wrong; the defect must name the first beat,
    // since shifting the whole script is the fix.
    const defects = findScenarioContractDefects([scenarioOpeningAt("opens-at-three", 3)]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe("beat 0 (session.created)");
    expect(defects[0]?.reason).toContain("first delivered position is 1");
  });

  it("negative control: the same script opening at the first position is clean", () => {
    // Without it both cases above would hold over a rule that reported every opening beat.
    expect(findScenarioContractDefects([scenarioOpeningAt("opens-at-one", 1)])).toStrictEqual([]);
  });
});

describe("scenario wire truth — a beat and the beat in front of it", () => {
  /**
   * The concurrent-streaming scenario's opening pair as a script of its own, each beat revised by
   * index.
   *
   * Two beats is the smallest script the tick and contiguity claims are about, and the shipped
   * scenario's own first two keep every other member one the predicate already accepts.
   */
  function openingPairScenario(
    scenarioId: string,
    revise: (beat: ScenarioBeat, beatIndex: number) => ScenarioBeat,
  ): Scenario {
    const openingPair = CONCURRENT_STREAMING_SCENARIO.beats.slice(0, 2);
    if (openingPair.length < 2) {
      throw new Error(
        "the concurrent-streaming scenario plays fewer than two beats, so there is no pair to order",
      );
    }
    return { ...CONCURRENT_STREAMING_SCENARIO, id: scenarioId, beats: openingPair.map(revise) };
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
    // The engine consumes the contiguous prefix that has fallen due, so an entry written behind a
    // later-due one is delivered late, and the screenshot and endurance tiers pin an exact tick.
    const defects = findScenarioContractDefects([
      openingPairScenario("is-due-out-of-order", (beat, beatIndex) =>
        dueAt(beat, beatIndex === 0 ? 200 : 20),
      ),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("beat 1 ");
    expect(defects[0]?.reason).toContain("before the beat in front of it");
  });

  it("accepts two beats at one tick that still take two log positions", () => {
    // The two claims pulled apart: sharing a tick is ordinary but does not share a position, and
    // relaxing contiguity for equal ticks would let the gap below back in.
    expect(
      findScenarioContractDefects([
        openingPairScenario("shares-one-tick", (beat) => dueAt(beat, 40)),
      ]),
    ).toStrictEqual([]);
  });

  it("reports a beat that skips a log position", () => {
    // Every per-beat parse passes; the store reads the jump as a real gap and enters degradation
    // and repair, where it can drop later rows.
    const defects = findScenarioContractDefects([
      openingPairScenario("skips-a-position", (beat, beatIndex) =>
        beatIndex === 1 ? atLogPosition(beat, beat.event.sequence + 1) : beat,
      ),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("beat 1 ");
    expect(defects[0]?.reason).toContain("skips a position");
  });

  it("reports a beat that steps backwards in the log", () => {
    // The reconciler reads this as a divergence rather than a gap; the two are fixed differently,
    // so the cases assert the reasons. Both beats sit at the opening position so only the second
    // beat's position is wrong.
    const openingPosition = CONCURRENT_STREAMING_SCENARIO.beats[0]?.event.sequence;
    if (openingPosition === undefined) {
      throw new Error(
        "the concurrent-streaming scenario plays no beats, so it opens at no position",
      );
    }
    const defects = findScenarioContractDefects([
      openingPairScenario("steps-backwards", (beat, beatIndex) =>
        beatIndex === 1 ? atLogPosition(beat, openingPosition) : beat,
      ),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("beat 1 ");
    expect(defects[0]?.reason).toContain("steps backwards");
  });

  it("negative control: the opening pair the shipped scenario carries is clean", () => {
    // Without it every case above would hold over a rule that reported every pair.
    expect(
      findScenarioContractDefects([openingPairScenario("the-shipped-pair", (beat) => beat)]),
    ).toStrictEqual([]);
  });
});
