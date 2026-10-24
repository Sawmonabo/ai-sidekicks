use std::borrow::Cow;
use std::sync::Arc;

use rstest::rstest;
use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use tokio_util::sync::CancellationToken;

use super::{
    PROJECTION_REBUILD_STATEMENT_CAPACITY, ProjectionContradiction, ProjectionFailureCause,
    ProjectionRebuildError, ProjectionRebuildRequest, ProjectionRebuildService, SessionProjection,
    SessionProjectionFold,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::writer::test_file::{TestDatabase, session_event_row, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::session::read::DamagedFromSequenceReader;
use crate::recovery::database_file::damage::DatabaseDamageWatch;
use crate::session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};

const PINNED_ROWS_TABLE_SQL: &str =
    "CREATE TABLE pinned_rows (session_id TEXT NOT NULL, sequence INTEGER NOT NULL) STRICT";

fn statement(
    sql: &'static str,
    bindings: StatementBindings,
    expected_row_count: Option<usize>,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings,
        expected_row_count,
    }
}

// What goes wrong at one event's fold or read.
#[derive(Clone, Copy, Debug)]
enum Fault {
    // A guard that matches no row.
    Guard,
    // A row that breaks the table's `NOT NULL`.
    Constraint,
    // A statement naming a table no one made, which SQLite fails as no constraint.
    MissingTable,
    // The stored row's payload is no JSON object.
    Malformed,
}

// A row per pinned event, its own fold too. The event at `faulted`'s sequence writes its fault
// first, so the fault's statement sits on the boundary between that event and the one before.
#[derive(Clone, Copy)]
struct PinnedRows {
    faulted: Option<(i64, Fault)>,
}

impl SessionProjection for PinnedRows {
    fn name(&self) -> &'static str {
        "pinned rows"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &[SessionEventType::SessionPinned]
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![statement(
            "DELETE FROM pinned_rows WHERE session_id = ?",
            StatementBindings::Positional(vec![Value::Text(session_id.to_string())]),
            None,
        )]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(*self)
    }
}

impl SessionProjectionFold for PinnedRows {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        _event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let sequence = i64::from(envelope.sequence);
        match self.faulted {
            Some((at, Fault::Guard)) if at == sequence => statements.push(statement(
                "UPDATE pinned_rows SET sequence = sequence WHERE sequence < 0",
                StatementBindings::None,
                Some(1),
            )),
            Some((at, Fault::Constraint)) if at == sequence => statements.push(statement(
                "INSERT INTO pinned_rows (session_id, sequence) VALUES (NULL, 0)",
                StatementBindings::None,
                None,
            )),
            Some((at, Fault::MissingTable)) if at == sequence => statements.push(statement(
                "DELETE FROM pinned_rows_never_made",
                StatementBindings::None,
                None,
            )),
            Some(_) | None => {}
        }
        statements.push(statement(
            "INSERT INTO pinned_rows (session_id, sequence) VALUES (?, ?)",
            StatementBindings::Positional(vec![
                Value::Text(envelope.session_id.to_string()),
                Value::Integer(sequence),
            ]),
            None,
        ));
        Ok(())
    }
}

// How a rebuild ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    // A projection failure naming the event at this sequence: its rows refused, or its row
    // unreadable.
    RefusedAt(i64),
    UnreadableAt(i64),
    // A failure of the store, no event's.
    StoreFailed,
    // Folded, its rows reflecting the log up to this sequence.
    Folded(i64),
    // Stopped before its first page.
    Stopped,
}

// A refused statement named by the wrong event (the ranges read with `<` for `<=`, which names
// the event before), a constraint read as the store's failure or a missing table read as a
// contradiction, a malformed row read as the store's failure, a stale mark skipped, a rebuild
// ended early marked current, or a stop token checked after the first page or not at all, each
// fails a case.
#[rstest]
#[case::a_refused_guard(Some((1, Fault::Guard)), None, false, Outcome::RefusedAt(1), "stale", -1)]
#[case::a_broken_constraint(
    Some((2, Fault::Constraint)),
    None,
    false,
    Outcome::RefusedAt(2),
    "stale",
    -1
)]
#[case::a_store_failure(
    Some((1, Fault::MissingTable)),
    None,
    false,
    Outcome::StoreFailed,
    "rebuilding",
    -1
)]
#[case::a_malformed_row(
    Some((1, Fault::Malformed)),
    None,
    false,
    Outcome::UnreadableAt(1),
    "stale",
    -1
)]
#[case::ended_before_an_event(None, Some(2), false, Outcome::Folded(1), "stale", 1)]
#[case::stopped(None, None, true, Outcome::Stopped, "rebuilding", -1)]
#[tokio::test]
async fn a_rebuild_leaves_its_cursor_where_its_fold_ended(
    #[case] faulted: Option<(i64, Fault)>,
    #[case] before_sequence: Option<i64>,
    #[case] is_stopped: bool,
    #[case] outcome: Outcome,
    #[case] cursor_state: &str,
    #[case] cursor_sequence: i64,
) {
    let database = TestDatabase::new();
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database"),
    );
    database
        .reader()
        .execute_batch(PINNED_ROWS_TABLE_SQL)
        .expect("the projection's table is made");
    let session_id = test_session_id();
    // Three events, at sequences 0, 1 and 2.
    writer
        .append_events(
            (0..3).map(|_| session_event_row(&session_id)).collect(),
            Vec::new(),
        )
        .await
        .expect("the session's events are stored");
    if let Some((sequence, Fault::Malformed)) = faulted {
        database
            .reader()
            .execute(
                "UPDATE session_events SET payload = '[]' WHERE sequence = ?",
                [sequence],
            )
            .expect("the test breaks the stored row");
    }
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        PROJECTION_REBUILD_STATEMENT_CAPACITY + SESSION_SERVICE_STATEMENT_CAPACITY,
    ));
    let reads_whole: Arc<DamagedFromSequenceReader> =
        Arc::new(|_session_id: &SessionId| -> Option<i64> { None });
    let service = ProjectionRebuildService::new(
        Arc::clone(&pool),
        writer,
        Arc::new(SessionService::new(pool, reads_whole)),
        Arc::new(DatabaseDamageWatch::new()),
        vec![Box::new(PinnedRows { faulted })],
    );
    let stop = CancellationToken::new();
    if is_stopped {
        stop.cancel();
    }

    let rebuilt = service
        .rebuild(
            ProjectionRebuildRequest {
                session_id,
                is_forced: true,
                before_sequence,
                stop: Some(stop),
            },
            None,
        )
        .await;

    let ended = match rebuilt {
        Ok(response) => Outcome::Folded(response.as_of_sequence),
        Err(ProjectionRebuildError::ProjectionFailure(failure)) => {
            let failure = failure.original();
            match failure.cause {
                ProjectionFailureCause::RowsRefused(_) => Outcome::RefusedAt(failure.sequence),
                ProjectionFailureCause::Unreadable(_) => Outcome::UnreadableAt(failure.sequence),
                ProjectionFailureCause::NotItsVariant(_)
                | ProjectionFailureCause::Contradicted(_) => {
                    panic!("the fold failed otherwise: {:?}", failure.cause)
                }
            }
        }
        Err(ProjectionRebuildError::Write(_)) => Outcome::StoreFailed,
        Err(ProjectionRebuildError::Stopped) => Outcome::Stopped,
        Err(error) => panic!("the rebuild failed otherwise: {error}"),
    };
    assert_eq!(ended, outcome);
    let cursor: (String, i64) = database
        .reader()
        .query_row(
            "SELECT state, last_sequence FROM projection_cursors WHERE session_id = ?",
            [session_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the session has a cursor");
    assert_eq!(cursor, (cursor_state.to_owned(), cursor_sequence));
}
