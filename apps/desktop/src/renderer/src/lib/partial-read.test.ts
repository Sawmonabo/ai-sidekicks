// A state that is not `served` never renders as complete, and a view holding two readings can
// never show one of them. The set is driven from `READING_STATE_KINDS`, so a state that falls
// through to the "no notice" shape fails here; the sentence and figure checks keep a notice that
// says nothing useful from satisfying it.

import { describe, expect, it } from "vitest";

import {
  READING_STATE_KINDS,
  REFUSAL_SCOPES,
  partialReadNotices,
  readingNoticeFor,
  unreadableDeliveryReading,
  type ReadingState,
} from "./partial-read.js";
import { PARSE_REFUSAL, READING_SUBJECT, STATE_BY_KIND } from "@test/helpers/partial-read.js";

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
    // Guards against a truncated tuple making every assertion below pass over a smaller set.
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
    // A `readingNoticeFor` answering `"none"` for everything or nothing would satisfy only one half
    // of the assertion above.
    expect(readingNoticeFor(STATE_BY_KIND.served, READING_SUBJECT).shape).toBe("none");
    expect(readingNoticeFor(STATE_BY_KIND.refused, READING_SUBJECT).shape).toBe("sentence");
    expect(readingNoticeFor(STATE_BY_KIND.partial, READING_SUBJECT).shape).toBe("counted-sentence");
    expect(readingNoticeFor(STATE_BY_KIND.reading, READING_SUBJECT).shape).toBe("reading");
  });
});

describe("partial-read — a view hands over every reading it holds", () => {
  it("answers a notice per reading that is not the whole of it", () => {
    // A served snapshot beside an unreadable tail must render a notice whichever reading the call
    // site passes.
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
    // Guards against a composition that answers nothing whenever any member served.
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
    // Two arms sharing a sentence would collapse distinct states.
    const sentences = READING_STATE_KINDS.map((kind) => sentenceOf(STATE_BY_KIND[kind])).filter(
      (sentence) => sentence !== "",
    );
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("says something different for a refusal that IS the answer", () => {
    // The sentence "what is shown here is not the whole of it" is false when nothing is shown.
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
    // A cut enumeration is not a refusal; inventing one would show a code no producer sent.
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
    // The two fragment arms carry a required figure, so a copy with nothing leading it is
    // unconstructible.
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
    // One hardcoded plural passes one of these and fails the other.
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
    // `String(n)` yields "1234"; the chokepoint groups. Asserted on both arms that carry a figure.
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
    // `{ kind: "partial", unreadableCount: 0 }` would render "0 deliveries could not be read"; the
    // producer's own call settles that.
    expect(unreadableDeliveryReading(0, undefined)).toStrictEqual({ kind: "served" });
    expect(unreadableDeliveryReading(-1, PARSE_REFUSAL)).toStrictEqual({ kind: "served" });
    expect(unreadableDeliveryReading(1.5, PARSE_REFUSAL)).toStrictEqual({ kind: "served" });
  });

  it("negative control: a real count is a partial reading and keeps its refusal", () => {
    // Guards against a constructor answering `served` for everything.
    expect(unreadableDeliveryReading(2, PARSE_REFUSAL)).toStrictEqual({
      kind: "partial",
      unreadableCount: 2,
      newestRefusal: PARSE_REFUSAL,
    });
  });

  it("negative control: a stale reading and a counted one are not one shape", () => {
    // A `stale` reading differs from a `partial` one; collapsing a flag into a count of one would
    // put a figure on screen the producer never sent.
    const stale = sentenceOf({ kind: "stale", refusal: undefined });
    const counted = sentenceOf(unreadableDeliveryReading(1, undefined));
    expect(stale).not.toBe(counted);
    expect(stale).not.toContain("1 ");
  });
});

describe("partial-read — a coverage gap is counted, and is its own fact", () => {
  it("carries the figure through the chokepoint and agrees on singular and plural", () => {
    const one = readingNoticeFor(
      { kind: "unchecked", uncheckedCount: 1, newestRefusal: undefined },
      READING_SUBJECT,
    );
    const many = readingNoticeFor(
      { kind: "unchecked", uncheckedCount: 1234, newestRefusal: undefined },
      READING_SUBJECT,
    );
    expect(one.shape === "counted-sentence" && one.copy.startsWith("part ")).toBe(true);
    expect(many.shape === "counted-sentence" && many.copy.startsWith("parts ")).toBe(true);
    // `String(n)` yields "1234"; the chokepoint groups.
    expect(many.shape === "counted-sentence" && many.figure).toBe("1,234");
  });

  it("says what no other arm says: the shown answer covers less than was asked", () => {
    // The nearest other arm, a `refused` reading beside an answer, carries no figure, so a view
    // with four unanswered sources could not say how much was missing.
    const coverage = sentenceOf(STATE_BY_KIND.unchecked);
    const besideAnAnswer = sentenceOf(STATE_BY_KIND.refused);
    expect(coverage).toContain("4 ");
    expect(coverage).toContain("covers less than was asked for");
    expect(besideAnAnswer).not.toMatch(/\d/u);
  });

  it("keeps the refusal that named the cause, and carries none where there is none", () => {
    const withRefusal = readingNoticeFor(STATE_BY_KIND.unchecked, READING_SUBJECT);
    expect(withRefusal.shape === "counted-sentence" && withRefusal.refusal).toBe(PARSE_REFUSAL);
    const without = readingNoticeFor(
      { kind: "unchecked", uncheckedCount: 1, newestRefusal: undefined },
      READING_SUBJECT,
    );
    expect(without.shape === "counted-sentence" && without.refusal).toBeUndefined();
  });

  it("negative control: it is not the delivery counter under another name", () => {
    // Guards against reusing `partial`'s sentence, which says the reading is behind its producer, a
    // different claim and false of a source that never answered.
    const coverage = sentenceOf({ kind: "unchecked", uncheckedCount: 3, newestRefusal: undefined });
    const unreadable = sentenceOf(unreadableDeliveryReading(3, undefined));
    expect(coverage).not.toBe(unreadable);
    expect(unreadable).toContain("behind what the background service has sent");
    expect(coverage).not.toContain("behind what the background service has sent");
  });
});

describe("readingNoticeFor — no arm agrees with the subject's number", () => {
  // The subject is a caller-written noun phrase of unknown number ("the queue", "these quotas"),
  // so it must never govern a verb. These tables check that structurally.

  const SINGULAR_SUBJECT = "the queue";
  const PLURAL_SUBJECT = "these quotas";

  /** Verbs that would agree with a singular subject, and so refuse a plural one. */
  const SINGULAR_VERBS: readonly string[] = ["was", "is", "has", "does"];

  /** And the reciprocal, which would refuse a singular subject. */
  const PLURAL_VERBS: readonly string[] = ["were", "are", "have", "do"];

  /**
   * The words after which a verb agrees with an earlier noun this module supplies: in "the read
   * of these quotas was refused" the verb agrees with "read". `before`, `after` and `while` are
   * absent on purpose: they take a clause, so the caller's phrase would govern the verb.
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
    // The other direction: writing the plural verb everywhere would pass a one-sided check.
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
    // Both claims above are empty-list checks; this drives a sentence that does put the subject
    // before a verb, so they cannot pass by looking for nothing.
    const superseded = `read before ${PLURAL_SUBJECT} was cut, so what is not shown here may still exist.`;
    expect(governedPairsIn(superseded, PLURAL_SUBJECT, SINGULAR_VERBS)).toStrictEqual(["was"]);
  });

  it("negative control: a postmodified subject governs nothing, and is admitted", () => {
    // Not a bare search for two adjacent words: `refused` writes "the read of these quotas was
    // refused", correct because the verb agrees with "read".
    const postmodified = `The read of ${PLURAL_SUBJECT} was refused, so none of it is shown here.`;
    expect(postmodified).toContain(`${PLURAL_SUBJECT} was`);
    expect(governedPairsIn(postmodified, PLURAL_SUBJECT, SINGULAR_VERBS)).toStrictEqual([]);
  });

  it("negative control: every arm still names the subject at all", () => {
    // Guards against a repair that drops the subject from the sentence.
    const silent = READING_STATE_KINDS.filter(
      (kind) =>
        kind !== "served" && !wordsOf(STATE_BY_KIND[kind], PLURAL_SUBJECT).includes(PLURAL_SUBJECT),
    );
    expect(silent).toStrictEqual([]);
  });
});
