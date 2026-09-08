// Six absences, six sentences, and the one that has no figure to give.
//
// Driven from `WINDOW_ABSENCE_KINDS` rather than from hand-listed arms, so a seventh
// narrowing added to a caller's pipeline fails here rather than silently rendering one
// of the six existing sets of words — the defect this vocabulary was lifted out of a
// ledger to prevent, where a row folded into a chapter, a row a replay was holding
// back, and a row the cap had taken were all reported as hidden by a filter.

import { describe, expect, it } from "vitest";

import {
  WINDOW_ABSENCE_KINDS,
  windowAbsenceNotice,
  windowAbsenceNotices,
  type WindowAbsence,
  type WindowAbsenceKind,
} from "./window-absence.js";

const SUBJECT = "entries";

const ABSENCE_BY_KIND: Readonly<Record<WindowAbsenceKind, WindowAbsence>> = {
  unprojectable: { kind: "unprojectable", count: 4 },
  dropped: { kind: "dropped", count: 1200 },
  "withheld-by-replay": { kind: "withheld-by-replay", count: 7 },
  "never-received": { kind: "never-received" },
  "duplicate-key": { kind: "duplicate-key", count: 3 },
  "past-element-ceiling": { kind: "past-element-ceiling", count: 40000 },
};

/** Every arm that reports a figure — the complement of the one that cannot. */
const COUNTED_KINDS: readonly WindowAbsenceKind[] = WINDOW_ABSENCE_KINDS.filter(
  (kind) => kind !== "never-received",
);

describe("window-absence — six ways a window is less than the whole", () => {
  it("finds every kind to drive", () => {
    expect(WINDOW_ABSENCE_KINDS.length).toBe(6);
    expect(Object.keys(ABSENCE_BY_KIND).sort()).toStrictEqual([...WINDOW_ABSENCE_KINDS].sort());
  });

  it("gives each kind its own title and its own second line", () => {
    // The collapse rule 8 forbids, applied to a window's cap: two absences sharing a
    // sentence would tell somebody rows they can scrub back to in one keystroke are
    // gone for good.
    const titles = WINDOW_ABSENCE_KINDS.map(
      (kind) => windowAbsenceNotice(ABSENCE_BY_KIND[kind], SUBJECT).title,
    );
    const details = WINDOW_ABSENCE_KINDS.map(
      (kind) => windowAbsenceNotice(ABSENCE_BY_KIND[kind], SUBJECT).detail,
    );
    expect(new Set(titles).size).toBe(WINDOW_ABSENCE_KINDS.length);
    expect(new Set(details).size).toBe(WINDOW_ABSENCE_KINDS.length);
  });

  it("names what the window holds in every title", () => {
    for (const kind of WINDOW_ABSENCE_KINDS) {
      expect(
        windowAbsenceNotice(ABSENCE_BY_KIND[kind], SUBJECT).title,
        `the ${kind} title does not name what is missing`,
      ).toContain(SUBJECT);
    }
  });

  it("separates this build's limit from the window's cap", () => {
    // An unrecognised type is not a row that left: nothing failed and nothing can be
    // scrolled back to, so it takes the absence kind that means the question was
    // never put rather than the one that means a read came back short.
    expect(windowAbsenceNotice(ABSENCE_BY_KIND.unprojectable, SUBJECT).kind).toBe("not-checked");
    expect(windowAbsenceNotice(ABSENCE_BY_KIND.dropped, SUBJECT).kind).toBe("empty");
  });

  it("takes no absence kind that would drop its own second line", () => {
    // `not-loaded` is a skeleton: it announces its title rather than setting it and
    // renders no detail at all, which is right for a read in flight and wrong for
    // every sentence here — each of which carries the act, or the absence of one, on
    // exactly that line.
    for (const kind of WINDOW_ABSENCE_KINDS) {
      expect(windowAbsenceNotice(ABSENCE_BY_KIND[kind], SUBJECT).kind, kind).not.toBe("not-loaded");
    }
  });

  it("negative control: the kinds are not all one kind", () => {
    // Without this the assertion above would also be satisfied by a table that
    // answered a single absence kind for everything.
    const kinds = WINDOW_ABSENCE_KINDS.map(
      (kind) => windowAbsenceNotice(ABSENCE_BY_KIND[kind], SUBJECT).kind,
    );
    expect(new Set(kinds).size).toBeGreaterThan(1);
  });
});

describe("window-absence — figures, and the arm that has none", () => {
  it("formats every count through the figures chokepoint", () => {
    // `String(n)` yields "1200"; the chokepoint groups.
    expect(windowAbsenceNotice(ABSENCE_BY_KIND.dropped, SUBJECT).detail).toContain("1,200");
  });

  it("says the never-received arm without a figure at all", () => {
    // The asymmetry is the wire's: a window can count the rows it dropped, and what
    // it knows about sequences that never arrived is that it was told of some.
    const notice = windowAbsenceNotice(ABSENCE_BY_KIND["never-received"], SUBJECT);
    expect(/\d/.test(notice.detail)).toBe(false);
    expect(/\d/.test(notice.title)).toBe(false);
  });

  it("negative control: the counted arms do carry digits", () => {
    // Without this the figureless claim above would also be satisfied by a table
    // that dropped every count, which is a window that cannot say how much is gone.
    // Derived as the complement rather than listed, so a seventh counted arm is
    // covered by the set and not by somebody remembering to extend a literal.
    expect(COUNTED_KINDS.length).toBe(WINDOW_ABSENCE_KINDS.length - 1);
    for (const kind of COUNTED_KINDS) {
      expect(/\d/.test(windowAbsenceNotice(ABSENCE_BY_KIND[kind], SUBJECT).detail), kind).toBe(
        true,
      );
    }
  });
});

describe("window-absence — the two the window decided rather than lost", () => {
  it("separates a shared identifier from a row that never arrived", () => {
    // Both are rows a person cannot see and both are the producer's doing, and there
    // the resemblance stops: one row is here and indistinguishable from another, and
    // the other was never delivered at all. Saying either in the other's words tells
    // somebody to re-read a log that already holds what they are looking for.
    const duplicate = windowAbsenceNotice(ABSENCE_BY_KIND["duplicate-key"], SUBJECT);
    expect(duplicate.detail).toContain("carries the same identifier");
    expect(duplicate.detail).not.toContain("read again");
  });

  it("keeps a row past the ceiling reachable, unlike one the cap took", () => {
    // The distinction that decides what a person does next: the cap's rows are gone
    // and its second line says there is nothing to press, while these are still held
    // and two surfaces reach them. Collapsing them would tell somebody rows they can
    // find in one keystroke are gone for good.
    const pastCeiling = windowAbsenceNotice(ABSENCE_BY_KIND["past-element-ceiling"], SUBJECT);
    const dropped = windowAbsenceNotice(ABSENCE_BY_KIND.dropped, SUBJECT);
    expect(pastCeiling.detail).toContain("still held");
    expect(pastCeiling.detail).toContain("Find and the rail reach them.");
    expect(dropped.detail).toContain("nothing to press");
    expect(pastCeiling.title).not.toBe(dropped.title);
  });

  it("negative control: neither new arm borrows the cap's words", () => {
    // Without this the two cases above would also pass over arms that had been given
    // the dropped sentence with a different title, which is the exact collapse this
    // vocabulary exists to prevent.
    for (const kind of ["duplicate-key", "past-element-ceiling"] as const) {
      expect(windowAbsenceNotice(ABSENCE_BY_KIND[kind], SUBJECT).detail, kind).not.toContain(
        "left the window as the session grew",
      );
    }
  });
});

describe("window-absence — whose numbering the gap is in", () => {
  /** A window onto one channel of a session's stream: the caller the member is for. */
  const CHANNEL_SUBJECT = "messages";

  it("names the producer the caller gave, in the sentence's own opening noun", () => {
    const notice = windowAbsenceNotice(
      { kind: "never-received", producer: "session" },
      CHANNEL_SUBJECT,
    );

    expect(notice.detail).toContain("The session numbered messages this window did not receive.");
  });

  it("says the generic noun where no producer is named, unchanged from before", () => {
    // The sentence is one shape, not two: naming the producer replaces this word and
    // adds no clause, which is what lets a caller with one producer keep saying this.
    expect(windowAbsenceNotice({ kind: "never-received" }, CHANNEL_SUBJECT).detail).toContain(
      "The producer numbered messages this window did not receive.",
    );
  });

  it("negative control: a channel-scoped window without it attributes the gap to itself", () => {
    // The defect in terms: with the subject alone, the only stream the sentence can
    // name is the pane's own. Both spellings are asserted to differ, so the case
    // above is about the member and not about a sentence that reads the same either
    // way.
    const named = windowAbsenceNotice(
      { kind: "never-received", producer: "session" },
      CHANNEL_SUBJECT,
    ).detail;
    const unnamed = windowAbsenceNotice({ kind: "never-received" }, CHANNEL_SUBJECT).detail;

    expect(named).not.toBe(unnamed);
    expect(unnamed).not.toContain("session");
  });

  it("falls back rather than opening a hole in the sentence for a blank name", () => {
    // A caller that resolved its producer to nothing and passed the result anyway:
    // an unnamed producer and one named "   " are the same fact, and the second must
    // not render as "The  numbered".
    for (const blank of ["", "   "]) {
      expect(
        windowAbsenceNotice({ kind: "never-received", producer: blank }, CHANNEL_SUBJECT).detail,
        JSON.stringify(blank),
      ).toContain("The producer numbered messages");
    }
  });

  it("negative control: a named producer is not trimmed away with the blanks", () => {
    // Without this the fallback above would also be satisfied by an arm that ignored
    // the member entirely, which is the state this case exists to leave.
    expect(
      windowAbsenceNotice({ kind: "never-received", producer: "  relay  " }, CHANNEL_SUBJECT)
        .detail,
    ).toContain("The relay numbered messages");
  });
});

describe("window-absence — what there is to say", () => {
  it("says nothing about a counted absence of zero", () => {
    expect(
      windowAbsenceNotices(
        [
          { kind: "dropped", count: 0 },
          { kind: "withheld-by-replay", count: 0 },
          { kind: "unprojectable", count: 0 },
        ],
        SUBJECT,
      ),
    ).toStrictEqual([]);
  });

  it("says every absence a window really has, in the caller's order", () => {
    const notices = windowAbsenceNotices(
      [
        { kind: "dropped", count: 0 },
        ABSENCE_BY_KIND["withheld-by-replay"],
        { kind: "never-received" },
      ],
      SUBJECT,
    );
    expect(notices.map((notice) => notice.title)).toStrictEqual([
      windowAbsenceNotice(ABSENCE_BY_KIND["withheld-by-replay"], SUBJECT).title,
      windowAbsenceNotice(ABSENCE_BY_KIND["never-received"], SUBJECT).title,
    ]);
  });

  it("negative control: the countless arm is not filtered out with the zeros", () => {
    // `never-received` carries no count, so a filter written on a `count > 0` member
    // alone would silently drop the one absence that cannot report a size.
    expect(windowAbsenceNotices([{ kind: "never-received" }], SUBJECT).length).toBe(1);
  });
});
