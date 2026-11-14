use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::params;
use serde_json::Value;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::repo::mount::WorkspaceId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::MessageContent;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::registry::{test_provider, test_token};
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, first_provider, registry_of_first_provider,
};
use sidekicks_provider::run::delivery::ChildRunSubagent;
use sidekicks_provider::run::posture::{compose_execution_posture, resolve_posture};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::schema::SchemaParts;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::EventReadAfterCursorRequest;
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::projection::SessionProjection as _;
use sidekicks_workspace::run_setup_gates::{RunSetupContext, RunSetupGate, RunSetupGateError};
use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

use crate::agent_tree::projection::AgentTreeProjection;
use crate::agent_tree::store::{AgentTreeNode, find_node};
use crate::plan_holds::NoPlanHolds;
use crate::questions::schema::schema_parts;
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::test_fixture::{
    TestSessionPostures, append, end_run_aside, stored_run_state, test_engine, test_engine_on,
    test_engine_with,
};
use crate::run::engine::tests::{started_turn, turn_start};
use crate::run::engine::{RunEngine, SubagentRunStart};
use crate::run::read::RunStateReader;
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
    bind_run_to_first_provider(database, run_id);
    let queued = AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
        session_id,
        run_id,
        run_version: SafeInt::ZERO,
        new_state: AgentRunQueuedNewState::Value,
        agent_id: AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
        resolved_agent: None,
        provider_child: None,
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
            opening_words: None,
            provider: test_provider(),
            output_speed: None,
            running_statements: None,
        })
        .await
        .expect("the parent starts at Ask");
    run_id
}

// The questions' schema with the agent tree's table, which a subagent's start writes its node to.
fn subagent_schema_parts() -> SchemaParts {
    schema_parts().with_parts(crate::agent_tree::schema::schema_parts())
}

// The helper `subagent_id` beneath the helper `parent_subagent_id`, its run started by the call
// `start_call_id`.
fn helper(
    subagent_id: &str,
    parent_subagent_id: Option<&str>,
    start_call_id: &str,
) -> ChildRunSubagent {
    ChildRunSubagent {
        subagent_id: SubagentId::new(subagent_id.to_owned()).expect("a helper id"),
        parent_subagent_id: parent_subagent_id
            .map(|parent| SubagentId::new(parent.to_owned()).expect("a helper id")),
        name: None,
        role: None,
        provider_path: None,
        ask: None,
        model_id: None,
        effort: None,
        start_call_id: Some(ToolCallId::new(start_call_id.to_owned()).expect("a call id")),
    }
}

// The run a subagent's start left running.
fn running(started: Option<SubagentRunStart>) -> RunId {
    match started {
        Some(SubagentRunStart::Running(run_id)) => run_id,
        unstarted @ (Some(SubagentRunStart::Refused(..)) | None) => {
            panic!("the subagent runs: {unstarted:?}")
        }
    }
}

// The run's `agent.run.queued` payload and the `occurredAt` its envelope records.
fn queued_event(database: &TestDatabase, run_id: &RunId) -> (Value, String) {
    let (payload, occurred_at): (String, String) = database
        .reader()
        .query_row(
            "SELECT payload, occurred_at FROM session_events
              WHERE run_id = ?1 AND type = 'agent.run.queued'",
            params![run_id.text().as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the run's queued event reads");
    (
        serde_json::from_str(&payload).expect("the payload is JSON"),
        occurred_at,
    )
}

// The handle a run's `agent.run.queued` names its helper by.
fn queued_child_handle(queued: &Value) -> ChildHandle {
    ChildHandle::new(
        queued["providerChild"]["childHandle"]
            .as_str()
            .expect("the queued run names its helper's handle")
            .to_owned(),
    )
    .expect("the handle is a child handle")
}

// The node of the first provider's helper `subagent_id` in `session_id`.
fn stored_node(database: &TestDatabase, session_id: SessionId, subagent_id: &str) -> AgentTreeNode {
    let provider = first_provider();
    find_node(&database.reader(), session_id, &provider, subagent_id)
        .expect("the node reads")
        .expect("the helper has a node")
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
    let database = TestDatabase::new(subagent_schema_parts());
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
        .start_provider_subagent_run(parent, helper("helper-1", None, "call-1"))
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

// A gate that records the parent run and its workspace each run it checks was started beneath,
// and passes it.
#[derive(Default)]
struct ParentRunGate {
    parents: Mutex<Vec<SeenParent>>,
}

// A checked run's parent run and that run's workspace, as the gate saw them.
type SeenParent = Option<(RunId, Option<WorkspaceId>)>;

impl RunSetupGate for ParentRunGate {
    fn assert_run_ready<'a>(
        &'a self,
        context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        lock(&self.parents).push(
            context
                .parent_run
                .map(|parent| (parent.run_id, parent.workspace_id)),
        );
        Box::pin(std::future::ready(Ok(())))
    }
}

// Writes `run_id`'s execution context, bound in a workspace of its own on a mount of its own, and
// answers that workspace.
fn bind_run_in_new_workspace(database: &TestDatabase, run_id: RunId) -> WorkspaceId {
    let workspace_id = WorkspaceId::try_from(mint_uuid_v7()).expect("a minted UUID is an id");
    let mount_id = mint_uuid_v7().to_string();
    let connection = database.reader();
    for row in project_and_mount_rows(&mount_id, None) {
        connection
            .execute_batch(&row)
            .expect("the project and its mount are stored");
    }
    // Each mount is of a folder of its own, as two live mounts never share one.
    connection
        .execute(
            "UPDATE repo_mounts SET local_path = ?1, canonical_root = ?1 WHERE id = ?2",
            params![format!("/repos/{mount_id}"), mount_id],
        )
        .expect("the mount points at its own folder");
    connection
        .execute_batch(&format!(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at, \
             updated_at) VALUES ('{workspace_id}', '{session_id}', '{mount_id}', 'boundRoot', \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}');
             INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, created_at, \
             updated_at) VALUES ('{workspace_id}', '{workspace_id}', 'main', 'main', \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')",
            session_id = test_session_id().text().as_str(),
        ))
        .expect("the run's workspace is stored");
    connection
        .execute(
            "INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, \
             execution_mode, execution_root, checkout_root, git_common_dir, branch_context_id, \
             created_at) VALUES (?1, ?2, ?3, 'boundRoot', '/checkout', '/checkout', \
             '/checkout/.git', ?3, ?4)",
            params![
                run_id.text().as_str(),
                test_session_id().text().as_str(),
                workspace_id.text().as_str(),
                PARENT_ROWS_AT
            ],
        )
        .expect("the run's context is written");
    workspace_id
}

// A helper is gated beside its own parent run in that run's workspace, never left for the
// execution-root gate to place in the session's newest, and a continue on its provider's turn in
// the session's current one. Killed by the helper's start handing its gates no parent or no
// workspace, and by the continue handing a parent of its own.
#[tokio::test]
async fn a_helper_is_gated_in_its_parents_workspace_and_a_continue_in_the_sessions() {
    let database = TestDatabase::new(subagent_schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let gate = Arc::new(ParentRunGate::default());
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
    let parent_workspace = bind_run_in_new_workspace(&database, parent);
    let interrupted = insert_interrupted_run(&database);
    bind_run_in_new_workspace(&database, interrupted);

    running(
        engine
            .start_provider_subagent_run(parent, helper("helper-1", None, "call-1"))
            .await
            .expect("the subagent's start is answered"),
    );
    engine
        .continue_run_with_kept_messages(interrupted)
        .await
        .expect("the continue is written");

    assert_eq!(
        *lock(&gate.parents),
        [None, Some((parent, Some(parent_workspace))), None],
        "the parent's send has no parent, the helper its own with its workspace, a continue none"
    );
}

// Killed by a posture stamped on a refused subagent's run, by the gate's refusal returned as an
// error in place of the refused answer the driver stops the subagent on, and by a refused answer
// whose cause is not the one the run's failure records.
#[tokio::test]
async fn a_subagent_whose_sandboxed_root_is_gone_is_refused_and_ended() {
    let database = TestDatabase::new(subagent_schema_parts());
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
        .start_provider_subagent_run(parent, helper("helper-1", None, "call-1"))
        .await
        .expect("a refused subagent is answered, not failed");

    let Some(SubagentRunStart::Refused(child, refusal)) = started else {
        panic!("the subagent is refused: {started:?}");
    };
    assert_eq!(stored_run_state(&database, &child).0, "failed");
    let failed = run_event_payload(&database, &child, "agent.run.failed")
        .expect("the subagent's end is written");
    assert_eq!(failed["failureCategory"], "setupFailure");
    assert_eq!(failed["failureCause"]["cause"], "setupFailed");
    assert_eq!(failed["failureCause"]["message"], refusal.cause.as_str());
    assert!(refusal.cause.contains("repo.git"), "{}", refusal.cause);
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
    let database = TestDatabase::new(subagent_schema_parts());
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
        .start_provider_subagent_run(parent, helper("helper-1", None, "call-1"))
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

// A helper's first start writes its node in its run's own append, under the handle its
// `agent.run.queued` carries and at that event's instant; a node the append refuses leaves no run
// and no event behind. Killed by the node written in a write after the run's, which the second
// half finds as a third run and event, by the event naming another handle or none, and by the
// store minting its own handle.
#[tokio::test]
async fn a_helpers_start_writes_its_node_in_its_runs_own_append() {
    let database = TestDatabase::new(subagent_schema_parts());
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

    let child = running(
        engine
            .start_provider_subagent_run(parent, helper("helper-1", None, "call-1"))
            .await
            .expect("the subagent's start is answered"),
    );

    let (queued, occurred_at) = queued_event(&database, &child);
    let session_id = SessionId::new(queued["sessionId"].as_str().expect("a session id"))
        .expect("the queued run names its session");
    let node = stored_node(&database, session_id, "helper-1");
    assert_eq!(node.child_handle, queued_child_handle(&queued));
    assert_eq!(node.own_run_id, child);
    assert_eq!(
        node.start_call_id.as_ref().map(ToolCallId::as_str),
        Some("call-1")
    );
    assert_eq!(node.parent_subagent_id, None);
    assert_eq!(node.parent_child_handle, None);
    assert_eq!(node.started_at.as_str(), occurred_at);
    assert_eq!(node.updated_at.as_str(), occurred_at);

    // A node write the database refuses, after the start's reads have passed.
    database
        .reader()
        .execute_batch(
            "CREATE TRIGGER refuse_agent_tree_node BEFORE INSERT ON agent_tree_nodes
             BEGIN SELECT RAISE(ABORT, 'the test refuses the node'); END;",
        )
        .expect("the test refuses every new node");
    let refused = engine
        .start_provider_subagent_run(parent, helper("helper-2", None, "call-2"))
        .await;

    assert!(
        matches!(refused, Err(RunEngineError::Append(_))),
        "{refused:?}"
    );
    let count = |sql: &str| -> i64 {
        database
            .reader()
            .query_row(sql, [], |row| row.get(0))
            .expect("the test counts rows")
    };
    assert_eq!(count("SELECT COUNT(*) FROM runs"), 2);
    assert_eq!(
        count("SELECT COUNT(*) FROM session_events WHERE type = 'agent.run.queued'"),
        2
    );
}

// A helper's later start binds its node to the newer run, keeping its handle and its first start,
// the ask, model and effort that start named included; a helper started beneath it hangs under its
// node; and the fold rebuilds every row as the live writes left it. Killed by an insert per start,
// which the unique key refuses, a new handle per start, `started_at` rewritten on a bind, the
// parent link left unresolved, the payload or the node dropping the ask, model or effort, a bind
// that rewrites them, a live resume that names the newer run's own start's model, which is none,
// and by a fold that mints a handle, inserts a handle it already wrote, drops the ask, model or
// effort, or times a row by the clock.
#[tokio::test]
async fn a_helpers_later_start_binds_its_node_and_a_rebuild_writes_the_same_rows() {
    let database = TestDatabase::new(subagent_schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let session_postures = Arc::new(TestSessionPostures::default());
    engine
        .set_session_postures(Arc::downgrade(&session_postures) as Weak<_>)
        .expect("a new engine holds no posture source yet");
    let parent = start_ask_parent(&database, &engine, &session_postures, &git_folder).await;

    let first = running(
        engine
            .start_provider_subagent_run(
                parent,
                ChildRunSubagent {
                    ask: Some(
                        MessageContent::new("Map the auth module.".to_owned()).expect("an ask"),
                    ),
                    model_id: Some(test_token("gpt-5.4-mini")),
                    effort: Some(test_token("low")),
                    ..helper("helper-1", None, "call-1")
                },
            )
            .await
            .expect("the first start is answered"),
    );
    let second = running(
        engine
            .start_provider_subagent_run(parent, helper("helper-1", None, "call-2"))
            .await
            .expect("the later start is answered"),
    );
    running(
        engine
            .start_provider_subagent_run(second, helper("helper-2", Some("helper-1"), "call-3"))
            .await
            .expect("the nested start is answered"),
    );

    let (first_queued, first_at) = queued_event(&database, &first);
    let (second_queued, second_at) = queued_event(&database, &second);
    let session_id = SessionId::new(first_queued["sessionId"].as_str().expect("a session id"))
        .expect("the queued run names its session");
    assert_eq!(first_queued["providerChild"]["modelId"], "gpt-5.4-mini");
    assert_eq!(first_queued["providerChild"]["effort"], "low");
    assert_eq!(first_queued["providerChild"]["ask"], "Map the auth module.");
    let helper_one = stored_node(&database, session_id, "helper-1");
    assert_eq!(
        helper_one.ask.as_ref().map(MessageContent::as_str),
        Some("Map the auth module.")
    );
    assert_eq!(helper_one.model_id, Some(test_token("gpt-5.4-mini")));
    assert_eq!(helper_one.effort, Some(test_token("low")));
    assert_eq!(helper_one.child_handle, queued_child_handle(&first_queued));
    assert_eq!(helper_one.child_handle, queued_child_handle(&second_queued));
    assert_eq!(helper_one.own_run_id, second);
    assert_eq!(
        helper_one.start_call_id.as_ref().map(ToolCallId::as_str),
        Some("call-2")
    );
    assert_eq!(helper_one.started_at.as_str(), first_at);
    let live_runs = RunStateReader::new(&database.reader())
        .list_live_run_resumes(&session_id)
        .expect("the live runs read");
    let resumed = live_runs.iter().find(|run| run.run_id == second);
    assert_eq!(
        resumed.and_then(|run| run.model_id.clone()),
        Some(test_token("gpt-5.4-mini")),
        "a resume of the node's newer run names the model its first start named"
    );
    assert_eq!(helper_one.updated_at.as_str(), second_at);
    let helper_two = stored_node(&database, session_id, "helper-2");
    assert_eq!(
        helper_two
            .parent_subagent_id
            .as_ref()
            .map(SubagentId::as_str),
        Some("helper-1")
    );
    assert_eq!(
        helper_two.parent_child_handle,
        Some(helper_one.child_handle.clone())
    );

    let page = log
        .service
        .read_after_cursor(EventReadAfterCursorRequest {
            session_id,
            after_cursor: None,
            limit: None,
        })
        .await
        .expect("the log reads");
    assert!(!page.has_more, "one page holds the test's log");
    let mut statements = AgentTreeProjection.clear_statements(&session_id);
    let mut fold = AgentTreeProjection.fold(&session_id);
    for envelope in &page.events {
        let event = SessionEvent::from_envelope(envelope).expect("each event reads");
        fold.apply(envelope, &event, &mut statements)
            .expect("each event folds");
    }
    log.writer
        .write(statements)
        .await
        .expect("the rebuilt rows are written");

    assert_eq!(stored_node(&database, session_id, "helper-1"), helper_one);
    assert_eq!(stored_node(&database, session_id, "helper-2"), helper_two);
}
