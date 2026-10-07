// How the full-text index's rows are keyed. A row's rowid is its source row's rowid times the
// number of kinds plus its kind's slot, so a search reaches a session's title, group or tag row
// by arithmetic.
// A session's id is held in the `session_key` column as its UUID without the hyphens, which the
// tokenizer would split on, so the id is one token and a search inside one session is answered
// from that token's own entries in the index.

// Each kind's slot is its place in this list.
const INDEX_ROW_KINDS = ["event", "title", "group", "tag"] as const;

/** What an index row holds: a log row's text, a session's title, a group's name or a tag. */
export type IndexRowKind = (typeof INDEX_ROW_KINDS)[number];

// One rowid slot per kind, so every source row owns this many index rowids.
const SLOT_COUNT = INDEX_ROW_KINDS.length;

/** The SQL that turns a session id held in `idSql` into its `session_key` token. */
export function sessionKeySql(idSql: string): string {
  return `replace(${idSql}, '-', '')`;
}

/** A session's `session_key` token, as {@link sessionKeySql} writes it. */
export function sessionKeyOf(sessionId: string): string {
  return sessionId.replaceAll("-", "");
}

/** The SQL for the rowid of the `kind` index row of the source row whose rowid is `rowidSql`. */
export function indexRowidSql(rowidSql: string, kind: IndexRowKind): string {
  return `(${rowidSql} * ${String(SLOT_COUNT)} + ${String(INDEX_ROW_KINDS.indexOf(kind))})`;
}

/** The SQL for the source rowid of the `kind` index row whose rowid is `indexRowidSql`. */
export function sourceRowidSql(indexRowidSql: string, kind: IndexRowKind): string {
  return `((${indexRowidSql} - ${String(INDEX_ROW_KINDS.indexOf(kind))}) / ${String(SLOT_COUNT)})`;
}

/** The SQL that holds while the index row whose rowid is `indexRowidSql` is a log row's. */
export function isEventRowSql(indexRowidSql: string): string {
  return `${indexRowidSql} % ${String(SLOT_COUNT)} = ${String(INDEX_ROW_KINDS.indexOf("event"))}`;
}

/** The kind of the index row with this rowid. */
export function indexRowKindOf(indexRowid: number): IndexRowKind {
  return INDEX_ROW_KINDS[indexRowid % SLOT_COUNT]!;
}

/** The rowid of the source row behind the index row with this rowid, as {@link sourceRowidSql}. */
export function sourceRowidOf(indexRowid: number): number {
  return Math.floor(indexRowid / SLOT_COUNT);
}
