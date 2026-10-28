//! The `session.search` cursor: which held search it continues, and where the next page starts. A
//! search's later pages read what its first page held, so a cursor names that search by its id
//! and a place in its order of sessions; a cursor of a search no longer held continues nothing.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::methods::SessionSearchCursor;
use sidekicks_ipc::domain_error::DomainError;

/// Where a page starts in a held search: at a session of the search's order, past its best hits
/// when an earlier page showed some, named by the last one's index key, whose place among the
/// session's hits the held view keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SearchPagePosition {
    /// The session's place in the search's order.
    pub(crate) session_index: usize,
    /// The index key of the last hit an earlier page showed in that session, if any.
    pub(crate) after_hit_key: Option<u64>,
}

/// A cursor read back: the held search it continues, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SearchCursorPosition {
    /// The held search's id.
    pub(crate) snapshot_id: String,
    /// Where its next page starts.
    pub(crate) position: SearchPagePosition,
}

static CURSOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^([0-9a-f-]+):(0|[1-9][0-9]*)(?::(0|[1-9][0-9]*))?$")
        .expect("the cursor pattern is a valid regular expression")
});

/// Writes a held search's next page position as the cursor a client passes back; `snapshot_id`
/// is the held search's UUID.
pub(crate) fn encode_search_cursor(
    snapshot_id: &str,
    position: SearchPagePosition,
) -> SessionSearchCursor {
    let after_hit_key = position
        .after_hit_key
        .map_or_else(String::new, |key| format!(":{key}"));
    SessionSearchCursor::new(format!(
        "{snapshot_id}:{}{after_hit_key}",
        position.session_index
    ))
    .expect("a snapshot UUID and two integers run to at most 78 characters, inside the bound")
}

/// Reads a cursor back. Fails with `session.search.cursorUnresolvable` for a cursor
/// [`encode_search_cursor`] did not write.
pub(crate) fn decode_search_cursor(
    cursor: &SessionSearchCursor,
) -> Result<SearchCursorPosition, DomainError> {
    let parts = CURSOR
        .captures(cursor.as_str())
        .ok_or_else(|| search_cursor_unresolvable(cursor))?;
    let session_index = parts[2]
        .parse()
        .map_err(|error| search_cursor_unresolvable(cursor).with_source(error))?;
    let after_hit_key = parts
        .get(3)
        .map(|key| key.as_str().parse())
        .transpose()
        .map_err(|error| search_cursor_unresolvable(cursor).with_source(error))?;
    Ok(SearchCursorPosition {
        snapshot_id: parts[1].to_owned(),
        position: SearchPagePosition {
            session_index,
            after_hit_key,
        },
    })
}

/// The refusal of a cursor that continues no search the daemon holds for this query: one it did
/// not write, one written for another query, or one whose search it has since let go.
pub(crate) fn search_cursor_unresolvable(cursor: &SessionSearchCursor) -> DomainError {
    DomainError::new(
        "The search cursor does not continue a search the daemon holds.",
        RefusalCode::SessionSearchCursorUnresolvable,
    )
    .with_detail(json!({ "cursor": cursor.as_str() }))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::methods::SessionSearchCursor;

    use super::{SearchPagePosition, decode_search_cursor, encode_search_cursor};

    const SNAPSHOT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f";

    #[rstest]
    #[case(
        "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f:0",
        Some(SearchPagePosition { session_index: 0, after_hit_key: None })
    )]
    #[case(
        "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f:17:9007199254740991",
        Some(SearchPagePosition { session_index: 17, after_hit_key: Some(9_007_199_254_740_991) })
    )]
    #[case("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f", None)]
    #[case("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f:", None)]
    #[case("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f:01", None)]
    #[case("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f:-1", None)]
    #[case("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f:1:", None)]
    #[case("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f:1:2:3", None)]
    #[case("0199C1A2-7B3E-7C4D-8E5F-0A1B2C3D4E5F:1", None)]
    #[case(":1", None)]
    #[case("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e5f:1:99999999999999999999999", None)]
    fn a_cursor_reads_back_only_as_the_daemon_writes_it(
        #[case] text: &str,
        #[case] expected: Option<SearchPagePosition>,
    ) {
        let cursor = SessionSearchCursor::new(text.to_owned()).expect("a cursor's length");
        if let Some(position) = expected {
            assert_eq!(encode_search_cursor(SNAPSHOT_ID, position), cursor);
            let decoded = decode_search_cursor(&cursor).expect("a written cursor reads back");
            assert_eq!(decoded.snapshot_id, SNAPSHOT_ID);
            assert_eq!(decoded.position, position);
        } else {
            let refusal = decode_search_cursor(&cursor).expect_err("the cursor is refused");
            assert_eq!(refusal.code, RefusalCode::SessionSearchCursorUnresolvable);
        }
    }
}
