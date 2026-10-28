//! Test support for the Claude driver: a scripted Claude Code process that records everything the
//! driver writes to it and answers each control request as scripted, approval ports that record
//! what reaches them, and one live session on the driver's own composition, reached through its
//! routing, queue, session task, stream, requests and interventions.

pub(crate) mod channel;
pub(crate) mod daemon_services;
pub(crate) mod driver;
pub(crate) mod starts;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::FutureExt;
use serde_json::Value;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::provider::driver::capabilities::{CredentialPolicyRef, ExecutionPosture};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::Spawner;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_workspace::git::process::{GitLimits, GitRunner};
use sidekicks_workspace::git::worktree::staged_changes::StagedChangesWorktrees;
use tempfile::TempDir;
use tokio::runtime::Handle;
use tokio::sync::SetOnce;

use self::channel::ScriptedChannel;
use self::daemon_services::{
    RecordingPorts, RecordingUsage, ScriptedAttachments, test_callback_tool_binding,
};
use self::driver::{ScriptedDriver, create_params};
use self::starts::SCRIPTED_BUILD_VERSION;
use crate::background_work::BackgroundWorkForms;
use crate::driver::PROVIDERS;
use crate::driver::claude::delivery::requests::ClaudeInboundRequests;
use crate::driver::claude::delivery::stream::ClaudeSessionStream;
use crate::driver::claude::event_normalizer::is_claude_result_frame_kind;
use crate::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::driver::claude::intervention::{ClaudeForegroundHelpers, ClaudeInterventions};
use crate::driver::claude::lifecycle::ClaudeSessionParts;
use crate::driver::claude::run::routes::{ClaudeChildRunRoute, ClaudeRunRoutes};
use crate::driver::claude::run::start::ClaudeRunStart;
use crate::driver::claude::session::answered_commands::{
    ClaudeAttachedAdvisor, unreadable_claude_command_choices,
};
use crate::driver::claude::session::frame_observation::ClaudeStreamFrameRead;
use crate::driver::claude::session::process::{ClaudeProcessListener, ClaudeStreamFrame};
use crate::driver::claude::session::state::{
    ClaudeLiveSettings, ClaudeRequestedSpawn, ClaudeSpawnBinding, LiveClaudeSession,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::declarations::{
    ClaudeInitializeDeclaration, ClaudeOfferedModel,
};
use crate::driver::claude::session::transport::inbound::{
    ClaudeControlFrameReader, ClaudeInboundRequestEvent,
};
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::process_identity::ProviderProcessIdentity;
use crate::runtime_binding::test_store::{spawned_build, test_provider_account_id};

/// Staged-change worktrees under a scratch folder of their own, on a spawner of their own.
fn scripted_staged_changes() -> StagedChangesWorktrees {
    let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
    StagedChangesWorktrees::new(
        &std::env::temp_dir().join("sidekicks-scripted-worktrees"),
        GitRunner::new(spawner, None, Arc::from([]), GitLimits::DAEMON),
    )
}

/// The provider session every scripted process runs under.
pub(crate) const SCRIPTED_PROVIDER_SESSION_ID: &str = "provider-session";

/// A runtime binding id spelled from `name`.
pub(crate) fn binding_id(name: &str) -> RuntimeBindingId {
    RuntimeBindingId::new(name.to_owned()).expect("a test binding id fits")
}

/// A live session at Ask on the scripted process `channel`.
pub(crate) fn scripted_live_session(
    session_id: SessionId,
    channel: Arc<dyn ClaudeProcessChannel>,
) -> LiveClaudeSession {
    let execution_posture = ExecutionPosture::Ask {
        credential_policy_ref: CredentialPolicyRef::new("policy".to_owned())
            .expect("a test policy reference fits"),
        writable_roots: Vec::new(),
    };
    let choices = unreadable_claude_command_choices("unread");
    LiveClaudeSession {
        session_id,
        agent_id: AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        provider_session_id: SCRIPTED_PROVIDER_SESSION_ID.to_owned(),
        channel,
        spawn_binding: ClaudeSpawnBinding {
            execution_posture: Some(execution_posture.clone()),
            output_schema_digest: None,
        },
        spawn_bound_legs: ClaudeSpawnBoundLegs {
            session_id,
            model: "opus".to_owned(),
            execution_posture: Some(execution_posture.clone()),
            working_directory: PathBuf::from("/work"),
            callback_tools: None,
            subagent_policy: None,
            tool_servers: Vec::new(),
            output_schema: None,
            on_callback_tool_call: None,
            on_mcp_server_status: None,
            credential_deny_paths: Vec::new(),
            memory_folders: Vec::new(),
            background_work: Arc::new(BackgroundWorkForms::of_providers(PROVIDERS)),
            spawn_environment: Vec::new(),
            advisor: ClaudeSessionAdvisor::Unpicked,
            output_style: None,
            command_channel: None,
        },
        initialize: ClaudeInitializeDeclaration::default(),
        command_choices: async move { choices }.boxed().shared(),
        admitted_provider_account_id: test_provider_account_id(),
        settings: Mutex::new(ClaudeLiveSettings {
            execution_posture: Some(execution_posture),
            session_mode: SessionMode::Build,
            advisor: ClaudeSessionAdvisor::Unpicked,
            output_style: None,
            running_model: "opus".to_owned(),
            attached_advisor: ClaudeAttachedAdvisor::Unreported,
            applied_output_speed: None,
            ultracode_requested: None,
            ultracode: None,
        }),
        spawned_version: spawned_build(SCRIPTED_BUILD_VERSION, "/scripted/claude"),
        resumed_binding_id: None,
        requested_spawn: ClaudeRequestedSpawn::default(),
        process_identity: ProviderProcessIdentity {
            process_id: 1,
            spawn_sequence: 0,
        },
        callback_tool_binding: test_callback_tool_binding(session_id),
        process_exit: OnceLock::new(),
        task_ended: SetOnce::new(),
        served_bindings: Mutex::default(),
        messaging_socket: OnceLock::new(),
    }
}

/// One live session on a scripted process, opened through the driver's own create over a
/// recording run engine: frames and requests go through the process listener, the session's queue
/// and its task, as the reader hands them over. Built inside a Tokio runtime, since the session's
/// task is spawned.
pub(crate) struct ScriptedSession {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Its process.
    pub(crate) channel: Arc<ScriptedChannel>,
    /// The run engine.
    pub(crate) engine: Arc<RecordingRunEngine>,
    /// The approval ports and the queue's intake of taken messages.
    pub(crate) ports: Arc<RecordingPorts>,
    /// The staged files.
    pub(crate) attachments: Arc<ScriptedAttachments>,
    /// The usage record.
    pub(crate) usage: Arc<RecordingUsage>,
    /// The live session.
    pub(crate) live: Arc<LiveClaudeSession>,
    /// Its stream.
    pub(crate) stream: Arc<ClaudeSessionStream>,
    /// The driver's session pieces.
    pub(crate) parts: Arc<ClaudeSessionParts>,
    /// The run start.
    pub(crate) start: ClaudeRunStart,
    /// The requests.
    pub(crate) requests: Arc<ClaudeInboundRequests>,
    /// The interventions.
    pub(crate) interventions: Arc<ClaudeInterventions>,
    /// The helpers running in the foreground.
    pub(crate) foreground_helpers: Arc<Mutex<ClaudeForegroundHelpers>>,
    /// The words waiting for each helper.
    pub(crate) helper_steers: Arc<Mutex<ClaudeHelperSteers>>,
    listener: Arc<dyn ClaudeProcessListener>,
    control_frames: Mutex<ClaudeControlFrameReader>,
    // The home, working folder and database the session's start read from.
    _folder: TempDir,
    _database: TestDatabase,
}

impl ScriptedSession {
    /// A live session on `opus` at Ask whose process answers as scripted, with every approval port
    /// registered.
    pub(crate) async fn new() -> Self {
        let ScriptedDriver {
            driver,
            starts,
            engine,
            ports,
            usage,
            attachments,
            folder,
            database,
            ..
        } = ScriptedDriver::new();
        // The process offers the session's model, so its start sets none.
        starts.script_initialize(ClaudeInitializeDeclaration {
            models: vec![ClaudeOfferedModel {
                value: "opus".to_owned(),
                resolved_model: None,
                display_name: None,
            }],
            ..ClaudeInitializeDeclaration::default()
        });
        let channel = Arc::new(ScriptedChannel::default());
        starts.script_session(Arc::clone(&channel));
        let session_id = new_session_id();
        driver
            .create_session(create_params(session_id))
            .await
            .expect("the session opens");
        let started = starts.take_started().pop().expect("a start was recorded");
        let parts = Arc::clone(driver.composed_parts().expect("the pieces are composed"));
        let establishment = &parts.establishment;
        let services = &establishment.task_services;
        let live = establishment
            .slots
            .live_session(session_id)
            .expect("the created session is live");
        let stream = establishment
            .streams
            .get(session_id)
            .expect("the created session has a stream");
        let control_frames = ClaudeControlFrameReader::new(None, live.provider_session_id.clone());
        Self {
            session_id,
            channel,
            engine,
            ports,
            attachments,
            usage,
            live,
            stream,
            start: parts.run_start.clone(),
            requests: Arc::clone(&services.requests),
            interventions: Arc::clone(&parts.interventions),
            foreground_helpers: Arc::clone(&services.foreground_helpers),
            helper_steers: Arc::clone(&services.helper_steers),
            parts,
            listener: started.listener,
            control_frames: Mutex::new(control_frames),
            _folder: folder,
            _database: database,
        }
    }

    /// Hands the reader's next stream frame over, as the process wrote it.
    pub(crate) fn frame(&self, frame: &Value) {
        hand_scripted_frame(&*self.listener, &self.start.routes, self.session_id, frame);
    }

    /// Hands over a `control_request` the process sent.
    pub(crate) fn request(&self, request_id: &str, request: &Value) {
        let event = self.read_request(request_id, request);
        self.listener.take_request(event);
    }

    /// Hands over Claude Code's withdrawal of `request_id`.
    pub(crate) fn cancel(&self, request_id: &str) {
        let event = self.read_cancel(request_id);
        self.listener.take_request(event);
    }

    /// A `control_request` the process sent, as the reader reads it.
    pub(crate) fn read_request(
        &self,
        request_id: &str,
        request: &Value,
    ) -> ClaudeInboundRequestEvent {
        let text = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": request,
        })
        .to_string();
        lock(&self.control_frames)
            .read_request(&text)
            .expect("a test request reads")
    }

    /// Claude Code's withdrawal of `request_id`, as the reader reads it.
    pub(crate) fn read_cancel(&self, request_id: &str) -> ClaudeInboundRequestEvent {
        let text = serde_json::json!({
            "type": "control_cancel_request",
            "request_id": request_id,
        })
        .to_string();
        lock(&self.control_frames)
            .read_cancel(&text)
            .expect("a test withdrawal reads")
    }

    /// Holds the session's turn for a fresh lead run on `binding`, as a run's start does.
    pub(crate) fn hold_lead_turn(&self, binding: &str) -> RunId {
        let run_id = new_run_id();
        self.start
            .routes
            .hold_turn(run_id, self.session_id, binding_id(binding))
            .expect("the session's turn is free");
        run_id
    }

    /// Binds a fresh child run for the helper `agent_id`, started beneath `parent_run_id`.
    pub(crate) fn bind_helper(&self, parent_run_id: RunId, agent_id: &str) -> RunId {
        let run_id = new_run_id();
        self.start.routes.bind_child_run(
            run_id,
            ClaudeChildRunRoute {
                session_id: self.session_id,
                agent_id: agent_id.to_owned(),
                parent_run_id,
                binding_id: binding_id("helper"),
            },
        );
        run_id
    }
}

/// Hands `listener` one stream frame as the reader would: the turn's hold on `session_id` is
/// released first when it is the lead `result` that ends the turn.
pub(crate) fn hand_scripted_frame(
    listener: &dyn ClaudeProcessListener,
    routes: &ClaudeRunRoutes,
    session_id: SessionId,
    frame: &Value,
) {
    let text = frame.to_string();
    let observation = ClaudeStreamFrameRead::read(&text)
        .expect("a test frame is an object")
        .into_observation();
    let frame = ClaudeStreamFrame { text, observation };
    if is_claude_result_frame_kind(&frame.observation.frame_kind)
        && frame.observation.subagent_id.is_none()
        && listener.is_turn_ending(&frame)
    {
        routes.settle_turn_holds(session_id);
    }
    listener.take_frame(frame);
}

/// Lets every task run until all wait: on a paused clock the runtime advances time only once
/// nothing can run, so a short sleep returns after the session's task drained its queue.
pub(crate) async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}
