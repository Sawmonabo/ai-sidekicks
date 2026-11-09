//! The edited message of an undo's resend, kept under the undo's key from before its cut until its
//! hold is let go, so a daemon that stops in between puts the words back into the session's draft
//! at its next start rather than losing them.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::Connection;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::SessionRestoreResend;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::text_column;

use crate::draft_store::returned_messages_statement;
use crate::queue_store::QueueMessageBody;

// A retried undo under the same key keeps its newest edit.
static STAGE_RESEND_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_restore_resends
    (session_id, client_idempotency_key, resend, created_at)
  VALUES (@sessionId, @key, @resend, {DATABASE_NOW_SQL})
  ON CONFLICT (session_id, client_idempotency_key) DO UPDATE SET resend = excluded.resend"
    )
});

const UNSTAGE_RESEND_SQL: &str = "DELETE FROM session_restore_resends
  WHERE session_id = @sessionId AND client_idempotency_key = @key";

const STAGED_RESENDS_SQL: &str = "SELECT session_id, client_idempotency_key, resend
  FROM session_restore_resends ORDER BY created_at, rowid";

/// An undo's resend a stop left kept: its session, the undo's key, and the edited message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedResend {
    /// The session undone.
    pub session_id: SessionId,
    /// The undo's key.
    pub undo_key: ClientUuid,
    /// The edited message.
    pub resend: SessionRestoreResend,
}

/// The statement that keeps `resend` for `session_id`'s undo `undo_key`, replacing what a retry
/// under the same key kept.
pub fn stage_resend_statement(
    session_id: SessionId,
    undo_key: &ClientUuid,
    resend: &SessionRestoreResend,
) -> WriteStatement {
    let resend = serde_json::to_string(resend).expect("an undo's resend writes as JSON");
    WriteStatement {
        sql: Cow::Borrowed(STAGE_RESEND_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@key", undo_key.as_str()),
            text_binding("@resend", &resend),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that drops what `session_id`'s undo `undo_key` kept; none kept drops nothing.
pub fn unstage_resend_statement(session_id: SessionId, undo_key: &ClientUuid) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UNSTAGE_RESEND_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@key", undo_key.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// Every resend kept, oldest first. Fails as SQLite does, or when a stored column does not read.
pub fn read_staged_resends(connection: &Connection) -> rusqlite::Result<Vec<StagedResend>> {
    connection
        .prepare_cached(STAGED_RESENDS_SQL)?
        .query_map([], |row| {
            Ok(StagedResend {
                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                undo_key: text_column(row, 1, ClientUuid::new)?,
                resend: text_column(row, 2, |text| serde_json::from_str(&text))?,
            })
        })?
        .collect()
}

/// The statements of one write that put `staged`'s edited message back into its session's draft,
/// as a Stop returns a message, and drop it from the kept resends.
pub fn return_staged_resend_statements(
    staged: &StagedResend,
    now: &WireInstant,
) -> Vec<WriteStatement> {
    let resend = &staged.resend;
    let body = QueueMessageBody {
        content: resend.content.clone(),
        attachments: resend.attachments.clone(),
        skills: None,
        skill_picks: resend.skills.clone(),
        answers_question_id: None,
        output_speed_for_turn: resend.output_speed_for_turn.clone(),
        workspace_id: None,
    };
    returned_messages_statement(&staged.session_id, &[&body], now)
        .into_iter()
        .chain([unstage_resend_statement(
            staged.session_id,
            &staged.undo_key,
        )])
        .collect()
}
