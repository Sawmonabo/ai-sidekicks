// Row objects one transcript derivation publishes, held across its own passes. Two callers, each
// with its own instance: the unfurled projection in `transcript-window.ts` and the fold in
// `run-group-fold.ts`. A pass keeps only what it republishes, so the table never outgrows the
// window.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { type ViewportRow } from "../viewport/viewport-snapshot.js";

/**
 * Structural sharing, one pass at a time: the row or identity triple the previous pass published
 * under a key is returned again when every member is equal, so unchanged rows keep the identity
 * the memos below the feed key on (measured: without it a ten-row window drew ten row bodies at
 * mount and twenty-one more per admitted event). One instance per derivation: the projection and
 * the fold key the same run row differently, so a shared table would thrash.
 */
export class TranscriptRowRetention {
  #retainedRowsById = new Map<string, TimelineRow>();
  #publishedRowsById = new Map<string, TimelineRow>();
  #retainedIdentitiesByKey = new Map<string, ViewportRow>();
  #publishedIdentitiesByKey = new Map<string, ViewportRow>();

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

  /** One projected row's place in the identity list; takes the row and parent key, not a triple. */
  public retainRowIdentity(row: TimelineRow, parentKey: string | undefined): ViewportRow {
    return this.#retainIdentity(row.id, parentKey, cutUnitFor(row));
  }

  /**
   * A group header's place in that list, which no projected row backs. The header is its group,
   * so it is keyed by the group key (a run id, or `supersededTurnsKey`'s composite for rewound
   * turns) and is its own cut unit, so pruning it takes its subtree with it.
   */
  public retainGroupHeaderIdentity(groupKey: string): ViewportRow {
    return this.#retainIdentity(groupKey, undefined, groupKey);
  }

  #retainIdentity(key: string, parentKey: string | undefined, rootCursor: string): ViewportRow {
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
 * The cut unit the window cap prunes by: each row is its own, the finest the cap can act on. A
 * cursor shared across a page would make the cap all-or-nothing over every row the page delivered.
 */
function cutUnitFor(row: TimelineRow): string {
  return row.id;
}

/**
 * Whether two projections of one row are equal member for member, by identity. Compares the
 * candidate's own keys, not a list written here, so a member added to `TimelineRow` cannot be
 * forgotten and make a changed row compare equal (a stale card). `payload` is the delivered
 * envelope's own object, held by the store across revisions. A row whose envelope has no payload
 * gets a fresh `{}` each pass, so it takes a new identity and redraws each time; that is correct,
 * and it costs one row.
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
