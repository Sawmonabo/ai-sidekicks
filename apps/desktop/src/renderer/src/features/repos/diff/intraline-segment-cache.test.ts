// What the intraline register costs and does when a pair is too long to compare. The claims
// are about work, not output: parsing runs no word diff, materializing a row runs one and a
// second read runs none, the register stays bounded, and an over-bound pair keeps its whole
// line. The library call is counted at the mock, not by a figure the module keeps about itself.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
} from "./caps.js";
import { diffLineText, type DiffModel, type DiffLine } from "./diff-model.js";
import type { DiffLineRow } from "./row-model.js";
import { IntralineSegmentCache } from "./intraline-segment-cache.js";
import { parseUnifiedPatch } from "./patch-parse.js";
import { COMPARED_STATES } from "#test/helpers/patch-parsing.js";

const wordDiffCalls = vi.hoisted(() => vi.fn());

// The real word diff still runs, counted on the way through so the assertions read the
// library's own call count. The mock targets the `./lib/*.js` subpath the module under test
// imports; a mock of the package root would intercept nothing.
vi.mock("diff/lib/diff/word.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("diff/lib/diff/word.js")>();
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

beforeEach(() => {
  wordDiffCalls.mockClear();
});

/** One hunk's worth of prefixed body lines, under a header that counts both sides. */
function modelOf(bodyLines: readonly string[]): DiffModel {
  const baseCount = bodyLines.filter((line) => !line.startsWith("+")).length;
  const headCount = bodyLines.filter((line) => !line.startsWith("-")).length;
  const patchText = [
    "--- one.ts",
    "+++ one.ts",
    `@@ -1,${String(baseCount)} +1,${String(headCount)} @@`,
    ...bodyLines,
    "",
  ].join("\n");
  return parseUnifiedPatch(patchText, COMPARED_STATES);
}

/** A body row of the first hunk of the first file, where every case builds. */
function bodyRow(lineIndex: number): DiffLineRow {
  return { kind: "line", fileIndex: 0, hunkIndex: 0, source: "hunk-body", lineIndex };
}

/** One line of the first hunk of the first file, by its index in the body. */
function bodyLineAt(model: DiffModel, lineIndex: number): DiffLine {
  const line = model.files[0]?.hunks[0]?.lines[lineIndex];
  if (line === undefined) {
    throw new Error(`the patch parsed to no body line at ${String(lineIndex)}`);
  }
  return line;
}

/**
 * A modified pair the word diff splits into three runs, at any length. The padding trails the
 * statement because a padded identifier would be one token and move the assertions.
 */
function modifiedPair(padding: string): readonly string[] {
  return [`-const value = previousBudget;${padding}`, `+const value = nextBudget;${padding}`];
}

const MODIFIED_PAIR_BODY = modifiedPair("");

describe("intraline segmentation — when the word diff runs", () => {
  it("runs none while a patch is parsed", () => {
    // The parser must not segment pairs itself; this patch holds a modified pair, so zero is a
    // decision rather than an absence.
    modelOf(MODIFIED_PAIR_BODY);
    expect(wordDiffCalls).not.toHaveBeenCalled();
  });

  it("runs one when a row is materialized, and none on a second read of that row", () => {
    const cache = new IntralineSegmentCache(modelOf(MODIFIED_PAIR_BODY));
    const first = cache.readingFor(bodyRow(0), 0);
    expect(wordDiffCalls).toHaveBeenCalledTimes(1);
    // A scroll re-renders its window every tick, so this decides whether the window costs one
    // word diff or one per frame.
    const second = cache.readingFor(bodyRow(0), 0);
    expect(second).toBe(first);
    expect(wordDiffCalls).toHaveBeenCalledTimes(1);
  });

  it("serves both rows of one pair from the single comparison that made them", () => {
    // One comparison serves both rows; a register keyed by line would run two.
    const cache = new IntralineSegmentCache(modelOf(MODIFIED_PAIR_BODY));
    const deleted = cache.readingFor(bodyRow(0), 0);
    const inserted = cache.readingFor(bodyRow(1), 1);

    expect(wordDiffCalls).toHaveBeenCalledTimes(1);
    // The two rows are still the two sides of that comparison: a register that served one
    // reading to both would highlight the deleted line's words on the inserted line.
    expect(deleted.segments.filter((segment) => segment.changed)).toStrictEqual([
      { text: "previousBudget", changed: true },
    ]);
    expect(inserted.segments.filter((segment) => segment.changed)).toStrictEqual([
      { text: "nextBudget", changed: true },
    ]);
  });

  it("drops the least recently read reading past the register's cap", () => {
    // Scrolling a large change set end to end must not accumulate a segment list per changed
    // line, so the register must actually evict.
    const pairCount = DIFF_INTRALINE_CACHE_ENTRY_CAP + 1;
    const deletions: string[] = [];
    const insertions: string[] = [];
    for (let ordinal = 0; ordinal < pairCount; ordinal += 1) {
      deletions.push(`-const value${String(ordinal)} = previousBudget;`);
      insertions.push(`+const value${String(ordinal)} = nextBudget;`);
    }
    const cache = new IntralineSegmentCache(modelOf([...deletions, ...insertions]));
    for (let lineIndex = 0; lineIndex < pairCount - 1; lineIndex += 1) {
      cache.readingFor(bodyRow(lineIndex), lineIndex);
    }
    // Read again, so the first pair is now the most recently read rather than the oldest.
    cache.readingFor(bodyRow(0), 0);
    cache.readingFor(bodyRow(pairCount - 1), pairCount - 1);
    expect(wordDiffCalls).toHaveBeenCalledTimes(pairCount);
    // The pair read again is still held, and the least recently read is not.
    cache.readingFor(bodyRow(0), 0);
    expect(wordDiffCalls).toHaveBeenCalledTimes(pairCount);
    cache.readingFor(bodyRow(1), 1);
    expect(wordDiffCalls).toHaveBeenCalledTimes(pairCount + 1);
  });
});

describe("intraline segmentation — what a pair segments to", () => {
  it("reassembles each side to the line it was read for", () => {
    // A reading is a view of the text, not a second copy of it.
    const model = modelOf(MODIFIED_PAIR_BODY);
    const cache = new IntralineSegmentCache(model);
    for (const lineIndex of [0, 1]) {
      const reading = cache.readingFor(bodyRow(lineIndex), lineIndex);
      expect(reading.segments.map((segment) => segment.text).join("")).toBe(
        diffLineText(bodyLineAt(model, lineIndex)),
      );
    }
  });

  it(
    "pairs a longer delete run with a shorter insert run by ordinal " +
      "and leaves the surplus whole",
    () => {
      // The context line after the runs is where a surplus delete paired past its insert run
      // would land, highlighting words against a line it was never replaced by.
      const cache = new IntralineSegmentCache(
        modelOf([
          "-const value = compute(previousBudget, 1);",
          "-const dropped = true;",
          "+const value = compute(nextBudget, 1);",
          " const kept = false;",
        ]),
      );
      expect(
        cache.readingFor(bodyRow(0), 0).segments.filter((segment) => segment.changed),
      ).toStrictEqual([{ text: "previousBudget", changed: true }]);
      expect(cache.readingFor(bodyRow(1), 1)).toStrictEqual({
        segments: [{ text: "const dropped = true;", changed: false }],
      });
    },
  );

  it("leaves a longer insert run's overhang whole", () => {
    const cache = new IntralineSegmentCache(
      modelOf([
        "-const value = compute(previousBudget, 1);",
        "+const value = compute(nextBudget, 1);",
        "+const added = true;",
      ]),
    );
    expect(cache.readingFor(bodyRow(2), 2)).toStrictEqual({
      segments: [{ text: "const added = true;", changed: false }],
    });
  });
});

describe("intraline segmentation — the size bound", () => {
  it("keeps the whole line, uncompared, past the character cap", () => {
    // Against a short partner, so the pair's product is in bounds and only the line cap can
    // decide: one long line against a short one costs the square of the long one.
    const model = modelOf([
      `-const value = previousBudget;${"x".repeat(DIFF_INTRALINE_LINE_CHARACTER_CAP)}`,
      "+const value = nextBudget;",
    ]);
    const deletedText = diffLineText(bodyLineAt(model, 0));
    const insertedText = diffLineText(bodyLineAt(model, 1));
    expect(deletedText.length).toBeGreaterThan(DIFF_INTRALINE_LINE_CHARACTER_CAP);
    expect(deletedText.length * insertedText.length).toBeLessThanOrEqual(
      DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
    );
    const reading = new IntralineSegmentCache(model).readingFor(bodyRow(0), 0);
    // The fallback withholds the highlight, never characters.
    expect(reading.segments).toStrictEqual([{ text: deletedText, changed: false }]);
    expect(wordDiffCalls).not.toHaveBeenCalled();
  });

  it("skips a pair whose product is out of bounds though neither line is", () => {
    // The adopted word diff is O(n·m) in tokens, so two lines each under the per-line cap can
    // still multiply into work no row is worth.
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
    expect(new IntralineSegmentCache(model).readingFor(bodyRow(0), 0).segments).toStrictEqual([
      { text: deletedText, changed: false },
    ]);
    expect(wordDiffCalls).not.toHaveBeenCalled();
  });
});
