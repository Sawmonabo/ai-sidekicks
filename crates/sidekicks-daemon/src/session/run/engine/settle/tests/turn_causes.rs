use std::path::Path;
use std::sync::Arc;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;

use super::{limit_record, record_interrupt, running_at};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::EventLogService;
use crate::events::log_service::tests::open_log;
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::{
    SETTLE_WAIT, TestLimitInterrupter, append, continue_request, events, hand_limit_interrupter,
    insert_running_run, provider_end, started_turn, step_stop, stored_events, stored_run_state,
    test_engine, token_limit, turn, turn_started_at,
};
use crate::session::run::read::{RunRead, RunStateReader};
use crate::session::run::state_change::RunStateChangeCompanions;
use sidekicks_contracts::wire::id::mint_uuid_v7;

// A run's log the parity test writes through a live engine before the live path or a restart ends
// it.
#[derive(Clone, Copy, Debug)]
enum CutLog {
    // Turn 1 cut by the step limit, a person's interrupt that ends the run before turn 1's end, a
    // continue, and turn 2 cut by the token limit, the run left running at version 3.
    TwoCutTurns,
    // Turn 1 cut by the step limit, then by the spend limit, the run left running at version 1.
    StepThenSpend,
}

// Writes `cut_log` of `run_id` through a live engine whose interventions service records its rows.
// Returns the engine and that service.
async fn write_cut_log(
    cut_log: CutLog,
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    home: &Path,
    session_id: SessionId,
    run_id: RunId,
) -> (Arc<RunEngine>, Arc<TestLimitInterrupter>) {
    insert_running_run(database, session_id, run_id);
    let engine = test_engine(database, event_log, home);
    let interventions = hand_limit_interrupter(&engine, 0);
    interventions.record_rows_in(database);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    engine
        .stop_at_limit(run_id, step_stop(1))
        .await
        .expect("the step limit's interrupt is accepted");
    match cut_log {
        CutLog::TwoCutTurns => {
            let ended = engine
                .end_run_for_interrupt(run_id, 1, None, None, RunStateChangeCompanions::default())
                .await
                .expect("the person's interrupt ends the run");
            assert!(ended);
            engine
                .continue_run(continue_request(run_id, started_turn))
                .await
                .expect("the continue runs the run again");
            append(
                &engine,
                session_id,
                &turn_started_at(session_id, run_id, 2, 3),
            )
            .await;
            engine
                .stop_at_token_limit(run_id, token_limit())
                .await
                .expect("the token limit's interrupt is accepted");
        }
        CutLog::StepThenSpend => {
            engine
                .stop_at_spend_limit(run_id)
                .await
                .expect("the spend limit's interrupt is accepted");
        }
    }
    (engine, interventions)
}

// The run's turn ends in order, each with its cause.
fn turn_end_causes(database: &TestDatabase, run_id: &RunId) -> Vec<(String, Option<String>)> {
    stored_events(database, run_id)
        .into_iter()
        .filter(|(event_type, _, _)| {
            event_type.starts_with("agent.turn.") && event_type != "agent.turn.started"
        })
        .map(|(event_type, cause, _origin)| (event_type, cause))
        .collect()
}

// Killed by the restart giving a turn only the limit that settles the run, or none to a turn a
// limit that a person's interrupt overtook cut: turn 1 then ends `daemonRestart` from the log where
// the live path ends it `stepLimit` (`two_cut_turns`); and by either path keeping the first or the
// later of two limits that cut one turn over the higher-ranked, where the live path ends it
// `spendLimit` (`step_then_spend`).
#[rstest]
#[case::two_cut_turns(
    CutLog::TwoCutTurns,
    &["stepLimit", "tokenLimit"],
    ("stopped", 4)
)]
#[case::step_then_spend(CutLog::StepThenSpend, &["spendLimit"], ("interrupted", 2))]
#[tokio::test]
async fn a_restart_ends_each_turn_of_a_log_with_the_cause_the_live_path_writes(
    #[case] cut_log: CutLog,
    #[case] turn_causes: &[&str],
    #[case] settled: (&str, i64),
) {
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let live_database = TestDatabase::new();
    let live_log = open_log(&live_database, None).await;
    let restart_database = TestDatabase::new();
    let restart_log = open_log(&restart_database, None).await;
    let (live, _live_interventions) = write_cut_log(
        cut_log,
        &live_database,
        live_log.service,
        home.path(),
        session_id,
        run_id,
    )
    .await;
    let (before_restart, _interventions) = write_cut_log(
        cut_log,
        &restart_database,
        Arc::clone(&restart_log.service),
        home.path(),
        session_id,
        run_id,
    )
    .await;
    let (settling_limit, settling_turn, run_version) = match cut_log {
        CutLog::TwoCutTurns => (RunLimit::TokenLimit, 2, 3),
        CutLog::StepThenSpend => (RunLimit::SpendLimit, 1, 1),
    };

    // Live: turn 1's provider end arrives, then the settling limit's end ends the run.
    let turn_one_ended = live
        .record_turn_end(run_id, provider_end(1))
        .await
        .expect("the provider's end of turn 1 is written");
    assert!(turn_one_ended.written);
    let ended = live
        .end_run_for_interrupt(
            run_id,
            run_version,
            Some(settling_limit),
            Some(turn(settling_turn)),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the run ends at its limit");
    assert!(ended);
    // Restart: the daemon goes down before either, and the restart settles the same log.
    drop(before_restart);
    test_engine(&restart_database, restart_log.service, home.path())
        .settle_run_after_restart(
            &running_at(session_id, run_id, run_version),
            "not resumed",
            None,
        )
        .await
        .expect("the restart settles the run");

    let live_causes = turn_end_causes(&live_database, &run_id);
    assert_eq!(live_causes, turn_end_causes(&restart_database, &run_id));
    let expected_causes: Vec<_> = turn_causes
        .iter()
        .map(|&cause| ("agent.turn.interrupted".to_owned(), Some(cause.to_owned())))
        .collect();
    assert_eq!(live_causes, expected_causes);
    let (settled_state, settled_version) = settled;
    for database in [&live_database, &restart_database] {
        assert_eq!(
            stored_run_state(database, &run_id),
            (settled_state.to_owned(), settled_version)
        );
    }
}

// Killed by the restart reading only live runs, which leaves turn 1 of a run a person's interrupt
// ended open for good; by ending it without the limit its step stop's row named, or a turn no row
// names with a limit; by ending a live run's turn or moving an ended run's row; and by the
// provider's late end writing that turn a second end.
#[tokio::test]
async fn a_restart_ends_the_open_turns_of_runs_that_had_ended() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let cut_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let uncut_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let live_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, cut_run_id);
    let connection = database.reader();
    for (run_id, state) in [(uncut_run_id, "failed"), (live_run_id, "running")] {
        connection
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?1, ?2, ?3, 1)",
                params![run_id.text().as_str(), session_id.text().as_str(), state],
            )
            .expect("the test writes the run");
    }
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    interventions.record_rows_in(&database);
    for run_id in [cut_run_id, uncut_run_id, live_run_id] {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 1),
        )
        .await;
    }
    // The step stop cuts turn 1, and a person's interrupt ends the run before the turn's end.
    engine
        .stop_at_limit(cut_run_id, step_stop(1))
        .await
        .expect("the limit's interrupt is accepted");
    let ended = engine
        .end_run_for_interrupt(
            cut_run_id,
            1,
            None,
            None,
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the person's interrupt ends the run");
    assert!(ended);
    drop(engine);
    let restarted = test_engine(&database, log.service, home.path());
    let ended_runs = RunStateReader::new(&connection)
        .list_ended_runs_with_open_turns()
        .expect("the restart lists the ended runs with open turns");

    restarted
        .end_open_turns_of_ended_runs(&ended_runs)
        .await
        .expect("the restart ends the ended runs' open turns");
    let late_end = restarted
        .record_turn_end(cut_run_id, provider_end(1))
        .await
        .expect("the provider's late end is read");

    assert!(!late_end.written, "the provider's late end is dropped");
    assert_eq!(
        stored_events(&database, &cut_run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.run.interrupted", None, None),
            ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ])
    );
    assert_eq!(
        stored_events(&database, &uncut_run_id),
        events(&[
            ("agent.turn.started", None, None),
            (
                "agent.turn.interrupted",
                Some("daemonRestart"),
                Some("daemon")
            ),
        ])
    );
    assert_eq!(
        stored_events(&database, &live_run_id),
        events(&[("agent.turn.started", None, None)])
    );
    assert_eq!(
        stored_run_state(&database, &cut_run_id),
        ("interrupted".to_owned(), 2)
    );
    assert_eq!(
        stored_run_state(&database, &uncut_run_id),
        ("failed".to_owned(), 1)
    );
}

// Killed by the sweep stopping at its first failure, which leaves the ended run after an unknown
// one open; and by dropping the run-at-version guard from a turn end it writes, the newest or an
// older one, which ends a turn of a run that ran again since its read.
#[tokio::test]
async fn the_ended_runs_sweep_collects_its_failures_and_ends_no_turn_of_a_run_that_moved() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let ended_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let moved_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let unknown_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, ended_run_id);
    let connection = database.reader();
    connection
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'failed', 1)",
            params![moved_run_id.text().as_str(), session_id.text().as_str()],
        )
        .expect("the test writes the run");
    connection
        .execute(
            "UPDATE runs SET state = 'failed' WHERE run_id = ?1",
            params![ended_run_id.text().as_str()],
        )
        .expect("the test ends the run");
    let engine = test_engine(&database, log.service, home.path());
    for (run_id, turn_number) in [(ended_run_id, 1), (moved_run_id, 1), (moved_run_id, 2)] {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, turn_number, 1),
        )
        .await;
    }
    let stale_read = RunRead {
        version: 1,
        session_id,
        state: RunState::Failed,
    };
    // The run runs again after the sweep read it ended.
    connection
        .execute(
            "UPDATE runs SET state = 'running', run_version = 2 WHERE run_id = ?1",
            params![moved_run_id.text().as_str()],
        )
        .expect("the test runs the run again");

    let swept = engine
        .end_open_turns_of_ended_runs(&[unknown_run_id, ended_run_id])
        .await;
    let moved = engine
        .end_open_turns_of_ended_run(moved_run_id, &stale_read)
        .await;

    assert!(swept.is_err(), "the sweep answers {swept:?}");
    assert_eq!(
        stored_events(&database, &ended_run_id),
        events(&[
            ("agent.turn.started", None, None),
            (
                "agent.turn.interrupted",
                Some("daemonRestart"),
                Some("daemon")
            ),
        ])
    );
    assert!(moved.is_err(), "the moved run's sweep answers {moved:?}");
    assert_eq!(
        stored_events(&database, &moved_run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.turn.started", None, None),
        ])
    );
}

// Killed by a late provider end on a run that reads ended resolving its turn's cause from the
// engine's empty memory alone, as a live run's does, which after a restart ends the turn a step
// limit's row names with no cause; and by a token stop of the ended run cutting that turn, held
// while the late end lands, which then ends it `tokenLimit`, a limit no row names.
#[tokio::test]
async fn a_late_turn_end_after_a_restart_takes_the_limit_its_row_names() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let before_restart = test_engine(&database, Arc::clone(&log.service), home.path());
    append(
        &before_restart,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    drop(before_restart);
    record_interrupt(
        &database,
        run_id,
        &limit_record("stepLimit", 1),
        "accepted",
        false,
    );
    database
        .reader()
        .execute(
            "UPDATE runs SET state = 'interrupted', run_version = 2 WHERE run_id = ?1",
            params![run_id.text().as_str()],
        )
        .expect("the test rests the run");
    let restarted = test_engine(&database, log.service, home.path());
    let _interventions = hand_limit_interrupter(&restarted, 0);
    // A usage report's token stop of the ended run, held at its cut should it make one.
    let paused = restarted.cut_pause.arm();
    let mut stopping = Box::pin(restarted.stop_at_token_limit(run_id, token_limit()));
    let stop_settled = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::select! {
            stopped = &mut stopping => stopped,
            reached = paused.reached => {
                reached.expect("the stop holds its cut");
                Ok(())
            }
        }
    })
    .await
    .expect("the stop ends or holds its cut");
    stop_settled.expect("a stop of a run that reads ended is left");

    let late_end = restarted
        .record_turn_end(run_id, provider_end(1))
        .await
        .expect("the provider's late end is written");

    assert!(late_end.written);
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            (
                "agent.turn.interrupted",
                Some("stepLimit"),
                Some("provider")
            ),
        ])
    );
}
