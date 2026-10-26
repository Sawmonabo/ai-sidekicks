//! The `sessions` rows as list entries: one statement names every fact a row draws, its group's
//! name, project, activity and a chat's document count among them, read a page at a time for the
//! opening list and by id for the sessions that changed.

use std::sync::LazyLock;

use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::session::directory::{
    SessionListChatEntry, SessionListEntry, SessionListGroup, SessionListProjectEntry,
};
use sidekicks_contracts::session::groups::SessionGroupId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::session::directory::lookups::session_project_sql;
use crate::session::directory::run_activity::session_activity_sql;

/// The statements the list's reads prepare, counted into the read pool's statement capacity.
pub(crate) const SESSION_LIST_ROWS_STATEMENT_CAPACITY: usize = 2;

/// The rows one read of the opening list takes, so no read holds a connection for the whole list.
pub(super) const OPENING_READ_PAGE_ROWS: usize = 500;

// One session's list facts and the row's position in the table, which the opening read pages by.
// A chat's document count is kept on its managed mount's row, so no folder is walked here.
static SESSION_LIST_ROW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT s.rowid, s.id, s.shape, s.state, s.name, s.first_message_preview, s.branch,
                s.pinned_at, s.muted_at, s.last_activity_at, g.id, g.name,
                {} AS project_id,
                {} AS activity,
                (SELECT mount.document_count FROM repo_mounts AS mount
                  WHERE mount.managed_session_id = s.id) AS document_count
           FROM sessions AS s LEFT JOIN session_groups AS g ON g.id = s.group_id",
        session_project_sql("s.id"),
        session_activity_sql("s.id", "s.last_run_outcome"),
    )
});

static READ_PAGE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{} WHERE s.rowid > @after ORDER BY s.rowid LIMIT @limit",
        *SESSION_LIST_ROW_SQL
    )
});

static READ_SOME_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{} WHERE s.id IN (SELECT value FROM json_each(@sessionIds))",
        *SESSION_LIST_ROW_SQL
    )
});

/// One `sessions` row as the list reads it: the session, its entry, and the row's position.
pub(super) struct SessionListRow {
    /// The row's position in the table.
    pub(super) row_position: i64,
    /// The session.
    pub(super) session_id: SessionId,
    /// Its entry; `None` for a project session with no project, which shows no entry.
    pub(super) entry: Option<SessionListEntry>,
}

/// The rows after `after_position` in table order, at most [`OPENING_READ_PAGE_ROWS`]. Fails when
/// SQLite refuses the read or a stored column does not read as its type.
pub(super) fn read_list_page(
    connection: &Connection,
    after_position: i64,
) -> rusqlite::Result<Vec<SessionListRow>> {
    let limit = i64::try_from(OPENING_READ_PAGE_ROWS).expect("a page's row count fits i64");
    connection
        .prepare_cached(&READ_PAGE_SQL)?
        .query_map(
            named_params! { "@after": after_position, "@limit": limit },
            row_of,
        )?
        .collect()
}

/// The rows of `session_ids` that exist; a purged session has none. Fails as
/// [`read_list_page`] does.
pub(super) fn read_list_rows(
    connection: &Connection,
    session_ids: &[SessionId],
) -> rusqlite::Result<Vec<SessionListRow>> {
    let ids: Vec<String> = session_ids.iter().map(SessionId::to_string).collect();
    let ids = serde_json::to_string(&ids).expect("a list of strings writes as JSON");
    connection
        .prepare_cached(&READ_SOME_SQL)?
        .query_map(named_params! { "@sessionIds": ids }, row_of)?
        .collect()
}

fn row_of(row: &Row<'_>) -> rusqlite::Result<SessionListRow> {
    let session_id = text_column(row, 1, |text| SessionId::new(&text))?;
    let shape: SessionShape = text_column(row, 2, closed_word)?;
    let name = optional_text_column(row, 4, FreeFormText::new)?;
    let first_message_preview = optional_text_column(row, 5, FreeFormText::new)?;
    let state = text_column(row, 3, closed_word)?;
    let activity = text_column(row, 13, closed_word)?;
    let pinned_at = optional_text_column(row, 7, WireInstant::try_from)?;
    let muted = row.get::<_, Option<String>>(8)?.is_some();
    let last_activity_at = text_column(row, 9, WireInstant::try_from)?;
    // Stamped at the read; each emission stamps its own send.
    let activity_renewed_at = WireInstant::now();
    let entry = match shape {
        SessionShape::Chat => Some(SessionListEntry::Chat(SessionListChatEntry {
            session_id,
            name,
            first_message_preview,
            state,
            activity,
            activity_renewed_at,
            pinned_at,
            muted,
            exchange: None,
            last_activity_at,
            document_count: row
                .get::<_, Option<i64>>(14)?
                .map(|count| stored_count(count, 14))
                .transpose()?,
        })),
        SessionShape::Project => {
            match optional_text_column(row, 12, |text| ProjectId::new(&text))? {
                None => None,
                Some(project_id) => {
                    let group =
                        match optional_text_column(row, 10, |text| SessionGroupId::new(&text))? {
                            None => None,
                            Some(group_id) => Some(SessionListGroup {
                                group_id,
                                name: text_column(row, 11, FreeFormText::new)?,
                            }),
                        };
                    Some(SessionListEntry::Project(SessionListProjectEntry {
                        session_id,
                        name,
                        first_message_preview,
                        state,
                        activity,
                        activity_renewed_at,
                        pinned_at,
                        muted,
                        exchange: None,
                        last_activity_at,
                        project_id,
                        branch: optional_text_column(row, 6, FreeFormText::new)?,
                        group,
                    }))
                }
            }
        }
    };
    Ok(SessionListRow {
        row_position: row.get(0)?,
        session_id,
        entry,
    })
}

// A stored count as the wire carries it; a negative one fails the read.
fn stored_count(count: i64, index: usize) -> rusqlite::Result<SafeInt<0>> {
    u64::try_from(count)
        .ok()
        .and_then(SafeInt::new)
        .ok_or(rusqlite::Error::IntegralValueOutOfRange(index, count))
}
