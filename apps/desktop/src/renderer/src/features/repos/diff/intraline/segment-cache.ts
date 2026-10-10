// Word-level highlights are computed when a row is materialized, not at parse time, and are
// memoized per delete/insert pair in a bounded register. Every replaced pair is compared,
// whatever its length: a short pair on the window's own thread, so its marks are in the row's
// first paint, and a long one on the alignment worker, the row drawing its whole-line wash
// until the marks land.

import { DIFF_INTRALINE_CACHE_ENTRY_CAP } from "../caps.js";
import {
  diffLineText,
  wholeLineSegments,
  type DiffModel,
  type DiffIntralineSegment,
} from "../model.js";
import { diffHunkAt, diffLineAt } from "../rows/flat-index.js";
import { pairedLineIndexFor } from "../hunk/row-layout.js";
import type { DiffLineRow, DiffRow } from "../rows/model.js";
import { AlignmentWorker } from "./alignment-worker.js";
import { intralineSegments, type IntralineSegmentPair } from "./word-alignment.js";

/** One line's segmentation: the word-level comparison, or the whole line where there is none. */
export interface IntralineReading {
  readonly segments: readonly DiffIntralineSegment[];
}

/**
 * The intraline segmentations of one diff, computed on demand and held bounded. Keyed per
 * model, not per row index: a gap expansion or view-mode toggle builds a new `DiffRowIndex`
 * without changing any line's text, and must not discard the segmentations. Owns the alignment
 * worker its long pairs start; `dispose` ends it.
 */
export class IntralineSegmentCache {
  readonly #model: DiffModel;
  /**
   * The computed readings, least recently read first. A `Map`, since insertion order is the
   * recency order as long as a read re-inserts (`#remember`). Held on the instance so two
   * open diffs never share one.
   */
  readonly #readingByPair = new Map<string, IntralinePairReading>();
  /** The long pairs sent to the worker whose marks have not landed yet. */
  readonly #pendingPairs = new Set<string>();
  /**
   * When each long pair's marks last landed, as a number that only grows, so a row reads a
   * change by comparing it. Not evicted with the readings: an eviction draws nothing new.
   */
  readonly #landingByPair = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  #landingCount = 0;
  #disposalCount = 0;
  #worker: AlignmentWorker | undefined;
  #failure: Error | undefined;

  /**
   * Which landing of a row's marks it reads: a value that changes when a long pair's marks
   * land, when the worker fails, and when `dispose` drops the alignments in flight. Computes
   * nothing.
   */
  public readonly landingFor = (row: DiffRow): string => {
    if (this.#failure !== undefined) {
      return "failed";
    }
    const landing =
      row.kind === "line"
        ? (this.#landingByPair.get(this.#pairOf(row, row.lineIndex)?.key ?? "") ?? 0)
        : 0;
    return `${String(this.#disposalCount)}:${String(landing)}`;
  };

  /** Be told when any long pair's marks land or the worker fails. Returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  public constructor(model: DiffModel) {
    this.#model = model;
  }

  /**
   * The segmentation of one line a row addresses. A long pair whose marks have not landed reads
   * as its whole line. Throws, as `diffLineAt` does, on an address the model does not hold, and
   * throws the worker's failure once the worker has failed.
   */
  public readingFor(row: DiffLineRow, lineIndex: number): IntralineReading {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    const line = diffLineAt(this.#model, row, lineIndex);
    const pair = this.#pairOf(row, lineIndex);
    if (pair === undefined) {
      // A gap's revealed context or an unpaired line, which a whole-line highlight already
      // says. Not cached; deriving it is one string join.
      return wholeLineReading(diffLineText(line));
    }
    const reading = this.#readingByPair.get(pair.key) ?? this.#computedPair(pair);
    this.#remember(pair.key, reading);
    return line.kind === "delete" ? reading.deleted : reading.inserted;
  }

  /**
   * End the alignment worker, if one was started, and drop the alignments it held. Not terminal:
   * a row read again starts a new worker, so a remount of the same view keeps its marks.
   */
  public dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#pendingPairs.clear();
    this.#disposalCount += 1;
    this.#notify();
  }

  /** The pair a line belongs to, or `undefined` for a line no other line replaced. */
  #pairOf(row: DiffLineRow, lineIndex: number): LinePair | undefined {
    if (row.source === "preceding-context") {
      return undefined;
    }
    const hunk = diffHunkAt(this.#model, row);
    const pairedIndex = pairedLineIndexFor(hunk.lines, lineIndex);
    const paired = pairedIndex === undefined ? undefined : hunk.lines[pairedIndex];
    const line = hunk.lines[lineIndex];
    if (paired === undefined || pairedIndex === undefined || line === undefined) {
      return undefined;
    }
    // The pair's key is the lower index (the delete line's, since a delete run precedes the
    // insert run it pairs with).
    const pairStart = Math.min(lineIndex, pairedIndex);
    return {
      key: `${String(row.fileIndex)}:${String(row.hunkIndex)}:${String(pairStart)}`,
      deletedText: diffLineText(line.kind === "delete" ? line : paired),
      insertedText: diffLineText(line.kind === "delete" ? paired : line),
    };
  }

  /** One pair's comparison, here when it is short, or started on the worker when it is long. */
  #computedPair(pair: LinePair): IntralinePairReading {
    if (pair.deletedText.length + pair.insertedText.length <= WINDOW_THREAD_PAIR_CHARACTERS) {
      // The deleted line is always the first argument so one comparison yields both sides;
      // two comparisons could disagree about which words survived.
      return readingOf(intralineSegments(pair.deletedText, pair.insertedText));
    }
    if (!this.#pendingPairs.has(pair.key)) {
      this.#pendingPairs.add(pair.key);
      this.#worker ??= new AlignmentWorker();
      this.#worker.align(pair.deletedText, pair.insertedText).then(
        (segments) => {
          this.#pendingPairs.delete(pair.key);
          this.#remember(pair.key, readingOf(segments));
          this.#landingCount += 1;
          this.#landingByPair.set(pair.key, this.#landingCount);
          this.#notify();
        },
        (error: unknown) => {
          this.#failure = error instanceof Error ? error : new Error(String(error));
          this.#notify();
        },
      );
    }
    // Not remembered: the marks replace it when they land.
    return {
      deleted: wholeLineReading(pair.deletedText),
      inserted: wholeLineReading(pair.insertedText),
    };
  }

  /** Hold one pair as the most recently read, dropping the oldest past the cap. */
  #remember(key: string, reading: IntralinePairReading): void {
    if (this.#pendingPairs.has(key)) {
      return;
    }
    this.#readingByPair.delete(key);
    this.#readingByPair.set(key, reading);
    if (this.#readingByPair.size > DIFF_INTRALINE_CACHE_ENTRY_CAP) {
      const oldest = this.#readingByPair.keys().next();
      if (!oldest.done) {
        this.#readingByPair.delete(oldest.value);
      }
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * The longest pair, both lines' characters together, compared on the window's own thread. A
 * window of rows this long costs a fraction of a frame; a longer pair goes to the worker so a
 * minified line never holds the frame.
 */
const WINDOW_THREAD_PAIR_CHARACTERS = 1_000;

/** A replaced line and the line that replaced it, keyed by where the pair sits. */
interface LinePair {
  readonly key: string;
  readonly deletedText: string;
  readonly insertedText: string;
}

/**
 * Both sides of one comparison. They are two views of one alignment, so they are held as a
 * pair rather than two register entries that could disagree.
 */
interface IntralinePairReading {
  readonly deleted: IntralineReading;
  readonly inserted: IntralineReading;
}

function readingOf(pair: IntralineSegmentPair): IntralinePairReading {
  return { deleted: { segments: pair.deleted }, inserted: { segments: pair.inserted } };
}

/** One line's own text, unsplit: what a line with no counterpart reads as. */
function wholeLineReading(text: string): IntralineReading {
  return { segments: wholeLineSegments(text) };
}
