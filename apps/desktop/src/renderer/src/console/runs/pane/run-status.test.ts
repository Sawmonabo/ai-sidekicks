// The status vocabulary, driven by the closed sets rather than by a copy of them.
//
// The claims worth a unit are the ones a screenshot cannot make: that the tone
// table answers for EVERY member of the nine-state union, that a lookup which fell
// through would be caught, and — the one this pane exists to get right — that
// waiting is not pausing, in the derivation as well as in the copy.

import { describe, expect, it } from "vitest";
import type { RunState } from "@ai-sidekicks/contracts";

import {
  RUN_STATE_TONES,
  RUN_STATUS_SUBTYPES,
  RUN_TRIGGER_PHRASES,
  isBlockedRunState,
  runStatusSubtypeFor,
  runStatusSubtypeTraits,
} from "./run-status.js";

/**
 * The nine states, taken from the tone table's own keys.
 *
 * Driving the cases off the table rather than off a hand-written list is what
 * makes a tenth state widen these assertions instead of escaping them — and the
 * vacuity guard below is what keeps that honest if the table is ever emptied.
 */
const RUN_STATES = Object.keys(RUN_STATE_TONES) as readonly RunState[];

describe("the nine-member run-state vocabulary", () => {
  it("carries exactly the nine states the contract declares", () => {
    // Without this the whole file could pass over an empty table.
    expect(RUN_STATES).toHaveLength(9);
    expect(RUN_STATES).toContain("failed");
  });

  it("never carries a gloss the enum does not have", () => {
    // `errored` is the specific gloss the design names; a table that grew one
    // would put a state on screen the daemon never reported.
    expect(RUN_STATES).not.toContain("errored" as RunState);
  });

  it("gives every state a tone", () => {
    for (const state of RUN_STATES) {
      expect(RUN_STATE_TONES[state]).toBeTypeOf("string");
    }
  });

  it("negative control: a state the table has no entry for reads as absent", () => {
    // Proves the case above is a fact about the table rather than about `Record`'s
    // index signature answering for anything.
    expect(RUN_STATE_TONES["not-a-state" as RunState]).toBeUndefined();
  });
});

describe("waiting is not pausing", () => {
  it("classifies both waiting states as blocked and paused as not", () => {
    expect(isBlockedRunState("waiting_for_approval")).toBe(true);
    expect(isBlockedRunState("waiting_for_input")).toBe(true);
    expect(isBlockedRunState("paused")).toBe(false);
  });

  it("derives `blocked` on entering a waiting state, never `paused`", () => {
    expect(runStatusSubtypeFor("running", "waiting_for_approval")).toBe("blocked");
    expect(runStatusSubtypeFor("running", "waiting_for_input")).toBe("blocked");
  });

  it("derives `unblocked` when a waiting state resolves", () => {
    expect(runStatusSubtypeFor("waiting_for_approval", "running")).toBe("unblocked");
    expect(runStatusSubtypeFor("waiting_for_input", "running")).toBe("unblocked");
  });

  it("reads the destination before the origin", () => {
    // Leaving `paused` FOR a waiting state is blocked, not resumed: what a person
    // is waiting on is the destination.
    expect(runStatusSubtypeFor("paused", "waiting_for_approval")).toBe("blocked");
  });

  it("derives `paused` and `resumed` on the pause pair", () => {
    expect(runStatusSubtypeFor("running", "paused")).toBe("paused");
    expect(runStatusSubtypeFor("paused", "running")).toBe("resumed");
  });

  it("falls through to `transitioned` for a pair the table names no subtype for", () => {
    expect(runStatusSubtypeFor("queued", "starting")).toBe("transitioned");
    expect(runStatusSubtypeFor("running", "completed")).toBe("transitioned");
  });
});

describe("what each subtype is drawn with", () => {
  it("gives every declared subtype a mark and a phrase", () => {
    expect(RUN_STATUS_SUBTYPES.length).toBeGreaterThan(0);
    for (const subtype of RUN_STATUS_SUBTYPES) {
      const traits = runStatusSubtypeTraits(subtype);
      expect(traits.glyph).toBeTypeOf("string");
      expect(traits.label.length).toBeGreaterThan(0);
    }
  });

  it("negative control: the phrase is not the subtype token", () => {
    // A table that echoed its key would satisfy the case above and would put a
    // wire-shaped token in a place the design reserves for the console's own words.
    for (const subtype of RUN_STATUS_SUBTYPES) {
      expect(runStatusSubtypeTraits(subtype).label).not.toBe(subtype);
    }
  });
});

describe("stop-condition provenance", () => {
  it("names every trigger in words rather than in wire tokens", () => {
    const triggers = Object.keys(RUN_TRIGGER_PHRASES);
    expect(triggers).toHaveLength(5);
    for (const trigger of triggers) {
      const phrase = RUN_TRIGGER_PHRASES[trigger as keyof typeof RUN_TRIGGER_PHRASES];
      expect(phrase.length).toBeGreaterThan(0);
      expect(phrase).not.toContain("_");
    }
  });

  it("negative control: a trigger the table has no phrase for reads as absent", () => {
    expect(
      RUN_TRIGGER_PHRASES["not-a-trigger" as keyof typeof RUN_TRIGGER_PHRASES],
    ).toBeUndefined();
  });
});
