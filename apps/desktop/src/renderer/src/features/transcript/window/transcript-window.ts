// One loaded transcript window, derived from a session's log.
//
// Every derivation the pane renders is made here, once per store revision, so the render
// body holds no fold and no allocation and the frame's budget goes to the virtualizer's
// measurement pass.
//
// The viewport row and the row body are two things: the virtualizer's row is three identity
// members (`key`, `parentKey`, `rootCursor`) and no content, so a body change never
// re-measures every row. This module produces the identity list and a lookup from key to
// the projected row, and the pane's renderer joins them where a row is drawn.
//
// Three things the list decides and a row never knows: `actorHue`, read from the session
// store's hue allocator (which admits the read's join log first, then each actor the log
// attributes a row to); `isSuperseded`, a rollback ranking over the rows around a row
// (`SupersededIndex`); and `density`, the list's collapse state, where a terminal run's
// group folds and the live one stays open.
//
// What this module produces is the unfurled window, every member row of every run group,
// before any fold: the fold (`feed/run-group-fold.ts`) runs after the narrowing, which could
// otherwise neither count nor admit a folded group's rows. `readRunGroupKey` is exported for
// the fold, which re-keys rows under their headers, so a row's parent key has one answer.
//
// The objects this derivation publishes are held across passes by `row-retention.ts`, so an
// unchanged row keeps its identity and the memos below the feed do not re-render the whole
// mounted window on every admitted event.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type ConsoleSessionEvent } from "@renderer/console/store/entities/entities.js";
import {
  ChildRunIndex,
  type ChildRunEntry,
  type HandoffEntry,
} from "../dispatches/child-run-entries.js";
import { projectFixtureShellRows } from "../projection/transcript-row-projection.js";
import { RunGroupIndex, type RunGroup } from "../run-groups/run-groups.js";
import { SupersededIndex, type SupersededBand } from "../superseded/superseded-bands.js";
import {
  SystemMessageClassifier,
  type SystemMessageReading,
} from "../system-messages/system-message-classifier.js";
import { type ViewportRow } from "../viewport/viewport-snapshot.js";
import { TranscriptRowRetention } from "./row-retention.js";

/**
 * What one pipeline stage admitted, and the rows it removed on the way.
 *
 * THE STAGE REPORTS ITS OWN REMOVALS BECAUSE IT IS THE ONE THAT HAS THEM. The counts
 * beside the find field name what each narrowing is holding, and deriving that
 * downstream meant building a `Set` over one stage's rows and filtering the previous
 * stage's against it — two whole-projection passes per stage, re-run on every appended
 * row for as long as a query was in the field, over a set the stage had already
 * separated and thrown away.
 *
 * AND `removedRows` IS IDENTITY-STABLE WHERE A STAGE REMOVED NOTHING, which is what
 * makes the common ledger free rather than merely cheaper: a consumer's memo over
 * {@link NO_ROWS_REMOVED} does not re-run at all when the log grows.
 */
export interface TranscriptPipelineStage {
  readonly window: TranscriptWindowModel;
  /** The rows this stage took out of the window it was handed, in log order. */
  readonly removedRows: readonly TimelineRow[];
}

/**
 * The removal a pass-through stage reports.
 *
 * One shared value rather than a fresh `[]` per pass: the identity is the contract —
 * a consumer keys a memo on it, and a new empty array every pass would re-run that
 * memo on every append while reporting the same nothing.
 */
export const NO_ROWS_REMOVED: readonly TimelineRow[] = [];

/** Everything one render of the ledger needs, derived once per store revision. */
export interface TranscriptWindowModel {
  /** The virtualizer's identity list. Memoized: the viewport keys its reconcile on it. */
  readonly viewportRows: readonly ViewportRow[];
  /** The projected row behind each viewport key. */
  readonly rowsByKey: ReadonlyMap<string, TimelineRow>;
  /** Which rows a rollback boundary later in the log supersedes. */
  readonly supersededRowIds: ReadonlySet<string>;
  /**
   * The rewound band behind each band header row, keyed by the band key the header IS.
   *
   * Every band in the window has an entry, folded or open, for the chapter header's
   * reason: the control that folds a band back is on its own header, so a header
   * whose band is open still has to render.
   */
  readonly supersededBandByHeaderKey: ReadonlyMap<string, SupersededBand>;
  /** Which band each superseded row belongs to — the fold's per-row question. */
  readonly supersededBandKeyByRowId: ReadonlyMap<string, string>;
  /** Which rows are collapsed, under rule 7's terminal-chapter fold. */
  readonly collapsedRowIds: ReadonlySet<string>;
  /**
   * The chapter behind each header row, keyed by the run id the header IS.
   *
   * Every terminal chapter has an entry, whether it is folded or open: a header a
   * person opened still renders, because the control that folds it back is on it.
   * A live chapter has none — it draws no header, its rows are top-level, and the
   * fold below never touches it.
   */
  readonly chapterByHeaderKey: ReadonlyMap<string, RunGroup>;
  /**
   * The seam behind each row that is one — the lookup the feed's row renderer
   * consults BEFORE it delegates to the timeline row seat.
   *
   * The ONE form a seam is published in. The classifier's log-order pass is kept as a
   * local that feeds this map and is not carried on the model beside it: a second
   * member holding the same classification is a second thing every narrowing and every
   * fold has to remember to re-filter, and the one that gets forgotten is the one a
   * reader never sees go stale.
   */
  readonly seamByRowId: ReadonlyMap<string, SystemMessageReading>;
  /**
   * The child-run summary behind each row that carries one — the second lookup the
   * feed's row renderer consults before it delegates to the timeline row seat.
   *
   * Anchored: a child re-summarized as it progresses has ONE entry, at the row that
   * first named it, so its card stays where a reader left it — and that entry carries
   * the LATEST summary, so the card reports where the child has got to rather than
   * where it started.
   */
  readonly childRunEntryByRowId: ReadonlyMap<string, ChildRunEntry>;
  /** The handoff behind each row that is one, on the same dispatch. */
  readonly handoffEntryByRowId: ReadonlyMap<string, HandoffEntry>;
  /** The rows in log order, for find and the chapter fold. */
  readonly rows: readonly TimelineRow[];
  /** Events the registered census carries no category for. Rendered, never hidden. */
  readonly unprojectableEventCount: number;
  /**
   * Whether the store recorded sequences it never received.
   *
   * A hole in what arrived, not "rows exist before this window's head": the console
   * holds one live subscription and no range read, so the head of the window is the head
   * of everything it can reach. The feed names the hole in words.
   */
  readonly hasUnreceivedEntries: boolean;
  /** A run is mid-flight, so the viewport defers pruning rather than moving rows. */
  readonly hasActiveTurn: boolean;
}

/**
 * The chapter a row hangs from, or `undefined` for a top-level row.
 *
 * Read off the arm rather than off the payload: `kind` is the discriminator the
 * contract guarantees, and three of the four arms carry `runId` structurally while
 * the `general` arm structurally cannot.
 */
export function readRunGroupKey(row: TimelineRow): string | undefined {
  return row.kind === "general" ? undefined : row.runId;
}

/**
 * Derive the whole window from one log.
 *
 * Exported beside the hook so the fold can be driven by a test and by the bench tier
 * with no store and no React at all — `groupRowsByRun`' own precedent, for its reason.
 */
export function deriveLedgerWindow(
  timeline: readonly ConsoleSessionEvent[],
  hasUnreceivedEntries: boolean,
  retention: TranscriptRowRetention = new TranscriptRowRetention(),
): TranscriptWindowModel {
  const projection = projectFixtureShellRows(timeline);
  // BEFORE the indexes below read a row, so every one of them — and the feed, and
  // every memo under it — sees the object this window is actually publishing. A
  // fresh retention retains nothing, which is exactly what a one-shot caller wants.
  retention.beginPass();
  const rows = projection.rows.map((row) => retention.retainRow(row));
  const chapterIndex = new RunGroupIndex(rows);
  const supersededIndex = new SupersededIndex(rows);
  // The seam vocabulary has one classifier; this is the instance that reads the whole
  // log. Its log-order pass is a LOCAL and reaches the model only as the map keyed
  // from it below, so the row a narrowing carries forward and the row the feed draws
  // are one classification rather than two.
  const seamIndex = new SystemMessageClassifier();
  const seams = seamIndex.seams(rows);
  // Child runs and handoffs, over the same rows every other index reads.
  const childRunIndex = new ChildRunIndex(rows);
  const rowsByKey = new Map<string, TimelineRow>();
  const viewportRows: ViewportRow[] = [];
  const supersededRowIds = new Set<string>();
  for (const row of rows) {
    rowsByKey.set(row.id, row);
    viewportRows.push(retention.retainRowIdentity(row, readRunGroupKey(row)));
    if (supersededIndex.isSuperseded(row.id)) {
      supersededRowIds.add(row.id);
    }
  }
  return {
    viewportRows,
    rowsByKey,
    supersededRowIds,
    supersededBandByHeaderKey: supersededIndex.bandByHeaderKey(),
    supersededBandKeyByRowId: supersededIndex.bandKeyByRowId(),
    collapsedRowIds: collapsedRowIdsOf(chapterIndex),
    chapterByHeaderKey: new Map(
      chapterIndex.terminalChapters().map((chapter) => [chapter.runId, chapter]),
    ),
    seamByRowId: new Map(seams.map((seam) => [seam.rowId, seam])),
    childRunEntryByRowId: childRunIndex.childRunEntryByRowId(),
    handoffEntryByRowId: childRunIndex.handoffEntryByRowId(),
    rows,
    unprojectableEventCount: projection.unprojectableEventCount,
    hasUnreceivedEntries,
    // A chapter with no terminal is a run the log has not seen end. That is the
    // same question the viewport asks before it prunes, and it is answered from the
    // fold that already exists rather than from a second read of the run partition.
    hasActiveTurn: chapterIndex.chapters().length > chapterIndex.terminalChapters().length,
  };
}

/**
 * Which rows are collapsed: every row of a chapter that has reached a terminal.
 *
 * Rule 7 in terms — "run chapters collapse once terminal and the live chapter stays
 * open" — asked of the chapter index's own `terminalChapters()` rather than
 * re-derived from a terminal event type here, so the fold that decides a chapter is
 * over and the fold that decides a row is collapsed are one fold.
 */
function collapsedRowIdsOf(chapterIndex: RunGroupIndex): ReadonlySet<string> {
  const collapsed = new Set<string>();
  for (const chapter of chapterIndex.terminalChapters()) {
    for (const rowId of chapter.rowIds) {
      collapsed.add(rowId);
    }
  }
  return collapsed;
}
