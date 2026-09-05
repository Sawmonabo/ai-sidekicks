// The row objects one ledger derivation publishes, held across its own passes.
//
// ITS OWN MODULE BECAUSE IT IS ONE JOB — structural sharing, one pass at a time —
// and because it has two callers: the unfurled projection in `ledger-window.ts` and
// the fold in `ledger-chapter-fold.ts`, each holding an instance of its own. Read
// inside the derivation it came from, a hundred and forty lines of identity rules sat
// between the window's shape and the function that builds one, and the module that
// owned the shape also owned the equality.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type LedgerViewportRow } from "../../frame/index.js";

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
