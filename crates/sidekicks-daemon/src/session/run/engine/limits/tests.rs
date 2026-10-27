mod overlapping_stops;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rstest::rstest;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use tokio::sync::SetOnce;

use super::LimitStop;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::mutex_lock::lock;
use crate::plans::schema::schema_parts;
use crate::provider::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use crate::session::run::engine::live::ContinuingRun;
use crate::session::run::engine::tests::{
    DRIVER_HOLD, SETTLE_WAIT, append, continue_request, events, hand_limit_interrupter,
    held_driver, insert_running_run, started_turn, step_stop, stored_events, stored_run_state,
    test_engine, token_limit, turn, turn_started_at,
};
use crate::session::run::engine::{RunEngine, RunEngineError};
use crate::session::run::state_change::RunStateChangeCompanions;
use sidekicks_contracts::wire::id::mint_uuid_v7;

// A person's interrupt accepted at `accepted_run_version` ends the run, and a continue runs it
// again.
async fn interrupt_and_continue(engine: &RunEngine, run_id: RunId, accepted_run_version: i64) {
    let ended = engine
        .end_run_for_interrupt(
            run_id,
            accepted_run_version,
            None,
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
    let database = TestDatabase::new(schema_parts());
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
        .end_run_for_interrupt(run_id, 1, None, None, RunStateChangeCompanions::default())
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
    let database = TestDatabase::new(schema_parts());
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
// guard refuses so no interrupt goes, by a retry sending no interrupt, and by a failed hand that
// left no row keeping its cut, which no restart reads.
#[tokio::test]
async fn a_token_stop_retried_after_a_failed_interrupt_sends_the_interrupt_alone() {
    let database = TestDatabase::new(schema_parts());
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
    assert!(lock(&engine.live).cut_turns.is_empty());
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
            Some(turn(1)),
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
    let database = TestDatabase::new(schema_parts());
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
        .end_run_for_interrupt(run_id, 1, None, None, RunStateChangeCompanions::default())
        .await
        .expect("the person's interrupt ends the run");
    assert!(ended);
    let limit_ended = engine
        .end_run_for_interrupt(
            run_id,
            1,
            Some(RunLimit::TokenLimit),
            Some(turn(1)),
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
            Some(turn(2)),
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
// interrupt and leaves the continued run past the session's spend limit, and by a failed hand that
// left no row keeping its cut.
#[tokio::test]
async fn a_spend_stop_retried_during_a_continue_interrupts_the_continued_run() {
    let database = TestDatabase::new(schema_parts());
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
    assert!(lock(&engine.live).cut_turns.is_empty());
    let ended = engine
        .end_run_for_interrupt(run_id, 1, None, None, RunStateChangeCompanions::default())
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

// Killed by the pending check counting any interrupt, any limit's, a person's, or one whose
// outcome is in: a second token interrupt then goes while the first is pending, or none goes once
// the only interrupt left is another limit's, a person's or a failed one; and by the retry a failed
// hand leaves skipping the check (`token_limit_requested_after_a_failed_hand`), which sends a
// second token interrupt while the first is still pending.
#[rstest]
#[case::token_limit_requested(r#"{"limit":"tokenLimit"}"#, "requested", 0, 1)]
#[case::token_limit_accepted(r#"{"limit":"tokenLimit"}"#, "accepted", 0, 1)]
#[case::token_limit_failed(r#"{"limit":"tokenLimit"}"#, "failed", 0, 2)]
#[case::step_limit_accepted(r#"{"limit":"stepLimit"}"#, "accepted", 0, 2)]
#[case::person_accepted(r#"{"pending":"nextTurn"}"#, "accepted", 0, 2)]
#[case::token_limit_requested_after_a_failed_hand(r#"{"limit":"tokenLimit"}"#, "requested", 1, 1)]
#[tokio::test]
async fn a_token_stop_past_its_reached_event_waits_only_on_its_own_pending_interrupt(
    #[case] record: &str,
    #[case] state: &str,
    #[case] refusals: usize,
    #[case] expected_calls: usize,
) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, refusals);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    // The first hand is accepted, or refused, which keeps the limit owed; the test then inserts
    // the run's interrupt row itself.
    let first = engine.stop_at_token_limit(run_id, token_limit()).await;
    assert_eq!(
        first.is_ok(),
        refusals == 0,
        "the first stop answers {first:?}"
    );
    database
        .reader()
        .execute(
            "INSERT INTO interventions (id, target_run_id, type, state, payload,
               expected_run_version, client_idempotency_key, created_at)
             VALUES ('interrupt', ?1, 'interrupt', ?2, ?3, 1, 'interrupt',
               '2026-01-01T00:00:00.000Z')",
            [run_id.text().as_str(), state, record],
        )
        .expect("the test records the run's interrupt");

    engine
        .stop_at_token_limit(run_id, token_limit())
        .await
        .expect("the next usage report's stop is left or sends the interrupt alone");

    assert_eq!(interventions.calls.load(Ordering::SeqCst), expected_calls);
}

// Killed by a repeated spend stop sending its interrupt while the spend limit's interrupt of the
// run is pending, and by the check counting a failed one, which leaves the run past the limit.
#[rstest]
#[case::pending("accepted", 0)]
#[case::failed("failed", 1)]
#[tokio::test]
async fn a_spend_stop_waits_on_the_spend_limits_pending_interrupt(
    #[case] state: &str,
    #[case] expected_calls: usize,
) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    database
        .reader()
        .execute(
            "INSERT INTO interventions (id, target_run_id, type, state, payload,
               expected_run_version, client_idempotency_key, created_at)
             VALUES ('interrupt', ?1, 'interrupt', ?2, json_object('limit', 'spendLimit'), 1,
               'interrupt', '2026-01-01T00:00:00.000Z')",
            [run_id.text().as_str(), state],
        )
        .expect("the test records the run's interrupt");

    engine
        .stop_at_spend_limit(run_id)
        .await
        .expect("the next usage report's stop is left or sends the interrupt");

    assert_eq!(interventions.calls.load(Ordering::SeqCst), expected_calls);
}

// Killed by a turn cut twice keeping the later cut whatever its rank, which ends it `stepLimit`
// once the step stop follows the token stop (`token_then_step_provider_end_first`), and by the step
// limit's own end writing its own cause on a turn the token limit cut too
// (`step_then_token_run_end_first`).
#[rstest]
#[case::step_then_token_provider_end_first(false, true)]
#[case::step_then_token_run_end_first(false, false)]
#[case::token_then_step_provider_end_first(true, true)]
#[tokio::test]
async fn a_turn_two_limits_cut_ends_with_the_higher_ranked_limit(
    #[case] is_token_first: bool,
    #[case] is_provider_end_first: bool,
) {
    let database = TestDatabase::new(schema_parts());
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
    let stop_at_token = || async {
        engine
            .stop_at_token_limit(run_id, token_limit())
            .await
            .expect("the token limit's interrupt is accepted");
    };
    if is_token_first {
        stop_at_token().await;
    }
    engine
        .stop_at_limit(run_id, step_stop(1))
        .await
        .expect("the step limit's interrupt is accepted");
    if !is_token_first {
        stop_at_token().await;
    }

    let origin = if is_provider_end_first {
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
        "provider"
    } else {
        let ended = engine
            .end_run_for_interrupt(
                run_id,
                1,
                Some(RunLimit::StepLimit),
                Some(turn(1)),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the step limit's end ends the run");
        assert!(ended);
        "daemon"
    };

    let turn_end = stored_events(&database, &run_id)
        .into_iter()
        .find(|(event_type, _, _)| event_type == "agent.turn.interrupted");
    assert_eq!(
        turn_end,
        Some((
            "agent.turn.interrupted".to_owned(),
            Some("tokenLimit".to_owned()),
            Some(origin.to_owned())
        ))
    );
}

// How a test fails a limit stop after its cut went in.
#[derive(Clone, Copy, Debug)]
enum StopFailure {
    // The read of whether the limit's interrupt is pending fails.
    PendingReadFails,
    // The interventions service is gone by the time the interrupt is handed.
    InterrupterGone,
    // The service fails the interrupt and leaves no row pending.
    NoRow,
    // The service fails the interrupt with its row still pending.
    RowPending,
}

// Killed by a failed pending read keeping the stop's cut (`spend_pending_read_fails`), by a gone
// service or a failed hand that left no row keeping it (`spend_interrupter_gone`, `spend_no_row`,
// `step_no_row`), and by a hand whose row is still pending rolling it back (`spend_row_pending`):
// the live path then ends the turn with a limit no row names, or without the one a row names; and
// by a failed step hand forgetting the limit its retry hands again (`step_no_row`).
#[rstest]
#[case::spend_pending_read_fails(false, StopFailure::PendingReadFails)]
#[case::spend_interrupter_gone(false, StopFailure::InterrupterGone)]
#[case::spend_no_row(false, StopFailure::NoRow)]
#[case::spend_row_pending(false, StopFailure::RowPending)]
#[case::step_no_row(true, StopFailure::NoRow)]
#[tokio::test]
async fn a_failed_stop_keeps_its_cut_only_while_its_row_is_pending(
    #[case] is_step: bool,
    #[case] failure: StopFailure,
) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let refusals = usize::from(matches!(
        failure,
        StopFailure::NoRow | StopFailure::RowPending
    ));
    let interventions = hand_limit_interrupter(&engine, refusals);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    let stop = if is_step {
        step_stop(1)
    } else {
        LimitStop::Interrupt {
            limit: RunLimit::SpendLimit,
        }
    };

    let stopped = match failure {
        StopFailure::PendingReadFails => {
            database
                .reader()
                .execute_batch("DROP TABLE interventions")
                .expect("the test drops the interventions table");
            engine.stop_at_limit(run_id, stop).await
        }
        StopFailure::InterrupterGone => {
            // The stop waits out a continue that settles only once the service is gone, after
            // the stop found it live.
            let continuing = Arc::new(ContinuingRun {
                is_turn_started: AtomicBool::new(false),
                settled: SetOnce::new(),
            });
            lock(&engine.live)
                .continuing
                .insert(run_id, Arc::clone(&continuing));
            let stopping = engine.stop_at_limit(run_id, stop);
            tokio::pin!(stopping);
            assert!(
                futures::poll!(&mut stopping).is_pending(),
                "the stop waits out the continue"
            );
            drop(interventions);
            continuing
                .settled
                .set(())
                .expect("the test settles the continue once");
            stopping.await
        }
        StopFailure::NoRow => engine.stop_at_limit(run_id, stop).await,
        StopFailure::RowPending => {
            interventions.refuse_with_row_pending();
            engine.stop_at_limit(run_id, stop).await
        }
    };

    let is_failure_expected = match failure {
        // The pending read is the stop's one read of the interventions table.
        StopFailure::PendingReadFails => matches!(
            &stopped,
            Err(RunEngineError::Read(error)) if error.to_string().contains("interventions")
        ),
        StopFailure::InterrupterGone => {
            matches!(stopped, Err(RunEngineError::LimitInterrupterGone { .. }))
        }
        StopFailure::NoRow | StopFailure::RowPending => {
            matches!(stopped, Err(RunEngineError::LimitInterrupt { .. }))
        }
    };
    assert!(is_failure_expected, "the stop answers {stopped:?}");
    let live = lock(&engine.live);
    assert_eq!(
        live.cut_turns.contains_key(&(run_id, turn(1))),
        matches!(failure, StopFailure::RowPending)
    );
    assert_eq!(
        live.reached_limits.contains(&(run_id, RunLimit::StepLimit)),
        is_step,
        "a step stop's limit stays owed for its retry"
    );
}
