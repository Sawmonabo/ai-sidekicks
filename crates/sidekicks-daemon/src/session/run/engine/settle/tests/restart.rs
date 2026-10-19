use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::{
    AgentInterventionRequestedPayload, AgentInterventionRequestedState, AgentTurnCompletedPayload,
    DaemonInterventionActor, InterventionActor,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{InterventionId, InterventionType};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;

use super::{
    LIMIT_INTERRUPT_ID, PERSON_INTERRUPT_ID, STEP_INTERRUPT_ID, interrupted_at, running_at,
    step_limit_reached, token_limit_reached,
};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::session::run::engine::RunEngineError;
use crate::session::run::engine::tests::{
    INTERVENTIONS_TABLE_SQL, append, continue_request, events, hand_limit_interrupter,
    insert_running_run, run_version, started_turn, stored_events, stored_run_state, test_engine,
    token_limit, turn_started_at,
};
use crate::session::run::projection::RUNS_TABLE_SQL;
use crate::session::run::read::{LiveRun, RunRead};
use crate::session::run::restart::{QUEUE_ITEMS_TABLE_SQL, RestartFacts, read_restart_facts};
use crate::session::run::state_change::{RunStateChangeCompanions, RunStateChangeError};
use crate::uuid_v7::mint_uuid_v7;

// Killed by the owed read joining the interventions, where the failed token interrupt and its
// requested event read as discharging the limit; by the person's pending interrupt or the
// newer step limit winning over the owed token limit; by applying only one pending interrupt,
// which leaves the other pending on an ended run; by ending only the newest open turn; and by
// giving the limit's cause to the newest turn rather than the one its stop cut.
#[tokio::test]
async fn a_restart_stops_a_run_at_the_token_limit_its_log_still_owes() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    // Turn 1 was left open when turn 2 started; the token stop wrote its reached event on
    // turn 2 and its interrupt failed, a person's interrupt is still pending, a step stop
    // reached its bound and its interrupt is pending too, and turn 3 started before the daemon
    // went down.
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
    let connection = database.reader();
    connection
        .execute(
            "INSERT INTO interventions (id, target_run_id, type, state, payload, device_id,
               expected_run_version, client_idempotency_key, created_at)
             VALUES (?1, ?2, 'interrupt', 'failed', '{\"limit\":\"tokenLimit\"}', NULL, 1, ?1,
                     '2026-01-01T00:00:00.000Z'),
                    (?3, ?2, 'interrupt', 'accepted', '{\"pending\":\"nextTurn\"}', 'phone',
                     1, ?3, '2026-01-01T00:00:01.000Z'),
                    (?4, ?2, 'interrupt', 'requested', '{\"limit\":\"stepLimit\"}', NULL, 1,
                     ?4, '2026-01-01T00:00:02.000Z')",
            params![
                LIMIT_INTERRUPT_ID,
                run_id.text().as_str(),
                PERSON_INTERRUPT_ID,
                STEP_INTERRUPT_ID,
            ],
        )
        .expect("the test records the run's interrupts");
    append(
        &engine,
        session_id,
        &SessionEvent::AgentInterventionRequested(AgentInterventionRequestedPayload {
            session_id,
            intervention_id: InterventionId::new(LIMIT_INTERRUPT_ID)
                .expect("the test's id is an intervention id"),
            target_run_id: run_id,
            intervention_type: InterventionType::Interrupt,
            state: AgentInterventionRequestedState::Value,
            actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
        }),
    )
    .await;
    append(&engine, session_id, &step_limit_reached(session_id, run_id)).await;
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 3, 1),
    )
    .await;

    engine
        .settle_run_after_restart(&running_at(session_id, run_id, 1), "not resumed")
        .await
        .expect("the restart settles the run");

    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.turn.started", None, None),
            ("agent.run.tokenLimit.reached", None, None),
            ("agent.run.stepLimit.reached", None, None),
            ("agent.turn.started", None, None),
            (
                "agent.turn.interrupted",
                Some("daemonRestart"),
                Some("daemon")
            ),
            ("agent.turn.interrupted", Some("tokenLimit"), Some("daemon")),
            (
                "agent.turn.interrupted",
                Some("daemonRestart"),
                Some("daemon")
            ),
            ("agent.run.stopped", None, None),
        ])
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("stopped".to_owned(), 2)
    );
    let interrupt_states: Vec<(String, String)> = connection
        .prepare("SELECT id, state FROM interventions ORDER BY id")
        .expect("the test reads the run's interrupts")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the interrupts read")
        .collect::<Result<_, _>>()
        .expect("each interrupt reads");
    assert_eq!(
        interrupt_states,
        [
            (LIMIT_INTERRUPT_ID.to_owned(), "failed".to_owned()),
            (PERSON_INTERRUPT_ID.to_owned(), "applied".to_owned()),
            (STEP_INTERRUPT_ID.to_owned(), "applied".to_owned()),
        ],
        "every pending interrupt is applied by the run's end"
    );
}

// One record of a run's log before a restart.
#[derive(Clone, Copy, Debug)]
enum Logged {
    TurnStarted(u64),
    TurnCompleted(u64),
    StepReached,
    TokenReached,
    RunInterrupted,
    // The spend limit's interrupt, accepted and still pending, recorded now.
    SpendInterruptPending,
}

// Killed by the cut read keeping only one mark of the limit, which gives turn 1 `daemonRestart`
// though its own stop cut it (`two_steps_on_overlapping_turns`); by reading the turn a mark names
// as the newest started before it, ended or not, which cuts turn 3
// (`reached_after_turn_two_ended`); by giving a limit's cause to an open turn no mark names
// (`reaching_turn_closed`) or to the newest open turn over the one the stop cut
// (`step_cut_on_an_older_turn`); by keeping a step limit a later interrupt of the run discharged,
// or ending a turn a discharged limit cut with the run's failure
// (`step_discharged_by_an_interrupt`); by giving a turn only the limit that settles the run
// (`step_cut_beside_an_owed_token_limit`, `step_cut_beside_a_pending_spend_interrupt`); and by
// reading no interrupt row as a mark (`step_cut_beside_a_pending_spend_interrupt`).
#[rstest]
#[case::two_steps_on_overlapping_turns(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::TurnStarted(2),
        Logged::StepReached,
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::reached_after_turn_two_ended(
    &[
        Logged::TurnStarted(1),
        Logged::TurnStarted(2),
        Logged::TurnCompleted(2),
        Logged::TokenReached,
        Logged::TurnStarted(3),
    ],
    "stopped",
    &[
        ("agent.turn.interrupted", Some("tokenLimit"), Some("daemon")),
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.stopped", None, None),
    ]
)]
#[case::reaching_turn_closed(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::TurnCompleted(1),
        Logged::TurnStarted(2),
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::step_cut_on_an_older_turn(
    &[Logged::TurnStarted(1), Logged::StepReached, Logged::TurnStarted(2)],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::step_discharged_by_an_interrupt(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::RunInterrupted,
        Logged::TurnStarted(2),
    ],
    "failed",
    &[
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.turn.failed", Some("daemonRestart"), Some("daemon")),
        ("agent.run.failed", None, None),
    ]
)]
#[case::step_cut_beside_an_owed_token_limit(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::TurnStarted(2),
        Logged::TokenReached,
    ],
    "stopped",
    &[
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.turn.interrupted", Some("tokenLimit"), Some("daemon")),
        ("agent.run.stopped", None, None),
    ]
)]
#[case::step_cut_beside_a_pending_spend_interrupt(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::TurnStarted(2),
        Logged::SpendInterruptPending,
        Logged::TurnStarted(3),
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.turn.interrupted", Some("spendLimit"), Some("daemon")),
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[tokio::test]
async fn a_restart_ends_the_turns_its_owed_limit_reached_with_the_limit(
    #[case] logged: &[Logged],
    #[case] settled_state: &str,
    #[case] settled_events: &[(&str, Option<&str>, Option<&str>)],
) {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let mut expected = Vec::new();
    for &record in logged {
        let (event, event_type) = match record {
            Logged::SpendInterruptPending => {
                database
                    .reader()
                    .execute(
                        "INSERT INTO interventions (id, target_run_id, type, state, payload,
                           expected_run_version, client_idempotency_key, created_at)
                         VALUES (?1, ?2, 'interrupt', 'accepted', '{\"limit\":\"spendLimit\"}', 1,
                           ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        params![LIMIT_INTERRUPT_ID, run_id.text().as_str()],
                    )
                    .expect("the test records the spend limit's interrupt");
                // A turn started in the same millisecond reads as started before the row.
                tokio::time::sleep(Duration::from_millis(2)).await;
                continue;
            }
            Logged::TurnStarted(turn_number) => (
                turn_started_at(session_id, run_id, turn_number, 1),
                "agent.turn.started",
            ),
            Logged::TurnCompleted(turn_number) => (
                SessionEvent::AgentTurnCompleted(AgentTurnCompletedPayload {
                    session_id,
                    run_id,
                    run_version: run_version(1),
                    turn_number: SafeInt::new(turn_number).expect("the test's turns count from 1"),
                }),
                "agent.turn.completed",
            ),
            Logged::StepReached => (
                step_limit_reached(session_id, run_id),
                "agent.run.stepLimit.reached",
            ),
            Logged::TokenReached => (
                token_limit_reached(session_id, run_id),
                "agent.run.tokenLimit.reached",
            ),
            Logged::RunInterrupted => (
                interrupted_at(session_id, run_id, 1),
                "agent.run.interrupted",
            ),
        };
        append(&engine, session_id, &event).await;
        expected.push((event_type, None, None));
    }
    expected.extend_from_slice(settled_events);

    engine
        .settle_run_after_restart(&running_at(session_id, run_id, 1), "not resumed")
        .await
        .expect("the restart settles the run");

    assert_eq!(stored_events(&database, &run_id), events(&expected));
    assert_eq!(
        stored_run_state(&database, &run_id),
        (settled_state.to_owned(), 2)
    );
}

// Killed by the owed read taking the overtaken token interrupt as the limit's discharge, which
// fails a run the live path would stop at its token limit, and by giving the limit's cause to
// turn 2, which the continue started after the stop cut turn 1.
#[tokio::test]
async fn a_restart_after_an_overtaken_token_stop_and_a_continue_stops_the_run() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let _interventions = hand_limit_interrupter(&engine, 0);
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
    // A person's interrupt ends the run before the limit's end, a continue runs turn 2, and
    // the daemon goes down before turn 1's provider end.
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
    drop(engine);
    let restarted = test_engine(&database, log.service, home.path());

    restarted
        .settle_run_after_restart(&running_at(session_id, run_id, 3), "not resumed")
        .await
        .expect("the restart settles the run");

    assert_eq!(
        stored_events(&database, &run_id),
        events(&[
            ("agent.turn.started", None, None),
            ("agent.run.tokenLimit.reached", None, None),
            ("agent.run.interrupted", None, None),
            ("agent.run.running", None, None),
            ("agent.turn.started", None, None),
            ("agent.turn.interrupted", Some("tokenLimit"), Some("daemon")),
            (
                "agent.turn.interrupted",
                Some("daemonRestart"),
                Some("daemon")
            ),
            ("agent.run.stopped", None, None),
        ])
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("stopped".to_owned(), 4)
    );
}

// Killed by the waiting-item guard's refusal read at any other position, which answers a run
// its queue still starts with an error, or by dropping the guard, which fails that run.
#[tokio::test]
async fn a_message_queued_while_a_restart_settles_a_queued_run_leaves_it_queued() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let connection = database.reader();
    connection
        .execute_batch(RUNS_TABLE_SQL)
        .and_then(|()| connection.execute_batch(QUEUE_ITEMS_TABLE_SQL))
        .and_then(|()| connection.execute_batch(INTERVENTIONS_TABLE_SQL))
        .expect("the test makes its tables");
    connection
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'queued', 0)",
            params![run_id.text().as_str(), session_id.text().as_str()],
        )
        .expect("the test queues the run");
    // Queued after the settle read the run had no message waiting.
    connection
        .execute(
            "INSERT INTO queue_items (id, session_id, state, target_run_id, created_at,
               updated_at)
             VALUES ('item', ?1, 'queued', ?2, '', '')",
            params![session_id.text().as_str(), run_id.text().as_str()],
        )
        .expect("the test queues a message for the run");
    let engine = test_engine(&database, log.service, home.path());
    let run = LiveRun {
        run_id,
        run: RunRead {
            version: 0,
            session_id,
            state: RunState::Queued,
        },
        parent_run_id: None,
        reached_by: None,
    };

    let settled = engine
        .settle_run_from_facts(
            &run,
            &RestartFacts {
                pending_interrupts: Vec::new(),
                owed_limit: None,
                turn_cuts: Vec::new(),
                has_queued_item: false,
            },
            "the run could not be resumed",
        )
        .await
        .expect("a run its queue still starts is left");

    assert_eq!(settled, run.run);
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("queued".to_owned(), 0)
    );
    assert!(stored_events(&database, &run_id).is_empty());
}

// Killed by pushing the no-pending guard only when the settle read no pending interrupt, which
// lets the restart's end pass over an interrupt asked for after its read, and by pushing it
// before the moves, which refuses at another position.
#[tokio::test]
async fn a_restart_settle_is_refused_by_an_interrupt_asked_for_after_its_read() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let connection = database.reader();
    let record_interrupt = |id: &str, payload: &str, device_id: Option<&str>, created_at: &str| {
        connection
            .execute(
                "INSERT INTO interventions (id, target_run_id, type, state, payload, device_id,
                   expected_run_version, client_idempotency_key, created_at)
                 VALUES (?1, ?2, 'interrupt', 'accepted', ?3, ?4, 1, ?1, ?5)",
                params![id, run_id.text().as_str(), payload, device_id, created_at],
            )
            .expect("the test records the run's interrupt");
    };
    record_interrupt(
        PERSON_INTERRUPT_ID,
        r#"{"pending":"nextTurn"}"#,
        Some("phone"),
        "2026-01-01T00:00:00.000Z",
    );
    let run = running_at(session_id, run_id, 1);
    let facts = read_restart_facts(&connection, &run).expect("the restart reads the run's facts");
    // The step limit's interrupt is asked for after the read.
    record_interrupt(
        STEP_INTERRUPT_ID,
        r#"{"limit":"stepLimit"}"#,
        None,
        "2026-01-01T00:00:01.000Z",
    );

    let settled = engine
        .settle_run_from_facts(&run, &facts, "not resumed")
        .await;

    let rows_read = facts.pending_interrupts.len();
    assert_eq!(rows_read, 1);
    assert!(
        matches!(
            settled,
            Err(RunEngineError::Change(RunStateChangeError::CompanionRefused {
                companion_index,
                ..
            })) if companion_index == rows_read
        ),
        "the settle answers {settled:?}"
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("running".to_owned(), 1)
    );
    assert!(stored_events(&database, &run_id).is_empty());
}
