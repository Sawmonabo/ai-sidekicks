// How the full-text index's rows are keyed. A row's rowid is its source row's rowid times the
// number of kinds plus its kind's slot, so a search reaches a session's title, group or tag row
// by arithmetic.
// Each row's owner, the session a log, title or tag row belongs to or the group a group row names,
// is held in the `owner_key` column as its UUID without the hyphens, which the tokenizer would
// split on, so the id is one token and a search limited to some sessions and their groups is
// answered from those tokens' own entries in the index.

// Each kind's slot is its place in this list.
const INDEX_ROW_KINDS = ["event", "title", "group", "tag"] as const;

/** What an index row holds: a log row's text, a session's title, a group's name or a tag. */
export type IndexRowKind = (typeof INDEX_ROW_KINDS)[number];

// One rowid slot per kind, so every source row owns this many index rowids.
const SLOT_COUNT = INDEX_ROW_KINDS.length;

/** The SQL that turns a session's or group's id held in `idSql` into its `owner_key` token. */
export function ownerKeySql(idSql: string): string {
  return `replace(${idSql}, '-', '')`;
}

// A session's or group's `owner_key` token, as `ownerKeySql` writes it.
function ownerKeyOf(ownerId: string): string {
  return ownerId.replaceAll("-", "");
}

/** The owners of some sessions' rows: each session, and the group it is in, each once. */
export function ownerIdsOf(
  sessions: readonly { readonly sessionId: string; readonly groupId: string | null }[],
): string[] {
  const ownerIds = new Set<string>();
  for (const { sessionId, groupId } of sessions) {
    ownerIds.add(sessionId);
    if (groupId !== null) {
      ownerIds.add(groupId);
    }
  }
  return [...ownerIds];
}

/** The match limited to the rows these sessions and groups own, through each one's key. */
export function narrowToOwners(matchExpression: string, ownerIds: readonly string[]): string {
  const keys = ownerIds.map((ownerId) => `"${ownerKeyOf(ownerId)}"`).join(" OR ");
  return `(${matchExpression}) AND owner_key : (${keys})`;
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
