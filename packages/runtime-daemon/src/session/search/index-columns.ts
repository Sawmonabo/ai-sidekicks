// How the full-text index's rows are keyed. A row's rowid is its source row's rowid times four
// plus its kind's slot, so a search reaches a session's title, group or tag row by arithmetic.
// A session's id is held in the `session_key` column as its UUID without the hyphens, which the
// tokenizer would split on, so the id is one token and a search inside one session is answered
// from that token's own entries in the index.

/** What an index row holds: a log row's text, a session's title, a group's name or a tag. */
export type IndexRowKind = "event" | "title" | "group" | "tag";

const INDEX_ROW_SLOTS: Readonly<Record<IndexRowKind, number>> = {
  event: 0,
  title: 1,
  group: 2,
  tag: 3,
};

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
  return `(${rowidSql} * 4 + ${String(INDEX_ROW_SLOTS[kind])})`;
}

/** The SQL for the source rowid of the `kind` index row whose rowid is `indexRowidSql`. */
export function sourceRowidSql(indexRowidSql: string, kind: IndexRowKind): string {
  return `((${indexRowidSql} - ${String(INDEX_ROW_SLOTS[kind])}) / 4)`;
}

/** The SQL that holds while the index row whose rowid is `indexRowidSql` is a log row's. */
export function isEventRowSql(indexRowidSql: string): string {
  return `${indexRowidSql} % 4 = ${String(INDEX_ROW_SLOTS.event)}`;
}

/** Whether the index row with this rowid is a log row's; {@link isEventRowSql} in code. */
export function isEventRowid(indexRowid: number): boolean {
  return indexRowid % 4 === INDEX_ROW_SLOTS.event;
}
