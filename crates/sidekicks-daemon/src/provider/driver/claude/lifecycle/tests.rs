use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Map, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::wire::text::FreeFormText;
use tempfile::TempDir;
use tokio::sync::Notify;

use super::ClaudeDriver;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::mutex_lock::lock;
use crate::policy::execution_posture_service::{
    ExecutionPostureService, compose_execution_posture,
};
use crate::provider::driver::claude::delivery::run_engine::ClaudeRunEngine;
use crate::provider::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::provider::driver::claude::session::scripted::daemon_services::{
    RecordingPorts, RecordingUsage, register_scripted_ports, test_callback_tool_host,
};
use crate::provider::driver::claude::session::scripted::run_engine::RecordingRunEngine;
use crate::provider::driver::claude::session::scripted::starts::{
    ScriptedStartRecord, ScriptedStarts,
};
use crate::provider::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, binding_id, hand_scripted_frame, mint_session_id,
};
use crate::provider::driver::contract::{RunOpening, StartRunParams};
use crate::provider::driver::ports::SessionRelaunchListener;
use crate::provider::driver::session_control::{
    CreateSessionParams, DriverResumeResult, ResumeSessionParams,
};
use crate::provider::driver::test_registry::test_driver_services;
use crate::provider::driver::{
    DriverServices, ProviderAccountFolders, SessionSpawnContext, SessionSpawnContextResolver,
};

mod bring_up;
mod restarts;
mod session_controls;
mod settings_reads;

/// The statements the fixture's read pool caches.
const POOL_STATEMENT_CAPACITY: usize = 16;

/// Longer than every restart's wait, so a restart that would come has come.
const RESTART_WAITS_PASSED: Duration = Duration::from_secs(5);

// Every session runs in one folder, and every account on the folders given, else on the person's
// own home.
struct FolderContexts {
    work: PathBuf,
    account_folders: Option<ProviderAccountFolders>,
}

impl SessionSpawnContextResolver for FolderContexts {
    fn resolve_spawn_context(
        &self,
        _session_id: SessionId,
        _provider_account_id: Option<ProviderAccountId>,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn std::error::Error + Send + Sync>>> {
        let working_directory = self.work.clone();
        async move {
            Ok(SessionSpawnContext {
                working_directory,
                git_common_folder: None,
                every_project_rows: Vec::new(),
                project_rows: Vec::new(),
                account_folders: None,
            })
        }
        .boxed()
    }

    fn resolve_account_folders(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<
        '_,
        Result<Option<ProviderAccountFolders>, Box<dyn std::error::Error + Send + Sync>>,
    > {
        let account_folders = self.account_folders.clone();
        async move { Ok(account_folders) }.boxed()
    }
}

// Each relaunch the driver reported, with whether it resumed.
#[derive(Default)]
struct RecordedRelaunches {
    taken: Mutex<Vec<(SessionId, bool)>>,
    reported: Notify,
}

impl RecordedRelaunches {
    fn taken(&self) -> Vec<(SessionId, bool)> {
        lock(&self.taken).clone()
    }

    // The relaunches once the first is reported, which comes after the process it started.
    async fn first_reported(&self) -> Vec<(SessionId, bool)> {
        loop {
            let next = self.reported.notified();
            let taken = self.taken();
            if !taken.is_empty() {
                return taken;
            }
            next.await;
        }
    }
}

impl SessionRelaunchListener for RecordedRelaunches {
    fn session_relaunched(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> BoxFuture<'_, Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
        lock(&self.taken).push((session_id, is_resumed));
        self.reported.notify_waiters();
        async { Ok(()) }.boxed()
    }
}

// The Claude driver over the daemon's shared services, every process scripted, its session pieces
// composed over a recording run engine, in a home and a working folder of its own.
struct DriverFixture {
    driver: Arc<ClaudeDriver>,
    starts: Arc<ScriptedStarts>,
    engine: Arc<RecordingRunEngine>,
    ports: Arc<RecordingPorts>,
    usage: Arc<RecordingUsage>,
    relaunches: Arc<RecordedRelaunches>,
    services: DriverServices,
    home: PathBuf,
    work: PathBuf,
    _folder: TempDir,
    database: TestDatabase,
}

impl DriverFixture {
    fn new() -> Self {
        Self::with_account_folders(None)
    }

    // The fixture whose accounts run on `account_folders`, else on the person's own home.
    fn with_account_folders(account_folders: Option<ProviderAccountFolders>) -> Self {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let database = TestDatabase::new();
        drop((database.opener())().expect("the test database opens with the daemon's schema"));
        let home = folder.path().join("home");
        let work = folder.path().join("work");
        std::fs::create_dir_all(&work).expect("the working folder is made");
        let base = DriverServices {
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                POOL_STATEMENT_CAPACITY,
            )),
            spawn_contexts: Arc::new(FolderContexts {
                work: work.clone(),
                account_folders,
            }),
            data_folder: folder.path().join("data"),
            home_folder: home.clone(),
            // Claude Code's home in every composed environment is the fixture's own.
            base_environment: Arc::from([("HOME".to_owned(), home.display().to_string())]),
            execution_postures: Arc::new(ExecutionPostureService::new(
                &home,
                folder.path().join("session-token"),
            )),
            ..test_driver_services()
        };
        let ports = &base.ports;
        let recording = Arc::new(RecordingPorts::default());
        let usage = Arc::new(RecordingUsage::default());
        let relaunches = Arc::new(RecordedRelaunches::default());
        ports
            .callback_tool_host
            .register(test_callback_tool_host())
            .expect("the host registers once");
        register_scripted_ports(ports, &recording);
        ports
            .usage
            .register(usage.clone())
            .expect("the usage record registers once");
        ports
            .session_relaunched
            .register(relaunches.clone())
            .expect("the relaunch listener registers once");
        let starts = Arc::new(ScriptedStarts::default());
        let engine = Arc::new(RecordingRunEngine::default());
        let shared_engine: Arc<dyn ClaudeRunEngine> = engine.clone();
        let driver = ClaudeDriver::with_engine(&base, starts.clone(), &shared_engine)
            .expect("the session pieces compose");
        Self {
            driver: Arc::new(driver),
            starts,
            engine,
            ports: recording,
            usage,
            relaunches,
            services: base,
            home,
            work,
            _folder: folder,
            database,
        }
    }

    // Waits until `is_reached` answers true.
    async fn wait_for(is_reached: impl Fn() -> bool) {
        while !is_reached() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    // Opens a session on `channel`.
    async fn create(&self, channel: &Arc<ScriptedChannel>) -> SessionId {
        let session_id = mint_session_id();
        self.starts.script_session(Arc::clone(channel));
        self.driver
            .create_session(create_params(session_id))
            .await
            .expect("the session opens");
        session_id
    }

    // The next session start.
    async fn next_start(&self) -> ScriptedStartRecord {
        self.starts.wait_for_starts(1).await;
        self.starts
            .take_started()
            .pop()
            .expect("a start was recorded")
    }

    // Ends the process `start` brought up, as its reader would on an exit nothing asked for.
    fn exit(start: &ScriptedStartRecord) {
        start
            .listener
            .take_exit(Err(Arc::new(io::Error::other("the process ended"))));
    }

    // Hands the lead `result` that ends the session's turn to the process `start` brought up.
    fn end_turn(&self, start: &ScriptedStartRecord, session_id: SessionId) {
        end_turn_of(&self.driver, start, session_id);
    }
}

// Hands the lead `result` that ends the session's turn to the process `start` brought up for
// `driver`.
fn end_turn_of(driver: &ClaudeDriver, start: &ScriptedStartRecord, session_id: SessionId) {
    let routes = &driver.composed_parts().expect("composed").run_start.routes;
    for frame in [
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        }),
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "done",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        }),
    ] {
        hand_scripted_frame(&*start.listener, routes, session_id, &frame);
    }
}

fn create_params(session_id: SessionId) -> CreateSessionParams {
    CreateSessionParams {
        session_id,
        agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        config: Map::new(),
        model: ProviderToken::new("opus".to_owned()).expect("the model fits"),
        larger_window: None,
        // The run engine opens every session with a posture.
        execution_posture: Some(compose_execution_posture(
            PermissionLevel::Ask,
            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
        )),
        output_speed: None,
        options: Vec::new(),
        row_values: Record::default(),
        callback_tools: None,
        subagent_policy: None,
        tool_servers: None,
        output_schema: None,
        provider_account_id: None,
        on_mcp_server_status: None,
    }
}

fn start_params(session_id: SessionId, run_id: RunId) -> StartRunParams {
    StartRunParams {
        run_id,
        opening: RunOpening {
            session_id,
            binding_id: binding_id("lead"),
            agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an id"),
            content: FreeFormText::new("go".to_owned()).expect("the words fit"),
            attachments: Vec::new(),
            message_id: QueueItemId::new(&mint_uuid_v7().to_string())
                .expect("a minted UUID is an item id"),
            skills: Vec::new(),
        },
        conversation_history: None,
        output_speed: None,
        options: Vec::new(),
        output_speed_for_turn: None,
        execution_posture: None,
        output_schema: None,
    }
}

fn resume_params(session_id: SessionId) -> ResumeSessionParams {
    ResumeSessionParams {
        session_id,
        agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        resume_handle: "conversation".to_owned(),
        model: ProviderToken::new("opus".to_owned()).expect("the model fits"),
        larger_window: None,
        mode: SessionMode::Build,
        execution_posture: None,
        output_speed: None,
        options: Vec::new(),
        row_values: Record::default(),
        callback_tools: None,
        subagent_policy: None,
        tool_servers: None,
        output_schema: None,
        provider_account_id: None,
        on_mcp_server_status: None,
    }
}
