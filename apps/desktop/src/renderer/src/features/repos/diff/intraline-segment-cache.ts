// Word-level highlights are computed when a row is materialized, not at parse time (one
// 18,889-character pair in a 5,000-line patch measured 831 ms) and not on a worker, and are
// memoized per delete/insert pair in a bounded register. Past the character caps a row keeps
// its whole-line highlight and reports `skipped`, so a missing highlight never reads as a diff.

import {
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
} from "../diff-caps.js";
import {
  diffLineText,
  wholeLineSegments,
  type DiffModel,
  type DiffIntralineSegment,
  type DiffLine,
} from "./diff-model.js";
import { pairedLineIndexFor } from "./hunk-row-layout.js";
import type { DiffLineRow } from "./diff-row-model.js";
import { intralineSegments } from "./patch-parse.js";

/**
 * One line's segmentation, and whether it is the comparison or the fallback. `skipped` is
 * explicit because a whole-line reading is also what an unpaired or context line produces,
 * and only an over-bound pair is a comparison the console declined to make.
 */
export interface IntralineReading {
  readonly segments: readonly DiffIntralineSegment[];
  readonly skipped: boolean;
}

/**
 * Both sides of one comparison. They are two views of one alignment, so they are held as a
 * pair rather than two register entries that could disagree.
 */
interface IntralinePairReading {
  readonly deleted: IntralineReading;
  readonly inserted: IntralineReading;
}

/** The line a missing address reads as. */
const EMPTY_LINE: DiffLine = { kind: "context", segments: [{ text: "", changed: false }] };

/**
 * The intraline segmentations of one diff, computed on demand and held bounded. Keyed per
 * model, not per row index: a gap expansion or view-mode toggle builds a new `DiffRowIndex`
 * without changing any line's text, and must not discard the segmentations.
 */
export class IntralineSegmentCache {
  readonly #model: DiffModel;
  /**
   * The computed readings, least recently read first. A `Map`, since insertion order is the
   * recency order as long as a read re-inserts (`#remember`). Held on the instance so two
   * open diffs never share one.
   */
  readonly #readingByPair = new Map<string, IntralinePairReading>();
  #computeCount = 0;

  public constructor(model: DiffModel) {
    this.#model = model;
  }

  /**
   * How many word diffs this cache has actually run: one per materialized pair and none at
   * parse time. A renderer that recomputed per scroll tick would grow this while returning
   * identical segments.
   */
  public get computeCount(): number {
    return this.#computeCount;
  }

  /**
   * The segmentation of one line a row addresses. Total: a line at an address this model
   * does not hold reads as the empty line, which is unreachable while the index and model
   * agree.
   */
  public readingFor(row: DiffLineRow, lineIndex: number): IntralineReading {
    const hunk = this.#model.files[row.fileIndex]?.hunks[row.hunkIndex];
    if (hunk === undefined) {
      return wholeLineReading("");
    }
    if (row.source === "preceding-context") {
      // A gap's revealed lines are context, so there is no counterpart and nothing to cache.
      return wholeLineReading(diffLineText(hunk.precedingContext[lineIndex] ?? EMPTY_LINE));
    }
    const line = hunk.lines[lineIndex];
    if (line === undefined) {
      return wholeLineReading("");
    }
    const pairedIndex = pairedLineIndexFor(hunk.lines, lineIndex);
    const text = diffLineText(line);
    const paired = pairedIndex === undefined ? undefined : hunk.lines[pairedIndex];
    if (paired === undefined || pairedIndex === undefined) {
      // Unpaired: a plain addition or removal, which a whole-line highlight already says.
      // Not cached; deriving it is one string join.
      return wholeLineReading(text);
    }
    // The pair's key is the lower index (the delete line's, since a delete run precedes the
    // insert run it pairs with).
    const pairStart = Math.min(lineIndex, pairedIndex);
    const key = `${String(row.fileIndex)}:${String(row.hunkIndex)}:${String(pairStart)}`;
    const remembered = this.#readingByPair.get(key);
    const pair =
      remembered ??
      this.#computedPair(
        line.kind === "delete" ? text : diffLineText(paired),
        line.kind === "delete" ? diffLineText(paired) : text,
      );
    this.#remember(key, pair);
    return line.kind === "delete" ? pair.deleted : pair.inserted;
  }

  /** One pair's comparison, or the fallback where computing it is out of bounds. */
  #computedPair(deletedText: string, insertedText: string): IntralinePairReading {
    if (
      deletedText.length > DIFF_INTRALINE_LINE_CHARACTER_CAP ||
      insertedText.length > DIFF_INTRALINE_LINE_CHARACTER_CAP ||
      deletedText.length * insertedText.length > DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP
    ) {
      return {
        deleted: { segments: wholeLineSegments(deletedText), skipped: true },
        inserted: { segments: wholeLineSegments(insertedText), skipped: true },
      };
    }
    this.#computeCount += 1;
    // The deleted line is always the first argument so one comparison yields both sides;
    // two comparisons could disagree about which words survived.
    const pair = intralineSegments(deletedText, insertedText);
    return {
      deleted: { segments: pair.deleted, skipped: false },
      inserted: { segments: pair.inserted, skipped: false },
    };
  }

  /** Hold one pair as the most recently read, dropping the oldest past the cap. */
  #remember(key: string, reading: IntralinePairReading): void {
    this.#readingByPair.delete(key);
    this.#readingByPair.set(key, reading);
    if (this.#readingByPair.size > DIFF_INTRALINE_CACHE_ENTRY_CAP) {
      const oldest = this.#readingByPair.keys().next();
      if (!oldest.done) {
        this.#readingByPair.delete(oldest.value);
      }
    }
  }
}

/** One line's own text, unsplit: what a line with no counterpart reads as. */
function wholeLineReading(text: string): IntralineReading {
  return { segments: wholeLineSegments(text), skipped: false };
}
