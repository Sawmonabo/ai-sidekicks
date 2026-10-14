//! The links the daemon records from events: written inside the producing event's own write, so a
//! link exists exactly when its event does, and named by session id, so a rename changes none.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::links::SessionLinkKind;

use crate::database::statement::{StatementBindings, WriteStatement};

/// One link an event records, from the session that acted to the one it acted on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RecordedSessionLink {
    /// The session that acted.
    pub(crate) source_session_id: SessionId,
    /// The session it acted on.
    pub(crate) target_session_id: SessionId,
    /// What it did: any kind but `related`, which a person adds; none is ever removed.
    pub(crate) kind: SessionLinkKind,
    /// When the event occurred, in the stored form.
    pub(crate) occurred_at: String,
}

// A repeat of the same pair and kind is one more use: `messaged` counts the messages traded.
const RECORD_LINK_SQL: &str = "INSERT INTO session_links
    (source_session_id, target_session_id, kind, use_count, first_at, last_at)
  VALUES (@sourceSessionId, @targetSessionId, @kind, 1, @occurredAt, @occurredAt)
  ON CONFLICT (source_session_id, target_session_id, kind)
  DO UPDATE SET use_count = use_count + 1, last_at = excluded.last_at";

/// The statement an event's producer puts in that event's write to record its link, or count one
/// more use of it. Once the write commits, the producer asks the related ranking to re-score
/// around the two sessions.
pub(crate) fn recorded_session_link_statement(link: &RecordedSessionLink) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RECORD_LINK_SQL),
        bindings: StatementBindings::Named(vec![
            (
                Cow::Borrowed("@sourceSessionId"),
                Value::Text(link.source_session_id.as_str().to_owned()),
            ),
            (
                Cow::Borrowed("@targetSessionId"),
                Value::Text(link.target_session_id.as_str().to_owned()),
            ),
            (
                Cow::Borrowed("@kind"),
                Value::Text(<&'static str>::from(link.kind).to_owned()),
            ),
            (
                Cow::Borrowed("@occurredAt"),
                Value::Text(link.occurred_at.clone()),
            ),
        ]),
        expected_row_count: None,
    }
}
