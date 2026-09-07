// The reasoning model: the tail's window, the arm sentences, and the run scoping.

import { describe, expect, it } from "vitest";

import { REASONING_AVAILABILITY_STATES } from "@ai-sidekicks/contracts";

import { sampleGeneralRow, sampleRunRow } from "../row-samples.test-support.js";
import {
  REASONING_ARM_COPY,
  REASONING_TAIL_LINE_COUNT,
  reasoningRunIdOf,
  reasoningTailOf,
} from "./reasoning-surface.js";

describe("reasoningTailOf", () => {
  it("takes the newest lines and not the first ones", () => {
    expect(reasoningTailOf("one\ntwo\nthree\nfour\nfive")).toEqual(["three", "four", "five"]);
  });

  it("never returns more lines than the density budget allows", () => {
    const text = Array.from({ length: 40 }, (_unused, index) => `line ${index}`).join("\n");
    expect(reasoningTailOf(text)).toHaveLength(REASONING_TAIL_LINE_COUNT);
  });

  it("spends no slot on a blank line", () => {
    expect(reasoningTailOf("alpha\n\n\nbeta\n\ngamma\n")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("trims a partially arrived line rather than rendering it ragged", () => {
    expect(reasoningTailOf("still typing   ")).toEqual(["still typing"]);
  });

  it("has nothing to show for text that is only whitespace", () => {
    expect(reasoningTailOf("\n  \n\t\n")).toEqual([]);
  });
});

describe("REASONING_ARM_COPY", () => {
  it("carries a sentence for every arm the contract declares", () => {
    for (const availability of REASONING_AVAILABILITY_STATES) {
      expect(REASONING_ARM_COPY[availability].title.length).toBeGreaterThan(0);
    }
  });

  // THE NEGATIVE CONTROL for the one defect the four-arm discriminant exists to
  // prevent: three of these arms carry no entries, so if any two said the same thing
  // a reader could not tell "nothing was captured" from "it was captured and is being
  // withheld". Comparing the whole set by size is what makes that checkable rather
  // than eyeballed — two arms sharing a sentence collapses the set and fails here.
  it("says something different for every arm", () => {
    const sentences = new Set(
      REASONING_AVAILABILITY_STATES.map((availability) => REASONING_ARM_COPY[availability].title),
    );
    expect(sentences.size).toBe(REASONING_AVAILABILITY_STATES.length);
  });

  it("never says a withheld surface is an absent one", () => {
    expect(REASONING_ARM_COPY.policy_redacted.title).not.toBe(REASONING_ARM_COPY.unavailable.title);
    expect(REASONING_ARM_COPY.compacted.title).not.toBe(REASONING_ARM_COPY.unavailable.title);
  });
});

describe("reasoningRunIdOf", () => {
  it("answers the run a row is attributed to", () => {
    expect(reasoningRunIdOf(sampleRunRow())).toBe("01J0000000000000000000000B");
  });

  it("answers none for a row the run-scoped read could not address", () => {
    expect(reasoningRunIdOf(sampleGeneralRow())).toBeUndefined();
  });
});
