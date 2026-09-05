// When a changed line's word-level highlight is computed, and what happens when it is
// too expensive to compute at all.
//
// IT USED TO BE COMPUTED AT PARSE TIME, FOR EVERY PAIRED LINE IN THE CHANGE SET, WITH
// NO BOUND. `parseUnifiedPatch` walked every hunk and ran `diffWordsWithSpace` over
// each delete/insert pair before it returned — so opening a forty-file change set paid
// for five thousand word diffs before the virtualizer had placed a single row, and one
// pathological line paid far more than the rest of the diff put together: a single
// 18,889-character pair inside a 5,000-line patch measured 831 ms on its own
// (2026-09-02), on the main thread, before anything was drawn.
//
// SO IT IS COMPUTED WHEN A ROW IS MATERIALISED, WHICH IS THE ONE MOMENT IT IS NEEDED.
// `hunk-virtualization.ts` answers which rows exist; the virtualizer asks for the ones
// a scroll position needs; the row renderer asks this module for that row's
// segmentation. A diff nobody scrolls to the bottom of never computes the bottom's
// highlights, and a diff nobody opens computes none.
//
// AND NOT ON A WORKER. A worker adds a process, a message copy of the patch in each
// direction, and a second copy of the model to hold the answers — for a computation
// virtualization has already made both lazy and small. The cost this module removes is
// the whole change set's; what is left is one pair per row a person is looking at.
//
// MEMOISED PER PAIR, BOUNDED BOTH WAYS. A scroll re-renders its window on every tick,
// so a row asked for twice must not be computed twice — and a reader who scrolls a
// large change set end to end must not accumulate one segment list per changed line.
// The register below is keyed by hunk and line index and holds
// `DIFF_INTRALINE_CACHE_ENTRY_CAP` entries, dropping the least recently read.
//
// THE SIZE BOUND IS A FALLBACK AND NEVER A FAILURE. Past
// `DIFF_INTRALINE_LINE_CHARACTER_CAP` on either line, or
// `DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP` across the pair, the row keeps its
// whole-line highlight and SAYS the comparison was skipped for size — because a row
// drawn with no highlight and no note is indistinguishable from a row whose two
// versions differ everywhere, which is a diff quietly lying about what changed.
//
// THE MODEL IS THE TEXT'S ONE SOURCE. `DiffLine.segments` carries the line as the
// parser produced it — one whole-line segment — and this module derives a SPLIT of that
// text rather than a second copy of it, so `diffLineText` and every reading here
// reassemble to the same characters.

import {
  DIFF_INTRALINE_CACHE_ENTRY_CAP,
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
} from "./diff-bounds.js";
import {
  diffLineText,
  wholeLineSegments,
  type ConsoleDiffModel,
  type DiffIntralineSegment,
  type DiffLine,
  type DiffLineKind,
} from "./diff-model.js";
import { pairedLineIndexFor } from "./hunk-row-layout.js";
import type { DiffLineRow } from "./diff-row-model.js";
import { intralineSegments } from "./patch-parse.js";

/**
 * One line's segmentation, and whether it is the comparison or the fallback.
 *
 * `skipped` is rendered rather than inferred: a whole-line reading is what an unpaired
 * line, a context line, AND an over-bound pair all produce, and only the last of those
 * is a comparison the console declined to make. A renderer that could not tell them
 * apart would either annotate every context line or annotate none.
 */
export interface IntralineReading {
  readonly segments: readonly DiffIntralineSegment[];
  readonly skipped: boolean;
}

/** The line a missing address reads as. Declared once so no branch builds its own. */
const EMPTY_LINE: DiffLine = { kind: "context", segments: [{ text: "", changed: false }] };

/** One line's own text, unsplit. What a line with no counterpart reads as. */
function wholeLineReading(text: string): IntralineReading {
  return { segments: wholeLineSegments(text), skipped: false };
}

/**
 * The intraline segmentations of one diff, computed on demand and held bounded.
 *
 * PER MODEL AND NOT PER ROW INDEX. A gap expansion and a view-mode toggle both build a
 * new `DiffRowIndex`, and neither changes a single line's text — so a cache tied to the
 * index would be thrown away by an expansion and recomputed for rows that had not
 * moved. It is keyed by the model instead, which is the thing whose change actually
 * invalidates a segmentation.
 */
export class IntralineSegmentCache {
  readonly #model: ConsoleDiffModel;
  /**
   * The computed readings, least recently read first.
   *
   * A `Map` rather than a second ordering structure: insertion order IS the recency
   * order as long as a read re-inserts, which is what `#remember` does. Held on the
   * instance and never at module level, so two diffs open at once cannot share one.
   */
  readonly #readingByPair = new Map<string, IntralineReading>();
  #computeCount = 0;

  public constructor(model: ConsoleDiffModel) {
    this.#model = model;
  }

  /**
   * How many word diffs this cache has actually run.
   *
   * The laziness assertion, not an inference — `DiffRowIndex.bodyLayoutBuildCount`'s
   * rule. A correct cache runs one per materialised pair and none at parse time, and a
   * renderer that recomputed per scroll tick would grow this while handing back
   * identical segments, which no segment-level assertion can see.
   */
  public get computeCount(): number {
    return this.#computeCount;
  }

  /**
   * The segmentation of one line a row addresses.
   *
   * Total: a line at an address this model does not hold reads as the empty line, which
   * is unreachable while the index and the model agree — `DiffRows.tsx` draws a blank
   * row for exactly that disagreement and never reaches this.
   */
  public readingFor(row: DiffLineRow, lineIndex: number): IntralineReading {
    const hunk = this.#model.files[row.fileIndex]?.hunks[row.hunkIndex];
    if (hunk === undefined) {
      return wholeLineReading("");
    }
    if (row.source === "preceding-context") {
      // A gap's revealed lines are context by construction, so there is no counterpart
      // to compare against and nothing to cache.
      return wholeLineReading(diffLineText(hunk.precedingContext[lineIndex] ?? EMPTY_LINE));
    }
    const line = hunk.lines[lineIndex];
    if (line === undefined) {
      return wholeLineReading("");
    }
    const key = `${String(row.fileIndex)}:${String(row.hunkIndex)}:${String(lineIndex)}`;
    const remembered = this.#readingByPair.get(key);
    if (remembered !== undefined) {
      return this.#remember(key, remembered);
    }
    const pairedIndex = pairedLineIndexFor(hunk.lines, lineIndex);
    const paired = pairedIndex === undefined ? undefined : hunk.lines[pairedIndex];
    const text = diffLineText(line);
    if (paired === undefined) {
      // Unpaired: a plain addition or removal, which is what a whole-line highlight
      // already says. Not cached — deriving it is one string join.
      return wholeLineReading(text);
    }
    return this.#remember(key, this.#computed(line.kind, text, diffLineText(paired)));
  }

  /** One pair's comparison, or the fallback where computing it is out of bounds. */
  #computed(kind: DiffLineKind, text: string, pairedText: string): IntralineReading {
    if (
      text.length > DIFF_INTRALINE_LINE_CHARACTER_CAP ||
      pairedText.length > DIFF_INTRALINE_LINE_CHARACTER_CAP ||
      text.length * pairedText.length > DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP
    ) {
      return { segments: wholeLineSegments(text), skipped: true };
    }
    this.#computeCount += 1;
    // ONE COMPARISON ANSWERS BOTH SIDES, which is why the deleted line is always the
    // first argument: the two sides of an intraline diff are two readings of the same
    // alignment, and computing them from two comparisons would let the deleted line's
    // highlight disagree with the inserted line's about which words survived.
    const pair =
      kind === "delete" ? intralineSegments(text, pairedText) : intralineSegments(pairedText, text);
    return { segments: kind === "delete" ? pair.deleted : pair.inserted, skipped: false };
  }

  /** Hold one reading as the most recently read, dropping the oldest past the cap. */
  #remember(key: string, reading: IntralineReading): IntralineReading {
    this.#readingByPair.delete(key);
    this.#readingByPair.set(key, reading);
    if (this.#readingByPair.size > DIFF_INTRALINE_CACHE_ENTRY_CAP) {
      const oldest = this.#readingByPair.keys().next();
      if (!oldest.done) {
        this.#readingByPair.delete(oldest.value);
      }
    }
    return reading;
  }
}
