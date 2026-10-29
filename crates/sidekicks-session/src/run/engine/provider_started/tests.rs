use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

use futures::FutureExt;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::Value;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::registry::test_provider;
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use sidekicks_provider::run::posture::{compose_execution_posture, resolve_posture};
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_workspace::run_setup_gates::{RunSetupContext, RunSetupGate, RunSetupGateError};

use crate::plan_holds::NoPlanHolds;
use crate::questions::schema::schema_parts;
use crate::run::engine::test_fixture::{
    TestSessionPostures, append, stored_run_state, test_engine, test_engine_on, test_engine_with,
};
use crate::run::engine::tests::{started_turn, turn_start};
use crate::run::engine::{RunEngine, RunEngineError, SubagentRunStart};
use crate::run::start_request::RunStartRequest;

// The posture at `level` over `git_folder`.
fn posture_at(level: PermissionLevel, git_folder: &Path) -> ExecutionPosture {
    compose_execution_posture(
        level,
        FilesystemPath::new(git_folder.to_string_lossy().into_owned()).expect("a valid path"),
    )
}

// Queues a lead run of the test session, admitted against an account, and starts it at the Ask
// level, its session's process reading Ask through `session_postures`; returns the run.
async fn start_ask_parent(
    database: &TestDatabase,
    engine: &RunEngine,
    session_postures: &TestSessionPostures,
    git_folder: &Path,
) -> RunId {
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    database
        .reader()
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'queued', 0)",
            params![run_id.text().as_str(), session_id.text().as_str()],
        )
        .expect("the test queues the parent");
    let queued = AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
        session_id,
        run_id,
        run_version: SafeInt::ZERO,
        new_state: AgentRunQueuedNewState::Value,
        agent_id: AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
        resolved_agent: None,
        parent_run_id: None,
        reached_by: None,
        effective_run_config: None,
        admitted_model_family: None,
        admitted_provider_account_id: ProviderAccountId::new("account-1".to_owned())
            .expect("the test's account id is one"),
    });
    append(engine, session_id, &SessionEvent::AgentRunQueued(queued)).await;
    let ask = posture_at(PermissionLevel::Ask, git_folder);
    session_postures.move_to(ask.clone());
    let mut turn = turn_start(run_id, started_turn);
    turn.execution_posture = ask;
    engine
        .start_run(RunStartRequest {
            turn,
            queue_item: None,
            provider: test_provider(),
            output_speed: None,
            running_statements: None,
        })
        .await
        .expect("the parent starts at Ask");
    run_id
}

// The payload of the run's one event of `event_type`, if it has one.
fn run_event_payload(database: &TestDatabase, run_id: &RunId, event_type: &str) -> Option<Value> {
    let payloads: Vec<String> = database
        .reader()
        .prepare("SELECT payload FROM session_events WHERE run_id = ?1 AND type = ?2")
        .expect("the test reads the run's events")
        .query_map(params![run_id.text().as_str(), event_type], |row| {
            row.get(0)
        })
        .expect("the run's events read")
        .collect::<Result<_, _>>()
        .expect("each payload reads");
    payloads
        .first()
        .map(|payload| serde_json::from_str(payload).expect("the payload is JSON"))
}

// Killed by the subagent's `running` stamped with no posture, by gating it at its parent's resolved
// posture rather than its session's, and by skipping its setup gates, which leaves no resolved
// posture to stamp.
#[tokio::test]
async fn a_subagent_runs_at_the_posture_its_session_moved_to_since_its_parent_started() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let engine = test_engine(&database, log.service, home.path());
    let session_postures = Arc::new(TestSessionPostures::default());
    engine
        .set_session_postures(Arc::downgrade(&session_postures) as Weak<_>)
        .expect("a new engine holds no posture source yet");
    let parent = start_ask_parent(&database, &engine, &session_postures, &git_folder).await;

    let sandboxed = posture_at(PermissionLevel::Sandboxed, &git_folder);
    session_postures.move_to(sandboxed.clone());
    let started = engine
        .start_provider_subagent_run(parent)
        .await
        .expect("the subagent's start is answered");

    let Some(SubagentRunStart::Running(child)) = started else {
        panic!("the subagent runs: {started:?}");
    };
    let running = run_event_payload(&database, &child, "agent.run.running")
        .expect("the subagent's running is written");
    let resolved = resolve_posture(&sandboxed)
        .await
        .expect("the Sandboxed root resolves");
    assert_eq!(
        running["executionPosture"],
        serde_json::to_value(&resolved).expect("a posture serializes")
    );
}

// Killed by a posture stamped on a refused subagent's run, and by the gate's refusal returned as
// an error in place of the refused answer the driver stops the subagent on.
#[tokio::test]
async fn a_subagent_whose_sandboxed_root_is_gone_is_refused_and_ended() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let engine = test_engine(&database, log.service, home.path());
    let session_postures = Arc::new(TestSessionPostures::default());
    engine
        .set_session_postures(Arc::downgrade(&session_postures) as Weak<_>)
        .expect("a new engine holds no posture source yet");
    let parent = start_ask_parent(&database, &engine, &session_postures, &git_folder).await;

    session_postures.move_to(posture_at(PermissionLevel::Sandboxed, &git_folder));
    std::fs::remove_dir(&git_folder).expect("the git folder is removed");
    let started = engine
        .start_provider_subagent_run(parent)
        .await
        .expect("a refused subagent is answered, not failed");

    let Some(SubagentRunStart::Refused(child)) = started else {
        panic!("the subagent is refused: {started:?}");
    };
    assert_eq!(stored_run_state(&database, &child).0, "failed");
    let failed = run_event_payload(&database, &child, "agent.run.failed")
        .expect("the subagent's end is written");
    assert_eq!(failed["failureCategory"], "setupFailure");
    assert_eq!(failed["failureCause"]["cause"], "setupFailed");
    assert_eq!(
        run_event_payload(&database, &child, "agent.run.running"),
        None
    );
    assert_eq!(engine.execution_postures.resolved_posture_for(&child), None);
}

// Writes an interrupted run of the test session at version 1, and answers its id.
fn insert_interrupted_run(database: &TestDatabase) -> RunId {
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    database
        .reader()
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'interrupted', 1)",
            params![run_id.text().as_str(), test_session_id().text().as_str()],
        )
        .expect("the test writes the interrupted run");
    run_id
}

// Killed by the continue's `running` stamped with no posture, and by its setup gates skipped,
// which leaves no resolved posture to stamp.
#[tokio::test]
async fn a_continue_on_its_providers_turn_runs_at_the_posture_its_session_moved_to() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let engine = test_engine(&database, log.service, home.path());
    let session_postures = Arc::new(TestSessionPostures::default());
    engine
        .set_session_postures(Arc::downgrade(&session_postures) as Weak<_>)
        .expect("a new engine holds no posture source yet");
    session_postures.move_to(posture_at(PermissionLevel::Ask, &git_folder));
    let run_id = insert_interrupted_run(&database);

    let sandboxed = posture_at(PermissionLevel::Sandboxed, &git_folder);
    session_postures.move_to(sandboxed.clone());
    let continued = engine
        .continue_run_with_kept_messages(run_id)
        .await
        .expect("the continue is written");

    assert_eq!(continued.map(|run| run.state), Some(RunState::Running));
    let running = run_event_payload(&database, &run_id, "agent.run.running")
        .expect("the run's running is written");
    let resolved = resolve_posture(&sandboxed)
        .await
        .expect("the Sandboxed root resolves");
    assert_eq!(
        running["executionPosture"],
        serde_json::to_value(&resolved).expect("a posture serializes")
    );
}

// A gate after the posture gate that refuses every run, once the posture gate holds its posture.
struct RefusingGate;

impl RunSetupGate for RefusingGate {
    fn assert_run_ready<'a>(
        &'a self,
        _context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(std::future::ready(Err(RunSetupGateError::Failed(
            "the test's gate refuses the run".into(),
        ))))
    }
}

// Killed by the provider's turn left running on a refused continue, and by the posture the
// posture gate resolved before the refusal kept past it.
#[tokio::test]
async fn a_refused_continue_on_its_providers_turn_interrupts_the_turn_and_lets_its_posture_go() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let run_id = insert_interrupted_run(&database);
    bind_run_to_first_provider(&database, run_id);
    let interrupts = Arc::new(AtomicUsize::new(0));
    let mut driver = MockProviderDriver::new();
    let counted = Arc::clone(&interrupts);
    driver
        .expect_interrupt_run()
        .withf(move |request| request.run_id == run_id && request.reason.is_none())
        .times(1)
        .returning(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }.boxed()
        });
    let engine = test_engine_on(
        &database,
        log.service,
        home.path(),
        registry_of_first_provider(Arc::new(driver)),
        vec![Arc::new(RefusingGate)],
    );
    let session_postures = Arc::new(TestSessionPostures::default());
    engine
        .set_session_postures(Arc::downgrade(&session_postures) as Weak<_>)
        .expect("a new engine holds no posture source yet");
    session_postures.move_to(posture_at(PermissionLevel::Sandboxed, &git_folder));

    let refused = engine
        .continue_run_with_kept_messages(run_id)
        .await
        .expect_err("a refused continue fails");

    assert!(
        matches!(refused, RunEngineError::Gate { .. }),
        "{refused:?}"
    );
    assert_eq!(stored_run_state(&database, &run_id).0, "interrupted");
    assert_eq!(
        engine.execution_postures.resolved_posture_for(&run_id),
        None
    );
    assert_eq!(interrupts.load(Ordering::SeqCst), 1);
}

// Ends `run_id` `stopped` in the database at `path`, as an end landing beside the engine's writes.
pub(crate) fn end_run_aside(path: &Path, run_id: &RunId) {
    Connection::open(path)
        .and_then(|connection| {
            connection.execute(
                "UPDATE runs SET state = 'stopped', run_version = run_version + 1
                 WHERE run_id = ?1",
                params![run_id.text().as_str()],
            )
        })
        .expect("the test ends the run");
}

// A gate after the posture gate that, once armed, ends each run it checks while the posture gate
// holds that run's posture, then passes or refuses it.
struct EndingGate {
    database: PathBuf,
    is_armed: AtomicBool,
    refuses: bool,
}

impl RunSetupGate for EndingGate {
    fn assert_run_ready<'a>(
        &'a self,
        context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        if !self.is_armed.load(Ordering::SeqCst) {
            return Box::pin(std::future::ready(Ok(())));
        }
        end_run_aside(&self.database, &context.run_id);
        Box::pin(std::future::ready(if self.refuses {
            Err(RunSetupGateError::Failed(
                "the test's gate refuses the run".into(),
            ))
        } else {
            Ok(())
        }))
    }
}

// A subagent's run that ends some other way while its gates run is answered as ended, never as
// refused, so its helper is not stopped, and lets go of the posture the posture gate resolved,
// whether the later gate passes or refuses it. Killed by skipping the release after the refused
// `running` write, and by skipping the re-read before the refusal.
#[rstest]
#[case::gate_passes(false)]
#[case::gate_refuses(true)]
#[tokio::test]
async fn a_subagent_whose_run_ends_during_its_gates_lets_its_posture_go_unrefused(
    #[case] refuses: bool,
) {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let gate = Arc::new(EndingGate {
        database: database.path(),
        is_armed: AtomicBool::new(false),
        refuses,
    });
    let engine = test_engine_with(
        &database,
        log.service,
        home.path(),
        Arc::new(NoPlanHolds),
        vec![Arc::clone(&gate) as _],
    );
    let session_postures = Arc::new(TestSessionPostures::default());
    engine
        .set_session_postures(Arc::downgrade(&session_postures) as Weak<_>)
        .expect("a new engine holds no posture source yet");
    let parent = start_ask_parent(&database, &engine, &session_postures, &git_folder).await;
    gate.is_armed.store(true, Ordering::SeqCst);

    let started = engine
        .start_provider_subagent_run(parent)
        .await
        .expect("the subagent's start is answered");

    assert_eq!(started, None);
    let child: String = database
        .reader()
        .query_row(
            "SELECT run_id FROM runs WHERE run_id != ?1",
            params![parent.text().as_str()],
            |row| row.get(0),
        )
        .expect("the subagent's run is queued");
    let child = RunId::new(&child).expect("a stored run id");
    assert_eq!(stored_run_state(&database, &child).0, "stopped");
    assert_eq!(engine.execution_postures.resolved_posture_for(&child), None);
}

// A continue on its provider's turn whose run ends some other way while its gates run, a gate then
// refusing it, leaves the provider's turn alone, since the run holds none, and lets its posture
// go. Killed by interrupting the provider's turn of a run that ended meanwhile.
#[tokio::test]
async fn a_continue_whose_run_ends_during_its_gates_interrupts_no_turn() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let run_id = insert_interrupted_run(&database);
    bind_run_to_first_provider(&database, run_id);
    let mut driver = MockProviderDriver::new();
    driver.expect_interrupt_run().never();
    let engine = test_engine_on(
        &database,
        log.service,
        home.path(),
        registry_of_first_provider(Arc::new(driver)),
        vec![Arc::new(EndingGate {
            database: database.path(),
            is_armed: AtomicBool::new(true),
            refuses: true,
        })],
    );
    let session_postures = Arc::new(TestSessionPostures::default());
    engine
        .set_session_postures(Arc::downgrade(&session_postures) as Weak<_>)
        .expect("a new engine holds no posture source yet");
    session_postures.move_to(posture_at(PermissionLevel::Sandboxed, &git_folder));

    let refused = engine
        .continue_run_with_kept_messages(run_id)
        .await
        .expect_err("a refused continue fails");

    assert!(
        matches!(refused, RunEngineError::Gate { .. }),
        "{refused:?}"
    );
    assert_eq!(stored_run_state(&database, &run_id).0, "stopped");
    assert_eq!(
        engine.execution_postures.resolved_posture_for(&run_id),
        None
    );
}
