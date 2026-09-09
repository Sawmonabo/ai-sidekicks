// Rule 8's extra step, made countable: a state that is not `served` never renders as
// complete, and a surface holding two readings can never show one of them.
//
// The set is driven from `READING_STATE_KINDS` rather than from hand-listed arms, so
// a state that fell through to the "no notice" shape — the one shape that claims the
// reading is whole — fails here rather than shipping as a silent claim. That is the
// assertion this file exists for; the sentence and figure checks below are what keep
// it from being satisfied by a notice that says nothing useful.

import { describe, expect, it } from "vitest";

import {
  READING_STATE_KINDS,
  REFUSAL_SCOPES,
  behindProducerReading,
  partialReadNotices,
  readingNoticeFor,
  uncheckedCoverageReading,
  unreadableDeliveryReading,
  type ReadingState,
} from "./partial-read.js";
import { PARSE_REFUSAL, READING_SUBJECT, STATE_BY_KIND } from "./partial-read.test-support.js";

/** The sentence a notice puts on screen, whichever shape it took. */
function sentenceOf(state: ReadingState): string {
  const notice = readingNoticeFor(state, READING_SUBJECT);
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
    expect(READING_STATE_KINDS.length).toBe(7);
    expect(Object.keys(STATE_BY_KIND).sort()).toStrictEqual([...READING_STATE_KINDS].sort());
  });

  it("renders no notice for a served reading and a notice for every other kind", () => {
    const claimingCompleteness = READING_STATE_KINDS.filter(
      (kind) => readingNoticeFor(STATE_BY_KIND[kind], READING_SUBJECT).shape === "none",
    );
    expect(claimingCompleteness).toStrictEqual(["served"]);
  });

  it("negative control: the predicate distinguishes the shapes at all", () => {
    // A `readingNoticeFor` that answered `"none"` for everything, or for nothing,
    // would satisfy one half of the assertion above and not this one.
    expect(readingNoticeFor(STATE_BY_KIND.served, READING_SUBJECT).shape).toBe("none");
    expect(readingNoticeFor(STATE_BY_KIND.refused, READING_SUBJECT).shape).toBe("sentence");
    expect(readingNoticeFor(STATE_BY_KIND.partial, READING_SUBJECT).shape).toBe("counted-sentence");
    expect(readingNoticeFor(STATE_BY_KIND.reading, READING_SUBJECT).shape).toBe("reading");
  });
});

describe("partial-read — a surface hands over every reading it holds", () => {
  it("answers a notice per reading that is not the whole of it", () => {
    // The defect the composition removes: a queue whose snapshot served and whose
    // tail carried an unreadable delivery used to render one notice or none,
    // depending on which reading the call site happened to pass.
    const notices = partialReadNotices(
      [{ kind: "served" }, STATE_BY_KIND.partial, STATE_BY_KIND.cut],
      READING_SUBJECT,
    );
    expect(notices.length).toBe(2);
    expect(notices.every((notice) => notice.shape !== "none")).toBe(true);
  });

  it("answers nothing only when every reading served", () => {
    expect(
      partialReadNotices([{ kind: "served" }, { kind: "served" }], READING_SUBJECT),
    ).toStrictEqual([]);
    expect(partialReadNotices([], READING_SUBJECT)).toStrictEqual([]);
  });

  it("negative control: one incomplete reading among served ones still speaks", () => {
    // Without this the emptiness above would also be satisfied by a composition that
    // answered nothing whenever ANY member served, which is the silent claim of
    // completeness this module exists to prevent.
    const notices = partialReadNotices(
      [{ kind: "served" }, STATE_BY_KIND.stale, { kind: "served" }],
      READING_SUBJECT,
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
      ).toContain(READING_SUBJECT);
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
      const notice = readingNoticeFor(STATE_BY_KIND[kind], READING_SUBJECT);
      expect(
        (notice.shape === "sentence" || notice.shape === "counted-sentence") && notice.refusal,
        `${kind} dropped its refusal`,
      ).toBe(PARSE_REFUSAL);
    }
  });

  it("carries no refusal where the state has none to carry", () => {
    // A cut enumeration is not a refusal: the producer answered and said the answer
    // was short. Inventing a refusal here would put a code on screen no producer sent.
    const cut = readingNoticeFor(STATE_BY_KIND.cut, READING_SUBJECT);
    expect(cut.shape === "counted-sentence" && cut.refusal).toBeUndefined();
    const partialWithoutRefusal = readingNoticeFor(
      { kind: "partial", unreadableCount: 1, newestRefusal: undefined },
      READING_SUBJECT,
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
      const notice = readingNoticeFor(STATE_BY_KIND[kind], READING_SUBJECT);
      expect(notice.shape, `${kind} is not a counted sentence`).toBe("counted-sentence");
      expect(notice.shape === "counted-sentence" && notice.figure.length).toBeGreaterThan(0);
    }
  });

  it("gives the whole-sentence arms no figure member at all", () => {
    for (const kind of ["refused", "stale"] as const) {
      const notice = readingNoticeFor(STATE_BY_KIND[kind], READING_SUBJECT);
      expect(notice.shape, `${kind} is not a whole sentence`).toBe("sentence");
      expect(Object.hasOwn(notice, "figure"), `${kind} carries a figure`).toBe(false);
    }
  });

  it("agrees with the count on singular and plural", () => {
    // One hardcoded plural passes one of these and fails the other, which is the
    // whole point of asserting both.
    const one = readingNoticeFor(
      { kind: "partial", unreadableCount: 1, newestRefusal: undefined },
      READING_SUBJECT,
    );
    const two = readingNoticeFor(
      { kind: "partial", unreadableCount: 2, newestRefusal: undefined },
      READING_SUBJECT,
    );
    expect(one.shape === "counted-sentence" && one.copy.startsWith("delivery ")).toBe(true);
    expect(two.shape === "counted-sentence" && two.copy.startsWith("deliveries ")).toBe(true);
  });

  it("formats every count through the figures chokepoint", () => {
    // `String(n)` yields "1234"; the chokepoint groups. Asserted on both arms that
    // carry a figure, because either could have reached for its own conversion.
    const partial = readingNoticeFor(
      { kind: "partial", unreadableCount: 1234, newestRefusal: undefined },
      READING_SUBJECT,
    );
    const cut = readingNoticeFor({ kind: "cut", servedCount: 1234 }, READING_SUBJECT);
    expect(partial.shape === "counted-sentence" && partial.figure).toBe("1,234");
    expect(cut.shape === "counted-sentence" && cut.figure).toBe("1,234");
  });
});

describe("partial-read — the producer shapes", () => {
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

  it("negative control: the producer shapes are not one shape", () => {
    // A `stale` reading and a `partial` one say different things, and a rebind that
    // collapsed the boolean into a count of one would put a figure on screen the
    // producer never sent.
    const stale = sentenceOf(behindProducerReading(true, undefined));
    const counted = sentenceOf(unreadableDeliveryReading(1, undefined));
    expect(stale).not.toBe(counted);
    expect(stale).not.toContain("1 ");
  });

  it("reads full coverage as served, and a gap as the counted reading it is", () => {
    // The fan-out shape: a read that put its question to several sources and heard
    // back from all of them has nothing to disclaim, and one that did not has a
    // figure to say. Zero is the same rule the delivery counter applies to its own.
    expect(uncheckedCoverageReading(0, undefined)).toStrictEqual({ kind: "served" });
    expect(uncheckedCoverageReading(-1, PARSE_REFUSAL)).toStrictEqual({ kind: "served" });
    expect(uncheckedCoverageReading(2.5, PARSE_REFUSAL)).toStrictEqual({ kind: "served" });
    expect(uncheckedCoverageReading(2, PARSE_REFUSAL)).toStrictEqual({
      kind: "unchecked",
      uncheckedCount: 2,
      newestRefusal: PARSE_REFUSAL,
    });
  });
});

describe("partial-read — a coverage gap is counted, and is its own fact", () => {
  it("carries the figure through the chokepoint and agrees on singular and plural", () => {
    const one = readingNoticeFor(uncheckedCoverageReading(1, undefined), READING_SUBJECT);
    const many = readingNoticeFor(uncheckedCoverageReading(1234, undefined), READING_SUBJECT);
    expect(one.shape === "counted-sentence" && one.copy.startsWith("part ")).toBe(true);
    expect(many.shape === "counted-sentence" && many.copy.startsWith("parts ")).toBe(true);
    // `String(n)` yields "1234"; the chokepoint groups.
    expect(many.shape === "counted-sentence" && many.figure).toBe("1,234");
  });

  it("says what no other arm says: the shown answer covers less than was asked", () => {
    // The gap this arm was minted for. The nearest vocabulary was a `refused` reading
    // beside an answer, whose sentence carries no figure at all — so a surface with
    // four unanswered sources could say that something was missing and never how much.
    const coverage = sentenceOf(STATE_BY_KIND.unchecked);
    const besideAnAnswer = sentenceOf(STATE_BY_KIND.refused);
    expect(coverage).toContain("4 ");
    expect(coverage).toContain("covers less than was asked for");
    expect(besideAnAnswer).not.toMatch(/\d/u);
  });

  it("keeps the refusal that named the cause, and carries none where there is none", () => {
    const withRefusal = readingNoticeFor(STATE_BY_KIND.unchecked, READING_SUBJECT);
    expect(withRefusal.shape === "counted-sentence" && withRefusal.refusal).toBe(PARSE_REFUSAL);
    const without = readingNoticeFor(uncheckedCoverageReading(1, undefined), READING_SUBJECT);
    expect(without.shape === "counted-sentence" && without.refusal).toBeUndefined();
  });

  it("negative control: it is not the delivery counter under another name", () => {
    // Without this the arm would be satisfied by one that reused `partial`'s
    // sentence, which says the reading is BEHIND its producer — a different claim
    // about a different failure, and false of a source that simply never answered.
    const coverage = sentenceOf(uncheckedCoverageReading(3, undefined));
    const unreadable = sentenceOf(unreadableDeliveryReading(3, undefined));
    expect(coverage).not.toBe(unreadable);
    expect(unreadable).toContain("behind what the daemon has sent");
    expect(coverage).not.toContain("behind what the daemon has sent");
  });
});

describe("readingNoticeFor — no arm agrees with the subject's number", () => {
  // The subject is a noun phrase the caller writes and this module never learns
  // whether it is singular or plural — `partial-read.ts` offers "the queue" and
  // "these quotas" as equally valid in the same breath. So an arm that put the
  // subject in front of a verb read correctly for one and ungrammatically for the
  // other, which is what `cut` did: "read before these quotas was cut".
  //
  // Fixing it at the call site would mean a second parameter carrying the verb form,
  // which is the caller writing grammar again — the drift this module exists to
  // remove. So the rule is structural: the subject never governs a verb, and these
  // two tables are how that is checked rather than read.

  const SINGULAR_SUBJECT = "the queue";
  const PLURAL_SUBJECT = "these quotas";

  /** Verbs that would agree with a singular subject, and so refuse a plural one. */
  const SINGULAR_VERBS: readonly string[] = ["was", "is", "has", "does"];

  /** And the reciprocal, which would refuse a singular subject. */
  const PLURAL_VERBS: readonly string[] = ["were", "are", "have", "do"];

  /**
   * The words that make a following verb somebody else's to agree with.
   *
   * `of` and `for` POSTMODIFY the noun in front of them, so in "the read of these
   * quotas was refused" and "the answer for these quotas was cut short" the verb
   * agrees with "read" and with "answer" — nouns this module supplies — and the
   * caller's phrase governs nothing. That is precisely the technique the arms use to
   * stay number-blind, and a check without the distinction would report both correct
   * arms as defects and be switched off inside a week.
   *
   * `before`, `after` and `while` are deliberately absent, and the difference is the
   * whole finding: they take a CLAUSE, so "before these quotas was cut" makes the
   * caller's phrase the clause subject and the verb really does agree with it — which
   * is what the `cut` arm used to write, and what was ungrammatical for two of the
   * three subjects this module's own doc offers.
   */
  const BINDINGS_TO_AN_EARLIER_NOUN: readonly string[] = ["of ", "for "];

  /** Where `subject` governs the verb after it rather than modifying an earlier noun. */
  function governedPairsIn(
    copy: string,
    subject: string,
    verbs: readonly string[],
  ): readonly string[] {
    return verbs.filter((verb) => {
      const at = copy.indexOf(`${subject} ${verb}`);
      if (at < 0) {
        return false;
      }
      const before = copy.slice(0, at);
      return !BINDINGS_TO_AN_EARLIER_NOUN.some((binding) => before.endsWith(binding));
    });
  }

  /** Every word a notice puts on screen for one state, whatever shape it took. */
  function wordsOf(state: ReadingState, subject: string): string {
    const notice = readingNoticeFor(state, subject);
    switch (notice.shape) {
      case "none":
        return "";
      case "reading":
        return notice.title;
      case "sentence":
      case "counted-sentence":
        return notice.copy;
    }
  }

  it("never puts a singular verb straight after a plural subject", () => {
    const offenders = READING_STATE_KINDS.flatMap((kind) =>
      governedPairsIn(
        wordsOf(STATE_BY_KIND[kind], PLURAL_SUBJECT),
        PLURAL_SUBJECT,
        SINGULAR_VERBS,
      ).map((verb) => `${kind}: "${PLURAL_SUBJECT} ${verb}"`),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("never puts a plural verb straight after a singular subject", () => {
    // The other direction, and it is not decoration: the obvious repair for the first
    // claim is to write the plural verb everywhere, which trades one ungrammatical
    // pair for the other and would pass a one-sided check.
    const offenders = READING_STATE_KINDS.flatMap((kind) =>
      governedPairsIn(
        wordsOf(STATE_BY_KIND[kind], SINGULAR_SUBJECT),
        SINGULAR_SUBJECT,
        PLURAL_VERBS,
      ).map((verb) => `${kind}: "${SINGULAR_SUBJECT} ${verb}"`),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the check finds the pairing it is looking for", () => {
    // Both claims above are empty lists, and so is a check whose needle never matches
    // anything. This drives the same reading over the sentence the `cut` arm used to
    // produce, so the two claims cannot pass by looking for nothing.
    const superseded = `read before ${PLURAL_SUBJECT} was cut, so what is not shown here may still exist.`;
    expect(governedPairsIn(superseded, PLURAL_SUBJECT, SINGULAR_VERBS)).toStrictEqual(["was"]);
  });

  it("negative control: a postmodified subject governs nothing, and is admitted", () => {
    // The other half of the reading, and the reason this is not a bare search for two
    // adjacent words. `refused` writes "the read of these quotas was refused", which
    // is correct for every subject because the verb agrees with "read" — the exact
    // pair the first claim looks for, in a sentence that has nothing wrong with it.
    const postmodified = `The read of ${PLURAL_SUBJECT} was refused, so none of it is shown here.`;
    expect(postmodified).toContain(`${PLURAL_SUBJECT} was`);
    expect(governedPairsIn(postmodified, PLURAL_SUBJECT, SINGULAR_VERBS)).toStrictEqual([]);
  });

  it("negative control: every arm still names the subject at all", () => {
    // A repair that dropped the subject from a sentence would satisfy both claims
    // above while making the notice say nothing about what was read.
    const silent = READING_STATE_KINDS.filter(
      (kind) =>
        kind !== "served" && !wordsOf(STATE_BY_KIND[kind], PLURAL_SUBJECT).includes(PLURAL_SUBJECT),
    );
    expect(silent).toStrictEqual([]);
  });
});
