//! Each session's unsent composer draft, one `session_drafts` row per session: its words, and what
//! rides with them as JSON. The last write wins, so a retried save needs no key; an empty draft
//! deletes the row, which is how Send clears it.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::session::draft::{SessionDraft, SessionDraftExtras};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{StoredJsonFault, optional_text_column};
use sidekicks_store::database::writer::DatabaseWriter;

use crate::directory::lookups::{SessionWriteError, write_while_session_exists};
use crate::queue_store::QueueMessageBody;

/// The statements the store's reads run: the held draft.
pub const SESSION_DRAFT_STORE_STATEMENT_CAPACITY: usize = 1;

const SELECT_DRAFT_SQL: &str =
    "SELECT text, extras FROM session_drafts WHERE session_id = @sessionId";

const UPSERT_DRAFT_SQL: &str = "INSERT INTO session_drafts (session_id, text, extras, updated_at)
  VALUES (@sessionId, @text, @extras, @updatedAt)
  ON CONFLICT (session_id) DO UPDATE SET
    text = excluded.text, extras = excluded.extras, updated_at = excluded.updated_at";

// Puts the returned words on their own line ahead of the held draft's, and joins the returned
// extras to the held ones: files and skill picks after the held draft's, a speed or a repository
// only where the held draft names none. One statement, so a draft saved beside it is never read
// stale.
static JOIN_RETURNED_DRAFT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_drafts (session_id, text, extras, updated_at)
  VALUES (@sessionId, @text, @extras, @updatedAt)
  ON CONFLICT (session_id) DO UPDATE SET
    text = CASE WHEN session_drafts.text = '' THEN excluded.text
                ELSE excluded.text || char(10) || session_drafts.text END,
    extras = CASE WHEN excluded.extras IS NULL THEN session_drafts.extras
                  WHEN session_drafts.extras IS NULL THEN excluded.extras
                  ELSE json_patch(
                    json_patch(excluded.extras, session_drafts.extras),
                    json_object('attachments', {attachments}, 'skills', {skills})) END,
    updated_at = excluded.updated_at",
        attachments = joined_list_sql("$.attachments"),
        skills = joined_list_sql("$.skills"),
    )
});

const DELETE_DRAFT_SQL: &str = "DELETE FROM session_drafts WHERE session_id = @sessionId";

// The held draft's list at `path` followed by the returned draft's, as JSON, or `NULL` where
// neither holds one, which `json_patch` drops. `->>` renders each list as SQLite's JSON text, so its
// brackets are its first and last characters.
fn joined_list_sql(path: &str) -> String {
    let held = format!("session_drafts.extras ->> '{path}'");
    let returned = format!("excluded.extras ->> '{path}'");
    format!(
        "json(CASE
          WHEN json_array_length(session_drafts.extras, '{path}') > 0
            AND json_array_length(excluded.extras, '{path}') > 0
            THEN substr({held}, 1, length({held}) - 1) || ',' || substr({returned}, 2)
          WHEN json_array_length(session_drafts.extras, '{path}') > 0 THEN {held}
          ELSE {returned} END)"
    )
}

/// Why a draft was not read or stored; a refused store keeps nothing.
#[derive(Debug, thiserror::Error)]
pub enum SessionDraftError {
    /// The session is not one this daemon holds (`session.notFound`), or the write was not kept.
    #[error(transparent)]
    Write(#[from] SessionWriteError),
    /// SQLite refused the read.
    #[error("a read of a session's draft failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<SessionDraftError> for HandlerError {
    /// A store refused for its session answers as that refusal does; a failed read is a fault in
    /// the daemon.
    fn from(error: SessionDraftError) -> Self {
        match error {
            SessionDraftError::Write(write) => write.into(),
            fault @ (SessionDraftError::Database(_) | SessionDraftError::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Reads each session's draft through the daemon's read pool and stores it through its writer.
pub struct SessionDraftStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl SessionDraftStore {
    /// The store reading through `pool` and writing through `writer`.
    pub fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// The session's held draft, or an empty one when none is held. Fails with
    /// [`SessionDraftError::Database`] or [`SessionDraftError::Pool`] when the read does, including
    /// stored extras that don't parse.
    pub async fn read(&self, session_id: SessionId) -> Result<SessionDraft, SessionDraftError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                let draft = connection
                    .prepare_cached(SELECT_DRAFT_SQL)?
                    .query_row(
                        named_params! { "@sessionId": session_id.text().as_str() },
                        |row| {
                            Ok(SessionDraft {
                                text: row.get(0)?,
                                extras: optional_text_column(row, 1, |text| {
                                    serde_json::from_str::<SessionDraftExtras>(&text)
                                        .map_err(StoredJsonFault::from)
                                })?
                                .unwrap_or_default(),
                            })
                        },
                    )
                    .optional()?;
                Ok(draft.unwrap_or_default())
            })
            .await
    }

    /// Holds `draft` as the session's draft, or clears the draft when it is empty, and answers
    /// when it was stored once committed. Fails with [`SessionDraftError::Write`]:
    /// `session.notFound` for a session this daemon holds no row for, or the write not kept.
    pub async fn write(
        &self,
        session_id: SessionId,
        draft: SessionDraft,
    ) -> Result<WireInstant, SessionDraftError> {
        let updated_at = WireInstant::now();
        let session_text = session_id.text();
        let change = if draft.is_empty() {
            WriteStatement {
                sql: Cow::Borrowed(DELETE_DRAFT_SQL),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@sessionId",
                    session_text.as_str(),
                )]),
                expected_row_count: None,
            }
        } else {
            draft_statement(UPSERT_DRAFT_SQL, &session_id, draft, &updated_at)
        };
        write_while_session_exists(&self.writer, &session_id, change).await?;
        Ok(updated_at)
    }
}

/// The write that puts `messages`, the lead messages a Stop or an interrupt returns in queue order,
/// back into `session_id`'s draft whole, for a caller's own write: their words one line each ahead
/// of the held draft's, their files and skill picks after the held draft's, and the first speed and
/// repository among them where the held draft names none. `None` when no message is returned.
pub fn returned_messages_statement(
    session_id: &SessionId,
    messages: &[&QueueMessageBody],
    now: &WireInstant,
) -> Option<WriteStatement> {
    if messages.is_empty() {
        return None;
    }
    let text = messages
        .iter()
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let attachments: Vec<_> = messages
        .iter()
        .flat_map(|message| message.attachment_ids())
        .collect();
    let skills: Vec<_> = messages
        .iter()
        .flat_map(|message| message.skill_picks.iter().flatten().cloned())
        .collect();
    let extras = SessionDraftExtras {
        attachments: (!attachments.is_empty()).then_some(AttachmentReferenceList(attachments)),
        skills: (!skills.is_empty()).then_some(skills),
        output_speed_for_turn: messages
            .iter()
            .find_map(|message| message.output_speed_for_turn.clone()),
        workspace_id: messages.iter().find_map(|message| message.workspace_id),
    };
    Some(draft_statement(
        JOIN_RETURNED_DRAFT_SQL.as_str(),
        session_id,
        SessionDraft { text, extras },
        now,
    ))
}

// The draft write `sql` of `draft` for `session_id` at `updated_at`, its extras `NULL` when none
// ride with the words.
fn draft_statement(
    sql: &'static str,
    session_id: &SessionId,
    draft: SessionDraft,
    updated_at: &WireInstant,
) -> WriteStatement {
    let SessionDraft { text, extras } = draft;
    let extras = if extras.is_empty() {
        Value::Null
    } else {
        Value::Text(serde_json::to_string(&extras).expect("typed draft extras serialize to JSON"))
    };
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            (Cow::Borrowed("@text"), Value::Text(text)),
            (Cow::Borrowed("@extras"), extras),
            text_binding("@updatedAt", updated_at.as_str()),
        ]),
        expected_row_count: None,
    }
}
