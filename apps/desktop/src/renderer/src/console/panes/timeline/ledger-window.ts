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
// Two of this module's identity rules are exported for the fold, which re-keys rows
// under their chapter headers: `chapterKeyFor` and `LedgerRowRetention`. They are
// exported rather than duplicated because a fold that decided a row's parent key or
// its cut unit for itself would be a second answer to a question this derivation
// already settled.
//
// AND THE OBJECTS THIS DERIVATION PUBLISHES ARE HELD ACROSS PASSES, which is
// `LedgerRowRetention`'s whole job — see its own doc for the measurement that put it
// here. Every memo below the feed keys on those identities, so a derivation that
// minted a fresh object for every unchanged row re-rendered the whole mounted window
// on every admitted event for a change none of the rows could see.

import { useMemo, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { projectFixtureShellRows } from "../../ledger/cards/index.js";
import { type LedgerViewportRow } from "../../ledger/frame/index.js";
import {
  LedgerChapterIndex,
  LedgerSeamIndex,
  SupersededIndex,
  scopeLedgerRowsToChannel,
  type LedgerChapter,
  type LedgerSeam,
} from "../../ledger/structure/index.js";
import { useSessionStore, type ConsoleSessionEvent, type SessionStore } from "../../store/index.js";

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
 * The cut unit the window cap prunes by.
 *
 * `LedgerWindowRow.rootCursor` is the `timeline.read` cursor a row was read at, and
 * this console performs no timeline read — it holds one live subscription and the
 * whole log it delivered. So each row is its own cut unit, which is the FINEST the
 * cap can act on and therefore the least it can over-drop: a single shared cursor
 * would make the cap all-or-nothing over the entire window.
 */
function cutUnitFor(row: TimelineRow): string {
  return row.id;
}

/**
 * Whether two projections of one row say the same thing, member for member.
 *
 * Asked of the object's OWN KEYS rather than of a list written here, and that is the
 * point: `TimelineRow` is a four-arm union the contracts package owns, and a member
 * added there that this file forgot to compare would make a changed row compare
 * equal — which is a stale card on screen, the one failure a retention table can
 * cause. Reading the keys off the candidate costs two small arrays per row per pass
 * and cannot fall behind the type.
 *
 * Every member is compared by identity, which is exact for the primitives and right
 * for the two object-valued ones: `payload` is the delivered envelope's own object,
 * held by the store across revisions, and `superseded` is rebuilt only when the
 * ranking that produced it moved.
 */
function hasSameMembers(previous: TimelineRow, candidate: TimelineRow): boolean {
  const previousMembers = previous as unknown as Record<string, unknown>;
  const candidateMembers = candidate as unknown as Record<string, unknown>;
  const candidateKeys = Object.keys(candidateMembers);
  if (Object.keys(previousMembers).length !== candidateKeys.length) {
    return false;
  }
  for (const memberName of candidateKeys) {
    if (!Object.is(previousMembers[memberName], candidateMembers[memberName])) {
      return false;
    }
  }
  return true;
}

/**
 * The row objects one derivation publishes, held across its own passes.
 *
 * WHY IT EXISTS, MEASURED. `projectFixtureShellRows` rebuilds every `TimelineRow` on
 * every admitted event, and the identity triple beside each one used to be minted
 * fresh with it. Every memo below the feed keys on those identities, so a log that
 * gained one entry handed the viewport a window in which nothing had changed and
 * nothing was recognisable: a ten-row window drew ten row bodies at mount and
 * twenty-one more per admitted event, and none of that work produced a different
 * pixel.
 *
 * WHAT IT DOES. Structural sharing, one pass at a time: the object the PREVIOUS pass
 * published under a key is returned again whenever every member of the candidate
 * equals it. So a row that did not move keeps the identity the tree already holds,
 * and a row that did move takes a new one — which is what keeps this a performance
 * change rather than a stale-content bug.
 *
 * WHY A PASS AND NOT AN ACCUMULATING CACHE. `beginPass` moves what the last pass
 * published into the retained position and starts an empty one, so a row the
 * projection stopped emitting leaves with the pass that dropped it. The table can
 * therefore never outgrow the window it describes, which an accumulating map keyed by
 * row id could — and a table that outgrows its window is a leak wearing a cache's
 * clothes.
 *
 * WHAT IT ALLOCATES ON THE STEADY-STATE PATH: two maps per pass, and NOTHING per
 * retained row. `retainRowIdentity` takes the row and its parent key rather than a
 * built triple, so an unchanged row is answered without first minting the candidate
 * that would have been thrown away. The `TimelineRow` allocation is upstream — the
 * projection mints it before this is asked anything — so what is saved for those is
 * the identity CHANGE and not the object.
 *
 * WHAT IT DEPENDS ON UPSTREAM, STATED RATHER THAN ASSUMED. A row is retained only when
 * every member is identity-equal, and the projection copies the delivered envelope's own
 * `payload` object — which the store holds across revisions, so it is. An envelope
 * delivered WITHOUT a payload projects a fresh empty record on every pass, so its row
 * takes a new identity each time and is redrawn each time. That is a property of the
 * projection rather than of this table, it is correct rather than merely tolerated, and
 * the cost of it is one row.
 *
 * ONE INSTANCE PER DERIVATION AND NEVER SHARED. The unfurled projection files a run
 * row under its run's parent key and the fold files that same row under `undefined`
 * when its chapter is live, so a single table would answer one of the two stages with
 * the other's triple and thrash on every pass.
 */
export class LedgerRowRetention {
  #retainedRowsById = new Map<string, TimelineRow>();
  #publishedRowsById = new Map<string, TimelineRow>();
  #retainedIdentitiesByKey = new Map<string, LedgerViewportRow>();
  #publishedIdentitiesByKey = new Map<string, LedgerViewportRow>();

  /** Start a derivation: what the last pass published becomes what this one may retain. */
  public beginPass(): void {
    const rowsToRetain = this.#publishedRowsById;
    this.#publishedRowsById = this.#retainedRowsById;
    this.#retainedRowsById = rowsToRetain;
    this.#publishedRowsById.clear();
    const identitiesToRetain = this.#publishedIdentitiesByKey;
    this.#publishedIdentitiesByKey = this.#retainedIdentitiesByKey;
    this.#retainedIdentitiesByKey = identitiesToRetain;
    this.#publishedIdentitiesByKey.clear();
  }

  /** The projected row, as the last pass published it when nothing about it moved. */
  public retainRow(row: TimelineRow): TimelineRow {
    const retained = this.#retainedRowsById.get(row.id);
    const published = retained !== undefined && hasSameMembers(retained, row) ? retained : row;
    this.#publishedRowsById.set(row.id, published);
    return published;
  }

  /** One projected row's place in the virtualizer's identity list. */
  public retainRowIdentity(row: TimelineRow, parentKey: string | undefined): LedgerViewportRow {
    return this.#retainIdentity(row.id, parentKey, cutUnitFor(row));
  }

  /**
   * A chapter HEADER's place in that list, which no projected row backs.
   *
   * The header IS its run, so it is keyed by the run id — the same key
   * `chapterKeyFor` already hands that chapter's rows as their parent — and it is its
   * own cut unit, so pruning it takes its subtree with it.
   */
  public retainChapterHeaderIdentity(runId: string): LedgerViewportRow {
    return this.#retainIdentity(runId, undefined, runId);
  }

  #retainIdentity(
    key: string,
    parentKey: string | undefined,
    rootCursor: string,
  ): LedgerViewportRow {
    const retained = this.#retainedIdentitiesByKey.get(key);
    const published =
      retained !== undefined &&
      retained.parentKey === parentKey &&
      retained.rootCursor === rootCursor
        ? retained
        : { key, parentKey, rootCursor };
    this.#publishedIdentitiesByKey.set(key, published);
    return published;
  }
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
  // One table for the life of the mount, so a pass has a predecessor to retain from.
  // Minted through the lazy initialiser rather than held in a ref, because a ref's
  // first value is written during render and this one has to exist before the memo
  // below runs on the very first pass.
  const [retention] = useState(() => new LedgerRowRetention());
  return useMemo(
    () => deriveLedgerWindow(timeline, hasUnreceivedEntries, retention, channelId),
    [timeline, hasUnreceivedEntries, retention, channelId],
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
