//! The undo's stops over a test database holding a session whose lead is bound to the table's
//! first provider, whose driver is a stand-in recording each stop: what the reader names is what
//! is stopped, the step answers only once each end is in the log, and past the bound it names
//! what still runs.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::ChildRunProvenance;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::pin_running_process;
use sidekicks_provider::command::channel::PartyId;
use sidekicks_provider::command::channel::stop::StoppedCommandParties;
use sidekicks_provider::command::running_set::{
    RunningCommandSets, TestCommandStart, test_bound_running_command_sets,
};
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::run_control::HelperStopOutcome;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_provider::port::running_command_publisher::CommandStopCause;
use sidekicks_session::agent_tree::schema::schema_parts as agent_tree_schema_parts;
use sidekicks_session::agent_tree::store::{NewAgentTreeNode, insert_node};
use sidekicks_session::agent_tree::sweep::{
    AGENT_TREE_SWEEP_STATEMENT_CAPACITY, AgentTreeSweep, DescendantStop,
};
use sidekicks_session::agents::projection::test_fixture::{run_statements, write_log_row};
use sidekicks_session::agents::schema::schema_parts as agents_schema_parts;
use sidekicks_session::checkpoints::schema::schema_parts as checkpoint_schema_parts;
use sidekicks_session::interventions::service::test_fixture::test_intervention_service;
use sidekicks_session::questions::schema::schema_parts;
use sidekicks_session::run::engine::test_fixture::{insert_run, test_engine};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{
    TestDatabase, insert_lead, test_envelope, test_run_id, test_session_id,
};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::log_service::{EventLogAppendOptions, EventLogService};
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tempfile::TempDir;

use super::{UndoStopError, UndoStopWrapper, UndoStops, UndoStopsDeps};

/// The statements the tests' read pool prepares, every reader's together.
const READ_STATEMENT_CAPACITY: usize = 32;

/// Bounds every wait a fault could hang.
const WAIT: Duration = Duration::from_secs(5);

/// How long a step held behind an end is watched to show it waits.
const HELD_WATCH: Duration = Duration::from_millis(200);

/// An instant `second` seconds into the test's minute.
fn at(second: u32) -> String {
    format!("2026-10-28T09:00:{second:02}.000Z")
}

/// What the stand-in driver was asked to stop, in order.
#[derive(Default)]
struct DriverStops {
    /// Each command's stop, with its cause.
    commands: Mutex<Vec<(CommandId, CommandStopCause)>>,
    /// Each helper's stop, by its own run.
    helpers: Mutex<Vec<RunId>>,
}

/// A session whose lead runs one run, its log written row by row, its running commands on the
/// test binding.
struct Scene {
    database: TestDatabase,
    log: TestLog,
    session_id: SessionId,
    lead: AgentId,
    lead_run: RunId,
    // The sequence the next row of the log takes.
    sequence: i64,
    running: Arc<RunningCommandSets>,
    // The engine's posture files.
    home: TempDir,
}

async fn scene() -> Scene {
    let database = TestDatabase::new(
        schema_parts()
            .with_parts(checkpoint_schema_parts())
            .with_parts(agent_tree_schema_parts())
            .with_parts(agents_schema_parts()),
    );
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
    let lead = insert_lead(&database, session_id, PROVIDERS[0].id);
    let lead_run = test_run_id();
    insert_run(&database, session_id, lead_run, "running");
    Scene {
        database,
        log,
        session_id,
        lead,
        lead_run,
        sequence: 1,
        running: test_bound_running_command_sets(),
        home: tempfile::tempdir().expect("the test makes a home folder"),
    }
}

impl Scene {
    /// Writes the next row of the log at `occurred_at`, filed under `run_id`, and answers its
    /// sequence.
    fn row(
        &mut self,
        event_type: SessionEventType,
        payload: &Value,
        run_id: RunId,
        occurred_at: &str,
    ) -> i64 {
        let sequence = self.sequence;
        self.sequence += 1;
        write_log_row(
            &self.database.reader(),
            self.session_id,
            sequence,
            (event_type, payload),
            Some(run_id),
            occurred_at,
        );
        sequence
    }

    /// The lead run's opening of the call `tool_call_id` at `occurred_at`.
    fn open_tool_call(&mut self, tool_call_id: &str, occurred_at: &str) {
        let payload = json!({ "toolCallId": tool_call_id });
        self.row(
            SessionEventType::AgentToolCallInvoked,
            &payload,
            self.lead_run,
            occurred_at,
        );
    }

    /// A message to the lead at `occurred_at`, the undo's point, and its sequence.
    fn point(&mut self, occurred_at: &str) -> i64 {
        let payload = json!({ "content": "Look again" });
        self.row(
            SessionEventType::UserMessageSent,
            &payload,
            self.lead_run,
            occurred_at,
        )
    }

    /// A background command `name` of the lead run, started by `tool_call_id` at `started_at`.
    fn start_command(&self, name: &str, tool_call_id: Option<&str>, started_at: &str) -> CommandId {
        let command_id = CommandId::new(name.to_owned()).expect("a command id");
        self.running.start_test_command_of(
            self.session_id,
            TestCommandStart {
                command_id: command_id.clone(),
                run_id: self.lead_run,
                tool_call_id: tool_call_id
                    .map(|id| ToolCallId::new(id.to_owned()).expect("a tool call id")),
                started_at: WireInstant::try_from(started_at.to_owned()).expect("an instant"),
            },
        );
        command_id
    }

    /// A running helper of the lead run, its own run queued at `queued_at`, and its own run.
    fn start_helper(&mut self, subagent_id: &str, queued_at: &str) -> RunId {
        let own_run = test_run_id();
        self.database
            .reader()
            .execute(
                "INSERT INTO runs (run_id, session_id, parent_run_id, reached_by, state,
                                   run_version)
                 VALUES (?1, ?2, ?3, ?4, 'running', 1)",
                params![
                    own_run.text().as_str(),
                    self.session_id.text().as_str(),
                    self.lead_run.text().as_str(),
                    <&'static str>::from(ChildRunProvenance::ProviderSubagent),
                ],
            )
            .expect("the test writes the helper's run");
        let queued = json!({ "agentId": self.lead });
        self.row(
            SessionEventType::AgentRunQueued,
            &queued,
            own_run,
            queued_at,
        );
        let started = json!({
            "sessionId": self.session_id,
            "runId": self.lead_run,
            "provider": PROVIDERS[0].id,
            "subagentId": subagent_id,
            "childRunId": own_run,
        });
        let lead_run = self.lead_run;
        self.row(
            SessionEventType::AgentSubagentStarted,
            &started,
            lead_run,
            queued_at,
        );
        let node = insert_node(&NewAgentTreeNode {
            child_handle: ChildHandle::new(mint_uuid_v7().to_string()).expect("a child handle"),
            session_id: self.session_id,
            provider_name: ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a provider id"),
            subagent_id: subagent_id.to_owned(),
            parent_subagent_id: None,
            parent_child_handle: None,
            name: None,
            role: None,
            provider_path: None,
            model_id: None,
            effort: None,
            start_call_id: None,
            own_run_id: own_run,
            started_at: WireInstant::try_from(queued_at.to_owned()).expect("an instant"),
        });
        run_statements(&self.database.reader(), &[node]);
        own_run
    }

    /// The step over the scene, its lead's provider answered by `driver`.
    fn stops(&self, driver: MockProviderDriver) -> Arc<UndoStops> {
        let pool = Arc::new(DatabaseReadPool::new(
            self.database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
        let engine = test_engine(
            &self.database,
            Arc::clone(&self.log.service),
            self.home.path(),
        );
        let interventions =
            test_intervention_service(Arc::clone(&pool), &engine, Arc::clone(&providers));
        let sweep = AgentTreeSweep::new(
            Arc::new(DatabaseReadPool::new(
                self.database.path(),
                AGENT_TREE_SWEEP_STATEMENT_CAPACITY,
            )),
            Arc::clone(&providers),
            (*interventions).clone(),
            Arc::new(SessionEventAppender::new(
                Arc::clone(&self.log.service),
                SESSION_EVENT_VERSION.clone(),
            )),
        );
        let read_damaged_from_sequence: Arc<DamagedFromSequenceReader> =
            Arc::new(|_: &SessionId| None::<i64>);
        Arc::new(UndoStops::new(UndoStopsDeps {
            pool,
            event_log: Arc::clone(&self.log.service),
            providers,
            read_damaged_from_sequence,
            running_commands: Arc::clone(&self.running),
            sweep,
        }))
    }

    /// Appends the person-ended ending of the lead run's `command_id` through the log.
    async fn end_command(&self, command_id: &CommandId) {
        append(
            &self.log.service,
            self.session_id,
            &ending(self.session_id, self.lead_run, command_id),
        )
        .await;
    }

    /// Appends a row naming no command and no run, which wakes the step and ends nothing.
    async fn append_unrelated(&self) {
        append(
            &self.log.service,
            self.session_id,
            &json!({
                "type": "session.pinned",
                "payload": { "sessionId": self.session_id, "at": at(30) },
            }),
        )
        .await;
    }

    /// The path of the scene's database, which a stand-in driver writes through.
    fn path(&self) -> PathBuf {
        self.database.path()
    }
}

/// Appends `event` to `session_id`'s log through `service`, as a committed write wakes the step.
async fn append(service: &EventLogService, session_id: SessionId, event: &Value) {
    let event: SessionEvent =
        serde_json::from_value(event.clone()).expect("the test writes a well-formed event");
    service
        .append(
            test_envelope(session_id, &event),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the test's event is appended");
}

/// The person-ended `agent.command.ended` of `run_id`'s `command_id`.
fn ending(session_id: SessionId, run_id: RunId, command_id: &CommandId) -> Value {
    json!({
        "type": "agent.command.ended",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "commandId": command_id,
            "ending": "endedByPerson",
            "durationMs": 0,
        },
    })
}

/// Moves `run_id` to `completed` through a connection of its own on the database at `path`.
fn complete_run(path: &PathBuf, run_id: RunId) {
    Connection::open(path)
        .expect("the test opens the database")
        .execute(
            "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
            [run_id.text().as_str()],
        )
        .expect("the test ends the run");
}

/// A driver recording each stop in `stops`, each command's stop answered with no parties once
/// `on_command` ran for it and each helper's stopped once `on_helper` ran for it.
fn recording_driver(
    stops: &Arc<DriverStops>,
    on_command: impl Fn(CommandId) -> futures::future::BoxFuture<'static, ()> + Send + Sync + 'static,
    on_helper: impl Fn(RunId) + Send + Sync + 'static,
) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    let commands = Arc::clone(stops);
    driver.expect_stop_command().returning(move |params| {
        let command_id = params.command_id().clone();
        lock(&commands.commands).push((command_id.clone(), params.cause()));
        let ran = on_command(command_id);
        async move {
            ran.await;
            Ok(StoppedCommandParties::default())
        }
        .boxed()
    });
    let helpers = Arc::clone(stops);
    driver.expect_stop_child_run().returning(move |params| {
        lock(&helpers.helpers).push(params.run_id);
        on_helper(params.run_id);
        async { Ok(HelperStopOutcome::Stopped) }.boxed()
    });
    driver
}

/// The ids of `commands`.
fn ids(commands: &[(CommandId, CommandStopCause)]) -> Vec<CommandId> {
    commands
        .iter()
        .map(|(command_id, _)| command_id.clone())
        .collect()
}

// Three commands: one whose call opened before the point though it started after the point's
// message, one whose call opened after the point though it started before that message, and one
// with no call that started after it; one helper queued after the point; and one wrapper admitted
// after it that no command row names yet. The reader names the second and third, the helper and
// the wrapper, the step stops exactly those for an undo and answers that set, and the first still
// runs. Killed by stopping every command, by a reader placing a command by its start alone, by a
// reader taking every command of a run the cut reaches, and by one dropping unpaired wrappers.
#[tokio::test]
async fn stops_exactly_what_the_reader_names() {
    let mut scene = scene().await;
    scene.open_tool_call("call-before", &at(1));
    let point = scene.point(&at(2));
    scene.open_tool_call("call-after", &at(3));
    let helper_run = scene.start_helper("helper-after", &at(4));
    let before = scene.start_command("before", Some("call-before"), &at(3));
    let after = scene.start_command("after", Some("call-after"), &at(1));
    let untracked = scene.start_command("untracked", None, &at(3));
    let unpaired: PartyId = 4242;
    scene.running.admit_test_wrapper(scene.session_id, unpaired);

    let stops = Arc::new(DriverStops::default());
    let ending = {
        let service = Arc::clone(&scene.log.service);
        let (session_id, lead_run) = (scene.session_id, scene.lead_run);
        move |command_id: CommandId| {
            let service = Arc::clone(&service);
            async move {
                append(
                    &service,
                    session_id,
                    &ending(session_id, lead_run, &command_id),
                )
                .await;
            }
            .boxed()
        }
    };
    let path = scene.path();
    let driver = recording_driver(&stops, ending, move |run_id| complete_run(&path, run_id));
    let step = scene.stops(driver);

    let named = step
        .read_started_after(scene.session_id, point)
        .await
        .expect("the reader reads the session");
    assert_eq!(named.commands, [after.clone(), untracked.clone()]);
    assert_eq!(named.unpaired_wrappers, [unpaired]);
    assert_eq!(
        named
            .agents
            .iter()
            .map(|agent| match agent.stop {
                DescendantStop::Helper { run_id, .. } => run_id,
                DescendantStop::Run { .. } => panic!("the helper is a provider's child"),
            })
            .collect::<Vec<_>>(),
        [helper_run]
    );

    let stopped =
        tokio::time::timeout(WAIT, step.stop_started_after(scene.session_id, point, None))
            .await
            .expect("the step answers once everything ended")
            .expect("every stop stopped");

    assert_eq!(stopped, named);
    let mut stopped_commands = ids(&lock(&stops.commands));
    stopped_commands.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    assert_eq!(stopped_commands, [after, untracked]);
    assert!(
        lock(&stops.commands)
            .iter()
            .all(|(_, cause)| *cause == CommandStopCause::Undo)
    );
    assert_eq!(*lock(&stops.helpers), [helper_run]);
    assert!(
        scene
            .running
            .running_starts(scene.session_id)
            .iter()
            .any(|start| start.command_id == before)
    );
}

// The driver takes both stops at once; the step still waits for the command's ending, then for
// the helper's terminal state, and answers only once both are in the store. Killed by answering
// once the stops are taken, and by answering once the endings alone are in the log.
#[tokio::test]
async fn answers_only_after_each_end_is_in_the_log() {
    let mut scene = scene().await;
    let point = scene.point(&at(2));
    let helper_run = scene.start_helper("helper-after", &at(4));
    let command_id = scene.start_command("after", None, &at(3));
    let stops = Arc::new(DriverStops::default());
    let driver = recording_driver(&stops, |_| async {}.boxed(), |_| {});
    let step = scene.stops(driver);

    let session_id = scene.session_id;
    let stopping = tokio::spawn({
        let step = Arc::clone(&step);
        async move { step.stop_started_after(session_id, point, None).await }
    });
    tokio::time::timeout(WAIT, async {
        while lock(&stops.commands).is_empty() || lock(&stops.helpers).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("both stops are taken");
    tokio::time::sleep(HELD_WATCH).await;
    assert!(!stopping.is_finished(), "nothing has ended yet");

    scene.end_command(&command_id).await;
    tokio::time::sleep(HELD_WATCH).await;
    assert!(!stopping.is_finished(), "the helper still runs");

    complete_run(&scene.path(), helper_run);
    scene.append_unrelated().await;
    let stopped = tokio::time::timeout(WAIT, stopping)
        .await
        .expect("the step answers once both ended")
        .expect("the step does not panic")
        .expect("every stop stopped");
    assert_eq!(stopped.commands, [command_id]);
}

// A stop the driver takes, answering the test's own process as the wrapper's party, which never
// ends, and an ending that never lands: past the bound the step fails, naming the command among
// those with no ending and among the wrappers not ended. Killed by answering at the bound, and by
// skipping the wait on the parties.
#[tokio::test(start_paused = true)]
async fn names_what_still_runs_after_the_bound() {
    let mut scene = scene().await;
    let point = scene.point(&at(2));
    let command_id = scene.start_command("after", None, &at(3));
    let mut driver = MockProviderDriver::new();
    driver.expect_stop_command().returning(|_| {
        let party = pin_running_process(std::process::id())
            .expect("the test pins itself")
            .expect("it runs");
        async move { Ok(StoppedCommandParties::of_processes(vec![party])) }.boxed()
    });
    let step = scene.stops(driver);

    let failure = step
        .stop_started_after(scene.session_id, point, None)
        .await
        .expect_err("the command never ends");

    let UndoStopError::StillRunning {
        commands,
        wrappers,
        agents,
    } = failure
    else {
        panic!("the step fails as still running, not as {failure:?}");
    };
    assert_eq!(commands, std::slice::from_ref(&command_id));
    assert_eq!(wrappers, [UndoStopWrapper::Command(command_id)]);
    assert_eq!(agents, Vec::new());
}
