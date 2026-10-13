//! The session search's limits. The `session.search` and `session.fileSearch` types are built from
//! them; the cursor refusal is `RefusalCode::SessionSearchCursorUnresolvable`.

/// The longest query `session.search` and `session.fileSearch` accept, in code points.
pub const SESSION_SEARCH_QUERY_MAX_LEN: usize = 256;

/// The most hits one `session.search` page carries, across all its sessions.
pub const SESSION_SEARCH_PAGE_LIMIT_MAX: usize = 256;

/// The longest line a `session.search` hit carries, in code points: the stretch of a message
/// around its matches.
pub const SESSION_SEARCH_HIT_LINE_MAX_LEN: usize = 4096;
