//! The conversation cuts recorded under an undo's key once the cut applied, with the checkpoint
//! the undo's files go back to, the message the undo resends and, once the files went back, what
//! their put-back did, so a retry under that key after an outcome the daemon could not read never
//! cuts again, finishes the files to the point the cut took away and sends the resend.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension as _, named_params};
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
    (session_id, client_idempotency_key, checkpoint_id, resend, created_at)
  VALUES (@sessionId, @key, @checkpointId, @resend, {DATABASE_NOW_SQL})"
    )
});

const RECORD_FILES_SQL: &str = "UPDATE session_restore_cuts SET files_outcome = @filesOutcome
  WHERE session_id = @sessionId AND client_idempotency_key = @key";

const RECORDED_CUT_SQL: &str = "SELECT checkpoint_id, resend, files_outcome
  FROM session_restore_cuts
  WHERE session_id = @sessionId AND client_idempotency_key = @key";

/// What an undo's key recorded of its conversation cut.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedCut {
    /// The checkpoint the undo's files go back to, as the cut read it.
    pub checkpoint: Checkpoint,
    /// The message the undo resends once its cut applied, `None` for an undo with no resend.
    pub resend: Option<SessionRestoreResend>,
    /// What the files' put-back did once every file went back, `None` until then.
    pub files: Option<SessionRestoreFileOutcome>,
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
    let Some((checkpoint_id, resend, files)) = connection
        .prepare_cached(RECORDED_CUT_SQL)?
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
    }))
}
