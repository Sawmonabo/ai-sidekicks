// Word-level highlights are computed when a row is materialized, not at parse time, and are
// memoized per delete/insert pair in a bounded register. Every replaced pair is compared,
// whatever its length: a short pair on the window's own thread, so its marks are in the row's
// first paint, and a long one on the window's alignment worker, the row drawing its whole-line
// wash until the marks land. A long pair the worker fails on draws its whole line.

import { DIFF_INTRALINE_CACHE_ENTRY_CAP } from "../caps.js";
import {
  diffLineText,
  wholeLineSegments,
  type DiffHunk,
  type DiffModel,
  type DiffIntralineSegment,
} from "../model.js";
import { diffHunkAt, diffLineAt } from "../rows/flat-index.js";
import { hunkLinePartners } from "../hunk/row-layout.js";
import type { DiffLineRow, DiffRow } from "../rows/model.js";
import type { AlignmentWorker } from "./worker/handle.js";
import { intralineSegments, type IntralineSegmentPair } from "./word-alignment.js";

/** One line's segmentation: the word-level comparison, or the whole line where there is none. */
export interface IntralineReading {
  readonly segments: readonly DiffIntralineSegment[];
}

/**
 * The intraline segmentations of one diff, computed on demand and held bounded. Keyed per
 * model, not per row index: a gap expansion or view-mode toggle builds a new `DiffRowIndex`
 * without changing any line's text, and must not discard the segmentations. Its long pairs go to
 * the window's alignment worker; `dispose` drops the ones still there.
 */
export class IntralineSegmentCache {
  readonly #model: DiffModel;
  readonly #alignmentWorker: AlignmentWorker;
  /**
   * The computed readings, least recently read first. A `Map`, since insertion order is the
   * recency order as long as a read re-inserts (`#remember`). Held on the instance so two
   * open diffs never share one.
   */
  readonly #readingByPair = new Map<string, IntralinePairReading>();
  /** Each hunk's line partners, built in one walk the first time one of its rows is read. */
  readonly #partnersByHunk = new Map<DiffHunk, Int32Array>();
  /** The long pairs on the worker whose marks have not landed yet, by key. */
  readonly #pendingPairs = new Map<string, LinePair>();
  /** The long pairs the worker failed on, which draw their whole lines from then on. */
  readonly #failedPairs = new Set<string>();
  /**
   * When each long pair's marks last changed (they landed, the worker failed on it, or `dispose`
   * dropped it), by hunk and by the pair's first line, as a number that only grows, so a row reads
   * a change by comparing it. Not evicted with the readings: an eviction draws nothing new.
   */
  readonly #landingByPair = new Map<DiffHunk, Map<number, number>>();
  readonly #listeners = new Set<() => void>();
  #landingCount = 0;
  #pairsInFlight = new AbortController();

  /**
   * Which landing of a row's marks it reads: a value that changes when its pair's marks land, when
   * the worker fails on its pair, and when `dispose` drops its pair in flight. Map lookups only.
   */
  public readonly landingFor = (row: DiffRow): number => {
    if (row.kind !== "line" || row.source === "preceding-context") {
      return 0;
    }
    const hunk = diffHunkAt(this.#model, row);
    const partner = this.#partnersOf(hunk)[row.lineIndex] ?? -1;
    return partner < 0
      ? 0
      : (this.#landingByPair.get(hunk)?.get(Math.min(row.lineIndex, partner)) ?? 0);
  };

  /** Be told when any long pair's marks change. Returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  public constructor(model: DiffModel, alignmentWorker: AlignmentWorker) {
    this.#model = model;
    this.#alignmentWorker = alignmentWorker;
  }

  /**
   * The segmentation of one line a row addresses. A long pair whose marks have not landed, or
   * that the worker failed on, reads as its whole line. Throws, as `diffLineAt` does, on an
   * address the model does not hold.
   */
  public readingFor(row: DiffLineRow, lineIndex: number): IntralineReading {
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
   * Drop the pairs still on the worker, so it ends once no other diff has one there. Not terminal:
   * a row read again asks for its pair again, so a remount of the same view keeps its marks.
   */
  public dispose(): void {
    this.#pairsInFlight.abort();
    this.#pairsInFlight = new AbortController();
    for (const pair of this.#pendingPairs.values()) {
      this.#markLanded(pair.hunk, pair.pairStart);
    }
    this.#pendingPairs.clear();
    this.#notify();
  }

  /** The pair a line belongs to, or `undefined` for a line no other line replaced. */
  #pairOf(row: DiffLineRow, lineIndex: number): LinePair | undefined {
    if (row.source === "preceding-context") {
      return undefined;
    }
    const hunk = diffHunkAt(this.#model, row);
    const pairedIndex = this.#partnersOf(hunk)[lineIndex] ?? -1;
    const paired = hunk.lines[pairedIndex];
    const line = hunk.lines[lineIndex];
    if (pairedIndex < 0 || paired === undefined || line === undefined) {
      return undefined;
    }
    // The pair's first line is the delete line's, since a delete run precedes the insert run it
    // pairs with.
    const pairStart = Math.min(lineIndex, pairedIndex);
    return {
      key: `${String(row.fileIndex)}:${String(row.hunkIndex)}:${String(pairStart)}`,
      hunk,
      pairStart,
      deletedText: diffLineText(line.kind === "delete" ? line : paired),
      insertedText: diffLineText(line.kind === "delete" ? paired : line),
    };
  }

  #partnersOf(hunk: DiffHunk): Int32Array {
    let partners = this.#partnersByHunk.get(hunk);
    if (partners === undefined) {
      partners = hunkLinePartners(hunk.lines);
      this.#partnersByHunk.set(hunk, partners);
    }
    return partners;
  }

  /**
   * One pair's comparison, here when it is short, or asked of the worker when it is long and the
   * worker has not failed on it.
   */
  #computedPair(pair: LinePair): IntralinePairReading {
    if (pair.deletedText.length + pair.insertedText.length <= WINDOW_THREAD_PAIR_CHARACTERS) {
      // The deleted line is always the first argument so one comparison yields both sides;
      // two comparisons could disagree about which words survived.
      return readingOf(intralineSegments(pair.deletedText, pair.insertedText));
    }
    if (!this.#pendingPairs.has(pair.key) && !this.#failedPairs.has(pair.key)) {
      this.#pendingPairs.set(pair.key, pair);
      this.#alignmentWorker
        .align(pair.deletedText, pair.insertedText, this.#pairsInFlight.signal)
        .then(
          (segments) => {
            this.#pendingPairs.delete(pair.key);
            this.#remember(pair.key, readingOf(segments));
            this.#markLanded(pair.hunk, pair.pairStart);
            this.#notify();
          },
          () => {
            // The worker recorded its failure in the window's diagnostics; this pair keeps its
            // whole-line wash, and every other pair is still marked.
            this.#pendingPairs.delete(pair.key);
            this.#failedPairs.add(pair.key);
            this.#markLanded(pair.hunk, pair.pairStart);
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

  #markLanded(hunk: DiffHunk, pairStart: number): void {
    this.#landingCount += 1;
    let landings = this.#landingByPair.get(hunk);
    if (landings === undefined) {
      landings = new Map();
      this.#landingByPair.set(hunk, landings);
    }
    landings.set(pairStart, this.#landingCount);
  }

  /** Hold one pair as the most recently read, dropping the oldest past the cap. */
  #remember(key: string, reading: IntralinePairReading): void {
    if (this.#pendingPairs.has(key) || this.#failedPairs.has(key)) {
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
 * The longest pair, both lines' characters together, compared on the window's own thread; a
 * longer pair goes to the worker so a minified line never holds the frame.
 */
const WINDOW_THREAD_PAIR_CHARACTERS = 1_000;

/** A replaced line and the line that replaced it, keyed by where the pair sits. */
interface LinePair {
  readonly key: string;
  readonly hunk: DiffHunk;
  /** The index of the pair's first line, the delete line, in its hunk. */
  readonly pairStart: number;
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
