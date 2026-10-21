use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;

use super::{
    interrupt_state, limit_record, record_interrupt, step_limit_reached, token_limit_reached,
};
use crate::database::statement::DATABASE_NOW_SQL;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::session::run::engine::tests::{
    append, events, hand_limit_interrupter, insert_running_run, step_stop, stored_events,
    stored_run_state, test_engine, turn_started_at,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;

// The provider process's exit the tests report.
fn process_exit() -> ProcessExit {
    serde_json::from_value(json!({ "exitCode": 1, "outputTail": "the provider stopped" }))
        .expect("the test's exit reads as one")
}

// The trigger of the run's end of type `end_type`.
fn end_trigger(database: &TestDatabase, run_id: &RunId, end_type: &str) -> Option<String> {
    database
        .reader()
        .query_row(
            "SELECT json_extract(payload, '$.trigger') FROM session_events
              WHERE run_id = ?1 AND type = ?2",
            [run_id.text().as_str(), end_type],
            |row| row.get(0),
        )
        .expect("the test reads the run's end")
}

// What a live run waits on when its provider process exits.
#[derive(Clone, Copy, Debug)]
enum LiveStops {
    // Nothing.
    None,
    // A live step stop of turn 1 handed its interrupt, whose row is still pending.
    StepCut,
    // Only the spend limit's pending row, naming turn 1, from a stop of an earlier process.
    SpendPending,
    // A person's pending interrupt beside the step limit's pending row naming turn 1, the step
    // limit owed too.
    PersonBesideStep,
}

// Killed by a process exit failing a run whose step limit's stop it still owes or has pending,
// which loses the limit's end and its `Continue` (`step_cut`, `spend_pending`); by deciding from
// the owed limit alone, which fails a run whose stop is only pending (`spend_pending`); by leaving
// a pending interrupt pending on the ended run; by ending the turn a row names with the exit's
// failure, or a turn no row names with a limit; by the person's interrupt not deciding beside a
// limit with no token limit owed (`person_beside_step`); and by settling a run that waits on no
// stop as anything but `failed` (`no_stop`).
#[rstest]
#[case::no_stop(LiveStops::None, "agent.run.failed", None, None)]
#[case::step_cut(
    LiveStops::StepCut,
    "agent.run.interrupted",
    Some("stepLimit"),
    Some("stepLimit")
)]
#[case::spend_pending(
    LiveStops::SpendPending,
    "agent.run.interrupted",
    Some("spendLimit"),
    Some("spendLimit")
)]
#[case::person_beside_step(
    LiveStops::PersonBesideStep,
    "agent.run.interrupted",
    None,
    Some("stepLimit")
)]
#[tokio::test]
async fn a_process_exit_settles_a_live_run_as_its_stops_would_and_fails_every_uncut_turn(
    #[case] stops: LiveStops,
    #[case] end_type: &str,
    #[case] trigger: Option<&str>,
    #[case] turn_one_cause: Option<&str>,
) {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    interventions.record_rows_in(&database);
    for turn_number in 1..=2 {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, turn_number, 1),
        )
        .await;
    }
    let mut expected = vec![
        ("agent.turn.started", None, None),
        ("agent.turn.started", None, None),
    ];
    match stops {
        LiveStops::None => {}
        LiveStops::StepCut => {
            engine
                .stop_at_limit(run_id, step_stop(1))
                .await
                .expect("the limit's interrupt is accepted");
            expected.push(("agent.run.stepLimit.reached", None, None));
        }
        LiveStops::SpendPending => {
            record_interrupt(
                &database,
                run_id,
                &limit_record("spendLimit", 1),
                "accepted",
                false,
            );
        }
        LiveStops::PersonBesideStep => {
            append(&engine, session_id, &step_limit_reached(session_id, run_id)).await;
            expected.push(("agent.run.stepLimit.reached", None, None));
            record_interrupt(
                &database,
                run_id,
                &limit_record("stepLimit", 1),
                "accepted",
                false,
            );
            record_interrupt(
                &database,
                run_id,
                r#"{"pending":"nextTurn"}"#,
                "accepted",
                true,
            );
        }
    }

    engine
        .end_turn_on_process_exit(run_id, process_exit())
        .await
        .expect("the exit ends the run");

    let turn_one_end = match turn_one_cause {
        Some(cause) => ("agent.turn.interrupted", Some(cause), Some("daemon")),
        None => ("agent.turn.failed", Some("processExit"), Some("daemon")),
    };
    expected.extend([
        turn_one_end,
        ("agent.turn.failed", Some("processExit"), Some("daemon")),
        (end_type, None, None),
    ]);
    assert_eq!(stored_events(&database, &run_id), events(&expected));
    assert_eq!(
        end_trigger(&database, &run_id, end_type).as_deref(),
        trigger
    );
    let state = if end_type == "agent.run.failed" {
        "failed"
    } else {
        "interrupted"
    };
    assert_eq!(stored_run_state(&database, &run_id), (state.to_owned(), 2));
    let pending_left: i64 = database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM interventions WHERE state <> 'applied'",
            [],
            |row| row.get(0),
        )
        .expect("the test reads the run's interrupts");
    assert_eq!(pending_left, 0, "every pending interrupt is applied");
}

// Killed by a process exit settling a run that is not live by its stops, which stops a run the
// person interrupted at the token limit its log still owes, or fails an ended or queued run; by
// moving its pending row; and by ending its turns with anything but the limit a row names, else
// the exit's failure.
#[rstest]
#[case::resting("interrupted")]
#[case::ended("completed")]
#[case::queued("queued")]
#[tokio::test]
async fn a_process_exit_keeps_a_run_that_is_not_live_and_ends_its_open_turns(#[case] state: &str) {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    for turn_number in 1..=2 {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, turn_number, 1),
        )
        .await;
    }
    append(
        &engine,
        session_id,
        &token_limit_reached(session_id, run_id),
    )
    .await;
    let step_row = record_interrupt(
        &database,
        run_id,
        &limit_record("stepLimit", 1),
        "accepted",
        false,
    );
    database
        .reader()
        .execute(
            "UPDATE runs SET state = ?1 WHERE run_id = ?2",
            [state, run_id.text().as_str()],
        )
        .expect("the test moves the run");

    engine
        .end_turn_on_process_exit(run_id, process_exit())
        .await
        .expect("the exit ends the run's open turns");

    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.turn.started", None, None),
            ("agent.run.tokenLimit.reached", None, None),
            ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
            ("agent.turn.failed", Some("processExit"), Some("daemon")),
        ])
    );
    assert_eq!(stored_run_state(&database, &run_id), (state.to_owned(), 1));
    assert_eq!(interrupt_state(&database, &step_row), "accepted");
}

// Killed by a process exit that returns its first refusal, which leaves the run running with the
// step limit's row pending, and by one that decides again from its first read, which the guard
// refuses once more since the person's interrupt that turn 1's end brought is still unread.
#[tokio::test]
async fn a_process_exit_refused_by_an_interrupt_asked_for_since_its_read_reads_again_once() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    for turn_number in 1..=2 {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, turn_number, 1),
        )
        .await;
    }
    let step_row = record_interrupt(
        &database,
        run_id,
        &limit_record("stepLimit", 1),
        "accepted",
        false,
    );
    // A person asks for an interrupt once turn 1's end, written before the run's, lands; its id,
    // minted after the step row's, sorts after it where the two share a millisecond.
    let person_row = mint_uuid_v7().to_string();
    database
        .reader()
        .execute_batch(&format!(
            "CREATE TRIGGER person_interrupt_after_turn_one AFTER INSERT ON session_events
               WHEN NEW.type = 'agent.turn.interrupted' AND NEW.turn_number = 1
             BEGIN
               INSERT INTO interventions (id, target_run_id, type, state, payload, device_id,
                 expected_run_version, client_idempotency_key, created_at)
               VALUES ('{person_row}', NEW.run_id, 'interrupt', 'requested',
                 '{{\"pending\":\"nextTurn\"}}', 'phone', 1, '{person_row}',
                 {DATABASE_NOW_SQL});
             END;"
        ))
        .expect("the test makes the person's interrupt follow turn 1's end");

    engine
        .end_turn_on_process_exit(run_id, process_exit())
        .await
        .expect("the exit reads the run again and ends it");

    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.turn.started", None, None),
            ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
            ("agent.turn.failed", Some("processExit"), Some("daemon")),
            ("agent.run.interrupted", None, None),
        ])
    );
    assert_eq!(
        end_trigger(&database, &run_id, "agent.run.interrupted"),
        None
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("interrupted".to_owned(), 2)
    );
    for row in [step_row.as_str(), person_row.as_str()] {
        assert_eq!(interrupt_state(&database, row), "applied");
    }
}
