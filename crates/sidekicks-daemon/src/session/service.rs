//! The session service's reads: one session's record, transcript cursors, live runs and standing
//! events as `session.read` answers them, from the `sessions` row its events keep in step, its tags,
//! its console settings, its run rows and its log; the session's whole log, or a page of it after a
//! known sequence; and a rebuild of the record from that log through the projector, over the same
//! envelope reads the event log serves, which skip a range the session skipped past as damaged and,
//! while its history is damaged, stop at its last good point. The service owns one read-only
//! connection and runs each read on the blocking pool.

use std::path::Path;
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::{RUN_LIFECYCLE_EVENT_TYPES, SessionEventType};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::event_cursor::{START_OF_LOG_POSITION, encode_event_cursor};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionLiveRun, SessionPendingWorkingFolder, SessionReadRequest, SessionShape,
    SessionStandingEvent, SessionState, SessionTranscriptCursors,
};
use sidekicks_contracts::session::name::SESSION_NAME_MAX_LEN;
use sidekicks_contracts::tag::{Tag, TagList};
use sidekicks_contracts::transcript::run_facts::{FoldedThroughSequence, TranscriptRunFacts};
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::cleanup_failures::CleanupFailures;
use crate::database::connection::reader::{
    DatabaseReader, DatabaseReaderCloseError, DatabaseReaderError,
};
use crate::database::sql_list::sql_list_of;
use crate::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};
use crate::events::session::read::{
    DamagedFromSequenceReader, SessionEventFilter, SessionEventReads, SessionLogReadError,
    readable_event_sql, session_read_bound,
};
use crate::ipc::domain_error::DomainError;
use crate::session::console_state::read_session_max_steps_per_turn;
use crate::session::not_found::session_not_found;
use crate::session::projector::{SessionRebuildError, rebuild_session};
use crate::session::records::DaemonSessionRecord;
use crate::session::run::transitions::RUN_TERMINAL_STATES_SQL;
use crate::transcript::run_facts::TranscriptRunFactsReader;

/// The statements the service's connection caches: its own five (the row, the tags, the live runs,
/// the standing sequences and the console read), the run facts' three, and the five shared event
/// reads it runs (the head, the rows after a position of every type and of named types, a sequence
/// window and the rows at named sequences).
const SESSION_SERVICE_STATEMENT_CAPACITY: usize = 5 + 3 + 5;

// A negative limit reads every event.
const NO_LIMIT: i64 = -1;

/// One session as its stored row, tags and console settings answer `session.read`: every member
/// of the wire's session record but the held draft, the staged files and the address, which the
/// handler composes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SessionReadRecord {
    /// The session.
    pub(crate) id: SessionId,
    /// Its lifecycle state.
    pub(crate) state: SessionState,
    /// Its shape.
    pub(crate) shape: SessionShape,
    /// Its name, `None` while untitled.
    pub(crate) name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Whether the person muted its notifications.
    pub(crate) muted: bool,
    /// The move its next run boundary applies, `None` when none waits.
    pub(crate) pending_working_folder: Option<SessionPendingWorkingFolder>,
    /// When it was made.
    pub(crate) created_at: WireInstant,
    /// When it last changed.
    pub(crate) updated_at: WireInstant,
    /// Its own bound on the steps one turn may take, `None` where the person set none.
    pub(crate) max_steps_per_turn: Option<SafeInt<1>>,
    /// Its tags as first written, in the order of their case fold.
    pub(crate) tags: TagList,
}

/// A session's read as its row, tags, console settings, runs and log answer it, standing events
/// included.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SessionLogRead {
    /// The session.
    pub(crate) session: SessionReadRecord,
    /// Its transcript cursors.
    pub(crate) transcript_cursors: SessionTranscriptCursors,
    /// Every run not yet ended.
    pub(crate) live_runs: Vec<SessionLiveRun>,
    /// The newest event of each kind a reader keeps a standing fact from, in sequence order.
    pub(crate) standing_events: Vec<SessionStandingEvent>,
}

/// A page of a session's events after a known sequence; with no `limit`, every later event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EventsReadAfterSequenceRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The last sequence already read, or `-1` to read from the session's first event.
    pub(crate) after_sequence: i64,
    /// The most events the page holds; every later event when `None`.
    pub(crate) limit: Option<u32>,
    /// Only events of these types; every type when `None`.
    pub(crate) event_types: Option<Vec<String>>,
    /// Only events before this sequence; every later event when `None`.
    pub(crate) before_sequence: Option<i64>,
}

/// The page: its events in sequence order, and where the next page starts.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EventsReadAfterSequenceResponse {
    /// The events.
    pub(crate) events: Vec<EventEnvelope>,
    /// The `after_sequence` that reads the next page: the page's last sequence, or the request's.
    pub(crate) next_sequence: i64,
    /// Whether another page follows.
    pub(crate) has_more: bool,
}

/// Why a session service read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionServiceError {
    /// The session is not one this daemon holds (`session.not_found`).
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
    /// The service's connection is closed, or the read's blocking task did not finish.
    #[error(transparent)]
    Reader(#[from] DatabaseReaderError),
}

const SELECT_ROW_SQL: &str = "SELECT state, shape, name, muted_at, pending_working_folder,
       created_at, updated_at
  FROM sessions
 WHERE id = ?";

const SELECT_TAGS_SQL: &str =
    "SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag_folded";

// A run's agent is on its `run.queued` row, by id or inside the agent it brought in. Its newest
// touch is its newest readable `run_lifecycle` event. Both read the run-and-type index on the
// event log; the unary `+` drops the run id column's affinity, which would keep the index from
// serving.
static SELECT_LIVE_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    let run_queued = SessionEventType::RunQueued.as_str();
    let lifecycle_types = sql_list_of(
        RUN_LIFECYCLE_EVENT_TYPES
            .iter()
            .copied()
            .map(SessionEventType::as_str),
    );
    let terminal_states = &*RUN_TERMINAL_STATES_SQL;
    let readable_queued = readable_event_sql("queued");
    let readable_lifecycle = readable_event_sql("lifecycle");
    format!(
        "SELECT run_id, parent_run_id, is_apart, state, run_version,
    (SELECT COALESCE(json_extract(queued.payload, '$.agentId'),
                     json_extract(queued.payload, '$.resolvedAgent.agentId'))
       FROM session_events AS queued
      WHERE queued.session_id = runs.session_id
        AND queued.type = '{run_queued}'
        AND queued.run_id = +runs.run_id
        AND {readable_queued}) AS agent_id,
    (SELECT touched.occurred_at
       FROM session_events AS touched
      WHERE touched.session_id = runs.session_id
        AND touched.sequence = (
          SELECT MAX(lifecycle.sequence)
            FROM session_events AS lifecycle
           WHERE lifecycle.session_id = runs.session_id
             AND lifecycle.type IN ({lifecycle_types})
             AND lifecycle.run_id = +runs.run_id
             AND {readable_lifecycle})) AS touched_at
  FROM runs
  WHERE session_id = @session_id
    AND state NOT IN ({terminal_states})
  ORDER BY rowid"
    )
});

// The sequences of the session's standing events. A live run's newest measured window and newest
// compaction read the run-and-type index; the shells' lease changes, the events that brought an
// agent in and each agent's newest binding switch read the type index. `UNION ALL`, since the arms
// name different events and a sorting `UNION` would trade the type index for a walk of the whole
// log in sequence order; the envelope read orders them. A live run with no such row answers NULL,
// which the outer select drops. Each newest pick takes the newest readable row, so a damaged or
// skipped newer one never hides the fact before it.
static SELECT_STANDING_SEQUENCES_SQL: LazyLock<String> = LazyLock::new(|| {
    let window_update = SessionEventType::UsageContextWindowUpdate.as_str();
    let compacted = SessionEventType::UsageContextCompacted.as_str();
    let control_changed = SessionEventType::PtyControlChanged.as_str();
    let session_created = SessionEventType::SessionCreated.as_str();
    let run_queued = SessionEventType::RunQueued.as_str();
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

/// Reads one session on its own read-only connection: its record and cursors from its row, its
/// whole log or a page of it, or its record rebuilt from that log. Each read runs on the blocking
/// pool, one at a time on the connection.
pub(crate) struct SessionService {
    reader: DatabaseReader,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

impl SessionService {
    /// Opens the service's connection on the database at `database_path`, a blocking open;
    /// `read_damaged_from_sequence` says where a damaged session's reads stop. Fails when the
    /// database is missing or the connection's setup fails.
    pub(crate) fn open(
        database_path: &Path,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    ) -> Result<Self, CleanupFailures<rusqlite::Error>> {
        Ok(Self {
            reader: DatabaseReader::open(database_path, SESSION_SERVICE_STATEMENT_CAPACITY)?,
            read_damaged_from_sequence,
        })
    }

    /// The session's record, its transcript cursors, its runs not yet ended and its standing
    /// events: `earliest` is the start of the log, `latest` its newest readable event, or the start
    /// of the log too when its history is damaged before any. Everything is read in one snapshot,
    /// so no event the row, a run or a standing event reflects lies past `latest`. Fails with
    /// [`SessionServiceError::Refused`] (`session.not_found`) for a session this daemon holds no row
    /// for, [`SessionServiceError::Log`] for a standing event that is not a well-formed envelope,
    /// and [`SessionServiceError::RunNamesNoAgent`] for a live run whose creation names no agent.
    pub(crate) async fn read_session(
        &self,
        request: SessionReadRequest,
    ) -> Result<SessionLogRead, SessionServiceError> {
        self.run_read(move |reader, read_damaged_from_sequence| {
            read_session(reader, read_damaged_from_sequence, &request.session_id)
        })
        .await
    }

    /// The session's events after `after_sequence`, at most `limit` of them, only of `event_types`
    /// and only before `before_sequence` when each is given. Fails with
    /// [`SessionServiceError::Log`] when a stored row is not a well-formed envelope.
    pub(crate) async fn read_events_after_sequence(
        &self,
        request: EventsReadAfterSequenceRequest,
    ) -> Result<EventsReadAfterSequenceResponse, SessionServiceError> {
        self.run_read(move |reader, read_damaged_from_sequence| {
            read_events_after_sequence(reader, read_damaged_from_sequence, &request)
        })
        .await
    }

    /// Every event of the session's log in sequence order; none for a session with no events.
    /// Fails with [`SessionServiceError::Log`] when a stored row is not a well-formed envelope.
    pub(crate) async fn read_events(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<EventEnvelope>, SessionServiceError> {
        self.run_read(move |reader, read_damaged_from_sequence| {
            Ok(read_events(
                reader,
                read_damaged_from_sequence,
                &session_id,
            )?)
        })
        .await
    }

    /// Rebuilds the session's record from its whole log, `None` when it has no events. Fails with
    /// [`SessionServiceError::Rebuild`] for a log that does not open at `session.created`, and as
    /// [`SessionService::read_events`] does.
    pub(crate) async fn rebuild_session(
        &self,
        session_id: SessionId,
    ) -> Result<Option<DaemonSessionRecord>, SessionServiceError> {
        self.run_read(move |reader, read_damaged_from_sequence| {
            let events = read_events(reader, read_damaged_from_sequence, &session_id)?;
            Ok(rebuild_session(&events)?)
        })
        .await
    }

    /// Closes the service's connection once any running read is done; a later read fails with
    /// [`SessionServiceError::Reader`]. Fails with SQLite's refusal of the close.
    pub(crate) async fn close(&self) -> Result<(), DatabaseReaderCloseError> {
        self.reader.close().await
    }

    // Runs `read` on the blocking pool with the connection held.
    async fn run_read<Read, Answer>(&self, read: Read) -> Result<Answer, SessionServiceError>
    where
        Read: FnOnce(&Connection, &DamagedFromSequenceReader) -> Result<Answer, SessionServiceError>
            + Send
            + 'static,
        Answer: Send + 'static,
    {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.reader
            .read(move |connection| read(connection, &*read_damaged_from_sequence))
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
    let run_rows = reader
        .prepare_cached(&SELECT_LIVE_RUNS_SQL)?
        .query_map(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@read_bound": read_bound,
            },
            LiveRunRow::from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
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
    row: LiveRunRow,
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
            .expect("a run whose run.queued reads has a readable run_lifecycle event"),
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

/// A stored tag that is not a tag, which only a write outside the tag verbs can leave.
#[derive(Debug, thiserror::Error)]
#[error("the stored tag is not a tag")]
struct NotATag;

/// The `sessions` columns `session.read` answers from.
struct SessionRow {
    state: SessionState,
    shape: SessionShape,
    name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    is_muted: bool,
    pending_working_folder: Option<FilesystemPath>,
    created_at: WireInstant,
    updated_at: WireInstant,
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
        })
    }
}

/// The `runs` columns a live run is answered from, with its agent and newest touch from its
/// events; both are `None` when its `run.queued` is past the read bound or skipped.
struct LiveRunRow {
    run_id: RunId,
    parent_run_id: Option<RunId>,
    is_apart: bool,
    state: RunState,
    run_version: SafeInt<0>,
    agent_id: Option<AgentId>,
    touched_at: Option<WireInstant>,
}

impl LiveRunRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            run_id: text_column(row, 0, |text| RunId::new(&text))?,
            parent_run_id: optional_text_column(row, 1, |text| RunId::new(&text))?,
            is_apart: row.get(2)?,
            state: text_column(row, 3, closed_word)?,
            run_version: safe_int_column(row, 4)?,
            agent_id: optional_text_column(row, 5, |text| AgentId::new(&text))?,
            touched_at: optional_text_column(row, 6, WireInstant::try_from)?,
        })
    }
}
