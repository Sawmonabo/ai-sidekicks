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
//   • **The live chapter never collapses.** Collapse state is a separate MODULE
//     from the fold — `chapter-collapse.ts` — and its `isOpen` answers `true` for a
//     live chapter before it reads any stored state at all, so "never collapses the
//     live chapter" is a branch that cannot be reached rather than a rule a caller
//     has to remember.
//
// WHAT THIS MODULE IS NOT. It renders nothing. The header — the agent's name and
// hue, the run state, the paying account label, the row count — is drawn by
// `ChapterHeader.tsx` from this model, and every one of those five is a member sealed
// below, so the fold stays a pure derivation the `console-unit` tier can drive with no
// DOM at all. The two that read a wire read it VERBATIM: the run state is the daemon's
// own newest lifecycle type and the account is the id the run was admitted under, so
// neither is a word this console composed.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { ChapterBodyRowWindow, chapterClippedHeadRowCount } from "./chapter-body.js";
import {
  isReopeningEventType,
  isRunStateEventType,
  isTerminalEventType,
  payingAccountIdOf,
  type ChapterTerminalEventType,
} from "./chapter-lifecycle.js";

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
   * Rows the outer list's ceiling left out, which the body clips behind a top-edge
   * fade and scrolls to. Counted by the same rule the body's window is cut with —
   * `chapterClippedHeadRowCount`, which the selection itself defers to — so the figure
   * and the rows cannot disagree; reported rather than dropped, because a chapter that
   * hid rows silently would make its own row count a lie.
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
   * The newest run state the log reported for this run, wire-verbatim, or `undefined`
   * where no row in the window carried one and after a rewind that cleared it.
   *
   * It is not `terminalEventType` under another name: a terminal is one of these and
   * a live run's state is not, so a chapter that has never ended still has a state to
   * say. The header renders this and nothing about it is composed here.
   */
  readonly runStateEventType: string | undefined;
  /**
   * The provider account this run was admitted under, wire-verbatim, or `undefined`
   * where no row in the window named one. The header renders it as the paying account;
   * an absent one draws no label, because the receipt named none.
   */
  readonly payingAccountId: string | undefined;
  /**
   * The rows immediately older than the ones the outer list mounted, oldest first and
   * bounded by the same ceiling.
   *
   * The body's window, sealed here so the component that draws it asks the chapter
   * rather than re-reading the log. It is a SUBSET of what `clippedRowCount` counts:
   * a run long enough to outrun both bounds has older rows than these, and the body
   * says so rather than implying the head is all there was.
   */
  readonly clippedHeadRows: readonly TimelineRow[];
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
  runStateEventType: string | undefined;
  payingAccountId: string | undefined;
  /** The bounded head this chapter's body will draw. Fed one row at a time. */
  readonly bodyRows: ChapterBodyRowWindow;
  firstSequence: number;
  lastSequence: number;
  firstTimestamp: string;
  lastTimestamp: string;
  hasIncompleteChildExpand: boolean;
}

/**
 * The run a row belongs to, or `undefined` for a row that belongs to none.
 *
 * Narrowed on `kind` rather than on `type`, which is the narrowing
 * `@ai-sidekicks/contracts` states its own arms are for: `runId` is a required
 * member of three arms and structurally absent from the fourth.
 */
export function runIdOfChapteredRow(row: TimelineRow): string | undefined {
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
    const runId = runIdOfChapteredRow(row);
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
    runStateEventType: undefined,
    payingAccountId: undefined,
    bodyRows: new ChapterBodyRowWindow(),
    firstSequence: row.sequence,
    lastSequence: row.sequence,
    firstTimestamp: row.timestamp,
    lastTimestamp: row.timestamp,
    hasIncompleteChildExpand: false,
  };
}

function absorbRow(accumulator: ChapterAccumulator, row: TimelineRow): void {
  accumulator.rowIds.push(row.id);
  accumulator.bodyRows.admit(row);
  // First naming wins, for the actor's reason one line down and for one of its own:
  // the account is settled when the run is admitted, so a later row naming another
  // would be a run that changed who pays while it ran.
  accumulator.payingAccountId ??= payingAccountIdOf(row);
  // First actor wins. A chapter is one run and a run has one agent; a later row
  // naming a different actor is a human steering inside the agent's chapter,
  // which `Spec-023 §Meridian, the design language` rule 1 keeps on the ROW's own
  // "2 px attribution edge in the author's hue" rather than moving the chapter's
  // header onto the person who interrupted it.
  accumulator.actorId ??= row.actor;
  if (isRunStateEventType(row.type)) {
    // NEWEST wins, which is the opposite of the account above and for the opposite
    // reason: a state is what the run is NOW, so every transition replaces it.
    accumulator.runStateEventType = row.type;
  } else if (row.type === "run.rolled_back") {
    // A rewind says the run came back and not what it came back into, so the state it
    // had is cleared rather than kept: a chapter reporting `run.completed` after the
    // completion was rewound would be reading a receipt the daemon already undid.
    accumulator.runStateEventType = undefined;
  }
  if (isTerminalEventType(row.type)) {
    // LAST terminal wins, in the same act for both members so the type and the row
    // it was read from can never name two different rows.
    accumulator.terminalEventType = row.type;
    accumulator.terminalRowId = row.id;
  } else if (isReopeningEventType(row.type)) {
    // And a run that came BACK clears the one it had, in the same act for the same
    // reason. Cleared rather than remembered as a previous ending: the header renders
    // one receipt from these two members, and a chapter that is live has no receipt
    // to render. A later ending seals it again through the arm above.
    accumulator.terminalEventType = undefined;
    accumulator.terminalRowId = undefined;
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
    clippedRowCount: chapterClippedHeadRowCount(rowCount),
    actorId: accumulator.actorId,
    lifecycle: accumulator.terminalEventType === undefined ? "live" : "terminal",
    runStateEventType: accumulator.runStateEventType,
    payingAccountId: accumulator.payingAccountId,
    clippedHeadRows: accumulator.bodyRows.headRows,
    terminalEventType: accumulator.terminalEventType,
    terminalRowId: accumulator.terminalRowId,
    firstSequence: accumulator.firstSequence,
    lastSequence: accumulator.lastSequence,
    firstTimestamp: accumulator.firstTimestamp,
    lastTimestamp: accumulator.lastTimestamp,
    hasIncompleteChildExpand: accumulator.hasIncompleteChildExpand,
  };
}
