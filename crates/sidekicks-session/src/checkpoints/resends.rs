//! The edited message of an undo's resend, kept under the undo's key from before its cut until its
//! hold is let go, so a daemon that stops in between puts the words back into the session's draft
//! at its next start rather than losing them, and marks them returned, so a retry under the key
//! never sends them beside the draft.

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

// A retried undo under the same key keeps its newest edit, and a resend returned stays returned.
static STAGE_RESEND_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_restore_resends
    (session_id, client_idempotency_key, resend, created_at)
  VALUES (@sessionId, @key, @resend, {DATABASE_NOW_SQL})
  ON CONFLICT (session_id, client_idempotency_key) DO UPDATE SET resend = excluded.resend"
    )
});

// A returned resend's row stays, so its key's retry reads it returned.
const UNSTAGE_RESEND_SQL: &str = "DELETE FROM session_restore_resends
  WHERE session_id = @sessionId AND client_idempotency_key = @key AND returned_at IS NULL";

static MARK_RETURNED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE session_restore_resends SET returned_at = {DATABASE_NOW_SQL}
  WHERE session_id = @sessionId AND client_idempotency_key = @key"
    )
});

// A resend the release already sent stands as a queue item under the undo's key.
const STAGED_RESENDS_SQL: &str = "SELECT session_id, client_idempotency_key, resend,
    EXISTS (SELECT 1 FROM queue_items AS sent
      WHERE sent.session_id = kept.session_id
        AND sent.client_idempotency_key = kept.client_idempotency_key)
  FROM session_restore_resends AS kept WHERE returned_at IS NULL ORDER BY created_at, rowid";

const IS_RETURNED_SQL: &str = "SELECT EXISTS (SELECT 1 FROM session_restore_resends
  WHERE session_id = ?1 AND client_idempotency_key = ?2 AND returned_at IS NOT NULL)";

/// An undo's resend a stop left kept: its session, the undo's key, and the edited message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedResend {
    /// The session undone.
    pub session_id: SessionId,
    /// The undo's key.
    pub undo_key: ClientUuid,
    /// The edited message.
    pub resend: SessionRestoreResend,
    /// Whether the release sent it before the stop, its row not yet dropped.
    pub is_sent: bool,
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

/// The statement that drops what `session_id`'s undo `undo_key` kept; none kept, or one a start
/// returned to the draft, drops nothing.
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

/// Every resend kept and not yet returned, oldest first. Fails as SQLite does, or when a stored
/// column does not read.
pub fn read_staged_resends(connection: &Connection) -> rusqlite::Result<Vec<StagedResend>> {
    connection
        .prepare_cached(STAGED_RESENDS_SQL)?
        .query_map([], |row| {
            Ok(StagedResend {
                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                undo_key: text_column(row, 1, ClientUuid::new)?,
                resend: text_column(row, 2, |text| serde_json::from_str(&text))?,
                is_sent: row.get(3)?,
            })
        })?
        .collect()
}

/// Whether a start put `session_id`'s undo `undo_key`'s edited message back into the draft, so
/// the undo sends nothing under the key. Fails as SQLite does.
pub fn is_resend_returned(
    connection: &Connection,
    session_id: SessionId,
    undo_key: &ClientUuid,
) -> rusqlite::Result<bool> {
    connection
        .prepare_cached(IS_RETURNED_SQL)?
        .query_row([session_id.text().as_str(), undo_key.as_str()], |row| {
            row.get(0)
        })
}

/// The statements of one write that put `staged`'s edited message back into its session's draft,
/// as a Stop returns a message, and mark it returned; one the release already sent is dropped from
/// the kept resends instead.
pub fn return_staged_resend_statements(
    staged: &StagedResend,
    now: &WireInstant,
) -> Vec<WriteStatement> {
    if staged.is_sent {
        return vec![unstage_resend_statement(
            staged.session_id,
            &staged.undo_key,
        )];
    }
    let returned = WriteStatement {
        sql: Cow::Borrowed(MARK_RETURNED_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", staged.session_id.text().as_str()),
            text_binding("@key", staged.undo_key.as_str()),
        ]),
        expected_row_count: Some(1),
    };
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
        .chain([returned])
        .collect()
}
