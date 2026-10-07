// How a session's id is held in the full-text index's `session_key` column: its UUID without the
// hyphens, which the tokenizer would split on, so the id is one token and a search inside one
// session is answered from that token's own entries in the index.

/** The SQL that turns a session id held in `idSql` into its `session_key` token. */
export function sessionKeySql(idSql: string): string {
  return `replace(${idSql}, '-', '')`;
}
