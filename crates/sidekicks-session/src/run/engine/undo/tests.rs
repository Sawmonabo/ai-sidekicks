//! The rollback write over a test database holding one run: what it appends and leaves on the
//! run's row, its companions in its one write, and a run moving under it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::params;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::{
    AgentRunRecoveryResolvedPayload, AgentRunRolledBackEvent, RunRecoveryChoice,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::projection::SessionProjection as _;
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_store::events::session::appender::SessionEventDraft;
use sidekicks_store::events::session::read::{SessionEventFilter, SessionEventReads};
use tempfile::TempDir;

use super::RunRollback;
use crate::interventions::store::run_at_version_statement;
use crate::questions::schema::schema_parts;
use crate::run::engine::RunEngine;
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::test_fixture::{insert_running_run, stored_run_state, test_engine};
use crate::run::epochs::ConfirmedCut;
use crate::run::projection::RunsProjection;
use crate::run::read::RunRead;
use crate::run::state_change::{RunEventDraft, RunStateChangeCompanions, RunStateChangeError};

/// One run of a session at version 1, in the state a test sets, and the engine that writes it.
struct Fixture {
    database: TestDatabase,
    engine: Arc<RunEngine>,
    session_id: SessionId,
    run_id: RunId,
    log: TestLog,
    _home: TempDir,
}

impl Fixture {
    async fn new(state: RunState) -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        database
            .reader()
            .execute(
                "UPDATE runs SET state = ?1 WHERE run_id = ?2",
                params![<&'static str>::from(state), run_id.text().as_str()],
            )
            .expect("the test sets the run's state");
        let engine = test_engine(&database, Arc::clone(&log.service), home.path());
        Self {
            database,
            engine,
            session_id,
            run_id,
            log,
            _home: home,
        }
    }

    /// Rolls the run back to turn 3 under the session's append lock, with `companions`.
    async fn roll_back(
        &self,
        companions: RunStateChangeCompanions,
    ) -> Result<RunRollback, RunEngineError> {
        let hold = SESSION_APPEND_LOCK.acquire(self.session_id).await;
        self.engine
            .roll_back(self.run_id, &cut(), companions, &hold)
            .await
    }

    /// The types of the session's stored events, in order.
    fn event_types(&self) -> Vec<String> {
        let reader = self.database.reader();
        let mut statement = reader
            .prepare("SELECT type FROM session_events WHERE session_id = ?1 ORDER BY sequence")
            .expect("the test reads the log");
        statement
            .query_map([self.session_id.text().as_str()], |row| row.get(0))
            .expect("the test reads the log")
            .collect::<Result<_, _>>()
            .expect("each type reads as text")
    }

    /// The draft of the run's recovery question settled by undoing to where both agree.
    fn recovery_resolved(&self) -> SessionEventDraft {
        recovery_resolved(self.session_id, self.run_id)
    }
}

fn cut() -> ConfirmedCut {
    ConfirmedCut::InPlace {
        binding_id: RuntimeBindingId::new("binding".to_owned()).expect("a binding id"),
        point: SourcePosition(SafeInt::new(3).expect("a small turn")),
    }
}

fn recovery_resolved(session_id: SessionId, run_id: RunId) -> SessionEventDraft {
    SessionEventDraft::of_session(
        session_id,
        &SessionEvent::AgentRunRecoveryResolved(AgentRunRecoveryResolvedPayload {
            session_id,
            run_id,
            choice: RunRecoveryChoice::UndoToAgreed,
        }),
    )
    .expect("the event passes its checks")
}

// Killed by a rollback that does not advance the run's version, by one that swaps its state, and
// by a rebuild of the runs table that does not read or fold the rollback, leaving the row a version
// short.
#[tokio::test]
async fn a_rollback_advances_the_runs_version_and_leaves_its_state() {
    let fixture = Fixture::new(RunState::Running).await;

    let rollback = fixture
        .roll_back(RunStateChangeCompanions::default())
        .await
        .expect("the rollback is written");

    let event = AgentRunRolledBackEvent {
        session_id: fixture.session_id,
        run_id: fixture.run_id,
        run_version: SafeInt::new(2).expect("a small version"),
        target_position: cut().point(),
    };
    assert_eq!(
        rollback,
        RunRollback {
            event,
            run: RunRead {
                version: 2,
                session_id: fixture.session_id,
                state: RunState::Running,
            },
        }
    );
    assert_eq!(fixture.event_types(), ["agent.run.rolledBack"]);
    assert_eq!(
        stored_run_state(&fixture.database, &fixture.run_id),
        ("running".to_owned(), 2)
    );

    fixture
        .database
        .reader()
        .execute(
            "UPDATE runs SET run_version = 1 WHERE run_id = ?1",
            [fixture.run_id.text().as_str()],
        )
        .expect("the test puts the row back where the rebuild finds it");
    let reader = fixture.database.reader();
    // Read as the rebuild reads, by the types the runs fold names.
    let event_types: Vec<&str> = RunsProjection
        .event_types()
        .iter()
        .map(|event_type| event_type.as_str())
        .collect();
    let filter = SessionEventFilter {
        event_types: Some(&event_types),
        before_sequence: None,
    };
    let stored = SessionEventReads::new(&reader, |_: &SessionId| None)
        .read_after(&fixture.session_id, -1, -1, filter)
        .expect("the test reads the log");
    let mut fold = RunsProjection.fold(&fixture.session_id);
    let mut statements = Vec::new();
    for envelope in &stored {
        let event =
            SessionEvent::from_envelope(envelope).expect("a stored event reads as its type");
        fold.apply(envelope, &event, &mut statements)
            .expect("the rollback folds");
    }
    fixture
        .log
        .writer
        .write(statements)
        .await
        .expect("the fold's statements write");
    assert_eq!(
        stored_run_state(&fixture.database, &fixture.run_id),
        ("running".to_owned(), 2),
        "a rebuild leaves the row the rollback left"
    );
}

// Killed by the companions written apart from the rollback, so a refused statement leaves the
// rollback or the companion event behind, by the refusal not propagated, and by the companion
// event appended after the rollback or its statement run before the version's advance.
#[tokio::test]
async fn a_rollbacks_companions_commit_in_its_write_or_none_does() {
    let fixture = Fixture::new(RunState::Running).await;

    let refused = fixture
        .roll_back(RunStateChangeCompanions {
            statements: vec![run_at_version_statement(&fixture.run_id, 1)],
            preceding_events: vec![fixture.recovery_resolved()],
            ..RunStateChangeCompanions::default()
        })
        .await;
    assert!(
        matches!(
            refused,
            Err(RunEngineError::Change(
                RunStateChangeError::CompanionRefused {
                    companion_index: 0,
                    ..
                }
            ))
        ),
        "{refused:?}"
    );
    assert!(
        fixture.event_types().is_empty(),
        "a refused cut writes neither"
    );
    assert_eq!(
        stored_run_state(&fixture.database, &fixture.run_id),
        ("running".to_owned(), 1)
    );

    fixture
        .roll_back(RunStateChangeCompanions {
            statements: vec![run_at_version_statement(&fixture.run_id, 2)],
            preceding_events: vec![fixture.recovery_resolved()],
            ..RunStateChangeCompanions::default()
        })
        .await
        .expect("the rollback and its companions are written");
    assert_eq!(
        fixture.event_types(),
        ["agent.run.recovery.resolved", "agent.run.rolledBack"]
    );
}

// Killed by the guard on the version read dropped, which writes the rollback over the moved
// version at the version first read, and by a transition check applied, which refuses an ended
// run.
#[tokio::test]
async fn a_rollback_of_a_run_that_moved_lands_past_its_new_version() {
    let fixture = Fixture::new(RunState::Interrupted).await;
    let path = fixture.database.path();
    let (session_id, run_id) = (fixture.session_id, fixture.run_id);
    let has_moved = Arc::new(AtomicBool::new(false));
    // Drafted after each read and before its write, so the first attempt's run moves in between.
    let leading_event: RunEventDraft = Arc::new(move |_run: &RunRead| {
        if !has_moved.swap(true, Ordering::SeqCst) {
            rusqlite::Connection::open(&path)
                .and_then(|connection| {
                    connection.execute(
                        "UPDATE runs SET run_version = run_version + 1 WHERE run_id = ?1",
                        [run_id.text().as_str()],
                    )
                })
                .expect("the test moves the run aside");
        }
        Ok(recovery_resolved(session_id, run_id))
    });

    let rollback = fixture
        .roll_back(RunStateChangeCompanions {
            leading_event: Some(leading_event),
            ..RunStateChangeCompanions::default()
        })
        .await
        .expect("the retry writes the rollback");

    assert_eq!(i64::from(rollback.event.run_version), 3);
    assert_eq!(
        stored_run_state(&fixture.database, &fixture.run_id),
        ("interrupted".to_owned(), 3)
    );
}
