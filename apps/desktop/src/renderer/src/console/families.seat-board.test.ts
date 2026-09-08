// The composition's own text: its seat block holds nothing but seats, and its header
// states the seat count once.
//
// Split from `families.test.ts`, which asserts what the composition DOES. These cases
// assert what its source SAYS — a different instrument on the same subject, reading the
// board's characters rather than calling it. The seam is where that file's header
// stopped describing what sat under it: the header opens on composition holding, and
// nothing in it is about the text of the board.
//
// The sibling board's census sits in `panes/panes.test.ts` beside its composition cases
// rather than in a file of its own, because that board is composition-only — its whole
// body is seats and it carries no header count to police, so the census is the short
// half there and the long half here. One grammar reads both boards, and it lives in
// `seat-census.test-support.ts`.
//
// Nothing here names a family, a kind, or a seat's fill state, so every branch carries
// this file unchanged.

import { describe, expect, it } from "vitest";

// The seat grammar, shared with `panes/panes.test.ts`: two boards, one reader.
import {
  FAMILY_SEAT_BOARD,
  readSeatBoardCensus,
  reservedSeatLine,
  seatBoardSourceFrom,
} from "./seat-census.test-support.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

// The seat board's own text, inlined at transform time through Vite's raw glob —
// `node:fs` is banned in renderer programs, and this is the form `panes/panes.test.ts`
// established for the sibling seat board's source reads.
const seatBoardSources = import.meta.glob("./families.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The composition root's own source. One entry, keyed by the glob's resolved path.
 *
 * A glob that matched nothing leaves this empty, which the census below reports as
 * `board-not-found` rather than passing over — so the entry count needs no claim of its
 * own here, unlike in `families.test.ts`, where a source read backs a `toContain`.
 */
const seatBoardSource: string = Object.values(seatBoardSources).join("");

describe("console families — the seat block holds nothing but seats", () => {
  // The sibling board is composition-only, so its whole body is seats and anything
  // else in it is an offence. This board composes the shipped families first, with
  // the prose that explains each call, so the grammar governs the run of lines that
  // CLOSES the function — and inside that run the two boards are held to exactly the
  // same rule. What that buys is the property the seats exist for: a paragraph
  // between two seats reads to a branch just like a paragraph above them, and only
  // one of the two leaves seven one-line diffs at seven distinct positions.

  it("reads its own board, in task order, with every seat reserved or filled", () => {
    const census = readSeatBoardCensus(seatBoardSource, FAMILY_SEAT_BOARD);

    expect(census.offences).toStrictEqual([]);
    expect(census.seats.map((seat) => seat.taskOrdinal)).toStrictEqual([
      ...FAMILY_SEAT_BOARD.taskOrdinals,
    ]);
  });

  it("negative control: prose above the block is fine and prose inside it is not", () => {
    // Both halves, because either one alone is the wrong rule. A reader that refused
    // every comment would refuse the paragraphs this composition is largely made of;
    // one that refused none would have nothing to say about the finding this case
    // exists for. The pair is what makes the boundary the claim.
    const seats = FAMILY_SEAT_BOARD.taskOrdinals.map((taskOrdinal) =>
      reservedSeatLine(taskOrdinal, "seat-kind"),
    );
    const composition = [
      "  registerConsolePanes(panes);",
      "  // Prose explaining the call above it, which is where prose belongs.",
    ];

    expect(
      readSeatBoardCensus(
        seatBoardSourceFrom(FAMILY_SEAT_BOARD, seats, composition),
        FAMILY_SEAT_BOARD,
      ).offences,
    ).toStrictEqual([]);

    const interrupted = [
      ...seats.slice(0, 5),
      "  // A paragraph about the seat below it, sitting between two seats.",
      ...seats.slice(5),
    ];

    expect(
      readSeatBoardCensus(
        seatBoardSourceFrom(FAMILY_SEAT_BOARD, interrupted, composition),
        FAMILY_SEAT_BOARD,
      ).offences,
    ).toStrictEqual(["unmarked-line"]);
  });
});

/**
 * Every seat at the foot of the composition, as the task each names.
 *
 * The list a branch replaces one line of, read off the board's own source: nothing in
 * the compiler counts them, so the header's count was kept in step by hand until this
 * case.
 *
 * BOTH STATES OF A SEAT MATCH, which is what makes the count stable as families land.
 * A seat is the task marker, whether it stands alone as the reserved comment or rides
 * the registration that replaced it — the shape `panes/index.ts` already uses. Reading
 * only the reserved form would count seats DOWN as the board fills, so the first
 * family to land would have had to edit the header it was supposed to be held to.
 */
const SEAT_LINE = /^\s*(?:\/\/|[^\n]*;\s*\/\/) T-023p-1C-\d+ [a-z-]+(?: [a-z-]+)*$/gmu;

/**
 * Spelled cardinals, indexed by the number each spells.
 *
 * Spelled rather than numeric because that is how the header writes a count, and
 * the header is what this compares against.
 */
const SPELLED_CARDINALS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** The board's header: everything above the first import, which is its whole prose. */
function seatBoardHeader(): string {
  const firstImport = seatBoardSource.indexOf("\nimport ");
  return firstImport === -1 ? seatBoardSource : seatBoardSource.slice(0, firstImport);
}

/**
 * Every spelled cardinal in a header that names a number other than the seat count.
 *
 * The one home for the rule, read by the claim below and by its control, so a change
 * to what counts as a stray moves both. Values below two are not strays: "one" and
 * "zero" are ordinary English in prose about a single seat or an empty board, and
 * neither reads as a count of families. The seat count's own spelling is not a stray
 * either — repeating it names the same number, which is what the header is for; what
 * the defect looked like was a SECOND, DIFFERENT number standing beside it.
 */
function straySpelledCardinals(header: string, seatCount: number): readonly string[] {
  return SPELLED_CARDINALS.filter(
    (word, value) =>
      value > 1 && value !== seatCount && new RegExp(`\\b${word}\\b`, "iu").test(header),
  );
}

describe("console families — the header states the seat count, once", () => {
  it("spells the number of reserved seats and no other number", () => {
    // The defect this replaces: the header opened with "Seven surface families" and
    // three lines later said six branches produce six diffs at six positions, while
    // seven seats stood below — 1C-8 read as an audit task when it lands a family of
    // its own. Nothing reported the disagreement, because a count in prose is a claim
    // no compiler holds.
    //
    // So the rule is one count in one place, and this is what makes it one: the seat
    // count is DERIVED by counting the lines — reserved and filled alike — the header
    // has to spell that number, and any cardinal in the header naming a DIFFERENT
    // number is an offence.
    const seatCount = [...seatBoardSource.matchAll(SEAT_LINE)].length;
    expect(seatCount).toBe(7);
    const header = seatBoardHeader();
    const spelled = SPELLED_CARDINALS[seatCount];
    expect(header.toLowerCase()).toContain(`${spelled ?? "?"} surface families`);
    expect(straySpelledCardinals(header, seatCount)).toStrictEqual([]);
  });

  it("negative control: a header spelling a second, different count is an offence", () => {
    // Without this the clean result above could come from a predicate that reports
    // nothing at all. It plants the shape the defect actually took — a header opening
    // on one number and naming another three lines down — and drives the SHIPPED
    // predicate the claim above evaluates, so emptying that predicate reddens this
    // case rather than leaving it green over a hand-copied rule.
    //
    // The other direction is planted too, and it is deliberately NOT an offence: the
    // seat count spelled twice is still one number, and a rule that reported it would
    // forbid a header from using its own count in a sentence.
    //
    // The number here is the one the PLANTED headers spell, not a second copy of the
    // board's: the last assertion is the one that reads the real header, and it takes
    // the same derived count the claim above does.
    const plantedSeatCount = 7;
    expect(
      straySpelledCardinals(
        "// Seven surface families, and six branches that build them.",
        plantedSeatCount,
      ),
    ).toStrictEqual(["six"]);
    expect(
      straySpelledCardinals(
        "// Seven surface families. Seven branches, seven diffs.",
        plantedSeatCount,
      ),
    ).toStrictEqual([]);
    expect(
      straySpelledCardinals(seatBoardHeader(), [...seatBoardSource.matchAll(SEAT_LINE)].length),
    ).toStrictEqual([]);
  });
});
