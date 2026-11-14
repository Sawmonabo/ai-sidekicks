//! The rollback write over a test database holding a run: what it appends and leaves on the run's
//! row, its companions in its one write, a run moving under it, the runs a cut reaches written
//! together and refused while one holds a turn with no end, and a turn opening held back while the
//! write is in progress.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::event::session::SessionEvent;
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

use super::{RunCut, RunRollback};
use crate::checkpoints::schema::schema_parts as checkpoint_schema_parts;
use crate::interventions::store::run_at_version_statement;
use crate::questions::schema::schema_parts;
use crate::run::engine::RunEngine;
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::test_fixture::{append, insert_run, stored_run_state, test_engine};
use crate::run::projection::RunsProjection;
use crate::run::read::RunRead;
use crate::run::state_change::{RunEventDraft, RunWriteCompanions, RunWriteError};

// How long a turn opening held back by an undo's write is watched for not having opened; one that
// is not held back opens well within it.
const HELD_OPENING_BOUND: Duration = Duration::from_millis(500);

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
        // The checkpoint table takes the row a turn's start writes.
        let database = TestDatabase::new(schema_parts().with_parts(checkpoint_schema_parts()));
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_run(&database, session_id, run_id, "running");
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
        companions: RunWriteCompanions,
    ) -> Result<RunRollback, RunEngineError> {
        let mut rollbacks = self.roll_back_with(Vec::new(), companions).await?;
        Ok(rollbacks.pop().expect("one cut writes one rollback"))
    }

    /// Rolls the run back to turn 3 and each of `later_cuts` with it under the session's append
    /// lock, with `companions`.
    async fn roll_back_with(
        &self,
        later_cuts: Vec<RunCut>,
        companions: RunWriteCompanions,
    ) -> Result<Vec<RunRollback>, RunEngineError> {
        let hold = SESSION_APPEND_LOCK.acquire(self.session_id).await;
        let cut = RunCut {
            run_id: self.run_id,
            target_position: point(),
        };
        self.engine
            .roll_back(cut, later_cuts, companions, &hold)
            .await
    }

    /// Appends the turn event `event_type` of `run_id`'s turn 1.
    async fn append_turn_event(&self, run_id: RunId, event_type: &str) {
        let event: SessionEvent = serde_json::from_value(json!({
            "type": event_type,
            "payload": {
                "sessionId": self.session_id,
                "runId": run_id,
                "runVersion": 1,
                "turnNumber": 1,
            },
        }))
        .expect("the test writes a turn event");
        append(&self.engine, self.session_id, &event).await;
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

fn point() -> SourcePosition {
    SourcePosition(SafeInt::new(3).expect("a small turn"))
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
        .roll_back(RunWriteCompanions::default())
        .await
        .expect("the rollback is written");

    let event = AgentRunRolledBackEvent {
        session_id: fixture.session_id,
        run_id: fixture.run_id,
        run_version: SafeInt::new(2).expect("a small version"),
        target_position: point(),
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
        is_sparse: false,
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
        .roll_back(RunWriteCompanions {
            statements: vec![run_at_version_statement(&fixture.run_id, 1)],
            preceding_events: vec![fixture.recovery_resolved()],
            ..RunWriteCompanions::default()
        })
        .await;
    assert!(
        matches!(
            refused,
            Err(RunEngineError::Change(RunWriteError::CompanionRefused {
                companion_index: 0,
                ..
            }))
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
        .roll_back(RunWriteCompanions {
            statements: vec![run_at_version_statement(&fixture.run_id, 2)],
            preceding_events: vec![fixture.recovery_resolved()],
            ..RunWriteCompanions::default()
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
        .roll_back(RunWriteCompanions {
            leading_event: Some(leading_event),
            ..RunWriteCompanions::default()
        })
        .await
        .expect("the retry writes the rollback");

    assert_eq!(i64::from(rollback.event.run_version), 3);
    assert_eq!(
        stored_run_state(&fixture.database, &fixture.run_id),
        ("interrupted".to_owned(), 3)
    );
}

// A cut reaching two runs writes both rollbacks in one write, refused whole while the later run
// holds a turn with no end, and lands once that turn ended. Killed by a rollback written per run,
// which leaves the earlier run cut, by the open-turn guard dropped, and by its refusal read as a
// companion's.
#[tokio::test]
async fn a_cut_of_several_runs_lands_whole_once_no_turn_of_them_is_open() {
    let fixture = Fixture::new(RunState::Completed).await;
    let later_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_run(
        &fixture.database,
        fixture.session_id,
        later_run_id,
        "running",
    );
    fixture
        .append_turn_event(later_run_id, "agent.turn.started")
        .await;
    let later_cuts = || {
        vec![RunCut {
            run_id: later_run_id,
            target_position: SourcePosition(SafeInt::ZERO),
        }]
    };

    let refused = fixture
        .roll_back_with(later_cuts(), RunWriteCompanions::default())
        .await;
    assert!(
        matches!(
            &refused,
            Err(RunEngineError::Change(RunWriteError::TurnOpen { run_id, .. }))
                if *run_id == later_run_id
        ),
        "{refused:?}"
    );
    assert!(
        !fixture
            .event_types()
            .contains(&"agent.run.rolledBack".to_owned()),
        "a refused cut writes no rollback"
    );
    assert_eq!(
        stored_run_state(&fixture.database, &fixture.run_id),
        ("completed".to_owned(), 1)
    );
    assert_eq!(
        stored_run_state(&fixture.database, &later_run_id),
        ("running".to_owned(), 1)
    );

    fixture
        .append_turn_event(later_run_id, "agent.turn.completed")
        .await;
    let rollbacks = fixture
        .roll_back_with(later_cuts(), RunWriteCompanions::default())
        .await
        .expect("the cut lands once the turn ended");

    let landed: Vec<(RunId, i64, SourcePosition)> = rollbacks
        .iter()
        .map(|rollback| {
            (
                rollback.event.run_id,
                i64::from(rollback.event.run_version),
                rollback.event.target_position,
            )
        })
        .collect();
    assert_eq!(
        landed,
        [
            (fixture.run_id, 2, point()),
            (later_run_id, 2, SourcePosition(SafeInt::ZERO)),
        ]
    );
    assert_eq!(
        stored_run_state(&fixture.database, &fixture.run_id),
        ("completed".to_owned(), 2)
    );
    assert_eq!(
        stored_run_state(&fixture.database, &later_run_id),
        ("running".to_owned(), 2)
    );
}

// A turn the provider opens while an undo's rollback write is in progress opens once the write has
// ended, and the write lands. Killed by the opening run at once: it opens within the bound, and its
// open turn refuses the rollback.
#[tokio::test]
async fn a_turn_opened_during_an_undos_write_opens_after_it() {
    let fixture = Fixture::new(RunState::Running).await;
    let undo_write = fixture.engine.mark_undo_write(fixture.session_id);
    let engine = Arc::clone(&fixture.engine);
    let run_id = fixture.run_id;
    let mut opening =
        tokio::spawn(async move { engine.start_turn(run_id, None, None, None, None).await });

    assert!(
        tokio::time::timeout(HELD_OPENING_BOUND, &mut opening)
            .await
            .is_err(),
        "the opening waits for the write"
    );
    fixture
        .roll_back(RunWriteCompanions::default())
        .await
        .expect("no turn opened during the write refuses it");
    drop(undo_write);
    let started = opening
        .await
        .expect("the opening's task ends")
        .expect("the turn's start is written")
        .expect("the run is live");

    assert_eq!(started.turn_number.get(), 1);
    assert_eq!(
        fixture.event_types(),
        ["agent.run.rolledBack", "agent.turn.started"]
    );
}
