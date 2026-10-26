use std::sync::Arc;
use std::sync::atomic::Ordering;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;

use super::{no_turn_end_statement, no_turn_start_from_statement};
use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
use crate::events::log_service::tests::open_log;
use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
use crate::mutex_lock::lock;
use crate::session::run::engine::RunEngineError;
use crate::session::run::engine::tests::{
    append, arm_step_count, events, hand_limit_interrupter, insert_running_run, provider_end,
    stored_events, stored_run_state, test_engine, turn, turn_started_at,
};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::state_change::RunStateChangeCompanions;
use sidekicks_contracts::wire::id::mint_uuid_v7;

// Killed by the append not writing an event's turn number, which lets every guard pass on a
// NULL column, by the start guard reading `=` for `>=`, which lets a start numbered below the
// newest through, or by either guard spelling the category other than the stored word.
#[tokio::test]
async fn the_turn_guards_refuse_a_taken_number_and_a_second_end() {
    let database = TestDatabase::new();
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let stored = |event: serde_json::Value| {
        let event: SessionEvent =
            serde_json::from_value(event).expect("the test writes a turn event");
        let envelope = test_envelope(session_id, &event);
        SessionEventRow {
            payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
            envelope: Arc::new(envelope),
            monotonic_ns: monotonic_ns_now(),
            content_payload: None,
        }
    };
    // Turn 1 started and completed, turn 3 started and open; no start holds 2.
    let turn_event = |event_type: &str, turn_number: u64| {
        stored(json!({
            "type": event_type,
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "runVersion": 2,
                "turnNumber": turn_number,
            },
        }))
    };
    writer
        .append_events(
            vec![
                turn_event("agent.turn.started", 1),
                turn_event("agent.turn.completed", 1),
                turn_event("agent.turn.started", 3),
            ],
            Vec::new(),
        )
        .await
        .expect("the turn rows are appended");

    for (guard, is_refused) in [
        (no_turn_start_from_statement(&run_id, turn(2)), true),
        (no_turn_start_from_statement(&run_id, turn(4)), false),
        (no_turn_end_statement(&run_id, turn(1)), true),
        (no_turn_end_statement(&run_id, turn(3)), false),
    ] {
        let written = writer.write(vec![guard]).await;
        assert_eq!(
            matches!(
                written,
                Err(WriteError::Refused {
                    statement_index: 0,
                    ..
                })
            ),
            is_refused,
            "the guard answers {written:?}"
        );
    }
}

// Killed by a limit stop reading the run or writing before it finds the interventions service
// gone, and by a failed stop leaving the count stopping, so the next step reaches no stop.
#[tokio::test]
async fn a_limit_stop_with_no_interventions_service_writes_nothing_and_is_tried_again() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let engine = test_engine(&database, log.service, home.path());

    let spend_stop = engine.stop_at_spend_limit(run_id).await;
    assert!(
        matches!(spend_stop, Err(RunEngineError::LimitInterrupterGone { .. })),
        "the spend stop answers {spend_stop:?}"
    );

    arm_step_count(&engine, run_id, 1, 1);
    for step in 1..=2 {
        let counted = engine.count_step(run_id).await;
        assert!(
            matches!(counted, Err(RunEngineError::LimitInterrupterGone { .. })),
            "step {step} answers {counted:?}"
        );
    }
    assert!(stored_events(&database, &run_id).is_empty());
}

// Killed by a step stop retried after its interrupt failed writing the reached event again, by
// the failed interrupt leaving the count stopping, so the next step sends none, and by it keeping
// the cut no row names.
#[tokio::test]
async fn a_step_stop_retried_after_a_failed_interrupt_writes_one_reached_event() {
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
    arm_step_count(&engine, run_id, 1, 1);

    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the first stop answers {refused:?}"
    );
    assert!(lock(&engine.live).cut_turns.is_empty());
    engine
        .count_step(run_id)
        .await
        .expect("the retried stop's interrupt is accepted");
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
    // The interventions service ends the run with the limit it accepted at version 1.
    let ended = engine
        .end_run_for_interrupt(
            run_id,
            1,
            Some(RunLimit::StepLimit),
            Some(turn(1)),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the run ends at its limit");

    assert!(ended);
    assert_eq!(
        stored_events(&database, &run_id),
        [
            ("agent.turn.started".to_owned(), None, None),
            ("agent.run.stepLimit.reached".to_owned(), None, None),
            (
                "agent.turn.interrupted".to_owned(),
                Some("stepLimit".to_owned()),
                Some("daemon".to_owned())
            ),
            ("agent.run.interrupted".to_owned(), None, None),
        ]
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("interrupted".to_owned(), 2)
    );
}

// Killed by the count marking its turn reached only once the reached event lands: two steps of
// one turn delivered at once then both write that turn's reached event.
#[tokio::test]
async fn two_steps_delivered_at_once_write_one_reached_event() {
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
    arm_step_count(&engine, run_id, 1, 1);

    let (first, second) = tokio::join!(engine.count_step(run_id), engine.count_step(run_id));
    first.expect("the first step is counted");
    second.expect("the second step is counted");

    assert_eq!(interventions.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
        ])
    );
}

// Killed by a step stop refused on the run's state leaving the count stopping: the step that tries
// again once the run can be stopped then sends no interrupt.
#[tokio::test]
async fn a_step_stop_refused_on_the_runs_state_is_tried_again_at_the_next_step() {
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
    arm_step_count(&engine, run_id, 1, 1);
    let set_state = |state: &str| {
        database
            .reader()
            .execute(
                "UPDATE runs SET state = ?1 WHERE run_id = ?2",
                [state, run_id.text().as_str()],
            )
            .expect("the test moves the run");
    };

    // A queued run may not move to the step limit's end.
    set_state("queued");
    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(
            refused,
            Err(RunEngineError::Refused(
                RunRefusal::InvalidTransition { .. }
            ))
        ),
        "the first stop answers {refused:?}"
    );
    set_state("running");
    engine
        .count_step(run_id)
        .await
        .expect("the retried stop's interrupt is accepted");

    assert_eq!(interventions.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        stored_events(&database, &run_id),
        [
            ("agent.turn.started".to_owned(), None, None),
            ("agent.run.stepLimit.reached".to_owned(), None, None),
        ]
    );
}

// Killed by a turn's end, or the next turn's start, forgetting the step limit's interrupt its stop
// could not hand, by a retry that waits for the reaching turn's own count: the next step and the
// next turn end then hand nothing, and the run goes on past its step limit; and by a failed hand
// keeping its cut, which ends turn 1 or turn 2 with a limit no row names.
#[tokio::test]
async fn a_failed_resend_at_a_cut_turns_end_is_tried_at_the_next_step_and_turn_end() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 3);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    arm_step_count(&engine, run_id, 1, 1);

    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the stop answers {refused:?}"
    );
    let turn_one_ended = engine
        .record_turn_end(run_id, provider_end(1))
        .await
        .expect("the provider's end of the cut turn is written");
    assert!(turn_one_ended.written);
    assert!(
        matches!(
            turn_one_ended.resend_failure,
            Some(RunEngineError::LimitInterrupt { .. })
        ),
        "the resend answers {:?}",
        turn_one_ended.resend_failure
    );
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 2, 1),
    )
    .await;
    arm_step_count(&engine, run_id, 2, 5);
    let step_retried = engine.count_step(run_id).await;
    assert!(
        matches!(step_retried, Err(RunEngineError::LimitInterrupt { .. })),
        "the next step's retry answers {step_retried:?}"
    );
    let turn_two_ended = engine
        .record_turn_end(run_id, provider_end(2))
        .await
        .expect("the provider's end of turn 2 is written");

    assert!(turn_two_ended.written);
    assert!(turn_two_ended.resend_failure.is_none());
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 4);
    assert!(lock(&engine.live).reached_limits.is_empty());
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.turn.interrupted", None, Some("provider")),
            ("agent.turn.started", None, None),
            ("agent.turn.interrupted", None, Some("provider")),
        ])
    );
}

// Killed by a step stop deciding from the run's owed interrupt rather than its own turn's count:
// turn 2 reaching its own bound then writes no reached event of its own.
#[tokio::test]
async fn a_later_turn_reaching_its_bound_writes_its_own_reached_event_and_one_hand_clears_both() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 2);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    arm_step_count(&engine, run_id, 1, 1);
    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the stop answers {refused:?}"
    );
    let turn_one_ended = engine
        .record_turn_end(run_id, provider_end(1))
        .await
        .expect("the provider's end of the cut turn is written");
    assert!(turn_one_ended.resend_failure.is_some());
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 2, 1),
    )
    .await;
    arm_step_count(&engine, run_id, 2, 1);

    engine
        .count_step(run_id)
        .await
        .expect("turn 2's stop hands the interrupt");

    assert_eq!(interventions.calls.load(Ordering::SeqCst), 3);
    assert!(lock(&engine.live).reached_limits.is_empty());
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.turn.interrupted", None, Some("provider")),
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
        ])
    );
}

// Killed by the step interrupt handed again at a turn's end going straight to the interventions
// service: the open turn it cuts then holds no cut, and ends with the limit only when the run's
// end lands before its provider's frame; and by the hand leaving that turn's count unmarked, so
// its own bound writes a second reached event and sends a second interrupt.
#[rstest]
#[case::run_end_first(true)]
#[case::provider_end_first(false)]
#[tokio::test]
async fn a_step_interrupt_handed_again_cuts_the_open_turn_whichever_end_lands_first(
    #[case] is_run_end_first: bool,
) {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 1);
    // Turn 1 reached its bound and its interrupt failed; turn 2 started before turn 1's end,
    // which hands the interrupt again.
    for turn_number in 1..=2 {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, turn_number, 1),
        )
        .await;
    }
    arm_step_count(&engine, run_id, 1, 1);
    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the stop answers {refused:?}"
    );
    arm_step_count(&engine, run_id, 2, 1);
    let turn_one_ended = engine
        .record_turn_end(run_id, provider_end(1))
        .await
        .expect("the provider's end of the cut turn is written");
    assert!(turn_one_ended.resend_failure.is_none());
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
    // Turn 2, which the interrupt cut, reaching its own bound writes and sends nothing more.
    engine
        .count_step(run_id)
        .await
        .expect("turn 2's step is counted");
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);

    // The interventions service ends the run with the limit it accepted at version 1.
    let end_run = || {
        engine.end_run_for_interrupt(
            run_id,
            1,
            Some(RunLimit::StepLimit),
            Some(turn(2)),
            RunStateChangeCompanions::default(),
        )
    };
    if is_run_end_first {
        assert!(end_run().await.expect("the run ends at its limit"));
    }
    let turn_two_ended = engine
        .record_turn_end(run_id, provider_end(2))
        .await
        .expect("the provider's end of turn 2 is read");
    assert_eq!(turn_two_ended.written, !is_run_end_first);
    if !is_run_end_first {
        assert!(end_run().await.expect("the run ends at its limit"));
    }

    let turn_two_cause: Option<String> = database
        .reader()
        .query_row(
            "SELECT json_extract(payload, '$.cause') FROM session_events
              WHERE run_id = ?1 AND type = 'agent.turn.interrupted' AND turn_number = 2",
            [run_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("turn 2 holds one end");
    assert_eq!(turn_two_cause.as_deref(), Some("stepLimit"));
}

// Killed by a turn's reached write waiting on the step limit's interrupt another hand has in
// flight, which leaves turn 2 with no reached event of its own, and by the hand going while that
// one is in flight, which sends a second interrupt.
#[tokio::test]
async fn a_turn_reaching_its_bound_while_a_resend_is_in_flight_writes_its_reached_event_once() {
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
    arm_step_count(&engine, run_id, 1, 1);
    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the stop answers {refused:?}"
    );
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 2, 1),
    )
    .await;
    arm_step_count(&engine, run_id, 2, 1);
    // A resend of turn 1's interrupt is in flight.
    lock(&engine.live).step_interrupts_in_flight.insert(run_id);

    for _step in 1..=2 {
        engine
            .count_step(run_id)
            .await
            .expect("a step leaves the run to the hand in flight");
    }

    assert_eq!(interventions.calls.load(Ordering::SeqCst), 1);
    assert!(
        lock(&engine.live)
            .reached_limits
            .contains(&(run_id, RunLimit::StepLimit)),
        "the limit stays owed for the hand in flight"
    );
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
        ])
    );
}

// Killed by a turn reaching its bound sending its interrupt while the step limit's interrupt of
// the run is pending (`requested`, `accepted`), or by a resend that finds it pending once a hand
// in flight let go of the run sending one (`accepted_after_a_hand_in_flight`): either sends the
// run a second interrupt; by the pending check counting a failed interrupt (`failed`); by the stop
// keeping its cut, the step stop left to the hand in flight among them, which ends turn 2 with a
// limit no row names, or putting back its turn's reach, which writes its reached event again; and
// by the stop keeping the limit owed, which reads the pending row at every step.
#[rstest]
#[case::requested("requested", false, 1)]
#[case::accepted("accepted", false, 1)]
#[case::failed("failed", false, 2)]
#[case::accepted_after_a_hand_in_flight("accepted", true, 1)]
#[tokio::test]
async fn a_turn_reaching_its_bound_while_the_step_interrupt_is_pending_sends_none(
    #[case] state: &str,
    #[case] is_hand_in_flight: bool,
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
    for turn_number in 1..=2 {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, turn_number, 1),
        )
        .await;
    }
    arm_step_count(&engine, run_id, 1, 1);
    engine
        .count_step(run_id)
        .await
        .expect("turn 1's stop hands the interrupt");
    arm_step_count(&engine, run_id, 2, 1);
    // The interventions service records turn 1's interrupt.
    let record_interrupt = || {
        database
            .reader()
            .execute(
                "INSERT INTO interventions (id, target_run_id, type, state, payload,
                   expected_run_version, client_idempotency_key, created_at)
                 VALUES ('interrupt', ?1, 'interrupt', ?2,
                   json_object('limit', 'stepLimit', 'turnNumber', 1), 1, 'interrupt',
                   '2026-01-01T00:00:00.000Z')",
                [run_id.text().as_str(), state],
            )
            .expect("the test records the run's interrupt");
    };
    if is_hand_in_flight {
        // Turn 2 reaches its bound while a hand is in flight, before the interrupt is recorded.
        lock(&engine.live).step_interrupts_in_flight.insert(run_id);
        engine
            .count_step(run_id)
            .await
            .expect("turn 2's stop leaves the run to the hand in flight");
        record_interrupt();
        lock(&engine.live).step_interrupts_in_flight.remove(&run_id);
    } else {
        record_interrupt();
        engine
            .count_step(run_id)
            .await
            .expect("turn 2's step is counted");
    }
    engine
        .count_step(run_id)
        .await
        .expect("turn 2's next step is counted");
    engine
        .hand_owed_step_interrupt(run_id)
        .await
        .expect("a resend finds nothing owed");

    assert_eq!(interventions.calls.load(Ordering::SeqCst), expected_calls);
    let live = lock(&engine.live);
    assert!(live.reached_limits.is_empty());
    assert_eq!(
        live.cut_turns.contains_key(&(run_id, turn(2))),
        expected_calls == 2
    );
    drop(live);
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.run.stepLimit.reached", None, None),
        ])
    );
}

// Killed by a step stop writing its reached event and sending its interrupt for a turn that
// ended before its cut went in, which rests the run at a step limit no running turn reached, and by
// that stop forgetting the step limit's interrupt an earlier stop of the run could not hand.
#[tokio::test]
async fn a_step_stop_whose_turn_has_ended_writes_nothing_and_keeps_an_owed_interrupt() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 2);
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    // Turn 1's stop and its resend at the turn's end both fail to hand the interrupt.
    arm_step_count(&engine, run_id, 1, 1);
    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the stop answers {refused:?}"
    );
    let turn_one_ended = engine
        .record_turn_end(run_id, provider_end(1))
        .await
        .expect("the provider's end of turn 1 is written");
    assert!(turn_one_ended.written);
    assert!(turn_one_ended.resend_failure.is_some());
    // A step was counted against turn 1 while its end was being written.
    arm_step_count(&engine, run_id, 1, 1);

    engine
        .count_step(run_id)
        .await
        .expect("a step stop of a turn that has ended is left");

    assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
    let live = lock(&engine.live);
    assert!(
        live.reached_limits.contains(&(run_id, RunLimit::StepLimit)),
        "the earlier stop's interrupt is still owed"
    );
    assert!(live.cut_turns.is_empty());
    drop(live);
    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.turn.interrupted", None, Some("provider")),
        ])
    );
}

// Killed by the hand of the step limit's interrupt going while another is in flight, which sends
// the run two interrupts; by a resend left to that hand cutting a turn; and by that resend reading
// the run before it finds the hand in flight, which reads the run ended and forgets the limit, so
// no resend goes once the run runs again.
#[tokio::test]
async fn a_step_interrupt_resend_waits_for_the_hand_in_flight() {
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
    arm_step_count(&engine, run_id, 1, 1);
    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the stop answers {refused:?}"
    );
    let stop_cuts = lock(&engine.live).cut_turns.clone();
    let set_state = |state: &str| {
        database
            .reader()
            .execute(
                "UPDATE runs SET state = ?1 WHERE run_id = ?2",
                [state, run_id.text().as_str()],
            )
            .expect("the test moves the run");
    };
    // Another resend of the interrupt is in flight, and the run reads ended while it is.
    lock(&engine.live).step_interrupts_in_flight.insert(run_id);
    set_state("completed");

    engine
        .hand_owed_step_interrupt(run_id)
        .await
        .expect("the resend is left to the hand in flight");
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 1);
    let live = lock(&engine.live);
    assert_eq!(live.cut_turns, stop_cuts);
    assert!(
        live.reached_limits.contains(&(run_id, RunLimit::StepLimit)),
        "the resend read nothing, so the limit stays owed"
    );
    drop(live);

    set_state("running");
    lock(&engine.live).step_interrupts_in_flight.remove(&run_id);
    engine
        .hand_owed_step_interrupt(run_id)
        .await
        .expect("the resend's interrupt is accepted");
    assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
    assert!(lock(&engine.live).reached_limits.is_empty());
}
