//! The Claude driver over scripted process starts and a recording run engine, in a home, a working
//! folder and a database of its own: every session a test opens comes up through the driver's own
//! create.

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
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::record::Record;
use tempfile::TempDir;
use tokio::sync::Notify;

use super::channel::ScriptedChannel;
use super::daemon_services::{
    RecordingPorts, RecordingUsage, ScriptedAttachments, register_scripted_ports,
    test_callback_tool_host,
};
use super::run_engine::RecordingRunEngine;
use super::starts::{ScriptedStartRecord, ScriptedStarts};
use super::{SCRIPTED_PROVIDER_SESSION_ID, hand_scripted_frame, scripted_staged_changes};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::mutex_lock::lock;
use crate::plans::schema::schema_parts;
use crate::policy::execution_posture_service::{
    ExecutionPostureService, compose_execution_posture,
};
use crate::provider::driver::claude::delivery::run_engine::ClaudeRunEngine;
use crate::provider::driver::claude::lifecycle::ClaudeDriver;
use crate::provider::driver::ports::SessionRelaunchListener;
use crate::provider::driver::session_control::{CreateSessionParams, DriverResumeResult};
use crate::provider::driver::test_registry::{new_session_id, test_driver_services};
use crate::provider::driver::{
    DriverServices, ProviderAccountFolders, SessionSpawnContext, SessionSpawnContextResolver,
};

/// The statements the driver's read pool caches.
const POOL_STATEMENT_CAPACITY: usize = 16;

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
        provider_account_id: Option<ProviderAccountId>,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn std::error::Error + Send + Sync>>> {
        let working_directory = self.work.clone();
        let account_folders = provider_account_id.and(self.account_folders.clone());
        async move {
            Ok(SessionSpawnContext {
                working_directory,
                git_common_folder: None,
                every_project_rows: Vec::new(),
                project_rows: Vec::new(),
                account_folders,
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

    fn read_credential_generation(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn std::error::Error + Send + Sync>>> {
        async { Err("the scripted sessions read no account's credential generation".into()) }
            .boxed()
    }
}

/// Each relaunch the driver reported, with whether it resumed.
#[derive(Default)]
pub(crate) struct RecordedRelaunches {
    taken: Mutex<Vec<(SessionId, bool)>>,
    reported: Notify,
}

impl RecordedRelaunches {
    /// Each relaunch reported so far.
    pub(crate) fn taken(&self) -> Vec<(SessionId, bool)> {
        lock(&self.taken).clone()
    }

    /// The relaunches once `count` are reported, each after the process it started, which a start
    /// reader sees first.
    pub(crate) async fn reported(&self, count: usize) -> Vec<(SessionId, bool)> {
        loop {
            let next = self.reported.notified();
            let taken = self.taken();
            if taken.len() >= count {
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

/// The Claude driver over the daemon's shared services, every process scripted, its session pieces
/// composed over a recording run engine, in a home and a working folder of its own. Built inside a
/// Tokio runtime, since the spawner thread starts on it.
pub(crate) struct ScriptedDriver {
    /// The driver.
    pub(crate) driver: Arc<ClaudeDriver>,
    /// Every process start it makes.
    pub(crate) starts: Arc<ScriptedStarts>,
    /// The run engine.
    pub(crate) engine: Arc<RecordingRunEngine>,
    /// The approval ports and the queue's intake of taken messages.
    pub(crate) ports: Arc<RecordingPorts>,
    /// The usage record.
    pub(crate) usage: Arc<RecordingUsage>,
    /// The staged files.
    pub(crate) attachments: Arc<ScriptedAttachments>,
    /// The relaunches it reported.
    pub(crate) relaunches: Arc<RecordedRelaunches>,
    /// The shared services it was built over.
    pub(crate) services: DriverServices,
    /// The person's home.
    pub(crate) home: PathBuf,
    /// The folder every session runs in.
    pub(crate) work: PathBuf,
    /// The folder holding the home, the working folder and the data folder.
    pub(crate) folder: TempDir,
    /// The daemon's database.
    pub(crate) database: TestDatabase,
}

impl ScriptedDriver {
    /// The driver whose accounts run on the person's own home.
    pub(crate) fn new() -> Self {
        Self::with_account_folders(None)
    }

    /// The driver whose accounts run on `account_folders`, else on the person's own home.
    pub(crate) fn with_account_folders(account_folders: Option<ProviderAccountFolders>) -> Self {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let database = TestDatabase::new(schema_parts());
        drop((database.opener())().expect("the test database opens with the daemon's schema"));
        let home = folder.path().join("home");
        let work = folder.path().join("work");
        std::fs::create_dir_all(&work).expect("the working folder is made");
        let attachments = Arc::new(ScriptedAttachments::default());
        let base = DriverServices {
            attachments: attachments.clone(),
            staged_changes: scripted_staged_changes(),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                POOL_STATEMENT_CAPACITY,
            )),
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
        ports
            .spawn_contexts
            .register(Arc::new(FolderContexts {
                work: work.clone(),
                account_folders,
            }))
            .expect("the spawn contexts register once");
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
            attachments,
            relaunches,
            services: base,
            home,
            work,
            folder,
            database,
        }
    }

    /// Waits until `is_reached` answers true.
    pub(crate) async fn wait_for(is_reached: impl Fn() -> bool) {
        while !is_reached() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Opens a session on `channel` through the driver's create.
    pub(crate) async fn create(&self, channel: &Arc<ScriptedChannel>) -> SessionId {
        let session_id = new_session_id();
        self.starts.script_session(Arc::clone(channel));
        self.driver
            .create_session(create_params(session_id))
            .await
            .expect("the session opens");
        session_id
    }

    /// The next session start.
    pub(crate) async fn next_start(&self) -> ScriptedStartRecord {
        self.starts.wait_for_starts(1).await;
        self.starts
            .take_started()
            .pop()
            .expect("a start was recorded")
    }

    /// Ends the process `start` brought up, as its reader would on an exit nothing asked for.
    pub(crate) fn exit(start: &ScriptedStartRecord) {
        start
            .listener
            .take_exit(Err(Arc::new(io::Error::other("the process ended"))));
    }

    /// Hands the lead `result` that ends the session's turn to the process `start` brought up.
    pub(crate) fn end_turn(&self, start: &ScriptedStartRecord, session_id: SessionId) {
        end_turn_of(&self.driver, start, session_id);
    }
}

/// Hands the lead `result` that ends the session's turn to the process `start` brought up for
/// `driver`.
pub(crate) fn end_turn_of(
    driver: &ClaudeDriver,
    start: &ScriptedStartRecord,
    session_id: SessionId,
) {
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

/// A create of `session_id` at Ask on `opus`, with nothing else asked for.
pub(crate) fn create_params(session_id: SessionId) -> CreateSessionParams {
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
