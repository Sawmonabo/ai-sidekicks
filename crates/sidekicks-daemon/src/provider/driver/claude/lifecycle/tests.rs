use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
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
use sidekicks_contracts::session::controls::methods::{
    PermissionLevel, SessionMode, SessionReviewTarget,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::wire::text::FreeFormText;
use tempfile::TempDir;
use tokio::sync::Notify;

use super::ClaudeDriver;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::policy::execution_posture_service::{
    ExecutionPostureService, compose_execution_posture,
};
use crate::provider::driver::claude::delivery::run_engine::ClaudeRunEngine;
use crate::provider::driver::claude::session::scripted::channel::{ScriptedChannel, ScriptedWrite};
use crate::provider::driver::claude::session::scripted::daemon_services::{
    NoRepositories, RecordingPorts, ScriptedBindings, test_callback_tool_host,
};
use crate::provider::driver::claude::session::scripted::run_engine::{
    EngineCall, RecordingRunEngine,
};
use crate::provider::driver::claude::session::scripted::starts::{
    ScriptedStartRecord, ScriptedStarts,
};
use crate::provider::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, binding_id, hand_scripted_frame, mint_run_id, mint_session_id,
    settle,
};
use crate::provider::driver::claude::session::transport::declarations::ClaudeHandshakeDeclaration;
use crate::provider::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::provider::driver::contract::{
    DriverResumeResult, ProviderDriver, RunOpening, StartRunParams,
};
use crate::provider::driver::ports::SessionRelaunchListener;
use crate::provider::driver::run_control::InterruptRunRequest;
use crate::provider::driver::session_control::{
    CloseSessionParams, CreateSessionParams, ProviderBuildChange, ResumeSessionParams,
    StartReviewParams, StartingLevelParams,
};
use crate::provider::driver::test_registry::test_driver_services;
use crate::provider::driver::{
    DriverServices, ProviderAccountFolders, SessionSpawnContext, SessionSpawnContextResolver,
};
use crate::session::run::state_change::RunStateEntry;

/// The statements the fixture's read pool caches.
const POOL_STATEMENT_CAPACITY: usize = 16;

/// The longest a test waits for a start the driver should make. The tests run on the real clock:
/// a start checks the credential paths on the spawner thread under a deadline, which a paused
/// clock would pass at once.
const START_WAIT: Duration = Duration::from_secs(20);

/// Longer than every restart's wait, so a restart that would come has come.
const RESTART_WAITS_PASSED: Duration = Duration::from_secs(5);

// Every session runs in one folder, and every account on the person's own home.
struct FolderContexts(PathBuf);

impl SessionSpawnContextResolver for FolderContexts {
    fn resolve_spawn_context(
        &self,
        _session_id: SessionId,
        _provider_account_id: Option<ProviderAccountId>,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn std::error::Error + Send + Sync>>> {
        let working_directory = self.0.clone();
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
        async { Ok(None) }.boxed()
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
        self.taken
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    // The relaunches once the first is reported, which comes after the process it started.
    async fn first_reported(&self) -> Vec<(SessionId, bool)> {
        let reported = async {
            loop {
                let next = self.reported.notified();
                let taken = self.taken();
                if !taken.is_empty() {
                    return taken;
                }
                next.await;
            }
        };
        tokio::time::timeout(START_WAIT, reported)
            .await
            .expect("the driver reports the relaunch")
    }
}

impl SessionRelaunchListener for RecordedRelaunches {
    fn session_relaunched(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> BoxFuture<'_, Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
        self.taken
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((session_id, is_resumed));
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
    relaunches: Arc<RecordedRelaunches>,
    home: PathBuf,
    work: PathBuf,
    _folder: TempDir,
    _database: TestDatabase,
}

impl DriverFixture {
    fn new() -> Self {
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
            spawn_contexts: Arc::new(FolderContexts(work.clone())),
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
        let relaunches = Arc::new(RecordedRelaunches::default());
        ports
            .callback_tool_host
            .register(test_callback_tool_host())
            .expect("the host registers once");
        ports
            .daemon_turn_bindings
            .register(Arc::new(ScriptedBindings))
            .expect("the turn bindings register once");
        ports
            .repositories
            .register(Arc::new(NoRepositories))
            .expect("the repositories register once");
        ports
            .reviewer_denials
            .register(recording)
            .expect("the denials register once");
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
            relaunches,
            home,
            work,
            _folder: folder,
            _database: database,
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
        tokio::time::timeout(START_WAIT, self.starts.wait_for_starts(1))
            .await
            .expect("the driver starts a process");
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
        let routes = &self
            .driver
            .composed_parts()
            .expect("composed")
            .run_start
            .routes;
        for frame in [
            json!({"type": "system", "subtype": "init", "session_id": SCRIPTED_PROVIDER_SESSION_ID}),
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

// Killed by a failed bring-up leaving its claim behind, which refuses the next create, and by a
// close that finds a bring-up in flight returning before it settles, which leaves its process
// running with no session to close it.
#[tokio::test]
async fn a_failed_bring_up_frees_its_claim_and_a_close_waits_for_one_in_flight() {
    let fixture = DriverFixture::new();
    let session_id = mint_session_id();
    fixture.starts.script_failed_session("the spawn failed");
    assert!(
        fixture
            .driver
            .create_session(create_params(session_id))
            .await
            .is_err()
    );
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    let release = fixture.starts.hold_next_session_start();
    let driver = Arc::clone(&fixture.driver);
    let create =
        tokio::spawn(async move { driver.create_session(create_params(session_id)).await });
    tokio::time::timeout(START_WAIT, fixture.starts.wait_for_starts(1))
        .await
        .expect("the second create starts a process");
    let driver = Arc::clone(&fixture.driver);
    let close = tokio::spawn(async move {
        driver
            .close_session(CloseSessionParams { session_id })
            .await
    });
    settle().await;
    assert!(!channel.writes().contains(&ScriptedWrite::Terminate));

    drop(release);
    create
        .await
        .expect("the create runs")
        .expect("the create succeeds");
    close
        .await
        .expect("the close runs")
        .expect("the close succeeds");

    assert!(channel.writes().contains(&ScriptedWrite::Terminate));
    assert!(fixture.driver.starts_process(session_id));
}

// Killed by restarting past a full crash window: the fifth exit inside it reports the loop and
// starts nothing.
#[tokio::test]
async fn a_full_crash_window_reports_the_loop_and_restarts_nothing() {
    let fixture = DriverFixture::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let mut current = fixture.next_start().await;
    for _ in 0..4 {
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        DriverFixture::exit(&current);
        current = fixture.next_start().await;
    }
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    DriverFixture::exit(&current);
    tokio::time::sleep(RESTART_WAITS_PASSED).await;

    assert!(fixture.starts.take_started().is_empty());
    assert_eq!(fixture.relaunches.taken(), vec![(session_id, true); 4]);
    let notices = fixture
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "sessionNotice")
        .count();
    assert_eq!(notices, 1);
}

// Killed by a waited restart that resumes a session a create or resume took meanwhile: it would
// fight for the slot and report a failed relaunch over the session the person brought back.
#[tokio::test]
async fn a_restart_whose_slot_was_taken_during_its_wait_does_nothing() {
    let fixture = DriverFixture::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let first = fixture.next_start().await;
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    DriverFixture::exit(&first);
    // The first restart waits nothing; the second waits a second.
    let second = fixture.next_start().await;
    DriverFixture::exit(&second);
    settle().await;
    let taken_by_resume = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&taken_by_resume));
    let resumed = fixture
        .driver
        .resume_session(resume_params(session_id))
        .await
        .expect("the resume answers");
    assert!(matches!(resumed, DriverResumeResult::Resumed { .. }));
    assert_eq!(fixture.starts.take_started().len(), 1);

    tokio::time::sleep(RESTART_WAITS_PASSED).await;

    assert!(fixture.starts.take_started().is_empty());
    assert_eq!(fixture.relaunches.taken(), vec![(session_id, true)]);
    assert!(!fixture.driver.starts_process(session_id));
}

// Killed by moving a busy session to the new build at once, which would end its running reply,
// and by never moving it once the reply ends.
#[tokio::test]
async fn a_build_move_on_a_busy_session_waits_for_its_turn_to_settle() {
    let fixture = DriverFixture::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let first = fixture.next_start().await;
    fixture
        .driver
        .start_run(start_params(session_id, mint_run_id()))
        .await
        .expect("the run starts");
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    fixture
        .driver
        .move_to_provider_build(ProviderBuildChange {
            from_version: "2.1.0".to_owned(),
            to_version: "2.2.0".to_owned(),
        })
        .await
        .expect("the move is taken");
    settle().await;
    assert!(fixture.starts.take_started().is_empty());

    fixture.end_turn(&first, session_id);
    let moved = fixture.next_start().await;

    assert!(matches!(
        moved.conversation,
        ClaudeConversationStart::Resume { .. }
    ));
    assert_eq!(
        fixture.relaunches.first_reported().await,
        vec![(session_id, true)]
    );
}

// Killed by a stop that does not reach the review's run apart from the session's process: the
// review would go on to open its worktree and fail instead of ending interrupted.
#[tokio::test]
async fn a_stop_ends_the_staged_review_apart_from_the_session_process() {
    let fixture = DriverFixture::new();
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let live = parts
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    parts.run_start.handshakes.observe_handshake_declaration(
        session_id,
        &live.provider_session_id,
        ClaudeHandshakeDeclaration {
            skills: vec!["code-review".to_owned()],
            ..ClaudeHandshakeDeclaration::default()
        },
    );

    fixture
        .driver
        .start_review(StartReviewParams {
            session_id,
            target: SessionReviewTarget::Staged,
        })
        .await
        .expect("the review starts");
    let run_id = fixture
        .engine
        .calls()
        .into_iter()
        .find_map(|call| match call {
            EngineCall::StartDaemonTurn(run_id) => Some(run_id),
            EngineCall::Deliver(_)
            | EngineCall::StartTurn(_)
            | EngineCall::CountStep(_)
            | EngineCall::RecordTurnEnd(..)
            | EngineCall::EndTurnOnProcessExit(_) => None,
        })
        .expect("the review's run was started");
    fixture
        .driver
        .interrupt_run(InterruptRunRequest {
            run_id,
            reason: None,
        })
        .await
        .expect("the stop reaches the review");
    settle().await;

    assert_eq!(fixture.starts.take_one_turn_count(), 0);
    let ends: Vec<_> = fixture
        .engine
        .run_moves()
        .into_iter()
        .filter_map(|delivery| delivery.change)
        .filter(|change| change.run_id == run_id)
        .map(|change| change.entry)
        .collect();
    assert!(matches!(
        ends.as_slice(),
        [RunStateEntry::Interrupted { .. }]
    ));
}

// Killed by offering Reviewed whatever the model's catalog says, or on a catalog that could not be
// read: a person's `auto` starts at Reviewed only on a model Claude Code runs auto mode on.
#[tokio::test]
async fn a_new_session_starts_at_reviewed_only_on_a_model_that_runs_auto_mode() {
    let fixture = DriverFixture::new();
    let settings = fixture.home.join(".claude");
    std::fs::create_dir_all(&settings).expect("the settings folder is made");
    std::fs::write(
        settings.join("settings.json"),
        json!({"permissions": {"defaultMode": "auto"}}).to_string(),
    )
    .expect("the person's settings are written");
    let read = |model: &str| {
        fixture.driver.read_starting_level(StartingLevelParams {
            working_folder: fixture.work.clone(),
            model: ProviderToken::new(model.to_owned()).expect("the model fits"),
            provider_account_id: None,
        })
    };
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "supportsAutoMode": true},
        {"value": "haiku", "displayName": "Haiku", "supportsAutoMode": false},
    ]}));
    let on_auto_model = read("opus").await.expect("the level reads");
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "supportsAutoMode": true},
    ]}));
    let on_other_model = read("haiku").await.expect("the level reads");
    let unread_catalog = read("opus").await.expect("the level reads");

    assert_eq!(on_auto_model.level, PermissionLevel::Reviewed);
    assert_eq!(on_auto_model.session_mode, SessionMode::Build);
    assert_eq!(on_other_model.level, PermissionLevel::Ask);
    assert_eq!(unread_catalog.level, PermissionLevel::Ask);
}

// Killed by any break on the path the daemon calls: the trait's create and run start reach the
// scripted process, and its `result` ends the run completed.
#[tokio::test]
async fn a_run_started_through_the_driver_trait_ends_on_the_process_result() {
    let fixture = DriverFixture::new();
    let driver: Arc<dyn ProviderDriver> = fixture.driver.clone();
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    let session_id = mint_session_id();
    driver
        .create_session(create_params(session_id))
        .await
        .expect("the session opens");
    let start = fixture.next_start().await;
    let run_id = mint_run_id();

    driver
        .start_run(start_params(session_id, run_id))
        .await
        .expect("the run starts");
    fixture.end_turn(&start, session_id);
    settle().await;

    assert_eq!(channel.user_frames().len(), 1);
    let ends: Vec<_> = fixture
        .engine
        .run_moves()
        .into_iter()
        .filter_map(|delivery| delivery.change)
        .filter(|change| change.run_id == run_id)
        .map(|change| change.entry)
        .collect();
    assert!(matches!(ends.as_slice(), [RunStateEntry::Completed { .. }]));
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
