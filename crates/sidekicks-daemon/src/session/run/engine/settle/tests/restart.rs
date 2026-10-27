use std::sync::Arc;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::{
    AgentInterventionRequestedPayload, AgentInterventionRequestedState, DaemonInterventionActor,
    InterventionActor,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{InterventionId, InterventionType};
use sidekicks_contracts::run::state::RunState;

use super::{
    LIMIT_INTERRUPT_ID, PERSON_INTERRUPT_ID, STEP_INTERRUPT_ID, interrupt_state, interrupted_at,
    limit_record, record_interrupt, running_at, step_limit_reached, token_limit_reached,
};
use crate::questions::schema::schema_parts;
use crate::run::engine::RunEngineError;
use crate::run::engine::tests::{
    append, continue_request, events, hand_limit_interrupter, insert_running_run, started_turn,
    stored_events, stored_run_state, test_engine, token_limit, turn_completed_at, turn_started_at,
};
use crate::run::read::{LiveRun, RunRead};
use crate::run::refusals::RunRefusal;
use crate::run::restart::{RestartFacts, read_restart_facts};
use crate::run::state_change::{RunStateChangeCompanions, RunStateChangeError};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::tests::open_log;

// Killed by the owed read joining the interventions, where the failed token interrupt and its
// requested event read as discharging the limit; by the person's pending interrupt or the
// newer step limit winning over the owed token limit; by applying only one pending interrupt,
// which leaves the other pending on an ended run; by ending only the newest open turn; by giving
// a row's limit to the newest turn rather than the one it names; and by reading a failed row as a
// cut, which ends turn 2 `tokenLimit`.
#[tokio::test]
async fn a_restart_stops_a_run_at_the_token_limit_its_log_still_owes() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    // Turn 1 was left open when turn 2 started; the token stop wrote its reached event on
    // turn 2 and its interrupt failed, a person's interrupt is still pending, a step stop of
    // turn 2 reached its bound and its interrupt is pending too, and turn 3 started before the
    // daemon went down.
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
             VALUES (?1, ?2, 'interrupt', 'failed', ?5, NULL, 1, ?1,
                     '2026-01-01T00:00:00.000Z'),
                    (?3, ?2, 'interrupt', 'accepted', '{\"pending\":\"nextTurn\"}', 'phone',
                     1, ?3, '2026-01-01T00:00:01.000Z'),
                    (?4, ?2, 'interrupt', 'requested', ?6, NULL, 1, ?4,
                     '2026-01-01T00:00:02.000Z')",
            params![
                LIMIT_INTERRUPT_ID,
                run_id.text().as_str(),
                PERSON_INTERRUPT_ID,
                STEP_INTERRUPT_ID,
                limit_record("tokenLimit", 2),
                limit_record("stepLimit", 2),
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
        .settle_run_after_restart(&running_at(session_id, run_id, 1), "not resumed", None)
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
            ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
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
    // The daemon's own interrupt row at a limit, naming the turn its stop cut, in a state.
    LimitRow(&'static str, u64, &'static str),
    // A faster-model retry still pending.
    RetryPending,
}

// Killed by the cut read keeping only one row of the limit, which gives turn 1 `daemonRestart`
// though its own stop cut it (`two_step_rows`); by placing a row on any turn but the one it names,
// such as turn 2, which ended before the token stop cut turn 1, or turn 3, the newest
// (`row_after_turn_two_ended`); by giving a limit's cause to an open turn no row names
// (`reaching_turn_closed`, `step_owed_with_no_row`) or to the newest open turn over the one a row
// names (`step_cut_on_an_older_turn`); by keeping a step limit a later interrupt of the run
// discharged, or leaving an applied row out of the cuts (`step_discharged_by_an_interrupt`); by
// reading a failed row as a cut (`failed_step_row`); by giving a turn only the limit that settles
// the run (`step_cut_beside_an_owed_token_limit`, `step_cut_beside_a_pending_spend_interrupt`); by
// a turn two rows name keeping the first or the later row's limit over the higher-ranked
// (`step_then_spend_rows`, `spend_then_step_rows`); and by the pending read taking a faster-model
// retry for an interrupt, or the run's end leaving the retry open (`retry_pending`).
#[rstest]
#[case::two_step_rows(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::LimitRow("stepLimit", 1, "accepted"),
        Logged::TurnStarted(2),
        Logged::StepReached,
        Logged::LimitRow("stepLimit", 2, "requested"),
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::row_after_turn_two_ended(
    &[
        Logged::TurnStarted(1),
        Logged::TurnStarted(2),
        Logged::TurnCompleted(2),
        Logged::TokenReached,
        Logged::LimitRow("tokenLimit", 1, "failed"),
        Logged::LimitRow("tokenLimit", 1, "accepted"),
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
        Logged::LimitRow("stepLimit", 1, "accepted"),
        Logged::TurnCompleted(1),
        Logged::TurnStarted(2),
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::step_owed_with_no_row(
    &[
        Logged::TurnStarted(1),
        Logged::TurnStarted(2),
        Logged::StepReached,
        Logged::TurnCompleted(2),
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::step_cut_on_an_older_turn(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::LimitRow("stepLimit", 1, "accepted"),
        Logged::TurnStarted(2),
    ],
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
        Logged::LimitRow("stepLimit", 1, "applied"),
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
#[case::failed_step_row(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::LimitRow("stepLimit", 1, "failed"),
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::step_cut_beside_an_owed_token_limit(
    &[
        Logged::TurnStarted(1),
        Logged::StepReached,
        Logged::LimitRow("stepLimit", 1, "accepted"),
        Logged::TurnStarted(2),
        Logged::TokenReached,
        Logged::LimitRow("tokenLimit", 2, "requested"),
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
        Logged::LimitRow("stepLimit", 1, "accepted"),
        Logged::TurnStarted(2),
        Logged::LimitRow("spendLimit", 2, "accepted"),
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
#[case::step_then_spend_rows(
    &[
        Logged::TurnStarted(1),
        Logged::LimitRow("stepLimit", 1, "accepted"),
        Logged::LimitRow("spendLimit", 1, "accepted"),
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("spendLimit"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::spend_then_step_rows(
    &[
        Logged::TurnStarted(1),
        Logged::LimitRow("spendLimit", 1, "accepted"),
        Logged::LimitRow("stepLimit", 1, "accepted"),
    ],
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("spendLimit"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::retry_pending(
    &[Logged::TurnStarted(1), Logged::RetryPending],
    "failed",
    &[
        ("agent.turn.failed", Some("daemonRestart"), Some("daemon")),
        ("agent.run.failed", None, None),
    ]
)]
#[tokio::test]
async fn a_restart_ends_each_turn_a_limits_row_names_with_the_limit(
    #[case] logged: &[Logged],
    #[case] settled_state: &str,
    #[case] settled_events: &[(&str, Option<&str>, Option<&str>)],
) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let mut expected = Vec::new();
    let mut retry_row = None;
    for &record in logged {
        let (event, event_type) = match record {
            Logged::LimitRow(limit, turn_number, state) => {
                record_interrupt(
                    &database,
                    run_id,
                    &limit_record(limit, turn_number),
                    state,
                    false,
                );
                continue;
            }
            Logged::RetryPending => {
                let id = mint_uuid_v7().to_string();
                database
                    .reader()
                    .execute(
                        "INSERT INTO interventions (id, target_run_id, type, state,
                           expected_run_version, client_idempotency_key, created_at)
                         VALUES (?1, ?2, 'fasterModelRetry', 'accepted', 1, ?1,
                           '2026-01-01T00:00:00.000Z')",
                        params![id, run_id.text().as_str()],
                    )
                    .expect("the test records the run's retry");
                retry_row = Some(id);
                continue;
            }
            Logged::TurnStarted(turn_number) => (
                turn_started_at(session_id, run_id, turn_number, 1),
                "agent.turn.started",
            ),
            Logged::TurnCompleted(turn_number) => (
                turn_completed_at(session_id, run_id, turn_number, 1),
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
        .settle_run_after_restart(&running_at(session_id, run_id, 1), "not resumed", None)
        .await
        .expect("the restart settles the run");

    assert_eq!(stored_events(&database, &run_id), events(&expected));
    assert_eq!(
        stored_run_state(&database, &run_id),
        (settled_state.to_owned(), 2)
    );
    if let Some(retry_row) = retry_row {
        assert_eq!(interrupt_state(&database, &retry_row), "expired");
    }
}

// Killed by the owed read taking the overtaken token interrupt as the limit's discharge, which
// fails a run the live path would stop at its token limit, and by giving the limit's cause to
// turn 2, which the continue started after the stop's row named turn 1.
#[tokio::test]
async fn a_restart_after_an_overtaken_token_stop_and_a_continue_stops_the_run() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let interventions = hand_limit_interrupter(&engine, 0);
    interventions.record_rows_in(&database);
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
    drop(engine);
    let restarted = test_engine(&database, log.service, home.path());

    restarted
        .settle_run_after_restart(&running_at(session_id, run_id, 3), "not resumed", None)
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
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let connection = database.reader();
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
            "INSERT INTO queue_items (id, session_id, state, target_run_id, position,
               created_at, updated_at)
             VALUES ('item', ?1, 'queued', ?2, 0, '', '')",
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
            None,
        )
        .await
        .expect("a run its queue still starts is left");

    assert_eq!(settled, run.run);
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("queued".to_owned(), 0)
    );
    assert_eq!(stored_events(&database, &run_id), events(&[]));
}

// Killed by pushing the no-pending guard only when the settle read no pending interrupt, which
// lets the restart's end pass over an interrupt asked for after its read, and by pushing it
// before the moves, which refuses at another position.
#[tokio::test]
async fn a_restart_settle_is_refused_by_an_interrupt_asked_for_after_its_read() {
    let database = TestDatabase::new(schema_parts());
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
        .settle_run_from_facts(&run, &facts, "not resumed", None)
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
    assert_eq!(stored_events(&database, &run_id), events(&[]));
}

// Killed by dropping the `from_state != run.run.state` guard on the settle's refusal arm, which
// answers a run the table refused to move as settled.
#[tokio::test]
async fn a_restart_settle_the_table_refuses_from_the_state_read_is_an_error() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let connection = database.reader();
    connection
        .execute(
            "UPDATE runs SET state = 'starting' WHERE run_id = ?1",
            params![run_id.text().as_str()],
        )
        .expect("the test leaves the run starting");
    let engine = test_engine(&database, log.service, home.path());
    // The log owes a token stop whose interrupt failed, so the settle decides `stopped`, which the
    // table does not let a starting run reach.
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    append(
        &engine,
        session_id,
        &token_limit_reached(session_id, run_id),
    )
    .await;
    connection
        .execute(
            "INSERT INTO interventions (id, target_run_id, type, state, payload, device_id,
               expected_run_version, client_idempotency_key, created_at)
             VALUES (?1, ?2, 'interrupt', 'failed', ?3, NULL, 1, ?1, '2026-01-01T00:00:00.000Z')",
            params![
                LIMIT_INTERRUPT_ID,
                run_id.text().as_str(),
                limit_record("tokenLimit", 1)
            ],
        )
        .expect("the test records the limit's failed interrupt");
    let run = LiveRun {
        run_id,
        run: RunRead {
            version: 1,
            session_id,
            state: RunState::Starting,
        },
        parent_run_id: None,
        reached_by: None,
    };

    let settled = engine
        .settle_run_after_restart(&run, "not resumed", None)
        .await;

    assert!(
        matches!(
            settled,
            Err(RunEngineError::Refused(RunRefusal::InvalidTransition {
                from_state: RunState::Starting,
                ..
            }))
        ),
        "the settle answers {settled:?}"
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("starting".to_owned(), 1)
    );
}

// What lands between a restart settle's read of a run's facts and its write.
#[derive(Clone, Copy, Debug)]
enum LandedMeanwhile {
    // The person asks to interrupt the running run.
    PersonsInterrupt,
    // A message starts the queued run.
    QueuedRunStarted,
}

// Killed by the settle answering its first refusal rather than reading the run and its facts
// again, which answers the interrupt asked meanwhile with an error (`interrupt_asked`), and by its
// change written from whatever state the run has moved to, which fails the run a message started
// meanwhile (`queued_run_started`).
#[rstest]
#[case::interrupt_asked(LandedMeanwhile::PersonsInterrupt, ("interrupted", 2), 1)]
#[case::queued_run_started(LandedMeanwhile::QueuedRunStarted, ("starting", 0), 0)]
#[tokio::test]
async fn a_restart_settle_meets_what_landed_after_its_read(
    #[case] landed: LandedMeanwhile,
    #[case] expected_state: (&str, i64),
    #[case] expected_event_count: usize,
) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let run = match landed {
        LandedMeanwhile::PersonsInterrupt => {
            insert_running_run(&database, session_id, run_id);
            running_at(session_id, run_id, 1)
        }
        LandedMeanwhile::QueuedRunStarted => {
            database
                .reader()
                .execute(
                    "INSERT INTO runs (run_id, session_id, state, run_version)
                     VALUES (?1, ?2, 'queued', 0)",
                    params![run_id.text().as_str(), session_id.text().as_str()],
                )
                .expect("the test queues the run");
            LiveRun {
                run: RunRead {
                    state: RunState::Queued,
                    ..running_at(session_id, run_id, 0).run
                },
                ..running_at(session_id, run_id, 0)
            }
        }
    };
    let engine = test_engine(&database, log.service, home.path());
    let paused = engine.restart_facts_pause().arm();
    let mut settling = Box::pin(engine.settle_run_after_restart(&run, "not resumed", None));

    tokio::select! {
        settled = &mut settling => panic!("the settle passed its pause: {settled:?}"),
        reached = paused.reached => reached.expect("the settle holds after its read"),
    }
    match landed {
        LandedMeanwhile::PersonsInterrupt => {
            record_interrupt(
                &database,
                run_id,
                r#"{"pending":"nextTurn"}"#,
                "accepted",
                true,
            );
        }
        LandedMeanwhile::QueuedRunStarted => {
            database
                .reader()
                .execute(
                    "UPDATE runs SET state = 'starting' WHERE run_id = ?1",
                    [run_id.text().as_str()],
                )
                .expect("the test starts the run");
        }
    }
    paused.release.send(()).expect("the settle waits");
    settling.await.expect("the settle meets what landed");

    let (state, version) = expected_state;
    assert_eq!(
        stored_run_state(&database, &run_id),
        (state.to_owned(), version)
    );
    assert_eq!(
        stored_events(&database, &run_id).len(),
        expected_event_count
    );
}
