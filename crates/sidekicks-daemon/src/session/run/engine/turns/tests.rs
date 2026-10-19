use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::wire::integer::SafeInt;

use super::{StepCount, no_turn_end_statement, no_turn_start_from_statement};
use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
use crate::events::log_service::tests::open_log;
use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
use crate::session::run::engine::RunEngineError;
use crate::session::run::engine::live::lock;
use crate::session::run::engine::tests::{
    append, hand_limit_interrupter, insert_running_run, stored_events, stored_run_state,
    test_engine, turn_started_at,
};
use crate::session::run::state_change::RunStateChangeCompanions;
use crate::uuid_v7::mint_uuid_v7;

fn turn(number: u64) -> SafeInt<1> {
    SafeInt::new(number).expect("the test's turn numbers count from 1")
}

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

    lock(&engine.live).step_counts.insert(
        run_id,
        StepCount {
            turn_number: turn(1),
            bound: turn(1),
            steps: 0,
            is_stopping: false,
        },
    );
    for step in 1..=2 {
        let counted = engine.count_step(run_id).await;
        assert!(
            matches!(counted, Err(RunEngineError::LimitInterrupterGone { .. })),
            "step {step} answers {counted:?}"
        );
    }
    assert!(stored_events(&database, &run_id).is_empty());
}

// Killed by a step stop retried after its interrupt failed writing the reached event again,
// and by the failed interrupt leaving the count stopping, so the next step sends none.
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
    lock(&engine.live).step_counts.insert(
        run_id,
        StepCount {
            turn_number: turn(1),
            bound: turn(1),
            steps: 0,
            is_stopping: false,
        },
    );

    let refused = engine.count_step(run_id).await;
    assert!(
        matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
        "the first stop answers {refused:?}"
    );
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
