// Row objects one transcript derivation publishes, and the reply row lists beside them, held
// across its own passes. Two callers, each with its own instance: the unfurled projection in
// `transcript-window.ts` and the fold in `run-group-fold.ts`. A pass keeps only what it
// republishes, so the table never outgrows the window.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row/row";

import { type ViewportRow } from "../viewport/viewport-snapshot.js";

/**
 * Structural sharing, one pass at a time: the row or identity triple the previous pass published
 * under a key is returned again when every member is equal, so unchanged rows keep the identity
 * the memos below the feed key on, and an admitted event redraws only the rows it changed. One
 * instance per derivation: the projection and the fold key the same run row differently, so a
 * shared table would thrash.
 */
export class TranscriptRowRetention {
  #retainedRowsById = new Map<string, TranscriptEventRow>();
  #publishedRowsById = new Map<string, TranscriptEventRow>();
  #retainedIdentitiesByKey = new Map<string, ViewportRow>();
  #publishedIdentitiesByKey = new Map<string, ViewportRow>();
  #retainedReplyRowIdsByKey = new Map<string, readonly string[]>();
  #publishedReplyRowIdsByKey = new Map<string, readonly string[]>();

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
    const replyRowIdsToRetain = this.#publishedReplyRowIdsByKey;
    this.#publishedReplyRowIdsByKey = this.#retainedReplyRowIdsByKey;
    this.#retainedReplyRowIdsByKey = replyRowIdsToRetain;
    this.#publishedReplyRowIdsByKey.clear();
  }

  /** The projected row, as the last pass published it when nothing about it moved. */
  public retainRow(row: TranscriptEventRow): TranscriptEventRow {
    const retained = this.#retainedRowsById.get(row.id);
    const published = retained !== undefined && hasSameMembers(retained, row) ? retained : row;
    this.#publishedRowsById.set(row.id, published);
    return published;
  }

  /** One projected row's place in the identity list; takes the row and parent key, not a triple. */
  public retainRowIdentity(row: TranscriptEventRow, parentKey: string | undefined): ViewportRow {
    // Each row is its own cut unit, the finest the window cap can act on: a cursor shared across
    // a page would make the cap all-or-nothing over every row the page delivered.
    return this.#retainIdentity(row.id, parentKey, row.id);
  }

  /**
   * A run group header's place in that list, which no projected row backs. The header is its
   * group, so it is keyed by the group's run id and is its own cut unit, so pruning it takes its
   * subtree with it.
   */
  public retainGroupHeaderIdentity(groupKey: string): ViewportRow {
    return this.#retainIdentity(groupKey, undefined, groupKey);
  }

  /** A reply's row ids, filed under its foot row, as the last pass published them when equal. */
  public retainReplyRowIds(footRowId: string, rowIds: readonly string[]): readonly string[] {
    const retained = this.#retainedReplyRowIdsByKey.get(footRowId);
    const published =
      retained !== undefined &&
      retained.length === rowIds.length &&
      retained.every((rowId, index) => rowId === rowIds[index])
        ? retained
        : rowIds;
    this.#publishedReplyRowIdsByKey.set(footRowId, published);
    return published;
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
 * Whether two projections of one row are equal member for member, by identity. Compares the
 * candidate's own keys, not a list written here, so a member added to `TranscriptEventRow` cannot
 * be forgotten and make a changed row compare equal (a stale card). `payload` is the delivered
 * envelope's own object, held by the store across revisions. A row whose envelope has no payload
 * gets a fresh `{}` each pass, so it takes a new identity and redraws each time; that is correct,
 * and it costs one row.
 */
function hasSameMembers(previous: TranscriptEventRow, candidate: TranscriptEventRow): boolean {
  const previousMembers = new Map<string, unknown>(Object.entries(previous));
  const candidateMembers = Object.entries(candidate);
  if (previousMembers.size !== candidateMembers.length) {
    return false;
  }
  return candidateMembers.every(
    ([memberName, value]) =>
      previousMembers.has(memberName) && Object.is(previousMembers.get(memberName), value),
  );
}
