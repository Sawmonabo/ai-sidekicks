// How the search index's rows are keyed. A row's key is its source row's rowid times the number of
// kinds plus its kind's slot, so the key names the row's table and its row there, and a session's
// title or a group's name is reached by arithmetic.

import type { IndexRowKind } from "@ai-sidekicks/search-index";

/** Every kind of index row; each kind's slot is its place in this list. */
export const INDEX_ROW_KINDS: readonly IndexRowKind[] = ["event", "title", "group", "tag"];

// One key slot per kind, so every source row owns this many keys.
const SLOT_COUNT = INDEX_ROW_KINDS.length;

/** The SQL for the key of the `kind` index row of the source row whose rowid is `rowidSql`. */
export function indexKeySql(rowidSql: string, kind: IndexRowKind): string {
  return `(${rowidSql} * ${String(SLOT_COUNT)} + ${String(INDEX_ROW_KINDS.indexOf(kind))})`;
}

/** The key of the `kind` index row of the source row with this rowid, as {@link indexKeySql}. */
export function indexKeyOf(sourceRowid: number, kind: IndexRowKind): number {
  return sourceRowid * SLOT_COUNT + INDEX_ROW_KINDS.indexOf(kind);
}

/** The kind of the index row with this key. */
export function indexRowKindOf(key: number): IndexRowKind {
  return INDEX_ROW_KINDS[key % SLOT_COUNT]!;
}

/** The rowid of the source row behind the index row with this key. */
export function sourceRowidOf(key: number): number {
  return Math.floor(key / SLOT_COUNT);
}
