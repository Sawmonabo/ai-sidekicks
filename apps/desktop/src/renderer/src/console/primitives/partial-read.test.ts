// Rule 8's extra step, made countable: a state that is not `served` never renders as
// complete, and a surface holding two readings can never show one of them.
//
// The set is driven from `READING_STATE_KINDS` rather than from hand-listed arms, so
// a state that fell through to the "no notice" shape — the one shape that claims the
// reading is whole — fails here rather than shipping as a silent claim. That is the
// assertion this file exists for; the sentence and figure checks below are what keep
// it from being satisfied by a notice that says nothing useful.

import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import {
  READING_STATE_KINDS,
  REFUSAL_SCOPES,
  behindProducerReading,
  partialReadNotices,
  readingNoticeFor,
  unreadableDeliveryReading,
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
  refused: { kind: "refused", scope: "beside-an-answer", refusal: PARSE_REFUSAL },
  stale: { kind: "stale", refusal: PARSE_REFUSAL },
  partial: { kind: "partial", unreadableCount: 3, newestRefusal: PARSE_REFUSAL },
  cut: { kind: "cut", servedCount: 12 },
};

/** The sentence a notice puts on screen, whichever shape it took. */
function sentenceOf(state: ReadingState): string {
  const notice = readingNoticeFor(state, SUBJECT);
  switch (notice.shape) {
    case "none":
      return "";
    case "reading":
      return notice.title;
    case "sentence":
      return notice.copy;
    case "counted-sentence":
      return `${notice.figure} ${notice.copy}`;
  }
}

describe("partial-read — completeness is claimed by exactly one state", () => {
  it("finds every kind to drive", () => {
    // Without this a truncated tuple would make every assertion below pass over a
    // set smaller than the union it stands for.
    expect(READING_STATE_KINDS.length).toBe(6);
    expect(Object.keys(STATE_BY_KIND).sort()).toStrictEqual([...READING_STATE_KINDS].sort());
  });

  it("renders no notice for a served reading and a notice for every other kind", () => {
    const claimingCompleteness = READING_STATE_KINDS.filter(
      (kind) => readingNoticeFor(STATE_BY_KIND[kind], SUBJECT).shape === "none",
    );
    expect(claimingCompleteness).toStrictEqual(["served"]);
  });

  it("negative control: the predicate distinguishes the shapes at all", () => {
    // A `readingNoticeFor` that answered `"none"` for everything, or for nothing,
    // would satisfy one half of the assertion above and not this one.
    expect(readingNoticeFor(STATE_BY_KIND.served, SUBJECT).shape).toBe("none");
    expect(readingNoticeFor(STATE_BY_KIND.refused, SUBJECT).shape).toBe("sentence");
    expect(readingNoticeFor(STATE_BY_KIND.partial, SUBJECT).shape).toBe("counted-sentence");
    expect(readingNoticeFor(STATE_BY_KIND.reading, SUBJECT).shape).toBe("reading");
  });
});

describe("partial-read — a surface hands over every reading it holds", () => {
  it("answers a notice per reading that is not the whole of it", () => {
    // The defect the composition removes: a queue whose snapshot served and whose
    // tail carried an unreadable delivery used to render one notice or none,
    // depending on which reading the call site happened to pass.
    const notices = partialReadNotices(
      [{ kind: "served" }, STATE_BY_KIND.partial, STATE_BY_KIND.cut],
      SUBJECT,
    );
    expect(notices.length).toBe(2);
    expect(notices.every((notice) => notice.shape !== "none")).toBe(true);
  });

  it("answers nothing only when every reading served", () => {
    expect(partialReadNotices([{ kind: "served" }, { kind: "served" }], SUBJECT)).toStrictEqual([]);
    expect(partialReadNotices([], SUBJECT)).toStrictEqual([]);
  });

  it("negative control: one incomplete reading among served ones still speaks", () => {
    // Without this the emptiness above would also be satisfied by a composition that
    // answered nothing whenever ANY member served, which is the silent claim of
    // completeness this module exists to prevent.
    const notices = partialReadNotices(
      [{ kind: "served" }, STATE_BY_KIND.stale, { kind: "served" }],
      SUBJECT,
    );
    expect(notices.length).toBe(1);
  });
});

describe("partial-read — the sentence set", () => {
  it("names the subject in every arm that has words", () => {
    for (const kind of READING_STATE_KINDS) {
      if (kind === "served") {
        continue;
      }
      expect(
        sentenceOf(STATE_BY_KIND[kind]),
        `the ${kind} sentence does not name what was read`,
      ).toContain(SUBJECT);
    }
  });

  it("gives each arm its own sentence", () => {
    // Two arms sharing a sentence is the collapse rule 8 forbids for absences,
    // applied to the states of an incomplete reading.
    const sentences = READING_STATE_KINDS.map((kind) => sentenceOf(STATE_BY_KIND[kind])).filter(
      (sentence) => sentence !== "",
    );
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("says something different for a refusal that IS the answer", () => {
    // The defect in terms: the one sentence said "what is shown here is not the
    // whole of it", which is false when nothing is shown at all.
    const wholeAnswer = sentenceOf({
      kind: "refused",
      scope: "whole-answer",
      refusal: PARSE_REFUSAL,
    });
    const besideAnAnswer = sentenceOf({
      kind: "refused",
      scope: "beside-an-answer",
      refusal: PARSE_REFUSAL,
    });
    expect(wholeAnswer).not.toBe(besideAnAnswer);
    expect(wholeAnswer).toContain("none of it is shown");
    expect(besideAnAnswer).toContain("not the whole of it");
  });

  it("drives every refusal scope", () => {
    expect(REFUSAL_SCOPES.length).toBe(2);
    const sentences = REFUSAL_SCOPES.map((scope) =>
      sentenceOf({ kind: "refused", scope, refusal: PARSE_REFUSAL }),
    );
    expect(new Set(sentences).size).toBe(REFUSAL_SCOPES.length);
  });

  it("carries the refusal that named the cause, where the state kept one", () => {
    for (const kind of ["refused", "stale", "partial"] as const) {
      const notice = readingNoticeFor(STATE_BY_KIND[kind], SUBJECT);
      expect(
        (notice.shape === "sentence" || notice.shape === "counted-sentence") && notice.refusal,
        `${kind} dropped its refusal`,
      ).toBe(PARSE_REFUSAL);
    }
  });

  it("carries no refusal where the state has none to carry", () => {
    // A cut enumeration is not a refusal: the producer answered and said the answer
    // was short. Inventing a refusal here would put a code on screen no producer sent.
    const cut = readingNoticeFor(STATE_BY_KIND.cut, SUBJECT);
    expect(cut.shape === "counted-sentence" && cut.refusal).toBeUndefined();
    const partialWithoutRefusal = readingNoticeFor(
      { kind: "partial", unreadableCount: 1, newestRefusal: undefined },
      SUBJECT,
    );
    expect(
      partialWithoutRefusal.shape === "counted-sentence" && partialWithoutRefusal.refusal,
    ).toBe(undefined);
  });
});

describe("partial-read — a figure and its sentence are one thing", () => {
  it("gives the figure-first arms a figure that cannot be absent", () => {
    // The shape split in terms: the two arms whose copy is a fragment carry a
    // required figure, so `{ copy: "deliveries could not be read…" }` with nothing
    // leading it is unconstructible rather than merely undisciplined.
    for (const kind of ["partial", "cut"] as const) {
      const notice = readingNoticeFor(STATE_BY_KIND[kind], SUBJECT);
      expect(notice.shape, `${kind} is not a counted sentence`).toBe("counted-sentence");
      expect(notice.shape === "counted-sentence" && notice.figure.length).toBeGreaterThan(0);
    }
  });

  it("gives the whole-sentence arms no figure member at all", () => {
    for (const kind of ["refused", "stale"] as const) {
      const notice = readingNoticeFor(STATE_BY_KIND[kind], SUBJECT);
      expect(notice.shape, `${kind} is not a whole sentence`).toBe("sentence");
      expect(Object.hasOwn(notice, "figure"), `${kind} carries a figure`).toBe(false);
    }
  });

  it("agrees with the count on singular and plural", () => {
    // One hardcoded plural passes one of these and fails the other, which is the
    // whole point of asserting both.
    const one = readingNoticeFor(
      { kind: "partial", unreadableCount: 1, newestRefusal: undefined },
      SUBJECT,
    );
    const two = readingNoticeFor(
      { kind: "partial", unreadableCount: 2, newestRefusal: undefined },
      SUBJECT,
    );
    expect(one.shape === "counted-sentence" && one.copy.startsWith("delivery ")).toBe(true);
    expect(two.shape === "counted-sentence" && two.copy.startsWith("deliveries ")).toBe(true);
  });

  it("formats every count through the figures chokepoint", () => {
    // `String(n)` yields "1234"; the chokepoint groups. Asserted on both arms that
    // carry a figure, because either could have reached for its own conversion.
    const partial = readingNoticeFor(
      { kind: "partial", unreadableCount: 1234, newestRefusal: undefined },
      SUBJECT,
    );
    const cut = readingNoticeFor({ kind: "cut", servedCount: 1234 }, SUBJECT);
    expect(partial.shape === "counted-sentence" && partial.figure).toBe("1,234");
    expect(cut.shape === "counted-sentence" && cut.figure).toBe("1,234");
  });
});

describe("partial-read — the two producer shapes", () => {
  it("reads a count of zero as nothing to report, never as a partial reading", () => {
    // The nonsense notice in terms: `{ kind: "partial", unreadableCount: 0 }`
    // rendered "0 deliveries could not be read", a notice for an absence of anything
    // to notice. The producer's own door is where that is settled.
    expect(unreadableDeliveryReading(0, undefined)).toStrictEqual({ kind: "served" });
    expect(unreadableDeliveryReading(-1, PARSE_REFUSAL)).toStrictEqual({ kind: "served" });
    expect(unreadableDeliveryReading(1.5, PARSE_REFUSAL)).toStrictEqual({ kind: "served" });
  });

  it("negative control: a real count is a partial reading and keeps its refusal", () => {
    // Without this the zero rule above would also be satisfied by a constructor that
    // answered `served` for everything, which is a surface that never says it is short.
    expect(unreadableDeliveryReading(2, PARSE_REFUSAL)).toStrictEqual({
      kind: "partial",
      unreadableCount: 2,
      newestRefusal: PARSE_REFUSAL,
    });
  });

  it("reads a bare flag as stale, which carries no count to be wrong about", () => {
    // The composer's two feeds carry "may be behind what the daemon has sent" as a
    // boolean. Rendered as `partial` it would need a figure nobody sent; rendered as
    // `served` it would claim a completeness the producer just disclaimed.
    expect(behindProducerReading(true, PARSE_REFUSAL)).toStrictEqual({
      kind: "stale",
      refusal: PARSE_REFUSAL,
    });
    expect(behindProducerReading(false, PARSE_REFUSAL)).toStrictEqual({ kind: "served" });
  });

  it("negative control: the two producer shapes are not one shape", () => {
    // A `stale` reading and a `partial` one say different things, and a rebind that
    // collapsed the boolean into a count of one would put a figure on screen the
    // producer never sent.
    const stale = sentenceOf(behindProducerReading(true, undefined));
    const counted = sentenceOf(unreadableDeliveryReading(1, undefined));
    expect(stale).not.toBe(counted);
    expect(stale).not.toContain("1 ");
  });
});
