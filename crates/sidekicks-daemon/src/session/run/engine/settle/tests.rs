mod restart;
mod turn_causes;

use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::events::{AgentRunInterruptedNewState, AgentRunInterruptedPayload};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{
    AgentRunStepLimitReachedPayload, AgentRunTokenLimitReachedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::session::run::engine::limits::LimitStop;
use crate::session::run::engine::live::lock;
use crate::session::run::engine::tests::{
    append, events, hand_limit_interrupter, insert_running_run, run_version, stored_events,
    stored_run_state, test_engine, token_limit, turn_started_at,
};
use crate::session::run::engine::turns::{ProviderTurnEnd, TurnOutcome};
use crate::session::run::projection::RUNS_TABLE_SQL;
use crate::session::run::read::{LiveRun, RunRead};
use crate::session::run::state_change::RunStateChangeCompanions;
use crate::uuid_v7::mint_uuid_v7;

// The test's interrupt rows: the daemon's own at the token limit and at the step limit, and a
// person's.
const LIMIT_INTERRUPT_ID: &str = "0199f3a0-0000-7000-8000-000000000001";
const PERSON_INTERRUPT_ID: &str = "0199f3a0-0000-7000-8000-000000000002";
const STEP_INTERRUPT_ID: &str = "0199f3a0-0000-7000-8000-000000000003";

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

fn turn(number: u64) -> SafeInt<1> {
    SafeInt::new(number).expect("the test's turn numbers count from 1")
}

// The step stop of turn `turn_number` at its bound.
fn step_stop(turn_number: u64) -> LimitStop {
    LimitStop::Step {
        count: SafeInt::new(40).expect("40 is a step bound"),
        turn_number: turn(turn_number),
    }
}

// The provider's end of turn `turn_number`, interrupted with no cause of its own.
fn provider_end(turn_number: u64) -> ProviderTurnEnd {
    ProviderTurnEnd {
        turn_number: turn(turn_number),
        outcome: TurnOutcome::Interrupted(None),
    }
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
    let turn_one = turn(1);
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

// Killed by a process exit failing a run whose step limit's stop it still owes, which loses the
// limit's end and its `Continue`, or by leaving that limit's pending interrupt pending on the ended
// run (`step_cut`); by ending the turn the stop cut with the exit's failure, or a turn no stop cut
// with the limit; and by settling a run that waits on no stop as anything but `failed`
// (`no_stop`).
#[rstest]
#[case::step_cut(true)]
#[case::no_stop(false)]
#[tokio::test]
async fn a_process_exit_settles_the_run_as_its_stop_would_and_fails_every_uncut_turn(
    #[case] is_step_cut: bool,
) {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let engine = test_engine(&database, log.service, home.path());
    let _interventions = hand_limit_interrupter(&engine, 0);
    for turn_number in 1..=2 {
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, turn_number, 1),
        )
        .await;
    }
    if is_step_cut {
        engine
            .stop_at_limit(run_id, step_stop(1))
            .await
            .expect("the limit's interrupt is accepted");
        database
            .reader()
            .execute(
                "INSERT INTO interventions (id, target_run_id, type, state, payload,
                   expected_run_version, client_idempotency_key, created_at)
                 VALUES (?1, ?2, 'interrupt', 'accepted', '{\"limit\":\"stepLimit\"}', 1, ?1,
                   '2026-01-01T00:00:00.000Z')",
                params![STEP_INTERRUPT_ID, run_id.text().as_str()],
            )
            .expect("the test records the limit's interrupt");
    }
    let process_exit: ProcessExit =
        serde_json::from_value(json!({ "exitCode": 1, "outputTail": "the provider stopped" }))
            .expect("the test's exit reads as one");

    engine
        .end_turn_on_process_exit(run_id, process_exit)
        .await
        .expect("the exit ends the run");

    let (end_type, expected) = if is_step_cut {
        (
            "agent.run.interrupted",
            events(&[
                ("agent.turn.started", None, None),
                ("agent.turn.started", None, None),
                ("agent.run.stepLimit.reached", None, None),
                ("agent.turn.interrupted", Some("stepLimit"), Some("daemon")),
                ("agent.turn.failed", Some("processExit"), Some("daemon")),
                ("agent.run.interrupted", None, None),
            ]),
        )
    } else {
        (
            "agent.run.failed",
            events(&[
                ("agent.turn.started", None, None),
                ("agent.turn.started", None, None),
                ("agent.turn.failed", Some("processExit"), Some("daemon")),
                ("agent.turn.failed", Some("processExit"), Some("daemon")),
                ("agent.run.failed", None, None),
            ]),
        )
    };
    assert_eq!(stored_events(&database, &run_id), expected);
    assert_eq!(
        end_trigger(&database, &run_id, end_type).as_deref(),
        is_step_cut.then_some("stepLimit")
    );
    let state = if is_step_cut { "interrupted" } else { "failed" };
    assert_eq!(stored_run_state(&database, &run_id), (state.to_owned(), 2));
    if is_step_cut {
        let interrupt_state: String = database
            .reader()
            .query_row(
                "SELECT state FROM interventions WHERE id = ?1",
                [STEP_INTERRUPT_ID],
                |row| row.get(0),
            )
            .expect("the test reads the limit's interrupt");
        assert_eq!(interrupt_state, "applied");
    }
}
