use std::path::Path;
use std::sync::Arc;

use rusqlite::params;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::session::id::SessionId;

use super::{provider_end, running_at, step_stop};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::EventLogService;
use crate::events::log_service::tests::open_log;
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::{
    TestLimitInterrupter, append, continue_request, events, hand_limit_interrupter,
    insert_running_run, started_turn, stored_events, stored_run_state, test_engine, token_limit,
    turn_started_at,
};
use crate::session::run::state_change::RunStateChangeCompanions;
use crate::uuid_v7::mint_uuid_v7;

// Writes one run's log through a live engine: turn 1 cut by the step limit, a person's interrupt
// that ends the run before turn 1's end, a continue, and turn 2 cut by the token limit, the run
// left running at version 3. Returns the engine and the interventions service it holds.
async fn log_two_cut_turns(
    database: &TestDatabase,
    event_log: Arc<EventLogService>,
    home: &Path,
    session_id: SessionId,
    run_id: RunId,
) -> (RunEngine, Arc<TestLimitInterrupter>) {
    insert_running_run(database, session_id, run_id);
    let engine = test_engine(database, event_log, home);
    let interventions = hand_limit_interrupter(&engine, 0);
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
    let ended = engine
        .end_run_for_interrupt(run_id, 1, None, RunStateChangeCompanions::default())
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
// the live path ends it `stepLimit`.
#[tokio::test]
async fn a_restart_ends_each_turn_of_a_log_with_the_cause_the_live_path_writes() {
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let live_database = TestDatabase::new();
    let live_log = open_log(&live_database, None).await;
    let restart_database = TestDatabase::new();
    let restart_log = open_log(&restart_database, None).await;
    let (live, _live_interventions) = log_two_cut_turns(
        &live_database,
        live_log.service,
        home.path(),
        session_id,
        run_id,
    )
    .await;
    let (before_restart, _interventions) = log_two_cut_turns(
        &restart_database,
        Arc::clone(&restart_log.service),
        home.path(),
        session_id,
        run_id,
    )
    .await;

    // Live: turn 1's provider end arrives, then the token limit's end stops the run.
    let turn_one_ended = live
        .record_turn_end(run_id, provider_end(1))
        .await
        .expect("the provider's end of turn 1 is written");
    assert!(turn_one_ended.written);
    let stopped = live
        .end_run_for_interrupt(
            run_id,
            3,
            Some(RunLimit::TokenLimit),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the run ends at its token limit");
    assert!(stopped);
    // Restart: the daemon goes down before either, and the restart settles the same log.
    drop(before_restart);
    test_engine(&restart_database, restart_log.service, home.path())
        .settle_run_after_restart(&running_at(session_id, run_id, 3), "not resumed")
        .await
        .expect("the restart settles the run");

    let live_causes = turn_end_causes(&live_database, &run_id);
    assert_eq!(live_causes, turn_end_causes(&restart_database, &run_id));
    assert_eq!(
        live_causes,
        [
            (
                "agent.turn.interrupted".to_owned(),
                Some("stepLimit".to_owned())
            ),
            (
                "agent.turn.interrupted".to_owned(),
                Some("tokenLimit".to_owned())
            ),
        ]
    );
    assert_eq!(
        stored_run_state(&restart_database, &run_id),
        ("stopped".to_owned(), 4)
    );
}

// Killed by the restart reading only live runs, which leaves turn 1 of a run a person's interrupt
// ended open for good; by ending it without the limit its step stop cut it with, or a turn no stop
// cut with a limit; by ending a live run's turn or moving an ended run's row; and by the provider's
// late end writing that turn a second end.
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
    let _interventions = hand_limit_interrupter(&engine, 0);
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
        .end_run_for_interrupt(cut_run_id, 1, None, RunStateChangeCompanions::default())
        .await
        .expect("the person's interrupt ends the run");
    assert!(ended);
    drop(engine);
    let restarted = test_engine(&database, log.service, home.path());

    restarted
        .end_open_turns_of_ended_runs()
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
