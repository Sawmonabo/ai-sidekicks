// One loaded ledger window, derived from this window's session store.
//
// WHAT THIS MODULE IS FOR. `TimelinePane.tsx` renders; every derivation it renders
// is made here, once per store revision, so the component body holds no fold and no
// allocation. That split is `apps/desktop/AGENTS.md`'s rule about render bodies, and
// it is also what makes the pane cheap: the frame's budget is spent on the
// virtualizer's measurement pass, not on re-folding a ten-thousand-row log because
// a find field took a keystroke.
//
// WHY THE VIEWPORT ROW AND THE ROW BODY ARE TWO THINGS. The virtualizer's row is
// three identity members (`key`, `parentKey`, `rootCursor`) and no content — it
// decides placement, measurement, and pruning, and a viewport that also carried the
// body would re-measure every row whenever any body changed. So this module
// produces the identity list AND a lookup from key to the projected row, and the
// pane's renderer joins them at the one point a row is actually drawn.
//
// THE THREE THINGS THE LIST DECIDES AND A ROW NEVER KNOWS, which is the timeline row
// seat's own contract:
//
//   • `participantHue` — allocated over a join order, and NOT here. The session
//     store owns the wheel (`SessionStore.hueAllocator`): it admits the read's
//     participant join log first and then every actor the log attributes a row to,
//     which is the order rule 2 fixes. A second allocator over first-event
//     appearance was the same algorithm over a different order, so a participant
//     who joined early and spoke late wore one hue on their cast chip and another
//     on their rows — which defeats hue as an identity channel exactly where it is
//     supposed to work. The feed reads the store's assignment at the row it draws.
//   • `isSuperseded` — a rollback ranking over the rows AROUND a row, which is
//     `SupersededIndex`'s answer and never a member the row carries.
//   • `density` — the list's collapse state, which is `Spec-023 §Console Design
//     (Meridian)` rule 7: a terminal run's chapter folds and the live one stays open.
//
// WHAT THIS MODULE PRODUCES IS THE UNFURLED WINDOW — every member row of every
// chapter, before any fold. The fold is `ledger-chapter-fold.ts`', and it is a
// separate module because a narrowing runs BETWEEN the two. It has to: a fold
// performed first hands the narrowing a window in which a closed chapter is one
// receipt, and a narrowing over that window can neither count nor admit the
// chapter's messages, its tools, or the people in it.
//
// One of this module's identity rules is exported for the fold, which re-keys rows
// under their chapter headers: `chapterKeyFor`. It is exported rather than duplicated
// because a fold that decided a row's parent key for itself would be a second answer
// to a question this derivation already settled — and the retention table beside it
// is exported from its own module for that same reason.
//
// AND THE OBJECTS THIS DERIVATION PUBLISHES ARE HELD ACROSS PASSES, by
// `ledger-row-retention.ts` — see its own doc for the measurement that put it there.
// Every memo below the feed keys on those identities, so a derivation that minted a
// fresh object for every unchanged row re-rendered the whole mounted window on every
// admitted event for a change none of the rows could see.

import { useMemo } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { useConsoleBridge } from "../../../bridge/index.js";
import { projectFixtureShellRows } from "../../cards/index.js";
import { type LedgerViewportRow } from "../../frame/index.js";
import { LedgerRowRetention } from "./ledger-row-retention.js";
import {
  LedgerChapterIndex,
  LedgerSeamIndex,
  SupersededIndex,
  scopeLedgerRowsToChannel,
  type LedgerChapter,
  type LedgerSeam,
} from "../../structure/index.js";
import { useSessionScopedState } from "../../../seats/index.js";
import {
  useSessionStore,
  type ConsoleSessionEvent,
  type SessionStore,
} from "../../../store/index.js";

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
export interface LedgerPipelineStage {
  readonly window: LedgerWindowModel;
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
export interface LedgerWindowModel {
  /** The virtualizer's identity list. Memoized: the viewport keys its reconcile on it. */
  readonly viewportRows: readonly LedgerViewportRow[];
  /** The projected row behind each viewport key. */
  readonly rowsByKey: ReadonlyMap<string, TimelineRow>;
  /** Which rows a rollback boundary later in the log supersedes. */
  readonly supersededRowIds: ReadonlySet<string>;
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
  readonly chapterByHeaderKey: ReadonlyMap<string, LedgerChapter>;
  /** Every seam in log order — what the replay dock's next-seam jump walks. */
  readonly seams: readonly LedgerSeam[];
  /**
   * The seam behind each row that is one — the lookup the feed's row renderer
   * consults BEFORE it delegates to the timeline row seat.
   *
   * Built from the same index that produced `seams`, so the row a jump lands on and
   * the row a person reads are one classification rather than two.
   */
  readonly seamByRowId: ReadonlyMap<string, LedgerSeam>;
  /** The rows in log order, for find, the chapter fold, and the replay scrub. */
  readonly rows: readonly TimelineRow[];
  /** Events the registered census carries no category for. Rendered, never hidden. */
  readonly unprojectableEventCount: number;
  /**
   * Whether the store recorded sequences it never received.
   *
   * A HOLE in what arrived, which is not the same fact as "rows exist before this
   * window's head" and is deliberately no longer used as one: the console holds one
   * live subscription and no range read, so the head of the window is the head of
   * everything it can reach. The feed names the hole in words instead.
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
export function chapterKeyFor(row: TimelineRow): string | undefined {
  return row.kind === "general" ? undefined : row.runId;
}

/**
 * Which rows are collapsed: every row of a chapter that has reached a terminal.
 *
 * Rule 7 in terms — "run chapters collapse once terminal and the live chapter stays
 * open" — asked of the chapter index's own `terminalChapters()` rather than
 * re-derived from a terminal event type here, so the fold that decides a chapter is
 * over and the fold that decides a row is collapsed are one fold.
 */
function collapsedRowIdsOf(chapterIndex: LedgerChapterIndex): ReadonlySet<string> {
  const collapsed = new Set<string>();
  for (const chapter of chapterIndex.terminalChapters()) {
    for (const rowId of chapter.rowIds) {
      collapsed.add(rowId);
    }
  }
  return collapsed;
}
/**
 * Derive the whole window from one log.
 *
 * Exported beside the hook so the fold can be driven by a test and by the bench tier
 * with no store and no React at all — `foldChapters`' own precedent, for its reason.
 */
export function deriveLedgerWindow(
  timeline: readonly ConsoleSessionEvent[],
  hasUnreceivedEntries: boolean,
  retention: LedgerRowRetention = new LedgerRowRetention(),
  channelId?: string,
): LedgerWindowModel {
  const projection = projectFixtureShellRows(timeline);
  // THE PANE'S SCOPE, APPLIED BEFORE ANY INDEX READS A ROW — before the chapters
  // are folded, before the seams are classified, before the superseded bands are
  // ranked, and so before the facet bar, the viewport cap, replay, find and the
  // rail. Every figure this window publishes is therefore a figure about the
  // channel, and no piece below has to remember that a scope exists.
  //
  // The LOG is projected whole and the ROWS are narrowed, rather than the events
  // being filtered on the way in: a run's ordinal and epoch are counted across its
  // own rows, and dropping a rollback out of that count would leave every row after
  // it at a position no rewind ever reached.
  const scopedRows =
    channelId === undefined
      ? projection.rows
      : scopeLedgerRowsToChannel(projection.rows, channelId);
  // BEFORE the indexes below read a row, so every one of them — and the feed, and
  // every memo under it — sees the object this window is actually publishing. A
  // fresh retention retains nothing, which is exactly what a one-shot caller wants.
  retention.beginPass();
  const rows = scopedRows.map((row) => retention.retainRow(row));
  const chapterIndex = new LedgerChapterIndex(rows);
  const supersededIndex = new SupersededIndex(rows);
  // The seam vocabulary has one classifier; this is the instance that reads the
  // whole log, which is what replay's next-seam jump walks. The rail's own instance
  // reads the pruned window in `ledger-visible-window.ts`, because the rail marks what
  // is on screen.
  const seamIndex = new LedgerSeamIndex();
  const seams = seamIndex.seams(rows);
  const rowsByKey = new Map<string, TimelineRow>();
  const viewportRows: LedgerViewportRow[] = [];
  const supersededRowIds = new Set<string>();
  for (const row of rows) {
    rowsByKey.set(row.id, row);
    viewportRows.push(retention.retainRowIdentity(row, chapterKeyFor(row)));
    if (supersededIndex.isSuperseded(row.id)) {
      supersededRowIds.add(row.id);
    }
  }
  return {
    viewportRows,
    rowsByKey,
    supersededRowIds,
    collapsedRowIds: collapsedRowIdsOf(chapterIndex),
    chapterByHeaderKey: new Map(
      chapterIndex.terminalChapters().map((chapter) => [chapter.runId, chapter]),
    ),
    seams,
    seamByRowId: new Map(seams.map((seam) => [seam.rowId, seam])),
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
 * Subscribe to one session's log and project it, UNFURLED.
 *
 * The subscription is the store's `timeline` and its gap list and nothing else, so a
 * change to an entity partition — a run transition the ledger already saw as a row —
 * does not re-project the log. The store replaces the log's identity only when it
 * admits an event, which is what makes the memo fire exactly then.
 *
 * EVERY MEMBER ROW IS IN THE RESULT, including the ones a closed chapter will fold
 * away. This is the window a narrowing is applied to, so a facet count and a
 * narrowing both see a finished run's messages, tools and participants rather than
 * only the receipt its fold would have left.
 *
 * A NAMED CHANNEL IS THE EXCEPTION, and it is not a narrowing of this window but
 * the definition of it: a channel-scoped pane is a log of that channel, so the
 * scope is applied inside the derivation and everything downstream — the facets
 * included — is a fact about the channel.
 */
export function useLedgerProjection(
  sessionStore: SessionStore,
  channelId?: string,
): LedgerWindowModel {
  const timeline = useSessionStore(sessionStore, readTimeline);
  const hasUnreceivedEntries = useSessionStore(sessionStore, readHasGaps);
  // One table per SESSION, so a pass has a predecessor to retain from — and so a
  // pane that follows a navigation to another session starts that session with an
  // empty table rather than with the rows of the one it left. Seeded during the
  // render for the subject-scoped holder's reason: the pass that first sees a new
  // session already reads that session's own table, which a ref written in the body
  // could not promise and an effect would deliver one commit late.
  const bridge = useConsoleBridge();
  const retention = useSessionScopedState(
    bridge,
    sessionStore.sessionId,
    () => new LedgerRowRetention(),
  );
  const heldRetention = retention.value;
  return useMemo(
    () => deriveLedgerWindow(timeline, hasUnreceivedEntries, heldRetention, channelId),
    [timeline, hasUnreceivedEntries, heldRetention, channelId],
  );
}
/** The log this window holds. A named function, so the selector identity is stable. */
function readTimeline(state: {
  readonly timeline: readonly ConsoleSessionEvent[];
}): readonly ConsoleSessionEvent[] {
  return state.timeline;
}

/** Whether the store knows of sequences it never received. */
function readHasGaps(state: { readonly gaps: readonly unknown[] }): boolean {
  return state.gaps.length > 0;
}
