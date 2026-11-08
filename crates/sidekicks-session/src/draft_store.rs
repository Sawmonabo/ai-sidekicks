//! Each session's unsent composer draft, one `session_drafts` row per session: its words, what
//! rides with them as JSON, and its revision. A save carries the revision it was typed over and is
//! refused over a newer draft; an empty draft keeps the row, so its revision keeps counting.
//!
//! The draft sits outside the session's event log. A follower gets the held draft at once, then
//! again after each save and after each Stop's or interrupt's return to the draft commits, which it
//! hears from the log by the returned messages' `agent.queueItem.canceled`. Each follower reads on
//! a task of its own, and a read that finds the revision it last sent sends nothing.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::draft::{
    HeldSessionDraft, SessionDraft, SessionDraftExtras, SessionDraftUpdateResponse,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::latest_value::LatestValueOutlet;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{
    StoredJsonFault, optional_text_column, safe_int_column,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};

use crate::directory::lookups::{
    SESSION_CHANGE_STATEMENT_INDEX, SessionWriteError, session_exists, write_while_session_exists,
};
use crate::follower_wakes::{FollowerReadFailure, SessionFollowerWakes, send_each_read};
use crate::queue_store::QueueMessageBody;

/// The statements the store's reads run: the held draft, and whether the session has a row.
pub const SESSION_DRAFT_STORE_STATEMENT_CAPACITY: usize = 2;

const SELECT_DRAFT_SQL: &str =
    "SELECT text, extras, revision FROM session_drafts WHERE session_id = @sessionId";

// Writes the draft at `@revision` only while the held revision, 0 for no row, is the one the save
// was typed over; no row written means the save was stale.
const SAVE_DRAFT_SQL: &str =
    "INSERT INTO session_drafts (session_id, text, extras, revision, updated_at)
  SELECT @sessionId, @text, @extras, @revision, @updatedAt
  WHERE @expectedRevision = COALESCE(
    (SELECT revision FROM session_drafts WHERE session_id = @sessionId), 0)
  ON CONFLICT (session_id) DO UPDATE SET
    text = excluded.text, extras = excluded.extras, revision = excluded.revision,
    updated_at = excluded.updated_at";

// Puts the returned words on their own line ahead of the held draft's, and joins the returned
// extras to the held ones: files and skill picks after the held draft's, each once, a speed or a
// repository only where the held draft names none. One statement, so a draft saved beside it is
// never read stale.
static JOIN_RETURNED_DRAFT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_drafts (session_id, text, extras, revision, updated_at)
  VALUES (@sessionId, @text,
    CASE WHEN @extras IS NULL THEN NULL ELSE json_patch(@extras, {returned_lists}) END,
    1, @updatedAt)
  ON CONFLICT (session_id) DO UPDATE SET
    revision = session_drafts.revision + 1,
    text = CASE WHEN session_drafts.text = '' THEN excluded.text
                ELSE excluded.text || char(10) || session_drafts.text END,
    extras = CASE WHEN excluded.extras IS NULL THEN session_drafts.extras
                  ELSE json_patch(
                    json_patch(excluded.extras, COALESCE(session_drafts.extras, '{{}}')),
                    {joined_lists}) END,
    updated_at = excluded.updated_at",
        returned_lists = extras_lists_sql("NULL", "@extras"),
        joined_lists = extras_lists_sql("session_drafts.extras", "excluded.extras"),
    )
});

// The files and the skill picks of the extras `held` followed by those of `returned`, as a JSON
// object of the two lists to patch over the extras.
fn extras_lists_sql(held: &str, returned: &str) -> String {
    format!(
        "json_object('attachments', {attachments}, 'skills', {skills})",
        attachments = joined_list_sql(held, returned, "$.attachments"),
        skills = joined_list_sql(held, returned, "$.skills"),
    )
}

// The list at `path` of the extras `held` followed by that of `returned`, each item once at its
// first place, or `NULL` where neither holds an item, which `json_patch` drops. Items compare by
// their JSON text, which SQLite renders the same for the same item on either side.
fn joined_list_sql(held: &str, returned: &str, path: &str) -> String {
    format!(
        "(SELECT CASE WHEN COUNT(*) > 0 THEN json_group_array(json(item) ORDER BY place) END
      FROM (SELECT item, MIN(place) AS place
              FROM (SELECT json_quote(value) AS item, key AS place FROM json_each({held}, '{path}')
                    UNION ALL
                    SELECT json_quote(value),
                           key + COALESCE(json_array_length({held}, '{path}'), 0)
                      FROM json_each({returned}, '{path}'))
             GROUP BY item))"
    )
}

/// Why a draft was not read, stored or followed; a refused store keeps nothing.
#[derive(Debug, thiserror::Error)]
pub enum SessionDraftError {
    /// A follow asked for a session this daemon holds no row for (`session.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A save named a session this daemon holds no row for (`session.notFound`), or the writer did
    /// not keep it.
    #[error(transparent)]
    Write(#[from] SessionWriteError),
    /// The draft changed since the revision the save was typed over
    /// (`session.draft.revisionStale`).
    #[error("the draft changed since the revision the save was typed over")]
    RevisionStale,
    /// SQLite refused the read.
    #[error("a read of a session's draft failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<SessionDraftError> for HandlerError {
    /// A refusal answers by its code; a failed read or a save not kept is a fault in the daemon.
    fn from(error: SessionDraftError) -> Self {
        match error {
            SessionDraftError::Refused(refusal) => Self::Refused(refusal),
            SessionDraftError::Write(write) => write.into(),
            stale @ SessionDraftError::RevisionStale => Self::Refused(DomainError::new(
                stale.to_string(),
                RefusalCode::SessionDraftRevisionStale,
            )),
            fault @ (SessionDraftError::Database(_) | SessionDraftError::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

impl FollowerReadFailure for SessionDraftError {
    fn is_pool_closed(&self) -> bool {
        matches!(self, Self::Pool(DatabaseReadError::Closed))
    }
}

/// Reads each session's draft through the daemon's read pool, stores it through its writer, and
/// answers each session's followers.
pub struct SessionDraftStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    /// Each followed session's followers, woken after each of its draft changes.
    followers: Arc<SessionFollowerWakes>,
    // Wakes a session's followers as a return to its draft commits; detached with the store.
    _returns: FollowerAttachment,
}

impl SessionDraftStore {
    /// The store reading through `pool`, writing through `writer`, and hearing from `log_followers`
    /// each Stop's and interrupt's return to a draft as it commits.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        log_followers: &Arc<SessionEventFollowers>,
    ) -> Self {
        let followers = Arc::new(SessionFollowerWakes::default());
        let returned_to = Arc::clone(&followers);
        // A return to the draft commits with each returned message's `agent.queueItem.canceled`.
        // This runs on the writer's pump, so it only raises wakes; a person's own removal of a
        // waiting message raises them too, and the read it costs sends nothing.
        let returns = log_followers.follow_all(move |event| {
            if event.envelope.event_type() == SessionEventType::AgentQueueItemCanceled {
                returned_to.wake(event.envelope.session_id());
            }
            Ok(())
        });
        Self {
            pool,
            writer,
            followers,
            _returns: returns,
        }
    }

    /// The session's held draft with its revision, or an empty one at revision 0 when none is held.
    /// Fails with [`SessionDraftError::Database`] or [`SessionDraftError::Pool`] when the read
    /// does, including stored extras that don't parse and a revision outside the safe integers.
    pub async fn read(&self, session_id: SessionId) -> Result<HeldSessionDraft, SessionDraftError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                Ok(read_held_draft(connection, &session_id)?)
            })
            .await
    }

    /// Holds `draft`, an empty one clearing it, as the session's draft while its revision is still
    /// `expected_revision`, wakes the session's followers, and answers the new revision, one past
    /// it, and when it was stored once committed. Fails with [`SessionDraftError::RevisionStale`]
    /// when the draft changed since, or when no revision follows `expected_revision` within the
    /// safe integers, which no held draft reaches; and with [`SessionDraftError::Write`]:
    /// `session.notFound` for a session this daemon holds no row for, or the write not kept.
    pub async fn write(
        &self,
        session_id: SessionId,
        draft: SessionDraft,
        expected_revision: SafeInt<0>,
    ) -> Result<SessionDraftUpdateResponse, SessionDraftError> {
        let Some(revision) = SafeInt::<1>::new(expected_revision.get() + 1) else {
            return Err(SessionDraftError::RevisionStale);
        };
        let updated_at = WireInstant::now();
        let mut bindings = draft_bindings(&session_id, draft, &updated_at);
        bindings.extend([
            (
                Cow::Borrowed("@expectedRevision"),
                Value::Integer(i64::from(expected_revision)),
            ),
            (
                Cow::Borrowed("@revision"),
                Value::Integer(i64::from(revision)),
            ),
        ]);
        let change = WriteStatement {
            sql: Cow::Borrowed(SAVE_DRAFT_SQL),
            bindings: StatementBindings::Named(bindings),
            expected_row_count: Some(1),
        };
        match write_while_session_exists(&self.writer, &session_id, change).await {
            Ok(_saved) => {}
            Err(SessionWriteError::Write(WriteError::Refused {
                statement_index: SESSION_CHANGE_STATEMENT_INDEX,
                ..
            })) => return Err(SessionDraftError::RevisionStale),
            Err(error) => return Err(error.into()),
        }
        self.followers.wake(session_id);
        Ok(SessionDraftUpdateResponse {
            session_id,
            revision,
            updated_at,
        })
    }

    /// Sends the session's held draft through `outlet` now, then again after each change to it,
    /// until the returned detach runs; a later read that fails ends the stream with that failure,
    /// and the read pool closing at the daemon's stop ends it finished. Refused `session.notFound`
    /// for an unknown session, following nothing; fails when that check's read fails.
    pub async fn follow(
        self: &Arc<Self>,
        session_id: SessionId,
        outlet: LatestValueOutlet<HeldSessionDraft>,
    ) -> Result<Box<dyn FnOnce() + Send>, SessionDraftError> {
        let is_known = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, SessionDraftError>(session_exists(connection, &session_id)?)
            })
            .await?;
        if !is_known {
            return Err(session_not_found(&session_id).into());
        }
        let wake = self.followers.add(session_id);
        // The first read: the draft held now.
        wake.notify_one();
        let store = Arc::clone(self);
        // A read that finds the revision last sent sends nothing.
        let mut sent_revision = None;
        let reading = tokio::spawn(send_each_read(
            Arc::clone(&wake),
            outlet,
            move || {
                let store = Arc::clone(&store);
                async move { store.read(session_id).await }
            },
            move |held: &HeldSessionDraft| {
                let is_sent = sent_revision == Some(held.revision);
                sent_revision = Some(held.revision);
                is_sent
            },
        ));
        let store = Arc::clone(self);
        Ok(Box::new(move || {
            reading.abort();
            store.followers.remove(session_id, &wake);
        }))
    }
}

// The session's held draft read on `connection`, an empty one at revision 0 when none is held.
fn read_held_draft(
    connection: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<HeldSessionDraft> {
    let held = connection
        .prepare_cached(SELECT_DRAFT_SQL)?
        .query_row(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| {
                Ok(HeldSessionDraft {
                    draft: SessionDraft {
                        text: row.get(0)?,
                        extras: optional_text_column(row, 1, |text| {
                            serde_json::from_str::<SessionDraftExtras>(&text)
                                .map_err(StoredJsonFault::from)
                        })?
                        .unwrap_or_default(),
                    },
                    revision: safe_int_column(row, 2)?,
                })
            },
        )
        .optional()?;
    Ok(held.unwrap_or_else(|| HeldSessionDraft {
        draft: SessionDraft::default(),
        revision: SafeInt::from_usize(0),
    }))
}

/// The statement that puts `messages`, the lead messages a Stop or an interrupt returns in queue
/// order, back into `session_id`'s draft whole, for a caller's write that also records each
/// message canceled: their words one line each ahead of the held draft's, their files and skill
/// picks after the held draft's, each once, and the first speed and repository among them where
/// the held draft names none, the draft's revision moving on by one. `None` when no message is
/// returned.
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
    Some(WriteStatement {
        sql: Cow::Borrowed(JOIN_RETURNED_DRAFT_SQL.as_str()),
        bindings: StatementBindings::Named(draft_bindings(
            session_id,
            SessionDraft { text, extras },
            now,
        )),
        expected_row_count: None,
    })
}

// The bindings of `draft` for `session_id` at `updated_at`, its extras `NULL` when none ride with
// the words.
fn draft_bindings(
    session_id: &SessionId,
    draft: SessionDraft,
    updated_at: &WireInstant,
) -> Vec<(Cow<'static, str>, Value)> {
    let SessionDraft { text, extras } = draft;
    let extras = if extras.is_empty() {
        Value::Null
    } else {
        Value::Text(serde_json::to_string(&extras).expect("typed draft extras serialize to JSON"))
    };
    vec![
        text_binding("@sessionId", session_id.text().as_str()),
        (Cow::Borrowed("@text"), Value::Text(text)),
        (Cow::Borrowed("@extras"), extras),
        text_binding("@updatedAt", updated_at.as_str()),
    ]
}

/// A test's follow of one session's draft, for this crate's and other crates' tests.
#[cfg(any(test, feature = "test-support"))]
pub mod test_follow {
    use std::sync::Arc;
    use std::time::Duration;

    use sidekicks_contracts::session::draft::HeldSessionDraft;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_ipc::stream::feed::{CreditGate, Feed};
    use sidekicks_ipc::stream::latest_value::LatestValueFeed;

    use super::SessionDraftStore;

    /// One session's draft followed on a store, read one sent draft at a time.
    pub struct TestDraftFollow {
        feed: Box<dyn Feed<Emission = HeldSessionDraft>>,
        gate: CreditGate,
    }

    impl TestDraftFollow {
        /// Opens a follow of `session_id`'s draft on `store`; panics when the follow is refused.
        pub async fn open(store: &Arc<SessionDraftStore>, session_id: SessionId) -> Self {
            let following = Arc::clone(store);
            let feed = LatestValueFeed::open(|outlet| async move {
                following
                    .follow(session_id, outlet)
                    .await
                    .map_err(HandlerError::from)
            })
            .await
            .expect("the follow opens");
            Self {
                feed: Box::new(feed),
                gate: CreditGate::with_credit(64),
            }
        }

        /// The next draft the follow sends; panics when none comes within five seconds.
        pub async fn next(&mut self) -> HeldSessionDraft {
            tokio::time::timeout(Duration::from_secs(5), self.feed.next(&self.gate))
                .await
                .expect("a follower hears the change")
                .expect("the draft reads")
                .expect("the follow goes on")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::session::draft::SessionDraft;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_fixture::open_log;

    use super::test_follow::TestDraftFollow;
    use super::{SESSION_DRAFT_STORE_STATEMENT_CAPACITY, SessionDraftStore};
    use crate::questions::schema::schema_parts;

    /// A save reaches a follower of the draft with the saved words and the revision it answered.
    /// Killed by the save waking no follower.
    #[tokio::test]
    async fn a_save_reaches_the_drafts_followers() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let session_id = test_session_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        let store = Arc::new(SessionDraftStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_DRAFT_STORE_STATEMENT_CAPACITY,
            )),
            Arc::clone(&log.writer),
            &log.followers,
        ));
        let mut follow = TestDraftFollow::open(&store, session_id).await;
        assert_eq!(follow.next().await.revision, SafeInt::from_usize(0));
        let draft = SessionDraft {
            text: "Half a thought".to_owned(),
            ..SessionDraft::default()
        };

        let saved = store
            .write(session_id, draft.clone(), SafeInt::from_usize(0))
            .await
            .expect("the save is taken");
        let heard = follow.next().await;

        assert_eq!(heard.draft, draft);
        assert_eq!(heard.revision.get(), saved.revision.get());
    }
}
