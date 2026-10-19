use std::sync::atomic::Ordering;

use rstest::rstest;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::wire::integer::SafeInt;

use super::LimitStop;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::session::run::engine::live::lock;
use crate::session::run::engine::tests::{
    DRIVER_HOLD, SETTLE_WAIT, append, continue_request, events, hand_limit_interrupter,
    held_driver, insert_running_run, started_turn, stored_events, stored_run_state, test_engine,
    token_limit, turn_started_at,
};
use crate::session::run::engine::turns::{ProviderTurnEnd, TurnOutcome};
use crate::session::run::engine::{RunEngine, RunEngineError};
use crate::session::run::state_change::RunStateChangeCompanions;
use crate::uuid_v7::mint_uuid_v7;

fn step_stop(turn_number: u64) -> LimitStop {
    LimitStop::Step {
        count: SafeInt::new(40).expect("40 is a step bound"),
        turn_number: turn(turn_number),
    }
}

fn turn(number: u64) -> SafeInt<1> {
    SafeInt::new(number).expect("the test's turn numbers count from 1")
}

// A person's interrupt accepted at `accepted_run_version` ends the run, and a continue runs it
// again.
async fn interrupt_and_continue(engine: &RunEngine, run_id: RunId, accepted_run_version: i64) {
    let ended = engine
        .end_run_for_interrupt(
            run_id,
            accepted_run_version,
            None,
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the person's interrupt ends the run");
    assert!(ended);
    engine
        .continue_run(continue_request(run_id, started_turn))
        .await
        .expect("the continue runs the run again");
}

// Killed by the run's end forgetting the cut before the cut turn's end is written, and by a
// stop that finds the run ended leaving its own cut in place of the earlier one or removing
// both: either way the provider's end of the cut turn is written with another cause or none.
#[tokio::test]
async fn a_cut_turn_keeps_its_limit_past_the_runs_end_and_a_stop_that_found_it_ended() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let _interventions = hand_limit_interrupter(&engine, 0);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;

    engine
        .stop_at_limit(run_id, step_stop(1))
        .await
        .expect("the limit's interrupt is accepted");
    // A person's interrupt, accepted while the limit's is pending, ends the run first.
    let ended = engine
        .end_run_for_interrupt(run_id, 1, None, RunStateChangeCompanions::default())
        .await
        .expect("the person's interrupt ends the run");
    assert!(ended);
    // A token stop of the same turn finds the run ended and stops nothing.
    engine
        .stop_at_token_limit(run_id, token_limit())
        .await
        .expect("a stop of a run that has ended is left");
    let turn_ended = engine
        .record_turn_end(
            run_id,
            ProviderTurnEnd {
                turn_number: turn(1),
                outcome: TurnOutcome::Interrupted(None),
            },
        )
        .await
        .expect("the provider's end of the cut turn is written");

    assert!(turn_ended.written);
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.run.interrupted", None, None),
            (
                "agent.turn.interrupted",
                Some("stepLimit"),
                Some("provider")
            ),
        ])
    );
    assert!(
        lock(&engine.live).cut_turns.is_empty(),
        "the cut leaves with its turn's end"
    );
}

// Killed by the cuts keyed by run alone, where turn 2's cut replaces turn 1's, which its
// provider then ends with no cause.
#[tokio::test]
async fn a_later_turns_cut_keeps_the_limit_of_an_earlier_cut_turn() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let _interventions = hand_limit_interrupter(&engine, 0);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;

    // Turn 1 is cut, a person's interrupt ends the run before the provider ends the turn, and
    // a continue runs turn 2, which is cut too.
    engine
        .stop_at_limit(run_id, step_stop(1))
        .await
        .expect("the limit's interrupt is accepted");
    interrupt_and_continue(&engine, run_id, 1).await;
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 2, 3),
    )
    .await;
    engine
        .stop_at_limit(run_id, step_stop(2))
        .await
        .expect("the limit's interrupt is accepted");
    let turn_ended = engine
        .record_turn_end(
            run_id,
            ProviderTurnEnd {
                turn_number: turn(1),
                outcome: TurnOutcome::Interrupted(None),
            },
        )
        .await
        .expect("the provider's late end of turn 1 is written");

    assert!(turn_ended.written);
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.run.interrupted", None, None),
            ("agent.run.running", None, None),
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            (
                "agent.turn.interrupted",
                Some("stepLimit"),
                Some("provider")
            ),
        ])
    );
    let cuts: Vec<_> = lock(&engine.live).cut_turns.keys().copied().collect();
    assert_eq!(
        cuts,
        [(run_id, turn(2))],
        "turn 2's cut waits for its own end"
    );
}

// Killed by a retried token stop writing its reached event again, which the once-per-run
// guard refuses so no interrupt goes, and by a retry sending no interrupt.
#[tokio::test]
async fn a_token_stop_retried_after_a_failed_interrupt_sends_the_interrupt_alone() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 1);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;

    let refused = engine.stop_at_token_limit(run_id, token_limit()).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the first stop answers {refused:?}"
    );
    engine
        .stop_at_token_limit(run_id, token_limit())
        .await
        .expect("the retried stop's interrupt is accepted");
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
    // The interventions service ends the run with the limit it accepted at version 1.
    let ended = engine
        .end_run_for_interrupt(
            run_id,
            1,
            Some(RunLimit::TokenLimit),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the run ends at its limit");

    assert!(ended);
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.tokenLimit.reached", None, None),
            ("agent.turn.interrupted", Some("tokenLimit"), Some("daemon")),
            ("agent.run.stopped", None, None),
        ])
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("stopped".to_owned(), 2)
    );
}

// Killed by a token stop that finds the run's reached event standing sending no interrupt
// while no limit's interrupt is pending: a run a person's interrupt overtook and a continue
// ran again would run on past its token limit.
#[tokio::test]
async fn a_token_stop_after_an_overtaken_limit_and_a_continue_stops_the_run() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;

    engine
        .stop_at_token_limit(run_id, token_limit())
        .await
        .expect("the limit's interrupt is accepted");
    // A person's interrupt ends the run before the limit's end, which then finds it ended,
    // and a continue runs turn 2.
    let ended = engine
        .end_run_for_interrupt(run_id, 1, None, RunStateChangeCompanions::default())
        .await
        .expect("the person's interrupt ends the run");
    assert!(ended);
    let limit_ended = engine
        .end_run_for_interrupt(
            run_id,
            1,
            Some(RunLimit::TokenLimit),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the overtaken limit's end is left");
    assert!(!limit_ended);
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
        .expect("the next usage report's stop sends the interrupt alone");
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
    let stopped = engine
        .end_run_for_interrupt(
            run_id,
            3,
            Some(RunLimit::TokenLimit),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the run ends at its token limit");

    assert!(stopped);
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.tokenLimit.reached", None, None),
            ("agent.run.interrupted", None, None),
            ("agent.run.running", None, None),
            ("agent.turn.started", None, None),
            ("agent.turn.interrupted", Some("tokenLimit"), Some("daemon")),
            ("agent.run.stopped", None, None),
        ])
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("stopped".to_owned(), 4)
    );
}

// Killed by the interrupt alone reading a run being continued as ended, which sends no
// interrupt and leaves the continued run past the session's spend limit.
#[tokio::test]
async fn a_spend_stop_retried_during_a_continue_interrupts_the_continued_run() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 1);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;

    let refused = engine.stop_at_spend_limit(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the first stop answers {refused:?}"
    );
    let ended = engine
        .end_run_for_interrupt(run_id, 1, None, RunStateChangeCompanions::default())
        .await
        .expect("the person's interrupt ends the run");
    assert!(ended);
    let (start_driver, driver_has_started, release_driver) = held_driver();
    let request = continue_request(run_id, start_driver);
    let stop_during_continue = async {
        driver_has_started
            .await
            .expect("the driver's start is reached");
        let release = async {
            tokio::time::sleep(DRIVER_HOLD).await;
            release_driver
                .send(())
                .expect("the continue still waits in its driver");
        };
        tokio::join!(engine.stop_at_spend_limit(run_id), release).0
    };
    let (continued, stopped) = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::join!(engine.continue_run(request), stop_during_continue)
    })
    .await
    .expect("the continue and the stop settle");

    continued.expect("the continue runs the run again");
    stopped.expect("the retried stop's interrupt is accepted");
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
}

// Killed by the pending check counting any interrupt, any limit's, or one whose outcome is in:
// a second token interrupt then goes while the first is pending, or none goes once the only
// interrupt left is another limit's or a failed one.
#[rstest]
#[case::token_limit_requested("tokenLimit", "requested", 1)]
#[case::token_limit_accepted("tokenLimit", "accepted", 1)]
#[case::token_limit_failed("tokenLimit", "failed", 2)]
#[case::step_limit_accepted("stepLimit", "accepted", 2)]
#[tokio::test]
async fn a_token_stop_past_its_reached_event_waits_only_on_its_own_pending_interrupt(
    #[case] limit: &str,
    #[case] state: &str,
    #[case] expected_calls: usize,
) {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    engine
        .stop_at_token_limit(run_id, token_limit())
        .await
        .expect("the limit's interrupt is accepted");
    database
        .reader()
        .execute(
            "INSERT INTO interventions (id, target_run_id, type, state, payload,
               expected_run_version, client_idempotency_key, created_at)
             VALUES ('interrupt', ?1, 'interrupt', ?2, json_object('limit', ?3), 1, 'interrupt',
               '2026-01-01T00:00:00.000Z')",
            [run_id.text().as_str(), state, limit],
        )
        .expect("the test records the run's interrupt");

    engine
        .stop_at_token_limit(run_id, token_limit())
        .await
        .expect("the next usage report's stop is left or sends the interrupt alone");

    assert_eq!(interventions.calls.load(Ordering::SeqCst), expected_calls);
}
