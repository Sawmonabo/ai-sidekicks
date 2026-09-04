// Rule 8's extra step, made countable: a state that is not `served` never renders as
// complete.
//
// The set is driven from `READING_STATE_KINDS` rather than from five hand-listed
// arms, so a sixth state that fell through to the "no notice" shape — the one shape
// that claims the reading is whole — fails here rather than shipping as a silent
// claim. That is the assertion this file exists for; the sentence and figure checks
// below are what keep it from being satisfied by a notice that says nothing useful.

import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import {
  READING_STATE_KINDS,
  partialReadNotice,
  type ReadingState,
  type ReadingStateKind,
} from "./partial-read.js";

const SUBJECT = "the queue";

const PARSE_REFUSAL = refuse(
  "session-queue",
  "delivery-unreadable",
  "A queue delivery did not match the registered row shape.",
);

/**
 * One state per kind, total over the tuple by construction.
 *
 * A record rather than an array so a kind added to `READING_STATE_KINDS` fails to
 * compile here — the vacuity guard below walks the tuple, and a missing entry would
 * otherwise make it walk a shorter set than the one under test.
 */
const STATE_BY_KIND: Readonly<Record<ReadingStateKind, ReadingState>> = {
  served: { kind: "served" },
  reading: { kind: "reading" },
  refused: { kind: "refused", refusal: PARSE_REFUSAL },
  partial: { kind: "partial", unreadableCount: 3, newestRefusal: PARSE_REFUSAL },
  cut: { kind: "cut", servedCount: 12 },
};

describe("partial-read — completeness is claimed by exactly one state", () => {
  it("finds every kind to drive", () => {
    // Without this a truncated tuple would make every assertion below pass over a
    // set smaller than the union it stands for.
    expect(READING_STATE_KINDS.length).toBe(5);
    expect(Object.keys(STATE_BY_KIND).sort()).toStrictEqual([...READING_STATE_KINDS].sort());
  });

  it("renders no notice for a served reading and a notice for every other kind", () => {
    const claimingCompleteness = READING_STATE_KINDS.filter(
      (kind) => partialReadNotice(STATE_BY_KIND[kind], SUBJECT).shape === "none",
    );
    expect(claimingCompleteness).toStrictEqual(["served"]);
  });

  it("negative control: the predicate distinguishes the shapes at all", () => {
    // A `partialReadNotice` that answered `"none"` for everything, or for nothing,
    // would satisfy one half of the assertion above and not this one.
    expect(partialReadNotice(STATE_BY_KIND.served, SUBJECT).shape).toBe("none");
    expect(partialReadNotice(STATE_BY_KIND.refused, SUBJECT).shape).toBe("sentence");
    expect(partialReadNotice(STATE_BY_KIND.reading, SUBJECT).shape).toBe("reading");
  });
});

describe("partial-read — the sentence set", () => {
  it("names the subject in every arm that has words", () => {
    for (const kind of READING_STATE_KINDS) {
      const notice = partialReadNotice(STATE_BY_KIND[kind], SUBJECT);
      if (notice.shape === "none") {
        continue;
      }
      const text = notice.shape === "reading" ? notice.title : notice.copy;
      expect(text, `the ${kind} sentence does not name what was read`).toContain(SUBJECT);
    }
  });

  it("gives each arm its own sentence", () => {
    // Two arms sharing a sentence is the collapse rule 8 forbids for absences,
    // applied to the four states of an incomplete reading.
    const sentences = READING_STATE_KINDS.map((kind) => {
      const notice = partialReadNotice(STATE_BY_KIND[kind], SUBJECT);
      switch (notice.shape) {
        case "none":
          return "";
        case "reading":
          return notice.title;
        case "sentence":
          return notice.copy;
      }
    }).filter((sentence) => sentence !== "");
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("carries the refusal that named the cause, where the state kept one", () => {
    const refused = partialReadNotice(STATE_BY_KIND.refused, SUBJECT);
    const partial = partialReadNotice(STATE_BY_KIND.partial, SUBJECT);
    expect(refused.shape === "sentence" && refused.refusal).toBe(PARSE_REFUSAL);
    expect(partial.shape === "sentence" && partial.refusal).toBe(PARSE_REFUSAL);
  });

  it("carries no refusal where the state has none to carry", () => {
    // A cut enumeration is not a refusal: the producer answered and said the answer
    // was short. Inventing a refusal here would put a code on screen no producer sent.
    const cut = partialReadNotice(STATE_BY_KIND.cut, SUBJECT);
    expect(cut.shape === "sentence" && cut.refusal).toBeUndefined();
    const partialWithoutRefusal = partialReadNotice(
      { kind: "partial", unreadableCount: 1, newestRefusal: undefined },
      SUBJECT,
    );
    expect(partialWithoutRefusal.shape === "sentence" && partialWithoutRefusal.refusal).toBe(
      undefined,
    );
  });
});

describe("partial-read — figures", () => {
  it("agrees with the count on singular and plural", () => {
    // One hardcoded plural passes one of these and fails the other, which is the
    // whole point of asserting both.
    const one = partialReadNotice(
      { kind: "partial", unreadableCount: 1, newestRefusal: undefined },
      SUBJECT,
    );
    const two = partialReadNotice(
      { kind: "partial", unreadableCount: 2, newestRefusal: undefined },
      SUBJECT,
    );
    expect(one.shape === "sentence" && one.copy.startsWith("delivery ")).toBe(true);
    expect(two.shape === "sentence" && two.copy.startsWith("deliveries ")).toBe(true);
  });

  it("formats every count through the figures chokepoint", () => {
    // `String(n)` yields "1234"; the chokepoint groups. Asserted on both arms that
    // carry a figure, because either could have reached for its own conversion.
    const partial = partialReadNotice(
      { kind: "partial", unreadableCount: 1234, newestRefusal: undefined },
      SUBJECT,
    );
    const cut = partialReadNotice({ kind: "cut", servedCount: 1234 }, SUBJECT);
    expect(partial.shape === "sentence" && partial.figure).toBe("1,234");
    expect(cut.shape === "sentence" && cut.figure).toBe("1,234");
  });

  it("gives the wordless arms no figure", () => {
    const refused = partialReadNotice(STATE_BY_KIND.refused, SUBJECT);
    expect(refused.shape === "sentence" && refused.figure).toBeUndefined();
  });
});
