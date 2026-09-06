// What the intraline register costs, and what it does when a pair is too long to
// compare.
//
// The claims here are the ones the bound exists for, and every one of them is about
// WORK rather than about output: that parsing a patch runs no word diff at all, that
// materialising a row runs exactly one and a second read of that row runs none, that
// the register does not grow without limit, and that a pair past the bounds keeps its
// whole line and SAYS the comparison was declined. The library call is wrapped by the
// mock below so the count is read off the library itself rather than off a figure this
// module keeps about itself — a register that reported one compute and ran ten would
// pass every assertion made from the inside.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
} from "./diff-bounds.js";
import { buildDiffFixture } from "./diff-fixture.test-support.js";
import { SMALL_DIFF_SHAPE } from "./diff-fixture-shapes.test-support.js";
import { diffLineText, type ConsoleDiffModel, type DiffLine } from "./diff-model.js";
import type { DiffLineRow } from "./diff-row-model.js";
import { IntralineSegmentCache } from "./intraline-segments.js";
import { parseUnifiedPatch } from "./patch-parse.js";

const wordDiffCalls = vi.hoisted(() => vi.fn());

// The adopted library, with its one expensive call counted on the way through. The
// real implementation still runs, so every segmentation asserted below is the one the
// console would render rather than a stub's answer.
vi.mock("diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("diff")>();
  return {
    ...actual,
    diffWordsWithSpace: (
      ...parameters: Parameters<typeof actual.diffWordsWithSpace>
    ): ReturnType<typeof actual.diffWordsWithSpace> => {
      wordDiffCalls(...parameters);
      return actual.diffWordsWithSpace(...parameters);
    },
  };
});

const RUN_ATTRIBUTION = { mode: "run_attributed", runId: "run-1" } as const;
const COMPARED_STATES = { baseRef: "main", headRef: "feat/thing" } as const;

beforeEach(() => {
  wordDiffCalls.mockClear();
});

/** One hunk's worth of prefixed body lines, under a header that counts both sides. */
function modelOf(bodyLines: readonly string[]): ConsoleDiffModel {
  const baseCount = bodyLines.filter((line) => !line.startsWith("+")).length;
  const headCount = bodyLines.filter((line) => !line.startsWith("-")).length;
  const patchText = [
    "--- one.ts",
    "+++ one.ts",
    `@@ -1,${String(baseCount)} +1,${String(headCount)} @@`,
    ...bodyLines,
    "",
  ].join("\n");
  return parseUnifiedPatch(patchText, RUN_ATTRIBUTION, COMPARED_STATES);
}

/** A body row of the first hunk of the first file, which is where every case builds. */
function bodyRow(lineIndex: number): DiffLineRow {
  return { kind: "line", fileIndex: 0, hunkIndex: 0, source: "hunk-body", lineIndex };
}

/** One line of the first hunk of the first file, by its index in the body. */
function bodyLineAt(model: ConsoleDiffModel, lineIndex: number): DiffLine {
  const line = model.files[0]?.hunks[0]?.lines[lineIndex];
  if (line === undefined) {
    throw new Error(`the patch parsed to no body line at ${String(lineIndex)}`);
  }
  return line;
}

/**
 * A modified pair the word diff splits into three runs, at whatever length is asked.
 *
 * The padding trails the statement rather than sitting beside the identifier, so
 * lengthening the pair never changes which token the comparison finds — a padded
 * identifier is one token and the assertions would move with the padding.
 */
function modifiedPair(padding: string): readonly string[] {
  return [`-const value = previousBudget;${padding}`, `+const value = nextBudget;${padding}`];
}

const MODIFIED_PAIR_BODY = modifiedPair("");

/**
 * Two modified pairs in one hunk: a delete run of two, then an insert run of two.
 *
 * Pairing is positional within the runs, so body line 0 pairs with 2 and 1 with 3 —
 * which is what lets a case read two lines that are two PAIRS rather than two sides of
 * one, the distinction the register is keyed on.
 */
const TWO_MODIFIED_PAIRS_BODY = [
  "-const first = previousBudget;",
  "-const second = previousCeiling;",
  "+const first = nextBudget;",
  "+const second = nextCeiling;",
];

describe("intraline segmentation — when the word diff runs", () => {
  it("runs none while a patch is parsed", () => {
    // The whole bound: the parser used to segment every pair in the change set
    // before it returned. A modified pair is present in this patch and the register
    // below splits it, so a zero here is a decision rather than an absence.
    modelOf(MODIFIED_PAIR_BODY);
    expect(wordDiffCalls).not.toHaveBeenCalled();
  });

  it("runs one when a row is materialised, and none on a second read of that row", () => {
    const cache = new IntralineSegmentCache(modelOf(MODIFIED_PAIR_BODY));
    const first = cache.readingFor(bodyRow(0), 0);
    expect(wordDiffCalls).toHaveBeenCalledTimes(1);
    expect(cache.computeCount).toBe(1);
    // A scroll re-renders its whole window on every tick, so this is the case that
    // decides whether the window costs one word diff or one per frame.
    const second = cache.readingFor(bodyRow(0), 0);
    expect(second).toBe(first);
    expect(wordDiffCalls).toHaveBeenCalledTimes(1);
    expect(cache.computeCount).toBe(1);
  });

  it("serves both rows of one pair from the single comparison that made them", () => {
    // The register was keyed by LINE, so this read two entries and ran two word diffs
    // over one alignment, each discarding the half it did not need — double the work
    // for every changed pair on screen, and two of the register's entries per pair.
    // This case asserted `computeCount === 2` and passed, which is how it survived.
    const cache = new IntralineSegmentCache(modelOf(MODIFIED_PAIR_BODY));
    const deleted = cache.readingFor(bodyRow(0), 0);
    const inserted = cache.readingFor(bodyRow(1), 1);

    expect(wordDiffCalls).toHaveBeenCalledTimes(1);
    expect(cache.computeCount).toBe(1);
    // And the two rows are still the two SIDES of that comparison: one answer, two
    // readings — a register that served one reading to both would highlight the
    // deleted line's words on the inserted line.
    expect(deleted.segments.filter((segment) => segment.changed)).toStrictEqual([
      { text: "previousBudget", changed: true },
    ]);
    expect(inserted.segments.filter((segment) => segment.changed)).toStrictEqual([
      { text: "nextBudget", changed: true },
    ]);
  });

  it("negative control: a row of a DIFFERENT pair is a second computation", () => {
    // Without this the case above would pass over a register that answered every
    // address with the first reading it ever computed. Body lines 0 and 1 are two
    // delete lines of two different pairs, so nothing here is one alignment.
    const cache = new IntralineSegmentCache(modelOf(TWO_MODIFIED_PAIRS_BODY));
    cache.readingFor(bodyRow(0), 0);
    cache.readingFor(bodyRow(1), 1);
    expect(cache.computeCount).toBe(2);
  });

  it("drops the least recently read reading past the register's cap", () => {
    // A reader who scrolls a large change set end to end must not accumulate one
    // segment list per changed line, so the register is bounded — and a bound that
    // never evicts is not a bound.
    const pairCount = DIFF_INTRALINE_CACHE_ENTRY_CAP + 1;
    const deletions: string[] = [];
    const insertions: string[] = [];
    for (let ordinal = 0; ordinal < pairCount; ordinal += 1) {
      deletions.push(`-const value${String(ordinal)} = previousBudget;`);
      insertions.push(`+const value${String(ordinal)} = nextBudget;`);
    }
    const cache = new IntralineSegmentCache(modelOf([...deletions, ...insertions]));
    for (let lineIndex = 0; lineIndex < pairCount; lineIndex += 1) {
      cache.readingFor(bodyRow(lineIndex), lineIndex);
    }
    expect(cache.computeCount).toBe(pairCount);
    // The most recently read is still held, and the least recently read is not.
    cache.readingFor(bodyRow(pairCount - 1), pairCount - 1);
    expect(cache.computeCount).toBe(pairCount);
    cache.readingFor(bodyRow(0), 0);
    expect(cache.computeCount).toBe(pairCount + 1);
  });

  it("compares nothing for a gap's revealed context line", () => {
    // Revealed context is context by construction, so there is no counterpart to
    // compare it against and nothing to hold.
    const model = buildDiffFixture(SMALL_DIFF_SHAPE);
    const contextLine = model.files[0]?.hunks[0]?.precedingContext[0];
    expect(contextLine).toBeDefined();
    const cache = new IntralineSegmentCache(model);
    const reading = cache.readingFor(
      { kind: "line", fileIndex: 0, hunkIndex: 0, source: "preceding-context", lineIndex: 0 },
      0,
    );
    expect(reading).toStrictEqual({
      segments: [{ text: diffLineText(contextLine as DiffLine), changed: false }],
      skipped: false,
    });
    expect(wordDiffCalls).not.toHaveBeenCalled();
  });
});

describe("intraline segmentation — what a pair segments to", () => {
  it("segments a modified line pair at its word boundaries, on both sides", () => {
    const cache = new IntralineSegmentCache(modelOf(MODIFIED_PAIR_BODY));
    expect(
      cache.readingFor(bodyRow(0), 0).segments.filter((segment) => segment.changed),
    ).toStrictEqual([{ text: "previousBudget", changed: true }]);
    expect(
      cache.readingFor(bodyRow(1), 1).segments.filter((segment) => segment.changed),
    ).toStrictEqual([{ text: "nextBudget", changed: true }]);
  });

  it("reassembles each side to the line it was read for", () => {
    // What makes a reading a view of the text rather than a second copy of it.
    const model = modelOf(MODIFIED_PAIR_BODY);
    const cache = new IntralineSegmentCache(model);
    for (const lineIndex of [0, 1]) {
      const reading = cache.readingFor(bodyRow(lineIndex), lineIndex);
      expect(reading.segments.map((segment) => segment.text).join("")).toBe(
        diffLineText(bodyLineAt(model, lineIndex)),
      );
    }
  });

  it("pairs a longer delete run with a shorter insert run by ordinal and leaves the surplus whole", () => {
    const cache = new IntralineSegmentCache(
      modelOf([
        "-const value = compute(previousBudget, 1);",
        "-const dropped = true;",
        "+const value = compute(nextBudget, 1);",
      ]),
    );
    expect(
      cache.readingFor(bodyRow(0), 0).segments.filter((segment) => segment.changed),
    ).toStrictEqual([{ text: "previousBudget", changed: true }]);
    expect(cache.readingFor(bodyRow(1), 1)).toStrictEqual({
      segments: [{ text: "const dropped = true;", changed: false }],
      skipped: false,
    });
  });

  it("negative control: an unpaired insertion is one unchanged segment and costs no word diff", () => {
    // Without this the segmentation cases would pass over a register that marked
    // every line's whole text as changed. This insertion has no deleted counterpart,
    // so nothing about it is a word-level change.
    const cache = new IntralineSegmentCache(
      modelOf([" const kept = true;", "+const added = true;"]),
    );
    expect(cache.readingFor(bodyRow(1), 1)).toStrictEqual({
      segments: [{ text: "const added = true;", changed: false }],
      skipped: false,
    });
    expect(wordDiffCalls).not.toHaveBeenCalled();
  });
});

describe("intraline segmentation — the size bound", () => {
  it("keeps the whole line and says the comparison was skipped past the character cap", () => {
    const model = modelOf(modifiedPair("x".repeat(DIFF_INTRALINE_LINE_CHARACTER_CAP)));
    const deletedText = diffLineText(bodyLineAt(model, 0));
    expect(deletedText.length).toBeGreaterThan(DIFF_INTRALINE_LINE_CHARACTER_CAP);
    const reading = new IntralineSegmentCache(model).readingFor(bodyRow(0), 0);
    expect(reading.skipped).toBe(true);
    // The line is still whole and still drawn — the fallback withholds the
    // highlight, never characters.
    expect(reading.segments).toStrictEqual([{ text: deletedText, changed: false }]);
    expect(wordDiffCalls).not.toHaveBeenCalled();
  });

  it("negative control: the same pair inside the cap is compared rather than skipped", () => {
    // Without this the fallback case would pass over a register that skipped every
    // pair, which would draw the note on every changed line in the console.
    const cache = new IntralineSegmentCache(modelOf(modifiedPair("x".repeat(16))));
    const reading = cache.readingFor(bodyRow(0), 0);
    expect(reading.skipped).toBe(false);
    expect(reading.segments.filter((segment) => segment.changed)).toStrictEqual([
      { text: "previousBudget", changed: true },
    ]);
  });

  it("skips a pair whose product is out of bounds though neither line is", () => {
    // The product is the bound that matters for cost: the adopted word diff is
    // O(n·m) in tokens, so two lines each comfortably under the per-line cap still
    // multiply into work no row is worth.
    const model = modelOf(
      modifiedPair("x".repeat(Math.ceil(Math.sqrt(DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP)))),
    );
    const deletedText = diffLineText(bodyLineAt(model, 0));
    const insertedText = diffLineText(bodyLineAt(model, 1));
    expect(deletedText.length).toBeLessThanOrEqual(DIFF_INTRALINE_LINE_CHARACTER_CAP);
    expect(insertedText.length).toBeLessThanOrEqual(DIFF_INTRALINE_LINE_CHARACTER_CAP);
    expect(deletedText.length * insertedText.length).toBeGreaterThan(
      DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
    );
    expect(new IntralineSegmentCache(model).readingFor(bodyRow(0), 0).skipped).toBe(true);
    expect(wordDiffCalls).not.toHaveBeenCalled();
  });
});
