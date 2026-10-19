use std::sync::Arc;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::{
    AgentInterventionRequestedPayload, AgentInterventionRequestedState,
    AgentRunInterruptedNewState, AgentRunInterruptedPayload, DaemonInterventionActor,
    InterventionActor,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{InterventionId, InterventionType, RunLimit};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{
    AgentRunStepLimitReachedPayload, AgentRunTokenLimitReachedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::session::run::engine::live::lock;
use crate::session::run::engine::tests::{
    INTERVENTIONS_TABLE_SQL, append, continue_request, events, hand_limit_interrupter,
    insert_running_run, run_version, started_turn, stored_events, stored_run_state, test_engine,
    token_limit, turn_started_at,
};
use crate::session::run::engine::turns::{ProviderTurnEnd, TurnOutcome};
use crate::session::run::projection::RUNS_TABLE_SQL;
use crate::session::run::read::{LiveRun, RunRead};
use crate::session::run::restart::{QUEUE_ITEMS_TABLE_SQL, RestartFacts};
use crate::session::run::state_change::RunStateChangeCompanions;
use crate::uuid_v7::mint_uuid_v7;

// The test's interrupt rows: the daemon's own at the token limit, and a person's.
const LIMIT_INTERRUPT_ID: &str = "0199f3a0-0000-7000-8000-000000000001";
const PERSON_INTERRUPT_ID: &str = "0199f3a0-0000-7000-8000-000000000002";

fn token_limit_reached(session_id: SessionId, run_id: RunId) -> SessionEvent {
    SessionEvent::AgentRunTokenLimitReached(AgentRunTokenLimitReachedPayload {
        session_id,
        run_id,
        token_limit: token_limit(),
    })
}

fn step_limit_reached(session_id: SessionId, run_id: RunId) -> SessionEvent {
    SessionEvent::AgentRunStepLimitReached(AgentRunStepLimitReachedPayload {
        session_id,
        run_id,
        count: SafeInt::new(40).expect("40 is a step bound"),
    })
}

// `run_id` as a restart finds it, running at `version`.
fn running_at(session_id: SessionId, run_id: RunId, version: i64) -> LiveRun {
    LiveRun {
        run_id,
        run: RunRead {
            version,
            session_id,
            state: RunState::Running,
        },
        parent_run_id: None,
        reached_by: None,
    }
}

fn interrupted_at(session_id: SessionId, run_id: RunId, version: u64) -> SessionEvent {
    SessionEvent::AgentRunInterrupted(AgentRunInterruptedPayload {
        session_id,
        run_id,
        run_version: run_version(version),
        previous_state: RunState::Running,
        new_state: AgentRunInterruptedNewState::Value,
        failure_category: None,
        recovery_condition: None,
        intended_close: None,
        trigger: None,
    })
}

// Killed by the limit's end leaving the cut turn's end to its provider, which writes it with
// no cause; by the since-guard's refusal read at the position the turn end's guard shifts it
// to, which answers a run ended since with an error; by dropping that guard, which ends a run
// continued after the interrupt was accepted; and by the open-turn read taking a turn started
// after the accepted version, which marks a later turn of a run continued since, or leaving
// out one started at that version.
#[tokio::test]
async fn a_limit_end_writes_its_cut_turn_end_and_leaves_a_run_that_ended_since() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let turn_one = SafeInt::new(1).expect("1 is a turn number");
    // Interrupted at version 3, continued at 4, and running turn 1 at 5.
    database
        .reader()
        .execute_batch(RUNS_TABLE_SQL)
        .expect("the test makes the runs table");
    database
        .reader()
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'running', 5)",
            params![run_id.text().as_str(), session_id.text().as_str()],
        )
        .expect("the test writes the run");
    let engine = test_engine(&database, log.service, home.path());
    append(&engine, session_id, &interrupted_at(session_id, run_id, 3)).await;
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 5),
    )
    .await;
    let seeded = stored_events(&database, &run_id);

    // The cut is planted directly, read at the accepted version, to exercise the remap: no
    // stop cuts a turn started at 5 for an interrupt accepted at 2, before the run's end at 3.
    let mut live = lock(&engine.live);
    let cut = live.new_cut(RunLimit::StepLimit, 2);
    live.cut_turns.insert((run_id, turn_one), cut);
    drop(live);
    let ended_since = engine
        .end_run_for_interrupt(
            run_id,
            2,
            Some(RunLimit::StepLimit),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("a run that ended since the interrupt is left");
    assert!(!ended_since);
    assert_eq!(stored_events(&database, &run_id), seeded);
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("running".to_owned(), 5)
    );

    // With no cut held, the read finds turn 1, started at the accepted version.
    engine.forget_cut_turn(&run_id, turn_one);
    let ended = engine
        .end_run_for_interrupt(
            run_id,
            5,
            Some(RunLimit::StepLimit),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the run ends at its limit");
    assert!(ended);
    let late_end = engine
        .record_turn_end(
            run_id,
            ProviderTurnEnd {
                turn_number: turn_one,
                outcome: TurnOutcome::Interrupted(None),
            },
        )
        .await
        .expect("the provider's late end is read");
    assert!(
        !late_end.written,
        "the provider's late end of the cut turn is dropped"
    );
    assert_eq!(
        stored_events(&database, &run_id),
        [
            ("agent.run.interrupted".to_owned(), None, None),
            ("agent.turn.started".to_owned(), None, None),
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
        ("interrupted".to_owned(), 6)
    );

    // Continued at 7 on turn 2, which a person's interrupt at 8 left with no end, before the
    // limit accepted at 5 is ended again.
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 2, 7),
    )
    .await;
    append(&engine, session_id, &interrupted_at(session_id, run_id, 8)).await;
    database
        .reader()
        .execute(
            "UPDATE runs SET state = 'interrupted', run_version = 8 WHERE run_id = ?1",
            [run_id.text().as_str()],
        )
        .expect("the test ends the run again");
    let continued = stored_events(&database, &run_id);
    let ended_again = engine
        .end_run_for_interrupt(
            run_id,
            5,
            Some(RunLimit::StepLimit),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("a run that ended again is left");
    assert!(!ended_again);
    assert_eq!(
        stored_events(&database, &run_id),
        continued,
        "a turn started after the limit was accepted takes no limit end"
    );
}

// Killed by the owed read joining the interventions, where the failed token interrupt and its
// requested event read as discharging the limit; by the person's pending interrupt or the
// newer step limit winning over the owed token limit; by ending only the newest open turn; and
// by giving the limit's cause to the newest turn rather than the one its stop cut.
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
    // reached its bound, and turn 3 started before the daemon went down.
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
                     1, ?3, '2026-01-01T00:00:01.000Z')",
            params![
                LIMIT_INTERRUPT_ID,
                run_id.text().as_str(),
                PERSON_INTERRUPT_ID,
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
    let person_interrupt_state: String = connection
        .query_row(
            "SELECT state FROM interventions WHERE id = ?1",
            [PERSON_INTERRUPT_ID],
            |row| row.get(0),
        )
        .expect("the test reads the person's interrupt");
    assert_eq!(person_interrupt_state, "applied");
}

// Killed by the owed read keeping a step limit a later interrupt of the run discharged, which
// stops a run that never reached its bound again, and by giving the limit's cause to the
// newest open turn rather than the one its stop cut.
#[rstest]
#[case::step_cut_on_an_older_turn(
    false,
    "interrupted",
    &[
        ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
        ("agent.turn.interrupted", Some("daemonRestart"), Some("daemon")),
        ("agent.run.interrupted", None, None),
    ]
)]
#[case::step_discharged_by_a_persons_interrupt(
    true,
    "failed",
    &[
        ("agent.turn.failed", Some("daemonRestart"), Some("daemon")),
        ("agent.turn.failed", Some("daemonRestart"), Some("daemon")),
        ("agent.run.failed", None, None),
    ]
)]
#[tokio::test]
async fn a_restart_settles_a_step_limit_by_whether_the_run_was_interrupted_since(
    #[case] is_interrupted_since: bool,
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
    // Turn 1 reached its step bound; a person's interrupt ended the run and a continue ran it
    // again, or the run went on with turn 1 open; turn 2 started.
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 1, 1),
    )
    .await;
    append(&engine, session_id, &step_limit_reached(session_id, run_id)).await;
    let mut expected = vec![
        ("agent.turn.started", None, None),
        ("agent.run.stepLimit.reached", None, None),
    ];
    if is_interrupted_since {
        append(&engine, session_id, &interrupted_at(session_id, run_id, 1)).await;
        expected.push(("agent.run.interrupted", None, None));
    }
    append(
        &engine,
        session_id,
        &turn_started_at(session_id, run_id, 2, 1),
    )
    .await;
    expected.push(("agent.turn.started", None, None));
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
                pending_interrupt: None,
                owed_limit: None,
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
