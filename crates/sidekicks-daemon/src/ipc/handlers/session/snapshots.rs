//! `session.snapshot.list`: the inspector's list of a project session's snapshots, one per prompt
//! a run took, a turn's opening or a steer, each the checkpoint standing before that prompt and
//! named `Before` and the prompt's first words. The session's row, its checkpoints and their prompts come from one
//! database read; a chat has none.

use std::collections::HashMap;
use std::sync::Arc;

use futures::FutureExt as _;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::session::{SessionEvent, SessionEventReadError};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::session::restore::{
    SessionSnapshotList, SessionSnapshotListRequest, SessionSnapshotListResponse,
    SessionSnapshotSummary,
};
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_session::auto_title::first_words_of;
use sidekicks_session::checkpoints::store::list_checkpoints;
use sidekicks_session::run::superseded::SupersededTurnsReadError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::events::session::read::{
    DamagedFromSequenceReader, SessionEventReads, SessionLogReadError,
};

/// The statements the snapshot list keeps prepared on each read connection: the session's shape,
/// its checkpoints and the prompts at their sequences.
pub(crate) const SESSION_SNAPSHOTS_STATEMENT_CAPACITY: usize = 3;

const SESSION_SHAPE_SQL: &str = "SELECT shape FROM sessions WHERE id = @sessionId";

/// What `session.snapshot.list` reads through.
pub(crate) struct SessionSnapshotSources {
    /// The read pool the one read runs on.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The sequence a damaged session's log reads stop before.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

// Why the list did not answer: a session the daemon does not hold, or a fault in the daemon.
#[derive(Debug, thiserror::Error)]
enum SnapshotListError {
    // The session is not one the daemon holds.
    #[error(transparent)]
    Refused(#[from] DomainError),
    // The read pool did not run the read.
    #[error("the read pool did not run the snapshot list's read")]
    Pool(#[from] DatabaseReadError),
    // SQLite refused a read, or a stored column did not read as its type.
    #[error("the snapshot list's read failed")]
    Read(#[from] rusqlite::Error),
    // The checkpoints, or the rollbacks that leave some of them out, did not read.
    #[error("the snapshot list could not read the session's checkpoints")]
    Checkpoints(#[from] SupersededTurnsReadError),
    // The log refused the read of the checkpoints' prompts.
    #[error("the snapshot list could not read the checkpoints' prompts")]
    Log(#[from] SessionLogReadError),
    // A checkpoint's prompt is stored as an event that does not read.
    #[error("a checkpoint's prompt does not read as an event")]
    Event(#[from] SessionEventReadError),
    // The event at a checkpoint's sequence is no message of the person's.
    #[error("the event at checkpoint {sequence}'s sequence is no prompt")]
    NotAPrompt {
        // The sequence the checkpoint names.
        sequence: i64,
    },
}

impl From<SnapshotListError> for HandlerError {
    fn from(error: SnapshotListError) -> Self {
        match error {
            SnapshotListError::Refused(refusal) => Self::Refused(refusal),
            fault @ (SnapshotListError::Pool(_)
            | SnapshotListError::Read(_)
            | SnapshotListError::Checkpoints(_)
            | SnapshotListError::Log(_)
            | SnapshotListError::Event(_)
            | SnapshotListError::NotAPrompt { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Registers `session.snapshot.list` over `sources`, refusing a session the daemon does not hold
/// `session.notFound`. Fails the start when the method is already registered.
pub(crate) fn register_session_snapshots(
    registry: &mut MethodRegistryBuilder,
    sources: SessionSnapshotSources,
) -> Result<(), RegistrationError> {
    let sources = Arc::new(sources);
    registry.register::<SessionSnapshotList, _>(
        move |request: SessionSnapshotListRequest, _context: HandlerContext| {
            let sources = Arc::clone(&sources);
            async move { Ok(list_snapshots(&sources, request.session_id).await?) }.boxed()
        },
    )
}

// The session's snapshots in one read: none for a chat, else one per checkpoint no later rollback
// took back whose prompt the log reads, oldest prompt first. A prompt the log does not read, one
// at or past a damaged session's read bound or in a range it skipped, leaves its checkpoint out.
async fn list_snapshots(
    sources: &SessionSnapshotSources,
    session_id: SessionId,
) -> Result<SessionSnapshotListResponse, SnapshotListError> {
    let read_damaged_from_sequence = Arc::clone(&sources.read_damaged_from_sequence);
    sources
        .reads
        .read(ReadLength::Long, move |reader| {
            read_snapshots(reader, &*read_damaged_from_sequence, session_id)
        })
        .await
}

// The read `list_snapshots` runs, on one snapshot of the store.
fn read_snapshots(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    session_id: SessionId,
) -> Result<SessionSnapshotListResponse, SnapshotListError> {
    let snapshot = reader.unchecked_transaction()?;
    let shape = snapshot
        .prepare_cached(SESSION_SHAPE_SQL)?
        .query_row(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| text_column(row, 0, closed_word::<SessionShape>),
        )
        .optional()?
        .ok_or_else(|| session_not_found(&session_id))?;
    match shape {
        SessionShape::Chat => {
            return Ok(SessionSnapshotListResponse {
                snapshots: Vec::new(),
            });
        }
        SessionShape::Project => {}
    }
    let checkpoints = list_checkpoints(&snapshot, read_damaged_from_sequence, session_id)?;
    let sequences: Vec<i64> = checkpoints
        .iter()
        .map(|stored| i64::from(stored.checkpoint.message_sequence))
        .collect();
    let mut prompts: HashMap<i64, _> =
        SessionEventReads::new(&snapshot, read_damaged_from_sequence)
            .read_at_sequences(&session_id, &sequences)?
            .into_iter()
            .map(|envelope| (i64::from(envelope.sequence), envelope))
            .collect();
    let mut snapshots = Vec::with_capacity(checkpoints.len());
    for stored in checkpoints {
        let sequence = i64::from(stored.checkpoint.message_sequence);
        let Some(envelope) = prompts.remove(&sequence) else {
            continue;
        };
        let SessionEvent::UserMessageSent(prompt) = SessionEvent::from_envelope(&envelope)? else {
            return Err(SnapshotListError::NotAPrompt { sequence });
        };
        let name = NonEmptyText::new(format!(
            "Before {}",
            first_words_of(prompt.message.as_str())
        ))
        .expect("a name that starts with `Before` is never empty");
        snapshots.push(SessionSnapshotSummary {
            snapshot_id: stored.checkpoint.checkpoint_id,
            name,
            created_at: stored.created_at,
        });
    }
    Ok(SessionSnapshotListResponse { snapshots })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{Value, json};
    use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::SessionShape;
    use sidekicks_contracts::session::restore::{SessionSnapshotList, SnapshotId};
    use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{
        Dispatch as _, DispatchError, MethodRegistry, MethodRegistryBuilder, Reply,
    };
    use sidekicks_session::checkpoints::schema::schema_parts;
    use sidekicks_session::checkpoints::store::{Checkpoint, insert_checkpoint_statement};
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, test_envelope, test_session_id,
    };
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use sidekicks_store::events::session::insert::{SessionEventRow, monotonic_ns_now};

    use super::{
        SESSION_SNAPSHOTS_STATEMENT_CAPACITY, SessionSnapshotSources, register_session_snapshots,
    };

    /// A database on the checkpoint schema, the writer its rows go through, and the registry
    /// serving the snapshot list over it.
    struct Fixture {
        database: TestDatabase,
        writer: DatabaseWriter,
        registry: MethodRegistry,
    }

    impl Fixture {
        async fn new() -> Self {
            let database = TestDatabase::new(schema_parts());
            let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database");
            let mut builder = MethodRegistryBuilder::new();
            register_session_snapshots(
                &mut builder,
                SessionSnapshotSources {
                    reads: Arc::new(DatabaseReadPool::new(
                        database.path(),
                        SESSION_SNAPSHOTS_STATEMENT_CAPACITY,
                    )),
                    read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
                },
            )
            .expect("session.snapshot.list registers");
            Self {
                database,
                writer,
                registry: builder.freeze(),
            }
        }

        /// Stores `session_id` as a session of `shape`.
        fn hold_session(&self, session_id: SessionId, shape: SessionShape) {
            let reader = self.database.reader();
            insert_session_row(&reader, session_id.text().as_str(), None, None);
            reader
                .execute(
                    "UPDATE sessions SET shape = ?1 WHERE id = ?2",
                    [<&'static str>::from(shape), session_id.text().as_str()],
                )
                .expect("the test sets the session's shape");
        }

        /// Appends the person's `message` to `session_id`'s log and answers its sequence.
        async fn send(&self, session_id: SessionId, message: &str) -> SafeInt<0> {
            let event: SessionEvent = serde_json::from_value(json!({
                "type": "user.message.sent",
                "payload": { "sessionId": session_id, "actor": "person", "message": message },
            }))
            .expect("the test writes a user message");
            let envelope = test_envelope(session_id, &event);
            let row = SessionEventRow {
                payload: serde_json::to_string(envelope.payload())
                    .expect("a JSON object serializes"),
                envelope: Arc::new(envelope),
                monotonic_ns: monotonic_ns_now(),
                content_payload: None,
            };
            self.writer
                .append_events(vec![row], Vec::new())
                .await
                .expect("the message is appended")[0]
        }

        /// Records the checkpoint before the prompt at `message_sequence`, as recorded at
        /// `created_at`, and answers its id.
        async fn record(
            &self,
            session_id: SessionId,
            message_sequence: SafeInt<0>,
            created_at: &str,
        ) -> SnapshotId {
            let checkpoint = Checkpoint {
                checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id"),
                session_id,
                message_sequence,
                run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
                turn: EpochPosition {
                    epoch: SourceEpoch(SafeInt::ZERO),
                    position: SourcePosition(message_sequence),
                },
            };
            self.writer
                .write(vec![insert_checkpoint_statement(&checkpoint)])
                .await
                .expect("the checkpoint is written");
            self.database
                .reader()
                .execute(
                    "UPDATE session_checkpoints SET created_at = ?1 WHERE checkpoint_id = ?2",
                    [created_at, checkpoint.checkpoint_id.as_str()],
                )
                .expect("the test sets when the checkpoint was recorded");
            checkpoint.checkpoint_id
        }

        async fn list(&self, session_id: SessionId) -> Result<Reply, DispatchError> {
            self.registry
                .dispatch(
                    request(
                        SessionSnapshotList::DESCRIPTOR.method,
                        Some(&json!({ "sessionId": session_id })),
                    ),
                    context(1),
                )
                .await
        }

        /// The snapshots `session_id` lists.
        async fn snapshots(&self, session_id: SessionId) -> Value {
            let Ok(Reply::Result(result)) = self.list(session_id).await else {
                panic!("session.snapshot.list answers a result");
            };
            let answer: Value = serde_json::from_slice(&result.json).expect("a result is JSON");
            answer["snapshots"].clone()
        }
    }

    // Killed by answering an empty list for any id.
    #[tokio::test]
    async fn an_id_no_session_holds_is_refused_not_found() {
        let fixture = Fixture::new().await;
        let session_id = test_session_id();

        let Err(DispatchError::Refused(refusal)) = fixture.list(session_id).await else {
            panic!("a session the daemon does not hold is refused");
        };
        assert_eq!(refusal.code, RefusalCode::SessionNotFound);
        let detail = refusal.detail.expect("the refusal names the session");
        assert_eq!(detail["sessionId"], json!(session_id));
    }

    // Killed by the shape left unread, which lists the chat's checkpoint.
    #[tokio::test]
    async fn a_chat_lists_no_snapshot_even_with_a_checkpoint() {
        let fixture = Fixture::new().await;
        let session_id = test_session_id();
        fixture.hold_session(session_id, SessionShape::Chat);
        let prompt = fixture.send(session_id, "Tidy the notes").await;
        fixture
            .record(session_id, prompt, "2026-10-20T09:00:00.000Z")
            .await;

        assert_eq!(fixture.snapshots(session_id).await, json!([]));
    }

    // Killed by a name taken from another prompt (the steer between the two prompts, or the
    // other checkpoint's), by an id that is not the checkpoint's, by a time that is not the
    // checkpoint's own, and by rows out of prompt order (the later checkpoint is written first).
    #[tokio::test]
    async fn a_project_lists_each_checkpoint_named_for_its_own_prompt_oldest_first() {
        let fixture = Fixture::new().await;
        let session_id = test_session_id();
        fixture.hold_session(session_id, SessionShape::Project);
        let first_prompt = fixture.send(session_id, "Rename\tthe  config loader").await;
        fixture.send(session_id, "Also check the docs").await;
        let second_prompt = fixture
            .send(
                session_id,
                "Add a retry to the upload client so a dropped connection resumes",
            )
            .await;
        let second = fixture
            .record(session_id, second_prompt, "2026-10-20T09:05:00.000Z")
            .await;
        let first = fixture
            .record(session_id, first_prompt, "2026-10-20T09:00:00.000Z")
            .await;

        assert_eq!(
            fixture.snapshots(session_id).await,
            json!([
                {
                    "snapshotId": first.as_str(),
                    "name": "Before Rename the config loader",
                    "createdAt": "2026-10-20T09:00:00.000Z",
                },
                {
                    "snapshotId": second.as_str(),
                    "name": "Before Add a retry to the upload client so a",
                    "createdAt": "2026-10-20T09:05:00.000Z",
                },
            ])
        );
    }
}
