mod process_exit;
mod restart;
mod turn_causes;

use rusqlite::params;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::{AgentRunInterruptedNewState, AgentRunInterruptedPayload};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{
    AgentRunStepLimitReachedPayload, AgentRunTokenLimitReachedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::statement::DATABASE_NOW_SQL;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;

use crate::questions::schema::schema_parts;
use crate::run::engine::test_fixture::{append, stored_run_state, test_engine};
use crate::run::engine::tests::{
    STEP_BOUND, provider_end, run_version, stored_events, token_limit, turn, turn_started_at,
};
use crate::run::read::{LiveRun, RunRead};
use crate::run::state_change::RunStateChangeCompanions;

// The test's interrupt rows: the daemon's own at the token limit and at the step limit, and a
// person's.
const LIMIT_INTERRUPT_ID: &str = "0199f3a0-0000-7000-8000-000000000001";
const PERSON_INTERRUPT_ID: &str = "0199f3a0-0000-7000-8000-000000000002";
const STEP_INTERRUPT_ID: &str = "0199f3a0-0000-7000-8000-000000000003";

// The stored record of the daemon's own interrupt at `limit`, naming the turn it cut.
fn limit_record(limit: &str, turn_number: u64) -> String {
    format!(r#"{{"limit":"{limit}","turnNumber":{turn_number}}}"#)
}

// Records an interrupt of `run_id` with `record` in `state`, a person's from a phone where
// `is_person`, else the daemon's own, and returns its id.
fn record_interrupt(
    database: &TestDatabase,
    run_id: RunId,
    record: &str,
    state: &str,
    is_person: bool,
) -> String {
    let id = mint_uuid_v7().to_string();
    database
        .reader()
        .execute(
            &format!(
                "INSERT INTO interventions (id, target_run_id, type, state, payload, device_id,
                   expected_run_version, client_idempotency_key, created_at)
                 VALUES (?1, ?2, 'interrupt', ?3, ?4, ?5, 1, ?1, {DATABASE_NOW_SQL})"
            ),
            params![
                id,
                run_id.text().as_str(),
                state,
                record,
                is_person.then_some("phone"),
            ],
        )
        .expect("the test records the run's interrupt");
    id
}

// The state of the interrupt `id`.
fn interrupt_state(database: &TestDatabase, id: &str) -> String {
    database
        .reader()
        .query_row(
            "SELECT state FROM interventions WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("the test reads the run's interrupt")
}

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
        count: STEP_BOUND,
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
// continued after the interrupt was accepted; and by resolving the turn's cause from the engine's
// cut and the applying limit alone, which ends turn 1, whose higher-ranked cut only a row of the
// log holds after a restart, `stepLimit`.
#[tokio::test]
async fn a_limit_end_writes_its_cut_turn_end_and_leaves_a_run_that_ended_since() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let turn_one = turn(1);
    // Interrupted at version 3, continued at 4, and running turn 1 at 5.
    let connection = database.reader();
    connection
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

    // The cut is planted directly, for a step interrupt accepted at 2, before the run's end at 3.
    {
        let mut live = lock(&engine.live);
        let cut = live.new_cut(RunLimit::StepLimit);
        live.cut_turns
            .entry((run_id, turn_one))
            .or_default()
            .push(cut);
    }
    let ended_since = engine
        .end_run_for_interrupt(
            run_id,
            2,
            Some(RunLimit::StepLimit),
            Some(turn_one),
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

    // After a restart the engine holds no cut, and the log's rows name turn 1: the applying step
    // limit's, and the token limit's.
    engine.forget_cut_turn(&run_id, turn_one);
    for limit in ["stepLimit", "tokenLimit"] {
        record_interrupt(
            &database,
            run_id,
            &limit_record(limit, 1),
            "accepted",
            false,
        );
    }
    let ended = engine
        .end_run_for_interrupt(
            run_id,
            5,
            Some(RunLimit::StepLimit),
            Some(turn_one),
            RunStateChangeCompanions::default(),
        )
        .await
        .expect("the run ends at its limit");
    assert!(ended);
    let late_end = engine
        .record_turn_end(run_id, provider_end(1))
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
                Some("tokenLimit".to_owned()),
                Some("daemon".to_owned())
            ),
            ("agent.run.interrupted".to_owned(), None, None),
        ]
    );
    assert_eq!(
        stored_run_state(&database, &run_id),
        ("interrupted".to_owned(), 6)
    );
}
