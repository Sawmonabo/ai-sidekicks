//! The conversation cuts recorded under an undo's key once the cut applied, with the checkpoint
//! the undo's files go back to, the message the undo resends, where the session's log stood at the
//! cut and, once the files went back, what their put-back did, so a retry under that key after an
//! outcome the daemon could not read never cuts again, finishes the files to the point the cut took
//! away while no lead turn has started since, and sends the resend.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreFileOutcome, SessionRestoreResend, SnapshotId,
};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

use super::store::Checkpoint;
use super::store::kept::read_kept_checkpoint;

static RECORD_CUT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_restore_cuts
    (session_id, client_idempotency_key, checkpoint_id, resend, cut_sequence, created_at)
  VALUES (@sessionId, @key, @checkpointId, @resend,
    (SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id = @sessionId),
    {DATABASE_NOW_SQL})"
    )
});

const RECORD_FILES_SQL: &str = "UPDATE session_restore_cuts SET files_outcome = @filesOutcome
  WHERE session_id = @sessionId AND client_idempotency_key = @key";

// A turn of a lead run that started after the cut's write; a child run's turn leaves the files.
static RECORDED_CUT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT checkpoint_id, resend, files_outcome,
    EXISTS (SELECT 1 FROM session_events AS started JOIN runs ON runs.run_id = started.run_id
      WHERE started.session_id = cut.session_id AND started.sequence > cut.cut_sequence
        AND started.type = '{turn_started}' AND runs.parent_run_id IS NULL)
  FROM session_restore_cuts AS cut
  WHERE session_id = @sessionId AND client_idempotency_key = @key",
        turn_started = SessionEventType::AgentTurnStarted.as_str(),
    )
});

/// What an undo's key recorded of its conversation cut.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedCut {
    /// The checkpoint the undo's files go back to, as the cut read it.
    pub checkpoint: Checkpoint,
    /// The message the undo resends once its cut applied, `None` for an undo with no resend.
    pub resend: Option<SessionRestoreResend>,
    /// What the files' put-back did once every file went back, `None` until then.
    pub files: Option<SessionRestoreFileOutcome>,
    /// Whether a lead turn started after the cut was recorded, so the files a retry would finish
    /// may hold that turn's work.
    pub is_lead_turn_started_since: bool,
}

/// The statement that records the conversation cut of `session_id`'s undo `undo_key`, whose files
/// go back to `checkpoint_id` and which resends `resend`; a second one under the same key is
/// refused, so a write holding it fails whole.
pub fn record_cut_statement(
    session_id: SessionId,
    undo_key: &ClientUuid,
    checkpoint_id: &SnapshotId,
    resend: Option<&SessionRestoreResend>,
) -> WriteStatement {
    let resend = resend.map(|resend| serde_json::to_string(resend).expect("a resend is JSON"));
    WriteStatement {
        sql: Cow::Borrowed(RECORD_CUT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@key", undo_key.as_str()),
            text_binding("@checkpointId", checkpoint_id.as_str()),
            nullable_text_binding("@resend", resend.as_deref()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that records `files`, what the put-back of the files of `session_id`'s undo
/// `undo_key` did once every file went back, beside the cut it recorded; refused where the key
/// recorded no cut.
pub fn record_files_statement(
    session_id: SessionId,
    undo_key: &ClientUuid,
    files: &SessionRestoreFileOutcome,
) -> WriteStatement {
    let files = serde_json::to_string(files).expect("a file outcome serializes");
    WriteStatement {
        sql: Cow::Borrowed(RECORD_FILES_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@filesOutcome", &files),
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@key", undo_key.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// What `session_id`'s undo `undo_key` recorded of its conversation cut, `None` where it recorded
/// none. Fails as SQLite does, and as a conversion failure where the stored resend or files'
/// outcome does not read or the checkpoint the cut named is gone.
pub fn read_recorded_cut(
    connection: &Connection,
    session_id: SessionId,
    undo_key: &ClientUuid,
) -> rusqlite::Result<Option<RecordedCut>> {
    let Some((checkpoint_id, resend, files, is_lead_turn_started_since)) = connection
        .prepare_cached(RECORDED_CUT_SQL.as_str())?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@key": undo_key.as_str(),
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let conversion = |column: usize, error: Box<dyn std::error::Error + Send + Sync>| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Text, error)
    };
    let checkpoint_id = SnapshotId::new(checkpoint_id)
        .ok_or_else(|| conversion(0, "the cut's checkpoint id does not read".into()))?;
    let checkpoint = read_kept_checkpoint(connection, session_id, &checkpoint_id)?
        .ok_or_else(|| conversion(0, "the checkpoint the cut named is gone".into()))?;
    let resend = resend
        .map(|resend| serde_json::from_str(&resend))
        .transpose()
        .map_err(|error| conversion(1, error.into()))?;
    let files = files
        .map(|files| serde_json::from_str(&files))
        .transpose()
        .map_err(|error| conversion(2, error.into()))?;
    Ok(Some(RecordedCut {
        checkpoint,
        resend,
        files,
        is_lead_turn_started_since,
    }))
}
