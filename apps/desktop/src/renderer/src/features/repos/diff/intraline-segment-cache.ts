// Word-level highlights are computed when a row is materialized, not at parse time (one
// 18,889-character pair in a 5,000-line patch measured 831 ms) and not on a worker, and are
// memoized per delete/insert pair in a bounded register. Past the character caps a pair keeps
// its plain whole-line wash and nothing more is said about it.

import {
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
} from "./caps.js";
import {
  diffLineText,
  wholeLineSegments,
  type DiffModel,
  type DiffIntralineSegment,
} from "./diff-model.js";
import { diffHunkAt, diffLineAt } from "./diff-row-index.js";
import { pairedLineIndexFor } from "./hunk/row-layout.js";
import type { DiffLineRow } from "./row-model.js";
import { intralineSegments } from "./patch-parse.js";

/** One line's segmentation: the word-level comparison, or the whole line where there is none. */
export interface IntralineReading {
  readonly segments: readonly DiffIntralineSegment[];
}

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

  public constructor(model: DiffModel) {
    this.#model = model;
  }

  /**
   * The segmentation of one line a row addresses. Throws, as `diffLineAt` does, on an address
   * the model does not hold.
   */
  public readingFor(row: DiffLineRow, lineIndex: number): IntralineReading {
    const line = diffLineAt(this.#model, row, lineIndex);
    if (row.source === "preceding-context") {
      // A gap's revealed lines are context, so there is no counterpart and nothing to cache.
      return wholeLineReading(diffLineText(line));
    }
    const hunk = diffHunkAt(this.#model, row);
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
        deleted: wholeLineReading(deletedText),
        inserted: wholeLineReading(insertedText),
      };
    }
    // The deleted line is always the first argument so one comparison yields both sides;
    // two comparisons could disagree about which words survived.
    const pair = intralineSegments(deletedText, insertedText);
    return {
      deleted: { segments: pair.deleted },
      inserted: { segments: pair.inserted },
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

/**
 * Both sides of one comparison. They are two views of one alignment, so they are held as a
 * pair rather than two register entries that could disagree.
 */
interface IntralinePairReading {
  readonly deleted: IntralineReading;
  readonly inserted: IntralineReading;
}

/** One line's own text, unsplit: what a line with no counterpart reads as. */
function wholeLineReading(text: string): IntralineReading {
  return { segments: wholeLineSegments(text) };
}
