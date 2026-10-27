//! The session service's reads: one session's record, transcript cursors, live runs and standing
//! events as `session.read` answers them, from the `sessions` row its events keep in step, its
//! tags, its console settings, its run rows and its log; the session's whole log, or a page of it
//! after a known sequence; a window of its transcript rows and one stored row with its body; and a
//! rebuild of the record from that log through the projector, over the same envelope reads the
//! event log serves, which skip a range the session skipped past as damaged and, while its history
//! is damaged, stop at its last good point. Each read borrows a connection from the daemon's read
//! pool and runs on the blocking pool.

use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::event_cursor::{START_OF_LOG_POSITION, encode_event_cursor};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionLiveRun, SessionPendingWorkingFolder, SessionReadRequest, SessionShape,
    SessionStandingEvent, SessionState, SessionTranscriptCursors,
};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::tag::{Tag, TagList};
use sidekicks_contracts::transcript::content::{
    TranscriptBodyReadResponse, TranscriptPatchListRequest, TranscriptPatchListResponse,
};
use sidekicks_contracts::transcript::operations::{
    TranscriptChildRunExpandRequest, TranscriptChildRunExpandResponse, TranscriptReadRequest,
    TranscriptReadResponse, TranscriptReasoningReadRequest, TranscriptReasoningReadResponse,
};
use sidekicks_contracts::transcript::run_facts::{FoldedThroughSequence, TranscriptRunFacts};
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::events::session::read::{
    DamagedFromSequenceReader, SessionEventFilter, SessionEventReads, SessionLogReadError,
    readable_event_sql, session_read_bound,
};

use crate::console_state::read_session_max_steps_per_turn;
use crate::projector::{SessionRebuildError, rebuild_session};
use crate::records::DaemonSessionRecord;
use crate::run::read::{SessionLiveRunRow, read_session_live_runs};
use crate::run::transitions::RUN_TERMINAL_STATES_SQL;
use crate::tags::NotATag;
use crate::transcript::block_cut::MARKDOWN_PARSE;
use crate::transcript::body::starts_cache::BlockCuts;
use crate::transcript::body::{BodyReadError, is_body_cut_into_blocks, read_row_body};
use crate::transcript::child_run::expand_child_run;
use crate::transcript::patch_list::{PatchListError, list_patches};
use crate::transcript::reasoning::read_reasoning;
use crate::transcript::run_facts::TranscriptRunFactsReader;
use crate::transcript::window::{TranscriptReadError, read_transcript_window};

/// The statements the service's reads run: its own five (the row, the tags, the live runs, the
/// standing sequences and the console read), the run facts' three, the five shared event reads
/// (the head, the rows after a position of every type and of named types, a sequence window and the
/// rows at named sequences), and the transcript reads' six (the rows before a position, a stored
/// row, a window's bodies and the turn attribution's three seeds).
pub const SESSION_SERVICE_STATEMENT_CAPACITY: usize = 5 + 3 + 5 + 6;

// A negative limit reads every event.
const NO_LIMIT: i64 = -1;

/// One session as its stored row, tags and console settings answer `session.read`: every member
/// of the wire's session record but the held draft, the staged files and the inbox addresses,
/// which the handler composes.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionReadRecord {
    /// The session.
    pub id: SessionId,
    /// Its lifecycle state.
    pub state: SessionState,
    /// Its shape.
    pub shape: SessionShape,
    /// Where it runs; `None` on macOS and Linux.
    pub place: Option<Place>,
    /// Its name, `None` while untitled.
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Whether the person muted its notifications.
    pub muted: bool,
    /// The move its next run boundary applies, `None` when none waits.
    pub pending_working_folder: Option<SessionPendingWorkingFolder>,
    /// When it was made.
    pub created_at: WireInstant,
    /// When it last changed.
    pub updated_at: WireInstant,
    /// Its own bound on the steps one turn may take, `None` where the person set none.
    pub max_steps_per_turn: Option<SafeInt<1>>,
    /// Its tags as first written, in the order of their case fold.
    pub tags: TagList,
}

/// A session's read as its row, tags, console settings, runs and log answer it, standing events
/// included.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionLogRead {
    /// The session.
    pub session: SessionReadRecord,
    /// Its transcript cursors.
    pub transcript_cursors: SessionTranscriptCursors,
    /// Every run not yet ended.
    pub live_runs: Vec<SessionLiveRun>,
    /// The newest event of each kind a reader keeps a standing fact from, in sequence order.
    pub standing_events: Vec<SessionStandingEvent>,
}

/// A page of a session's events after a known sequence; with no `limit`, every later event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventsReadAfterSequenceRequest {
    /// The session.
    pub session_id: SessionId,
    /// The last sequence already read, or `-1` to read from the session's first event.
    pub after_sequence: i64,
    /// The most events the page holds; every later event when `None`.
    pub limit: Option<u32>,
    /// Only events of these types; every type when `None`.
    pub event_types: Option<Arc<[String]>>,
    /// Only events before this sequence; every later event when `None`.
    pub before_sequence: Option<i64>,
}

/// The page: its events in sequence order, and where the next page starts.
#[derive(Clone, Debug, PartialEq)]
pub struct EventsReadAfterSequenceResponse {
    /// The events.
    pub events: Vec<EventEnvelope>,
    /// The `after_sequence` that reads the next page: the page's last sequence, or the request's.
    pub next_sequence: i64,
    /// Whether another page follows.
    pub has_more: bool,
}

/// Why a session service read failed.
#[derive(Debug, thiserror::Error)]
pub enum SessionServiceError {
    /// The session is not one this daemon holds (`session.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("a read of a session's rows failed")]
    Database(#[from] rusqlite::Error),
    /// A read of the session's log failed, or a stored row is not a well-formed event envelope.
    #[error(transparent)]
    Log(#[from] SessionLogReadError),
    /// A live run's creation names no agent, which only a write outside admission can leave.
    #[error("run {run_id} of session {session_id} names no agent")]
    RunNamesNoAgent {
        /// The run.
        run_id: RunId,
        /// Its session.
        session_id: SessionId,
    },
    /// The log does not rebuild into a record.
    #[error(transparent)]
    Rebuild(#[from] SessionRebuildError),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<SessionServiceError> for HandlerError {
    /// A session the daemon does not hold answers `session.notFound`; every other failure is a
    /// fault in the daemon.
    fn from(error: SessionServiceError) -> Self {
        match error {
            SessionServiceError::Refused(refusal) => Self::Refused(refusal),
            fault @ (SessionServiceError::Database(_)
            | SessionServiceError::Log(_)
            | SessionServiceError::RunNamesNoAgent { .. }
            | SessionServiceError::Rebuild(_)
            | SessionServiceError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

const SELECT_ROW_SQL: &str = "SELECT state, shape, name, muted_at, pending_working_folder,
       created_at, updated_at, place
  FROM sessions
 WHERE id = ?";

const SELECT_TAGS_SQL: &str =
    "SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag_folded";

// The sequences of the session's standing events. A live run's newest measured window and newest
// compaction read the run-and-type index; the shells' lease changes, the events that brought an
// agent in and each agent's newest binding switch read the type index. `UNION ALL`, since the arms
// name different events and a sorting `UNION` would trade the type index for a walk of the whole
// log in sequence order; the envelope read orders them. A live run with no such row answers NULL,
// which the outer select drops. Each newest pick takes the newest readable row, so a damaged or
// skipped newer one never hides the fact before it.
static SELECT_STANDING_SEQUENCES_SQL: LazyLock<String> = LazyLock::new(|| {
    let window_update = SessionEventType::UsageContextWindowUpdated.as_str();
    let compacted = SessionEventType::AgentRunContextCompacted.as_str();
    let control_changed = SessionEventType::TerminalControlChanged.as_str();
    let session_created = SessionEventType::SessionCreated.as_str();
    let run_queued = SessionEventType::AgentRunQueued.as_str();
    let binding_changed = SessionEventType::AgentProviderBindingChanged.as_str();
    let terminal_states = &*RUN_TERMINAL_STATES_SQL;
    let readable_measured = readable_event_sql("measured");
    let readable_compacted = readable_event_sql("compacted");
    let readable_lease = readable_event_sql("lease");
    let readable_binding = readable_event_sql("binding");
    format!(
        "SELECT sequence FROM (
    SELECT (SELECT MAX(measured.sequence)
              FROM session_events AS measured
             WHERE measured.session_id = runs.session_id
               AND measured.type = '{window_update}'
               AND measured.run_id = +runs.run_id
               AND json_type(measured.payload, '$.windowUsedTokens') = 'integer'
               AND json_extract(measured.payload, '$.windowUsedTokens') >= 0
               AND json_type(measured.payload, '$.windowMaxTokens') = 'integer'
               AND json_extract(measured.payload, '$.windowMaxTokens') > 0
               AND {readable_measured}) AS sequence
      FROM runs
     WHERE runs.session_id = @session_id AND runs.state NOT IN ({terminal_states})
    UNION ALL
    SELECT (SELECT MAX(compacted.sequence)
              FROM session_events AS compacted
             WHERE compacted.session_id = runs.session_id
               AND compacted.type = '{compacted}'
               AND compacted.run_id = +runs.run_id
               AND {readable_compacted})
      FROM runs
     WHERE runs.session_id = @session_id AND runs.state NOT IN ({terminal_states})
    UNION ALL
    SELECT MAX(sequence)
      FROM session_events AS lease
     WHERE session_id = @session_id AND type = '{control_changed}'
       AND {readable_lease}
     GROUP BY CASE json_type(payload, '$.terminalId')
                WHEN 'text' THEN json_extract(payload, '$.terminalId')
              END
    UNION ALL
    SELECT sequence
      FROM session_events
     WHERE session_id = @session_id AND type = '{session_created}'
    UNION ALL
    SELECT sequence
      FROM session_events
     WHERE session_id = @session_id
       AND type = '{run_queued}'
       AND json_type(payload, '$.resolvedAgent') = 'object'
    UNION ALL
    SELECT MAX(sequence)
      FROM session_events AS binding
     WHERE session_id = @session_id AND type = '{binding_changed}'
       AND {readable_binding}
     GROUP BY json_extract(payload, '$.agentId'))
  WHERE sequence IS NOT NULL"
    )
});

/// Reads one session through the daemon's read pool: its record and cursors from its row, its
/// whole log or a page of it, a window of its transcript or one stored row, or its record rebuilt
/// from that log. Each read runs on the blocking pool on a connection it borrows for the whole
/// read.
pub struct SessionService {
    pool: Arc<DatabaseReadPool>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    // The cuts of ended replies its body reads keep, so a later part decodes only its frames.
    block_cuts: Arc<BlockCuts>,
}

impl SessionService {
    /// The service reading through `pool`; `read_damaged_from_sequence` says where a damaged
    /// session's reads stop.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    ) -> Self {
        Self {
            pool,
            read_damaged_from_sequence,
            block_cuts: Arc::default(),
        }
    }

    /// Lets go of the block cuts its body reads kept for `session_id`'s replies, once the session
    /// is purged.
    pub fn forget_session_block_cuts(&self, session_id: &SessionId) {
        self.block_cuts.forget_session_block_cuts(session_id);
    }

    /// The session's record, its transcript cursors, its runs not yet ended and its standing
    /// events: `earliest` is the start of the log, `latest` its newest readable event, or the start
    /// of the log too when its history is damaged before any. Everything is read in one snapshot,
    /// so no event the row, a run or a standing event reflects lies past `latest`. Fails with
    /// [`SessionServiceError::Refused`] (`session.notFound`) for a session this daemon holds no row
    /// for, [`SessionServiceError::Log`] for a standing event that is not a well-formed envelope,
    /// and [`SessionServiceError::RunNamesNoAgent`] for a live run whose creation names no agent.
    pub async fn read_session(
        &self,
        request: SessionReadRequest,
    ) -> Result<SessionLogRead, SessionServiceError> {
        self.run_read(
            ReadLength::Short,
            move |reader, read_damaged_from_sequence| {
                read_session(reader, read_damaged_from_sequence, &request.session_id)
            },
        )
        .await
    }

    /// The session's events after `after_sequence`, at most `limit` of them, only of `event_types`
    /// and only before `before_sequence` when each is given. Fails with
    /// [`SessionServiceError::Log`] when a stored row is not a well-formed envelope.
    pub async fn read_events_after_sequence(
        &self,
        request: EventsReadAfterSequenceRequest,
    ) -> Result<EventsReadAfterSequenceResponse, SessionServiceError> {
        self.run_read(
            ReadLength::Long,
            move |reader, read_damaged_from_sequence| {
                read_events_after_sequence(reader, read_damaged_from_sequence, &request)
            },
        )
        .await
    }

    /// Every event of the session's log in sequence order; none for a session with no events.
    /// Fails with [`SessionServiceError::Log`] when a stored row is not a well-formed envelope.
    pub(crate) async fn read_events(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<EventEnvelope>, SessionServiceError> {
        self.run_read(
            ReadLength::Long,
            move |reader, read_damaged_from_sequence| {
                Ok(read_events(
                    reader,
                    read_damaged_from_sequence,
                    &session_id,
                )?)
            },
        )
        .await
    }

    /// Rebuilds the session's record from its whole log, `None` when it has no events. Fails with
    /// [`SessionServiceError::Rebuild`] for a log that does not open at `session.created`, and as
    /// [`SessionService::read_events`] does.
    pub(crate) async fn rebuild_session(
        &self,
        session_id: SessionId,
    ) -> Result<Option<DaemonSessionRecord>, SessionServiceError> {
        self.run_read(
            ReadLength::Long,
            move |reader, read_damaged_from_sequence| {
                let events = read_events(reader, read_damaged_from_sequence, &session_id)?;
                Ok(rebuild_session(&events)?)
            },
        )
        .await
    }

    /// One bounded window of the session's transcript rows, or the window around one row, read in
    /// one snapshot. Fails with [`TranscriptReadError::Refused`] for a session this daemon holds no
    /// events for (`session.notFound`) or an `aroundCursor` at which no row stands
    /// (`transcript.row.notFound`), and [`TranscriptReadError::CursorUnresolvable`] for a cursor
    /// that names no position.
    pub async fn read_transcript_window(
        &self,
        request: TranscriptReadRequest,
    ) -> Result<TranscriptReadResponse, TranscriptReadError> {
        self.run_read(
            ReadLength::Long,
            move |reader, read_damaged_from_sequence| {
                read_transcript_window(reader, read_damaged_from_sequence, &request, MARKDOWN_PARSE)
            },
        )
        .await
    }

    /// The part from `offset` of the body of `session_id`'s row standing at the event `row_id`,
    /// `None` when no row of the session stands there. A short read of the row's event alone
    /// decides the read's length: a short read answers it, except for a reply drawn as markdown,
    /// whose whole body a long read loads to cut it into blocks. Fails with [`BodyReadError`] for
    /// a session this daemon holds no events for (`session.notFound`), an offset that is no place
    /// to resume from, or a read that failed.
    pub async fn read_row_body(
        &self,
        session_id: SessionId,
        row_id: String,
        offset: u64,
    ) -> Result<Option<TranscriptBodyReadResponse>, BodyReadError> {
        let event_id = row_id.clone();
        let is_cut = self
            .run_read(
                ReadLength::Short,
                move |reader, read_damaged_from_sequence| {
                    is_body_cut_into_blocks(
                        reader,
                        read_damaged_from_sequence,
                        &session_id,
                        &event_id,
                    )
                },
            )
            .await?;
        let length = if is_cut {
            ReadLength::Long
        } else {
            ReadLength::Short
        };
        let block_cuts = Arc::clone(&self.block_cuts);
        self.run_read(length, move |reader, read_damaged_from_sequence| {
            read_row_body(
                reader,
                read_damaged_from_sequence,
                &session_id,
                &row_id,
                offset,
                MARKDOWN_PARSE,
                &block_cuts,
            )
        })
        .await
    }

    /// One page of a run's reasoning. Fails with [`TranscriptReadError::Refused`] for a run this
    /// daemon does not hold (`agent.run.notFound`) and [`TranscriptReadError::CursorUnresolvable`]
    /// for a cursor that names no position.
    pub async fn read_reasoning(
        &self,
        request: TranscriptReasoningReadRequest,
    ) -> Result<TranscriptReasoningReadResponse, TranscriptReadError> {
        self.run_read(
            ReadLength::Long,
            move |reader, read_damaged_from_sequence| {
                read_reasoning(reader, read_damaged_from_sequence, &request)
            },
        )
        .await
    }

    /// One page of a child run's rows, its child rows summarized as of `observed_at`. Fails with
    /// [`TranscriptReadError::Refused`] for a run this daemon does not hold (`agent.run.notFound`)
    /// or one with no parent (`agent.run.notChild`), and
    /// [`TranscriptReadError::CursorUnresolvable`] for a cursor that names no position.
    pub async fn expand_child_run(
        &self,
        request: TranscriptChildRunExpandRequest,
        observed_at: WireInstant,
    ) -> Result<TranscriptChildRunExpandResponse, TranscriptReadError> {
        self.run_read(
            ReadLength::Long,
            move |reader, read_damaged_from_sequence| {
                expand_child_run(
                    reader,
                    read_damaged_from_sequence,
                    &request,
                    &observed_at,
                    MARKDOWN_PARSE,
                )
            },
        )
        .await
    }

    /// One page of the patches a tool call's row left out. Fails with [`PatchListError`] for a
    /// session or call this daemon does not hold, a cursor that names no place in the call's
    /// files, or a read that failed.
    pub async fn list_patches(
        &self,
        request: TranscriptPatchListRequest,
    ) -> Result<TranscriptPatchListResponse, PatchListError> {
        self.run_read(
            ReadLength::Long,
            move |reader, read_damaged_from_sequence| {
                list_patches(reader, read_damaged_from_sequence, &request)
            },
        )
        .await
    }

    /// The sequence `session_id`'s reads stop at while its history is damaged, `None` while it is
    /// whole.
    pub fn damaged_from_sequence(&self, session_id: &SessionId) -> Option<i64> {
        (self.read_damaged_from_sequence)(session_id)
    }

    // Runs `read` on the blocking pool on a borrowed connection held for the whole read.
    async fn run_read<Read, Answer, Failure>(
        &self,
        length: ReadLength,
        read: Read,
    ) -> Result<Answer, Failure>
    where
        Read: FnOnce(&Connection, &DamagedFromSequenceReader) -> Result<Answer, Failure>
            + Send
            + 'static,
        Answer: Send + 'static,
        Failure: From<DatabaseReadError> + Send + 'static,
    {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(length, move |connection| {
                read(connection, &*read_damaged_from_sequence)
            })
            .await
    }
}

fn read_session(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    session_id: &SessionId,
) -> Result<SessionLogRead, SessionServiceError> {
    let snapshot = reader.unchecked_transaction()?;
    let event_reads = SessionEventReads::new(&snapshot, read_damaged_from_sequence);
    let head = event_reads.read_head(session_id)?;
    let Some(row) = snapshot
        .prepare_cached(SELECT_ROW_SQL)?
        .query_row([session_id.text().as_str()], SessionRow::from_row)
        .optional()?
    else {
        return Err(session_not_found(session_id).into());
    };
    let tags = snapshot
        .prepare_cached(SELECT_TAGS_SQL)?
        .query_map([session_id.text().as_str()], |tag_row| {
            text_column(tag_row, 0, |text| Tag::new(text).ok_or(NotATag))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let max_steps_per_turn = read_session_max_steps_per_turn(&snapshot, session_id)?;
    let read_bound = session_read_bound(read_damaged_from_sequence, session_id, None);
    let live_runs = read_live_runs(
        &snapshot,
        read_damaged_from_sequence,
        session_id,
        read_bound,
        head,
    )?;
    let standing_sequences = snapshot
        .prepare_cached(&SELECT_STANDING_SEQUENCES_SQL)?
        .query_map(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@read_bound": read_bound,
            },
            |sequence_row| sequence_row.get::<_, i64>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let standing_events = event_reads
        .read_at_sequences(session_id, &standing_sequences)?
        .into_iter()
        .map(|event| SessionStandingEvent {
            cursor: encode_event_cursor(i64::from(event.sequence))
                .expect("an envelope's sequence is a safe integer"),
            event,
        })
        .collect();
    snapshot.commit()?;
    Ok(SessionLogRead {
        session: SessionReadRecord {
            id: *session_id,
            state: row.state,
            shape: row.shape,
            place: row.place,
            name: row.name,
            muted: row.is_muted,
            pending_working_folder: row
                .pending_working_folder
                .map(|path| SessionPendingWorkingFolder { path }),
            created_at: row.created_at,
            updated_at: row.updated_at,
            max_steps_per_turn,
            tags: TagList(UniqueList::new(tags).expect("a tag list has no count bound")),
        },
        transcript_cursors: SessionTranscriptCursors {
            earliest: encode_event_cursor(START_OF_LOG_POSITION)
                .expect("the start of the log is a position"),
            latest: encode_event_cursor(head.unwrap_or(START_OF_LOG_POSITION))
                .expect("the head is a safe sequence below the read bound"),
        },
        live_runs,
        standing_events,
    })
}

// Each live run with who acts for it and the account it is billed to, folded from the whole log
// as a transcript window's run facts are, so a reader knows both before any window names the run.
fn read_live_runs(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    session_id: &SessionId,
    read_bound: i64,
    head: Option<i64>,
) -> Result<Vec<SessionLiveRun>, SessionServiceError> {
    let run_rows = read_session_live_runs(reader, session_id, read_bound)?;
    let run_ids: Vec<RunId> = run_rows.iter().map(|run_row| run_row.run_id).collect();
    let head_sequence = FoldedThroughSequence::new(head.unwrap_or(START_OF_LOG_POSITION))
        .expect("the head is a safe sequence below the read bound");
    let run_facts = TranscriptRunFactsReader::new(reader, read_damaged_from_sequence).read(
        session_id,
        &run_ids,
        head_sequence,
    )?;
    // `read` answers one facts record per run, in the order the runs were asked for.
    run_rows
        .into_iter()
        .zip(run_facts)
        .map(|(run_row, facts)| live_run_of(run_row, session_id, facts))
        .collect()
}

fn live_run_of(
    row: SessionLiveRunRow,
    session_id: &SessionId,
    facts: TranscriptRunFacts,
) -> Result<SessionLiveRun, SessionServiceError> {
    // Every run is created naming its agent, so one naming none was written outside admission.
    let Some(agent_id) = row.agent_id else {
        return Err(SessionServiceError::RunNamesNoAgent {
            run_id: row.run_id,
            session_id: *session_id,
        });
    };
    Ok(SessionLiveRun {
        run_id: row.run_id,
        parent_run_id: row.parent_run_id,
        is_apart: row.is_apart.then(True::default),
        state: row.state,
        run_version: row.run_version,
        agent_id,
        actor: facts.actor,
        admitted_provider_account_id: facts.admitted_provider_account_id,
        touched_at: row
            .touched_at
            .expect("a run whose agent.run.queued reads has a readable runLifecycle event"),
    })
}

fn read_events_after_sequence(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    request: &EventsReadAfterSequenceRequest,
) -> Result<EventsReadAfterSequenceResponse, SessionServiceError> {
    let event_types: Option<Vec<&str>> = request
        .event_types
        .as_ref()
        .map(|event_types| event_types.iter().map(String::as_str).collect());
    // One row past the page says whether another page follows.
    let mut events = SessionEventReads::new(reader, read_damaged_from_sequence).read_after(
        &request.session_id,
        request.after_sequence,
        request.limit.map_or(NO_LIMIT, |limit| i64::from(limit) + 1),
        SessionEventFilter {
            event_types: event_types.as_deref(),
            before_sequence: request.before_sequence,
        },
    )?;
    let page_limit = request
        .limit
        .map(|limit| usize::try_from(limit).expect("a 32-bit count fits usize"));
    let has_more = page_limit.is_some_and(|limit| events.len() > limit);
    if let Some(limit) = page_limit {
        events.truncate(limit);
    }
    Ok(EventsReadAfterSequenceResponse {
        next_sequence: events
            .last()
            .map_or(request.after_sequence, |event| i64::from(event.sequence)),
        events,
        has_more,
    })
}

fn read_events(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFromSequenceReader,
    session_id: &SessionId,
) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
    let event_reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    match event_reads.read_head(session_id)? {
        None => Ok(Vec::new()),
        Some(head) => event_reads.read_window(session_id, 0, head),
    }
}

/// The `sessions` columns `session.read` answers from.
struct SessionRow {
    state: SessionState,
    shape: SessionShape,
    name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    is_muted: bool,
    pending_working_folder: Option<FilesystemPath>,
    created_at: WireInstant,
    updated_at: WireInstant,
    place: Option<Place>,
}

impl SessionRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            state: text_column(row, 0, closed_word)?,
            shape: text_column(row, 1, closed_word)?,
            name: optional_text_column(row, 2, FreeFormText::new)?,
            is_muted: row.get::<_, Option<String>>(3)?.is_some(),
            pending_working_folder: optional_text_column(row, 4, FilesystemPath::new)?,
            created_at: text_column(row, 5, WireInstant::try_from)?,
            updated_at: text_column(row, 6, WireInstant::try_from)?,
            // The column holds the place's wire JSON.
            place: optional_text_column(row, 7, |text| serde_json::from_str::<Place>(&text))?,
        })
    }
}
