// Run chapters — the fold that makes parallel runs read as parallel stories.
//
// `Spec-023 §Meridian, the design language` rule 7 fixes the collapse behaviour: "run
// chapters collapse once terminal and the live chapter stays open." THE GROUPING IS THIS
// MODULE'S, because no committed document states it: a run's rows sit under one chapter
// header so parallel runs read as parallel stories, one chapter per run, a terminal
// chapter folded to a header and a past-tense receipt, and nothing re-ordered.
//
// THREE RULES THIS MODULE ENCODES STRUCTURALLY, because each of them is a way the
// fold could quietly lie:
//
//   • **`runId` and nothing else.** A row joins a
//     chapter by its carried `runId` and never by a heuristic. `TimelineRow` makes
//     that checkable rather than aspirational — three of its four arms carry
//     `runId` as a required member of the arm, and the fourth (`general`) is the
//     NON-run arm by construction, so a general row cannot be guessed into a
//     chapter because it has nothing to guess from.
//   • **Order is the log's order.** Rows keep their sequence inside a chapter and
//     chapters keep the order their first row arrived in. The fold partitions; it
//     never sorts.
//   • **The live chapter never collapses.** Collapse state is a separate class
//     from the fold, and its `isOpen` answers `true` for a live chapter before it
//     reads any stored state at all — so "never collapses the live chapter" is a
//     branch that cannot be reached rather than a rule a caller has to remember.
//
// WHAT THIS MODULE IS NOT. It renders nothing. The header — the agent's name
// and hue, the run state, the paying account label, the row count — is drawn by
// the ledger frame from this model, so the fold stays a pure derivation the
// `console-unit` tier can drive with no DOM at all.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { CHAPTER_VISIBLE_ROW_CAP } from "./structure-bounds.js";

/**
 * The run-lifecycle event types that END a run, wire-verbatim.
 *
 * Declared once as a tuple with the membership test derived from it. All three
 * are registered in the `@ai-sidekicks/contracts` event census; `run.rolled_back`
 * is deliberately absent, because a rewind is not a terminal — the run continues
 * from the boundary, which is exactly why `Spec-013` gives the rollback its own
 * non-state event.
 */
export const CHAPTER_TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.interrupted",
] as const;

/** One terminal event type. Derived from the tuple, never restated. */
export type ChapterTerminalEventType = (typeof CHAPTER_TERMINAL_EVENT_TYPES)[number];

/**
 * Whether a chapter is still being written.
 *
 * Two values, and the distinction is the whole of rule 7's collapse behaviour: a
 * terminal chapter folds to one line and a live one stays open.
 */
export const CHAPTER_LIFECYCLES = ["live", "terminal"] as const;

export type ChapterLifecycle = (typeof CHAPTER_LIFECYCLES)[number];

/** One run's rows, folded. */
export interface LedgerChapter {
  /** The run this chapter is, wire-verbatim. The only thing rows are grouped by. */
  readonly runId: string;
  /**
   * The chapter's rows, in the order they arrived. Cached on the chapter rather
   * than recomputed per read — this module's cached row-id arrays — so a header that
   * renders a row count and a body that maps over ids read one array.
   */
  readonly rowIds: readonly string[];
  readonly rowCount: number;
  /**
   * Rows past `CHAPTER_VISIBLE_ROW_CAP`, which the body clips behind a top-edge
   * fade. Reported rather than dropped: a chapter that hid rows silently would
   * make its own row count a lie.
   */
  readonly clippedRowCount: number;
  /**
   * The actor the run's rows are attributed to, wire-verbatim, or `undefined`
   * where no row named one. The header renders the agent's name from this; the
   * console never invents one.
   */
  readonly actorId: string | undefined;
  readonly lifecycle: ChapterLifecycle;
  /**
   * Which terminal ended it, wire-verbatim, or `undefined` while live. The
   * receipt's past tense is composed from this by the header, so the console
   * never paraphrases the state the daemon reported.
   */
  readonly terminalEventType: ChapterTerminalEventType | undefined;
  /**
   * The row that ENDED it, or `undefined` while live.
   *
   * Carried as a row id rather than re-derived from the terminal event type,
   * because a folded chapter renders its header and that row and nothing else —
   * and a fold that had to scan for its own receipt would be a second reading of
   * the terminal that the seal already performed.
   */
  readonly terminalRowId: string | undefined;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
  /**
   * A child run this chapter summarizes whose expansion is incomplete
   * — the marked state this console gives a partial expansion. Read off
   * `TimelineRow.childRunSummary`, which is where the wire says so.
   */
  readonly hasIncompleteChildExpand: boolean;
}

/** What a fold produced: the chapters, and the rows that belong to none. */
export interface LedgerChapterFold {
  readonly chapters: readonly LedgerChapter[];
  /**
   * Rows carrying no run attribution — the `general` arm. They are NOT a chapter
   * and are deliberately not folded into one: a session-scoped row inside a run's
   * chapter would attribute it to that run.
   */
  readonly unchapteredRowIds: readonly string[];
}

/** A chapter under construction. Mutable only inside the fold. */
interface ChapterAccumulator {
  readonly runId: string;
  readonly rowIds: string[];
  actorId: string | undefined;
  terminalEventType: ChapterTerminalEventType | undefined;
  terminalRowId: string | undefined;
  firstSequence: number;
  lastSequence: number;
  firstTimestamp: string;
  lastTimestamp: string;
  hasIncompleteChildExpand: boolean;
}

function isTerminalEventType(wireType: string): wireType is ChapterTerminalEventType {
  return CHAPTER_TERMINAL_EVENT_TYPES.some((terminal) => terminal === wireType);
}

/**
 * The run a row belongs to, or `undefined` for a row that belongs to none.
 *
 * Narrowed on `kind` rather than on `type`, which is the narrowing
 * `@ai-sidekicks/contracts` states its own arms are for: `runId` is a required
 * member of three arms and structurally absent from the fourth.
 */
function chapterRunIdOf(row: TimelineRow): string | undefined {
  return row.kind === "general" ? undefined : row.runId;
}

/**
 * The chapter fold over one loaded window.
 *
 * A class rather than a function because the fold is read several times per frame
 * — the header wants counts, the body wants row ids, the collapse state wants
 * lifecycles — and it is lean by construction: cached row-id
 * arrays, a lazy completion index, memoised fold inputs. The instance IS the
 * memo: it is built once per loaded-window identity by the caller's `useMemo` and
 * computes nothing until something is read.
 */
export class LedgerChapterIndex {
  readonly #rows: readonly TimelineRow[];
  /** The lazy completion index. Undefined until the first read folds it. */
  #fold: LedgerChapterFold | undefined;
  #chapterByRunId: ReadonlyMap<string, LedgerChapter> | undefined;

  public constructor(rows: readonly TimelineRow[]) {
    this.#rows = rows;
  }

  /** Every chapter, in the order each run's first row arrived. */
  public chapters(): readonly LedgerChapter[] {
    return this.#foldOnce().chapters;
  }

  /** Rows carrying no run attribution, in log order. */
  public unchapteredRowIds(): readonly string[] {
    return this.#foldOnce().unchapteredRowIds;
  }

  /** One chapter by run, or `undefined` when the window holds none of that run. */
  public chapterFor(runId: string): LedgerChapter | undefined {
    this.#chapterByRunId ??= new Map(
      this.#foldOnce().chapters.map((chapter) => [chapter.runId, chapter]),
    );
    return this.#chapterByRunId.get(runId);
  }

  /** Chapters that have ended. The input to "collapse all terminal chapters". */
  public terminalChapters(): readonly LedgerChapter[] {
    return this.#foldOnce().chapters.filter((chapter) => chapter.lifecycle === "terminal");
  }

  #foldOnce(): LedgerChapterFold {
    this.#fold ??= foldChapters(this.#rows);
    return this.#fold;
  }
}

/**
 * Partition one loaded window into chapters.
 *
 * Exported beside the class so the derivation can be driven directly by a test
 * and by the bench tier without constructing an index — the class is the memo,
 * this is the fold, and there is exactly one of each.
 */
export function foldChapters(rows: readonly TimelineRow[]): LedgerChapterFold {
  const accumulatorsByRunId = new Map<string, ChapterAccumulator>();
  const unchapteredRowIds: string[] = [];

  for (const row of rows) {
    const runId = chapterRunIdOf(row);
    if (runId === undefined) {
      unchapteredRowIds.push(row.id);
      continue;
    }
    const existing = accumulatorsByRunId.get(runId);
    const accumulator = existing ?? newAccumulator(runId, row);
    if (existing === undefined) {
      accumulatorsByRunId.set(runId, accumulator);
    }
    absorbRow(accumulator, row);
  }

  return {
    chapters: [...accumulatorsByRunId.values()].map(sealChapter),
    unchapteredRowIds,
  };
}

function newAccumulator(runId: string, row: TimelineRow): ChapterAccumulator {
  return {
    runId,
    rowIds: [],
    actorId: undefined,
    terminalEventType: undefined,
    terminalRowId: undefined,
    firstSequence: row.sequence,
    lastSequence: row.sequence,
    firstTimestamp: row.timestamp,
    lastTimestamp: row.timestamp,
    hasIncompleteChildExpand: false,
  };
}

function absorbRow(accumulator: ChapterAccumulator, row: TimelineRow): void {
  accumulator.rowIds.push(row.id);
  // First actor wins. A chapter is one run and a run has one agent; a later row
  // naming a different actor is a human steering inside the agent's chapter,
  // which `Spec-023 §Meridian, the design language` rule 1 keeps on the ROW's own
  // "2 px attribution edge in the author's hue" rather than moving the chapter's
  // header onto the person who interrupted it.
  accumulator.actorId ??= row.actor;
  if (isTerminalEventType(row.type)) {
    // LAST terminal wins, in the same act for both members so the type and the row
    // it was read from can never name two different rows.
    accumulator.terminalEventType = row.type;
    accumulator.terminalRowId = row.id;
  }
  if (row.childRunSummary?.completeness.state === "incomplete") {
    accumulator.hasIncompleteChildExpand = true;
  }
  if (row.sequence < accumulator.firstSequence) {
    accumulator.firstSequence = row.sequence;
    accumulator.firstTimestamp = row.timestamp;
  }
  if (row.sequence > accumulator.lastSequence) {
    accumulator.lastSequence = row.sequence;
    accumulator.lastTimestamp = row.timestamp;
  }
}

function sealChapter(accumulator: ChapterAccumulator): LedgerChapter {
  const rowCount = accumulator.rowIds.length;
  return {
    runId: accumulator.runId,
    rowIds: accumulator.rowIds,
    rowCount,
    clippedRowCount: Math.max(0, rowCount - CHAPTER_VISIBLE_ROW_CAP),
    actorId: accumulator.actorId,
    lifecycle: accumulator.terminalEventType === undefined ? "live" : "terminal",
    terminalEventType: accumulator.terminalEventType,
    terminalRowId: accumulator.terminalRowId,
    firstSequence: accumulator.firstSequence,
    lastSequence: accumulator.lastSequence,
    firstTimestamp: accumulator.firstTimestamp,
    lastTimestamp: accumulator.lastTimestamp,
    hasIncompleteChildExpand: accumulator.hasIncompleteChildExpand,
  };
}

/**
 * What the console knows about a chapter's place on screen, at the moment an
 * auto-collapse is considered.
 *
 * Every member is an OBSERVATION the caller made, never something this class
 * derives: this module makes auto-collapse conditional on geometry — only when the
 * chapter is off screen and only after one fresh geometry sample since the pane
 * was last hidden — and on engagement, and both live where the DOM is. A class
 * that guessed either would auto-collapse the chapter somebody was reading.
 */
export interface ChapterAutoCollapseObservation {
  readonly isOffScreen: boolean;
  /**
   * Whether the caller has measured this chapter since the pane was last hidden.
   * A pane that was hidden reports every chapter as off screen, so collapsing on
   * a stale sample would fold the whole log the moment a person came back to it.
   */
  readonly hasFreshGeometrySample: boolean;
  /** An open card, a selection, or focus inside the chapter. Never auto-collapses. */
  readonly isEngaged: boolean;
}

/**
 * Which chapters are open.
 *
 * Held apart from the fold because the two change on different clocks: the fold
 * changes when rows arrive and this changes when a person clicks. Keeping them in
 * one object would rebuild every chapter's row-id array on a disclosure toggle.
 *
 * The stored state is the set of terminal chapters a person has OPENED, which is
 * the smallest thing that has to be remembered: live chapters are open by rule,
 * terminal chapters are folded by default, and everything else follows.
 */
export class ChapterCollapseState {
  readonly #openedTerminalRunIds = new Set<string>();

  /**
   * Whether this chapter renders its body.
   *
   * The live arm answers before any stored state is read, which is what makes
   * rule 7's "the live chapter stays open" unreachable rather than remembered.
   */
  public isOpen(chapter: LedgerChapter): boolean {
    if (chapter.lifecycle === "live") {
      return true;
    }
    return this.#openedTerminalRunIds.has(chapter.runId);
  }

  /** Open a folded chapter. It stays open until closed. */
  public open(chapter: LedgerChapter): void {
    this.#openedTerminalRunIds.add(chapter.runId);
  }

  /**
   * Fold a chapter a person opened.
   *
   * A live chapter is a no-op rather than an error: the caller is a click handler
   * on a header, and the header of a live chapter offers no fold control at all,
   * so reaching here means the run ended between the render and the click.
   */
  public close(chapter: LedgerChapter): boolean {
    if (chapter.lifecycle === "live") {
      return false;
    }
    return this.#openedTerminalRunIds.delete(chapter.runId);
  }

  /**
   * Fold every terminal chapter — the console's "collapse all terminal chapters" offer.
   *
   * Returns how many were folded, so the command that invokes it can say what it
   * did rather than reporting success over a no-op.
   */
  public collapseAllTerminal(chapters: readonly LedgerChapter[]): number {
    let folded = 0;
    for (const chapter of chapters) {
      if (this.close(chapter)) {
        folded += 1;
      }
    }
    return folded;
  }

  /**
   * Fold a terminal chapter that has scrolled away, if every condition holds.
   *
   * Returns whether it folded, so the caller never has to re-derive the rule to
   * find out. All four conditions are conjunctive and each one is a separate way
   * the fold would be wrong: a live chapter is still being written, an on-screen
   * chapter is being read, a stale sample is a measurement of a hidden pane, and
   * an engaged chapter has somebody in it.
   */
  public autoCollapse(
    chapter: LedgerChapter,
    observation: ChapterAutoCollapseObservation,
  ): boolean {
    if (chapter.lifecycle === "live") {
      return false;
    }
    if (!observation.isOffScreen || !observation.hasFreshGeometrySample || observation.isEngaged) {
      return false;
    }
    return this.#openedTerminalRunIds.delete(chapter.runId);
  }

  /**
   * Terminal chapters a person has opened.
   *
   * The SET rather than a count, because the caller that renders the fold needs to
   * ask about one chapter and the caller that reports on it needs `.size` — and two
   * accessors over one field is two things to keep agreeing.
   */
  public get openedTerminalRunIds(): ReadonlySet<string> {
    return this.#openedTerminalRunIds;
  }
}
