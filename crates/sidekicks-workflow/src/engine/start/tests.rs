mod unstarted;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::daemon::config::WorkflowChainAskAfterRuns;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_contracts::session::id::{SessionId, UserId};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{WorkflowNodeId, WorkflowVersionId};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowStartedBy, WorkflowTriggerKind,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_store::machine::local::LocalMachine;
use sidekicks_store::machine::registry::{MACHINE_REGISTRY_STATEMENT_CAPACITY, MachineRegistry};
use sidekicks_workspace::test_rows::project_and_mount_rows;

use super::{
    StartedRun, WORKFLOW_RUN_START_STATEMENT_CAPACITY, WorkflowRunStart, WorkflowRunStartError,
    WorkflowRunStarter, WorkflowRunStarterDependencies, WorkflowStartArrival, WorkflowStartOutcome,
};
use crate::definitions::kept_values::{
    WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY, WorkflowKeptValueStore,
};
use crate::engine::event_record::EngineRecorder;
use crate::engine::ports::kept_payloads::KeptPayloads;
use crate::engine::ports::run_limits::ScriptedRunLimits;
use crate::engine::ports::{EngineRecordSink, KeptEngineRecords, StepPayloadArtifacts};
use crate::kinds::{
    NodeKindTable, PassThroughExecutor, command_test_kind, git_test_kind, test_kind,
};
use crate::schema::schema_parts;
use crate::test_rows::{TEST_SESSION_ID, insert_run, insert_workflow_version_body};

const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70";
const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e71";
const UNKNOWN_VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e72";
const ROOT_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e73";
const ROOT_STARTED_AT: &str = "2026-10-02T00:00:00.000Z";
const ROWS_AT: &str = "2026-10-14T09:30:00.000Z";
const MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e74";

fn test_provider() -> ProviderId {
    ProviderId::new("test-provider".to_owned()).expect("the test's provider id")
}

/// The session a start names: none stored, stored with no working folder, or stored working in a
/// folder of its own.
#[derive(Clone, Copy, Debug)]
enum TestSession {
    Unknown,
    WithoutFolder,
    WithFolder,
}

/// The starter over a test database holding the store's, workspace and workflow tables, the
/// workflow's version 1 with `body` and no provider picked, the payloads it stored, the git kind,
/// which needs a project's repository, and the command kind, which runs in its provider's sandbox.
struct Fixture {
    database: TestDatabase,
    rows: Connection,
    starter: WorkflowRunStarter,
    payloads: Arc<KeptPayloads>,
    records: Arc<KeptEngineRecords>,
    machine_id: MachineId,
}

impl Fixture {
    async fn new(
        body: &Value,
        session: TestSession,
        chain_ask_after: Option<WorkflowChainAskAfterRuns>,
    ) -> Self {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens the test database"),
        );
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY
                + WORKFLOW_RUN_START_STATEMENT_CAPACITY
                + MACHINE_REGISTRY_STATEMENT_CAPACITY
                + WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY,
        ));
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::clone(&pool),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: None,
            refuse_session_write: None,
            read_damaged_from_sequence: None,
        }));
        let machine_id = MachineId::new(mint_uuid_v7().to_string()).expect("a machine id");
        let payloads = Arc::new(KeptPayloads::default());
        let kept_values = Arc::new(WorkflowKeptValueStore::new(
            Arc::clone(&pool),
            Arc::clone(&writer),
            Arc::clone(&payloads) as Arc<dyn StepPayloadArtifacts>,
        ));
        let machines = Arc::new(MachineRegistry::new(
            Arc::clone(&pool),
            writer,
            LocalMachine {
                machine_id: machine_id.clone(),
                owner_user_id: user_id(),
                name: "desk".to_owned(),
            },
        ));
        let records = Arc::new(KeptEngineRecords::default());
        let starter = WorkflowRunStarter::new(WorkflowRunStarterDependencies {
            pool,
            event_log,
            machines,
            authorizer: Arc::new(Authorizer::load_built_in().expect("the built-in rules load")),
            payloads: Arc::clone(&payloads) as Arc<dyn StepPayloadArtifacts>,
            run_limits: Arc::new(ScriptedRunLimits::with_chain_ask_after(chain_ask_after)),
            kept_values,
            kinds: Arc::new(
                NodeKindTable::new(vec![
                    test_kind(
                        json!({
                            "kind": "trigger.manual", "version": 1, "category": "trigger",
                            "displayName": "Manual", "description": "A run started by hand.",
                            "icon": "play", "params": [], "inputs": [],
                            "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
                            "outputsDeriveFromParams": false,
                        }),
                        None,
                        Box::new(PassThroughExecutor),
                    ),
                    test_kind(
                        json!({
                            "kind": "human.approval", "version": 1, "category": "human",
                            "displayName": "Approval", "description": "A person's yes or no.",
                            "icon": "check", "params": [],
                            "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
                            "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
                            "outputsDeriveFromParams": false,
                        }),
                        None,
                        Box::new(PassThroughExecutor),
                    ),
                    git_test_kind(),
                    command_test_kind(),
                ])
                .expect("the kinds build"),
            ),
            data_folder: test_folder(&database).join("data"),
            recorder: Arc::new(EngineRecorder::new(
                Arc::clone(&records) as Arc<dyn EngineRecordSink>
            )),
        });
        let rows = database.reader();
        insert_workflow_version_body(&rows, DEFINITION_ID, VERSION_ID, body);
        store_session(&rows, session, &session_folder(&database));
        Self {
            database,
            rows,
            starter,
            payloads,
            records,
            machine_id,
        }
    }

    fn data_folder(&self) -> PathBuf {
        test_folder(&self.database).join("data")
    }

    // Stores the chain's first run, already counting `run_count` runs.
    fn store_chain_root(&self, run_count: i64) {
        insert_run(
            &self.rows,
            ROOT_RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Succeeded,
            ROOT_STARTED_AT,
            Some(ROOT_STARTED_AT),
        );
        self.rows
            .execute(
                "UPDATE workflow_runs SET chain_run_count = ?1 WHERE id = ?2",
                params![run_count, ROOT_RUN_ID],
            )
            .expect("the test sets the chain's count");
    }

    fn count(&self, sql: &str) -> i64 {
        self.rows
            .query_row(sql, [], |row| row.get(0))
            .expect("the test counts rows")
    }

    // The started event's payload and instant, and the row's start.
    fn started_record(&self, run_id: WorkflowRunId) -> (Value, String, String) {
        let (payload, occurred_at): (String, String) = self
            .rows
            .query_row(
                "SELECT payload, occurred_at FROM session_events \
                 WHERE type = 'workflow.run.started'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the started event is stored");
        let started_at: String = self
            .rows
            .query_row(
                "SELECT started_at FROM workflow_runs WHERE id = ?1",
                [run_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the run is stored");
        (
            serde_json::from_str(&payload).expect("the payload is JSON"),
            occurred_at,
            started_at,
        )
    }
}

// The folder the test database sits in, removed with it.
fn test_folder(database: &TestDatabase) -> PathBuf {
    database
        .path()
        .parent()
        .expect("the database sits in its own folder")
        .to_path_buf()
}

fn session_folder(database: &TestDatabase) -> PathBuf {
    test_folder(database).join("session-folder")
}

fn user_id() -> UserId {
    UserId::try_from(mint_uuid_v7()).expect("a minted UUID is a user id")
}

fn session_id() -> SessionId {
    SessionId::new(TEST_SESSION_ID).expect("the test's session")
}

fn store_session(rows: &Connection, session: TestSession, folder: &Path) {
    if let TestSession::WithoutFolder | TestSession::WithFolder = session {
        insert_session_row(rows, TEST_SESSION_ID, None, None);
    }
    if let TestSession::WithFolder = session {
        for row in project_and_mount_rows(MOUNT_ID, None) {
            rows.execute_batch(&row).expect("a project row is stored");
        }
        rows.execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
             state, created_at, updated_at) VALUES ('workspace', ?1, ?6, ?2, ?3, ?4, ?5, ?5)",
            params![
                TEST_SESSION_ID,
                <&'static str>::from(ExecutionMode::BoundRoot),
                folder.to_string_lossy(),
                <&'static str>::from(WorkspaceState::Ready),
                ROWS_AT,
                MOUNT_ID
            ],
        )
        .expect("the session's workspace is stored");
    }
}

// A version body whose trigger declares `inputs`, or none, holding `nodes`.
fn body(inputs: Option<Value>, nodes: &Value) -> Value {
    let mut trigger = json!({
        "id": "start", "kind": "trigger.manual", "kindVersion": 1, "name": "Start", "order": 0,
        "params": {}
    });
    if let Some(inputs) = inputs {
        trigger["inputs"] = inputs;
    }
    json!({ "name": "Nightly", "trigger": trigger, "nodes": nodes, "edges": [] })
}

// A step `git` of the git kind, which needs a project's repository.
fn git_node() -> Value {
    json!({
        "id": "git", "kind": "developer.git", "kindVersion": 1, "name": "Git", "order": 0,
        "params": {}
    })
}

// A step `id` of the command kind, which runs in its provider's sandbox, disabled or not.
fn shell_node(id: &str, is_disabled: bool) -> Value {
    json!({
        "id": id, "kind": "developer.shell", "kindVersion": 1, "name": id, "order": 0,
        "disabled": is_disabled, "params": { "command": "pnpm test" }
    })
}

fn item(json: Value) -> WorkflowItem {
    WorkflowItem {
        json: AnyValue(json),
        binary: None,
        paired_item: None,
        error: None,
    }
}

fn joins_root() -> WorkflowRunChainPlace {
    WorkflowRunChainPlace::Joins {
        chain_root_run_id: WorkflowRunId::new(ROOT_RUN_ID).expect("the root's id"),
        is_from_error: true,
    }
}

// A start of the test version, as `arrival` makes one.
fn start(
    arrival: WorkflowStartArrival,
    chain: WorkflowRunChainPlace,
    input: Vec<WorkflowItem>,
) -> WorkflowRunStart {
    let (mode, trigger_kind, started_by) = match arrival {
        WorkflowStartArrival::Person => (
            WorkflowRunMode::Manual,
            WorkflowTriggerKind::Manual,
            WorkflowStartedBy::User {
                device_id: DeviceId::new("device-1".to_owned()).expect("a device id"),
            },
        ),
        WorkflowStartArrival::Agent => (
            WorkflowRunMode::Agent,
            WorkflowTriggerKind::Manual,
            WorkflowStartedBy::Agent {
                agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("an agent id"),
            },
        ),
        WorkflowStartArrival::Trigger => (
            WorkflowRunMode::Trigger,
            WorkflowTriggerKind::Schedule,
            WorkflowStartedBy::Schedule {},
        ),
    };
    WorkflowRunStart {
        workflow_version_id: WorkflowVersionId::new(VERSION_ID).expect("the test's version"),
        session_id: session_id(),
        mode,
        trigger_kind,
        arrival,
        started_by,
        chain,
        input,
    }
}

// The folders under `folder`, none when it is not there.
fn entries(folder: &Path) -> Vec<PathBuf> {
    if !folder.exists() {
        return Vec::new();
    }
    std::fs::read_dir(folder)
        .expect("the test reads the folder")
        .map(|entry| entry.expect("the test reads an entry").path())
        .collect()
}

// Every workflow's runs folder under the data folder, which holds its runs' own folders.
fn runs_folders(data_folder: &Path) -> Vec<PathBuf> {
    entries(&data_folder.join("workflows"))
        .iter()
        .map(|workflow| workflow.join("runs"))
        .filter(|runs| runs.exists())
        .collect()
}

// The refusal a start answers.
fn refusal(error: WorkflowRunStartError) -> DomainError {
    match HandlerError::from(error) {
        HandlerError::Refused(refusal) => Some(refusal),
        HandlerError::Internal(_) | HandlerError::Canceled => None,
    }
    .expect("the start is refused")
}

fn started(outcome: Result<WorkflowStartOutcome, WorkflowRunStartError>) -> StartedRun {
    match outcome.expect("the start is not refused") {
        WorkflowStartOutcome::Started(run) => Some(run),
        WorkflowStartOutcome::HeldOnChain { .. } => None,
    }
    .expect("the run started")
}

/// Mutations: the rule run for every start (the person's and the agent's on a machine registered
/// to another user are denied); a deny read as an allow; the owner read skipped, passing `None`,
/// which denies the trigger on its owner's machine.
#[rstest]
#[case::a_persons_start(WorkflowStartArrival::Person, true, true)]
#[case::an_agents_start(WorkflowStartArrival::Agent, true, true)]
#[case::a_trigger_on_another_users_machine(WorkflowStartArrival::Trigger, true, false)]
#[case::a_trigger_on_its_owners_machine(WorkflowStartArrival::Trigger, false, true)]
#[tokio::test]
async fn a_trigger_start_passes_the_rules_and_a_persons_or_agents_does_not(
    #[case] arrival: WorkflowStartArrival,
    #[case] is_registered_to_another_user: bool,
    #[case] is_started: bool,
) {
    let fixture = Fixture::new(&body(None, &json!([])), TestSession::WithoutFolder, None).await;
    if is_registered_to_another_user {
        fixture
            .rows
            .execute(
                "INSERT INTO machine_trust_state (machine_id, owner_user_id, established_at, \
                 updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![
                    fixture.machine_id.as_str(),
                    user_id().text().as_str(),
                    ROWS_AT
                ],
            )
            .expect("the test registers the machine");
    }

    let outcome = fixture
        .starter
        .start(start(arrival, WorkflowRunChainPlace::Starts {}, Vec::new()))
        .await;

    if is_started {
        started(outcome);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM workflow_runs"), 1);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM session_events"), 1);
    } else {
        let refusal = refusal(outcome.expect_err("the trigger's start is denied"));
        assert_eq!(refusal.code, RefusalCode::WorkflowRunStartDenied);
        assert!(
            refusal
                .detail
                .is_some_and(|detail| detail.contains_key("errors"))
        );
        assert_eq!(fixture.count("SELECT COUNT(*) FROM workflow_runs"), 0);
        assert_eq!(fixture.count("SELECT COUNT(*) FROM session_events"), 0);
        assert_eq!(runs_folders(&fixture.data_folder()), Vec::<PathBuf>::new());
    }
}

/// A start that is written, by where it works and how large its input is.
#[derive(Clone, Copy, Debug)]
enum WrittenStart {
    /// A trigger's start joining a chain, in a session with no folder, its trigger declaring an
    /// optional input with a default and the start giving none.
    TriggerJoiningAChain,
    /// A person's start in a session working in a project's folder, given an input above the cap,
    /// its version holding a step that needs a project's repository.
    ManualWithALargeInput,
}

/// Mutations: a member left off the started event; a declared input's default dropped; the run's
/// own folder named without its id, or not made; a large input carried inline (its event refused,
/// or no artifact); the folder made for a session that has one; the row's start and the event's
/// instant read from the clock apart (killed when the two readings fall in different milliseconds);
/// a step that needs a repository refused in a project's folder.
#[rstest]
#[case::a_trigger_joining_a_chain(WrittenStart::TriggerJoiningAChain)]
#[case::a_manual_start_with_a_large_input(WrittenStart::ManualWithALargeInput)]
#[tokio::test]
async fn a_started_run_records_its_trigger_chain_and_input_and_works_in_its_folder(
    #[case] case: WrittenStart,
) {
    match case {
        WrittenStart::TriggerJoiningAChain => {
            let declared = json!([{ "type": "string", "name": "branch", "default": "main" }]);
            let fixture = Fixture::new(
                &body(Some(declared), &json!([])),
                TestSession::WithoutFolder,
                WorkflowChainAskAfterRuns::new(25),
            )
            .await;
            fixture.store_chain_root(1);

            let run = started(
                fixture
                    .starter
                    .start(start(
                        WorkflowStartArrival::Trigger,
                        joins_root(),
                        Vec::new(),
                    ))
                    .await,
            );

            let (payload, occurred_at, started_at) = fixture.started_record(run.scope.run_id);
            assert_eq!(
                payload["trigger"],
                json!({ "kind": "trigger.schedule", "nodeId": "start" })
            );
            assert_eq!(
                payload["chain"],
                json!({ "kind": "joins", "chainRootRunId": ROOT_RUN_ID, "isFromError": true })
            );
            assert_eq!(
                payload["inputRef"],
                json!({ "kind": "inline", "items": [{ "json": { "branch": "main" } }] })
            );
            assert_eq!(started_at, occurred_at);
            let own_folder = fixture
                .data_folder()
                .join("workflows")
                .join(DEFINITION_ID)
                .join("runs")
                .join(run.scope.run_id.text().as_str());
            assert_eq!(run.scope.working_folder, own_folder);
            assert!(own_folder.is_dir());
            assert_eq!(entries(&own_folder), Vec::<PathBuf>::new());
            assert_eq!(fixture.payloads.writes(), Vec::new());
        }
        WrittenStart::ManualWithALargeInput => {
            let fixture = Fixture::new(
                &body(None, &json!([git_node()])),
                TestSession::WithFolder,
                None,
            )
            .await;
            let large = item(json!({ "note": "x".repeat(70 * 1024) }));

            let run = started(
                fixture
                    .starter
                    .start(start(
                        WorkflowStartArrival::Person,
                        WorkflowRunChainPlace::Starts {},
                        vec![large],
                    ))
                    .await,
            );

            let kept = fixture.payloads.writes();
            assert_eq!(kept.len(), 1);
            assert_eq!(
                (kept[0].session_id, &kept[0].step, kept[0].item_count),
                (
                    session_id(),
                    &WorkflowStepKey {
                        workflow_run_id: run.scope.run_id,
                        node_id: WorkflowNodeId::new("start".to_owned()).expect("a node id"),
                        attempt: SafeInt::new(1).expect("a first attempt"),
                        execution_index: SafeInt::ZERO,
                    },
                    1
                )
            );
            let artifact = WorkflowPayloadRef::Artifact {
                artifact_id: kept[0].artifact_id,
                size_bytes: SafeInt::new(
                    u64::try_from(kept[0].bytes.len()).expect("a length fits in 64 bits"),
                )
                .expect("the payload holds bytes"),
                item_count: SafeInt::new(1).expect("one item"),
            };
            assert_eq!(run.trigger_input, artifact);
            let (payload, occurred_at, started_at) = fixture.started_record(run.scope.run_id);
            assert_eq!(
                payload["inputRef"],
                serde_json::to_value(&artifact).expect("a payload ref writes as JSON")
            );
            assert_eq!(started_at, occurred_at);
            assert_eq!(run.scope.working_folder, session_folder(&fixture.database));
            assert!(!fixture.data_folder().join("workflows").exists());
        }
    }
}

/// Mutations: pins taken for a trigger run, or dropped for a manual one; the trigger left out of
/// the nodes or the version's nodes dropped; the scope's start read from the clock apart from the
/// event's instant; the provider read from anywhere but the workflow, or the run's row or started
/// event left without it; a start with no provider refused though no step runs in a sandbox; kept
/// values not read.
#[rstest]
#[case::a_manual_run(WorkflowStartArrival::Person, true, Some("test-provider"))]
#[case::a_trigger_run(WorkflowStartArrival::Trigger, false, None)]
#[tokio::test]
async fn the_start_scope_holds_the_pinned_version_and_its_pins(
    #[case] arrival: WorkflowStartArrival,
    #[case] has_pins: bool,
    #[case] provider: Option<&str>,
) {
    let version_body = body(
        None,
        &json!([{
            "id": "review", "kind": "human.approval", "kindVersion": 1, "name": "Review",
            "order": 0, "params": { "note": "check the draft" }
        }]),
    );
    let fixture = Fixture::new(&version_body, TestSession::WithFolder, None).await;
    let pins = json!({ "review": [{ "json": { "name": "Ada" } }] });
    fixture
        .rows
        .execute(
            "UPDATE workflow_definitions SET pin_data_json = ?1, provider = ?2 WHERE id = ?3",
            params![pins.to_string(), provider, DEFINITION_ID],
        )
        .expect("the test sets the workflow's pins and provider");
    fixture
        .rows
        .execute(
            "INSERT INTO workflow_node_state (definition_id, node_id, key, value_json, \
             kept_by_run_id, updated_at) VALUES (?1, '', 'region', '\"eu\"', ?2, ?3)",
            params![DEFINITION_ID, ROOT_RUN_ID, ROWS_AT],
        )
        .expect("the test keeps a value");

    let run = started(
        fixture
            .starter
            .start(start(arrival, WorkflowRunChainPlace::Starts {}, Vec::new()))
            .await,
    );

    let scope = &run.scope;
    let mut node_ids: Vec<&str> = scope.nodes.keys().map(WorkflowNodeId::as_str).collect();
    node_ids.sort_unstable();
    assert_eq!(node_ids, ["review", "start"]);
    let review = WorkflowNodeId::new("review".to_owned()).expect("a node id");
    assert_eq!(
        serde_json::to_value(&scope.node_params[&review]).expect("params write as JSON"),
        json!({ "note": "check the draft" })
    );
    let scope_pins = scope
        .pins
        .iter()
        .map(|(node_id, pin)| {
            let items = serde_json::to_value(&pin.items).expect("pins write as JSON");
            (node_id.as_str().to_owned(), items)
        })
        .collect();
    assert_eq!(
        Value::Object(scope_pins),
        if has_pins { pins } else { json!({}) }
    );
    assert_eq!(scope.provider, provider.map(|_| test_provider()));
    let row_provider: Option<String> = fixture
        .rows
        .query_row(
            "SELECT provider FROM workflow_runs WHERE id = ?1",
            [scope.run_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the run is stored");
    assert_eq!(row_provider.as_deref(), provider);
    assert_eq!(
        scope.project,
        Some(ProjectId::new(MOUNT_ID).expect("the project's id"))
    );
    let (payload, occurred_at, _) = fixture.started_record(scope.run_id);
    assert_eq!(payload.get("provider"), provider.map(Value::from).as_ref());
    assert_eq!(
        scope.run_started_at,
        occurred_at
            .parse::<jiff::Timestamp>()
            .expect("the event's instant parses")
    );
    assert_eq!(
        scope
            .kept_values
            .iter()
            .map(|kept| (kept.name.as_str(), &kept.value))
            .collect::<Vec<_>>(),
        [("region", &json!("eu"))]
    );
}

/// The workflow's pins do not parse, which fails a manual run's scope. Mutations: the scope read
/// after the write (a run row and its event are kept); the run's own folder, or its emptied runs
/// folder, left behind; the scope read after the trigger's input (the large input is stored).
#[tokio::test]
async fn a_failed_scope_read_writes_no_run() {
    let fixture = Fixture::new(&body(None, &json!([])), TestSession::WithoutFolder, None).await;
    fixture
        .rows
        .execute(
            "UPDATE workflow_definitions SET pin_data_json = '{\"start\": \"not a list\"}' \
             WHERE id = ?1",
            [DEFINITION_ID],
        )
        .expect("the test stores pins that do not parse");
    let large = item(json!({ "note": "x".repeat(70 * 1024) }));

    let outcome = fixture
        .starter
        .start(start(
            WorkflowStartArrival::Person,
            WorkflowRunChainPlace::Starts {},
            vec![large],
        ))
        .await;

    assert!(matches!(
        outcome,
        Err(WorkflowRunStartError::StoredDocument(_))
    ));
    assert_eq!(fixture.count("SELECT COUNT(*) FROM workflow_runs"), 0);
    assert_eq!(fixture.count("SELECT COUNT(*) FROM session_events"), 0);
    assert_eq!(runs_folders(&fixture.data_folder()), Vec::<PathBuf>::new());
    assert_eq!(fixture.payloads.writes(), Vec::new());
}
