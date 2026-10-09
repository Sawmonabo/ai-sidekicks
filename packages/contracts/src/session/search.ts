// The session search's limits and the code of its cursor refusal. The `session.search` schemas in
// `methods.ts` are built from them; this module builds none, so code that only builds search pages
// loads no schema library.

/** The longest query `session.search` and `session.fileSearch` accept. */
export const SESSION_SEARCH_QUERY_MAX_LEN = 256;

/** The most hits one `session.search` page carries, across all its sessions. */
export const SESSION_SEARCH_PAGE_LIMIT_MAX = 256;

/** The longest line a `session.search` hit carries: the stretch of a message around its matches. */
export const SESSION_SEARCH_HIT_LINE_MAX_LEN = 4096;

/**
 * A `session.search` cursor the daemon did not write, one written for another kind of query, or
 * one whose search the daemon no longer holds.
 */
export const SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE =
  "session.search_cursor_unresolvable" as const;
