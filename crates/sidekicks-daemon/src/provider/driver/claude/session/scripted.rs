//! Test support for the Claude driver: a scripted Claude Code process that records everything the
//! driver writes to it and answers each control request as scripted, a run engine that records
//! each call, approval ports that record what reaches them, and one live session wired through the
//! driver's own routing, queue, session task, stream, requests and interventions.

pub(crate) mod channel;
pub(crate) mod daemon_services;
pub(crate) mod run_engine;
pub(crate) mod starts;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::Duration;

use futures::FutureExt;
use serde_json::Value;
use sidekicks_contracts::provider::driver::capabilities::{CredentialPolicyRef, ExecutionPosture};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{PathRules, Spawner};
use tokio::runtime::Handle;

use self::channel::ScriptedChannel;
use self::daemon_services::{
    NoRepositories, RecordingPorts, ScriptedAttachments, ScriptedBindings,
    test_callback_tool_binding,
};
use self::run_engine::RecordingRunEngine;
use self::starts::ScriptedStarts;
use crate::git::process::{GitLimits, GitRunner};
use crate::git::worktree::staged_changes::StagedChangesWorktrees;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::delivery::dialogs::ClaudeProviderDialogs;
use crate::provider::driver::claude::delivery::requests::answers::ClaudeAnswerRules;
use crate::provider::driver::claude::delivery::requests::{
    ClaudeInboundRequests, ClaudeInboundRequestsDependencies,
};
use crate::provider::driver::claude::delivery::reviewer::ClaudeReviewerCapture;
use crate::provider::driver::claude::delivery::run_engine::ClaudeRunEngine;
use crate::provider::driver::claude::delivery::stream::daemon_ends::ClaudeStreamDialogPorts;
use crate::provider::driver::claude::delivery::stream::{
    ClaudeDeliveryStream, ClaudeSessionStream, ClaudeSessionStreams, ClaudeStreamDependencies,
};
use crate::provider::driver::claude::frame_routing::ClaudeFrameRouting;
use crate::provider::driver::claude::goals::ClaudeGoalCommands;
use crate::provider::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::provider::driver::claude::hooks::helper_limit::ClaudeHelperLimit;
use crate::provider::driver::claude::hooks::helper_steers::ClaudeHelperSteers;
use crate::provider::driver::claude::hooks::pause::ClaudeRunPauses;
use crate::provider::driver::claude::intervention::{ClaudeForegroundHelpers, ClaudeInterventions};
use crate::provider::driver::claude::run::controls::ClaudeRunControls;
use crate::provider::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::provider::driver::claude::run::rewind::ClaudeConversationCuts;
use crate::provider::driver::claude::run::routes::{ClaudeChildRunRoute, ClaudeRunRoutes};
use crate::provider::driver::claude::run::self_started_turns::ClaudeSelfStartedTurns;
use crate::provider::driver::claude::run::settlement::ClaudeTurnSettlement;
use crate::provider::driver::claude::run::start::ClaudeRunStart;
use crate::provider::driver::claude::session::answered_commands::{
    ClaudeAttachedAdvisor, unreadable_claude_command_choices,
};
use crate::provider::driver::claude::session::arrivals::task::{
    ClaudeSessionTask, ClaudeSessionTaskServices,
};
use crate::provider::driver::claude::session::arrivals::{
    ClaudeSessionListener, claude_session_arrivals, drain_claude_session_arrivals,
};
use crate::provider::driver::claude::session::controls::ClaudeSessionControls;
use crate::provider::driver::claude::session::frame_observation::ClaudeStreamFrameRead;
use crate::provider::driver::claude::session::process::{ClaudeProcessListener, ClaudeStreamFrame};
use crate::provider::driver::claude::session::restart::ClaudeSessionRestarts;
use crate::provider::driver::claude::session::state::{
    CLAUDE_THREAD_FRAME_ROUTER_CONFIG, ClaudeLiveSettings, ClaudeSessionRoutingBand,
    ClaudeSpawnBinding, ClaudeUsageEstablishment, LiveClaudeSession,
};
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::provider::driver::claude::session::transport::inbound::{
    ClaudeControlFrameReader, ClaudeInboundRequestEvent,
};
use crate::provider::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::provider::driver::ports::DriverPorts;
use crate::provider::port::permission_ask::PermissionAskPort;
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::repository_reader::RepositoryReader;
use crate::provider::port::reviewer_denial::ReviewerDenialPort;
use crate::provider::port::session_rules::SessionRulePort;
use crate::provider::process_registry::ProviderProcessRegistry;
use crate::provider::thread_frame_router::ThreadFrameRouter;
use crate::provider::usage_delta_accountant::UsageDeltaAccountant;
use crate::queue::delivery::ProviderProcessIdentity;

/// Staged-change worktrees under a scratch folder of their own, on a spawner of their own.
pub(crate) fn scripted_staged_changes() -> StagedChangesWorktrees {
    let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
    StagedChangesWorktrees::new(
        &std::env::temp_dir().join("sidekicks-scripted-worktrees"),
        GitRunner::new(spawner, None, Arc::from([]), GitLimits::DAEMON),
    )
}

/// The provider session every scripted process runs under.
pub(crate) const SCRIPTED_PROVIDER_SESSION_ID: &str = "provider-session";

/// A fresh run id.
pub(crate) fn mint_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

/// A fresh session id.
pub(crate) fn mint_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

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
            spawn_environment: Vec::new(),
            advisor_model: None,
            output_style: None,
        },
        initialize: ClaudeInitializeDeclaration::default(),
        command_choices: async move { choices }.boxed().shared(),
        establishment: ClaudeUsageEstablishment::Fresh,
        admitted_provider_account_id: None,
        settings: Mutex::new(ClaudeLiveSettings {
            execution_posture: Some(execution_posture),
            session_mode: SessionMode::Build,
            advisor_model: None,
            output_style: None,
            running_model: "opus".to_owned(),
            attached_advisor: ClaudeAttachedAdvisor::Unreported,
            applied_output_speed: None,
            ultracode_requested: None,
            ultracode: None,
        }),
        process_identity: ProviderProcessIdentity {
            process_id: 1,
            spawn_sequence: 0,
        },
        callback_tool_binding: test_callback_tool_binding(session_id),
        process_exit: OnceLock::new(),
    }
}

/// One live session on a scripted process, wired through the driver's own pieces: frames and
/// requests go through the process listener, the session's queue and its task, as the reader
/// hands them over. Built inside a Tokio runtime, since the session's task is spawned.
pub(crate) struct ScriptedSession {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Its process.
    pub(crate) channel: Arc<ScriptedChannel>,
    /// The run engine.
    pub(crate) engine: Arc<RecordingRunEngine>,
    /// The approval ports.
    pub(crate) ports: Arc<RecordingPorts>,
    /// The staged files.
    pub(crate) attachments: Arc<ScriptedAttachments>,
    /// The live session.
    pub(crate) live: Arc<LiveClaudeSession>,
    /// Its stream.
    pub(crate) stream: Arc<ClaudeSessionStream>,
    /// The run start.
    pub(crate) start: ClaudeRunStart,
    /// The requests.
    pub(crate) requests: Arc<ClaudeInboundRequests>,
    /// The interventions.
    pub(crate) interventions: Arc<ClaudeInterventions>,
    /// The run controls.
    pub(crate) controls: ClaudeRunControls,
    /// The helpers running in the foreground.
    pub(crate) foreground_helpers: Arc<Mutex<ClaudeForegroundHelpers>>,
    /// The words waiting for each helper.
    pub(crate) helper_steers: Arc<Mutex<ClaudeHelperSteers>>,
    /// Each message reported taken, with the run it was reported under.
    pub(crate) taken: Arc<Mutex<Vec<(String, RunId)>>>,
    listener: ClaudeSessionListener,
    control_frames: Mutex<ClaudeControlFrameReader>,
}

impl ScriptedSession {
    /// A live session whose process answers as scripted, with every approval port registered.
    pub(crate) fn new() -> Self {
        let session_id = mint_session_id();
        let channel = Arc::new(ScriptedChannel::default());
        let engine = Arc::new(RecordingRunEngine::default());
        let ports = Arc::new(RecordingPorts::default());
        let attachments = Arc::new(ScriptedAttachments::default());
        let engine_port: Arc<dyn ClaudeRunEngine> = engine.clone();
        let routes = Arc::new(ClaudeRunRoutes::default());
        let streams = Arc::new(ClaudeSessionStreams::default());
        let handshakes = Arc::new(ClaudeHandshakeRegister::default());
        let prompts = Arc::new(Mutex::new(ClaudeSentPrompts::default()));
        let pauses = Arc::new(Mutex::new(ClaudeRunPauses::default()));
        let helpers = Arc::new(Mutex::new(ClaudeHelperLimit::default()));
        let helper_steers = Arc::new(Mutex::new(ClaudeHelperSteers::default()));
        let foreground_helpers = Arc::new(Mutex::new(ClaudeForegroundHelpers::default()));
        let pending_compactions = PendingCompactionRegistry::default();
        let dialogs = Arc::new(ClaudeProviderDialogs::new(ClaudeStreamDialogPorts::new(
            Arc::clone(&engine_port),
            Arc::clone(&routes),
            Arc::clone(&streams),
        )));
        let denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>> =
            Arc::new(PortRegistration::new("reviewer denials"));
        denials
            .register(ports.clone())
            .expect("the denials port registers once");
        let reviewer = Arc::new(ClaudeReviewerCapture::new(denials));
        let permission_asks: Arc<PortRegistration<Arc<dyn PermissionAskPort>>> =
            Arc::new(PortRegistration::new("permission asks"));
        permission_asks
            .register(ports.clone())
            .expect("the asks port registers once");
        let requests = Arc::new(ClaudeInboundRequests::new(
            ClaudeInboundRequestsDependencies {
                engine: Arc::clone(&engine_port),
                routes: Arc::clone(&routes),
                permission_asks,
                questions: Arc::new(PortRegistration::new("questions")),
                plans: Arc::new(PortRegistration::new("plans")),
                dialogs: Arc::clone(&dialogs),
                reviewer: Arc::clone(&reviewer),
                answer_rules: ClaudeAnswerRules {
                    session_rules: Arc::new(PortRegistration::<Arc<dyn SessionRulePort>>::new(
                        "session rules",
                    )),
                    repositories: {
                        let repositories: Arc<PortRegistration<Arc<dyn RepositoryReader>>> =
                            Arc::new(PortRegistration::new("repositories"));
                        repositories
                            .register(Arc::new(NoRepositories))
                            .expect("the repositories port registers once");
                        repositories
                    },
                    home_folder: PathBuf::from("/home"),
                    path_rules: PathRules::NATIVE,
                },
            },
        ));
        let taken = Arc::new(Mutex::new(Vec::new()));
        let taken_report = Arc::clone(&taken);
        let delivery = Arc::new(ClaudeDeliveryStream::new(ClaudeStreamDependencies {
            engine: Arc::clone(&engine_port),
            routes: Arc::clone(&routes),
            prompts: Arc::clone(&prompts),
            dialogs: Arc::clone(&dialogs),
            pauses: Arc::clone(&pauses),
            reviewer: Arc::clone(&reviewer),
            message_taken: Arc::new(move |_session_id, uuid: &str, run_id| {
                lock(&taken_report).push((uuid.to_owned(), run_id));
            }),
        }));
        let restarts = ClaudeSessionRestarts::new(
            Arc::clone(&routes),
            Arc::clone(&engine_port),
            Weak::new(),
            Arc::new(DriverPorts::new()),
        );
        let start = ClaudeRunStart {
            slots: restarts.slots().clone(),
            routes: Arc::clone(&routes),
            streams: Arc::clone(&streams),
            handshakes: Arc::clone(&handshakes),
            prompts: Arc::clone(&prompts),
            engine: Arc::clone(&engine_port),
            attachments: attachments.clone(),
            bindings: Arc::new(ScriptedBindings),
        };
        let interventions = Arc::new(ClaudeInterventions::new(
            start.clone(),
            Arc::clone(&dialogs),
            Arc::clone(&requests),
            Arc::clone(&helper_steers),
            Arc::clone(&foreground_helpers),
        ));
        let session_controls = Arc::new(ClaudeSessionControls::new(
            start.clone(),
            Arc::new(ScriptedStarts::default()),
            scripted_staged_changes(),
            Arc::new(PortRegistration::new("session rules")),
            Arc::new(PortRegistration::new("in-process tool servers")),
            Box::new(|_session_id| None),
        ));
        let channel_port: Arc<dyn ClaudeProcessChannel> = channel.clone();
        let live = Arc::new(scripted_live_session(session_id, channel_port));
        let installed = start
            .slots
            .claim_bring_up(session_id)
            .expect("a new session's slot is free")
            .install(Arc::clone(&live));
        assert!(installed.is_ok(), "a fresh claim installs");
        let (arrivals, receiver) = claude_session_arrivals(session_id);
        let stream = Arc::new(ClaudeSessionStream::new(
            None,
            None,
            arrivals.clone(),
            Arc::clone(&routes),
            Arc::clone(&prompts),
        ));
        streams.insert(Arc::clone(&stream));
        let routing = Arc::new(ClaudeFrameRouting::new(
            Arc::clone(&handshakes),
            pending_compactions.clone(),
            Arc::new(PortRegistration::new("usage")),
        ));
        let mut band = ClaudeSessionRoutingBand {
            router: ThreadFrameRouter::new(
                DESCRIPTOR.provider_id(),
                CLAUDE_THREAD_FRAME_ROUTER_CONFIG,
            ),
            accountant: UsageDeltaAccountant::new(DESCRIPTOR.provider_id()),
        };
        routing.bind_session_thread(
            &mut band,
            session_id,
            SCRIPTED_PROVIDER_SESSION_ID,
            &ClaudeUsageEstablishment::Fresh,
        );
        let listener = ClaudeSessionListener::new(
            SCRIPTED_PROVIDER_SESSION_ID.to_owned(),
            Arc::new(Mutex::new(band)),
            routing,
            Arc::clone(&stream),
            arrivals,
        );
        let controls = ClaudeRunControls {
            start: start.clone(),
            dialogs: Arc::clone(&dialogs),
            requests: Arc::clone(&requests),
            pauses: Arc::clone(&pauses),
            helper_steers: Arc::clone(&helper_steers),
            interventions: Arc::clone(&interventions),
        };
        let services = Arc::new(ClaudeSessionTaskServices {
            delivery,
            streams: Arc::clone(&streams),
            requests: Arc::clone(&requests),
            dialogs: Arc::clone(&dialogs),
            reviewer,
            prompts: Arc::clone(&prompts),
            pauses: Arc::clone(&pauses),
            helpers: Arc::clone(&helpers),
            helper_steers: Arc::clone(&helper_steers),
            foreground_helpers: Arc::clone(&foreground_helpers),
            interventions: Arc::clone(&interventions),
            goals: Arc::new(ClaudeGoalCommands::default()),
            self_started: ClaudeSelfStartedTurns {
                start: start.clone(),
                pauses,
            },
            settlement: ClaudeTurnSettlement {
                handshakes,
                engine: engine_port,
                routes: Arc::clone(&routes),
                helpers,
                pending_compactions,
            },
            cuts: Arc::new(ClaudeConversationCuts {
                routes,
                prompts,
                dialogs,
                streams,
            }),
            shell_lines: Arc::new(ShellLineReadingBound::new(1 << 20)),
            tool_servers: Arc::new(PortRegistration::new("tool servers")),
            processes: Arc::new(ProviderProcessRegistry::default()),
            restarts,
            controls: session_controls,
        });
        let mut task = ClaudeSessionTask::new(services, Arc::clone(&live), Arc::clone(&stream));
        tokio::spawn(async move {
            drain_claude_session_arrivals(receiver, &mut task, None).await;
        });
        Self {
            session_id,
            channel,
            engine,
            ports,
            attachments,
            live,
            stream,
            start,
            requests,
            interventions,
            controls,
            foreground_helpers,
            helper_steers,
            taken,
            listener,
            control_frames: Mutex::new(ClaudeControlFrameReader::new(
                None,
                SCRIPTED_PROVIDER_SESSION_ID.to_owned(),
            )),
        }
    }

    /// Hands the reader's next stream frame over, as the process wrote it.
    pub(crate) fn frame(&self, frame: &Value) {
        hand_scripted_frame(&self.listener, &self.start.routes, self.session_id, frame);
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
        let run_id = mint_run_id();
        self.start
            .routes
            .hold_turn(run_id, self.session_id, binding_id(binding))
            .expect("the session's turn is free");
        run_id
    }

    /// Binds a fresh child run for the helper `agent_id`, started beneath `parent_run_id`.
    pub(crate) fn bind_helper(&self, parent_run_id: RunId, agent_id: &str) -> RunId {
        let run_id = mint_run_id();
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

    /// The messages reported taken so far, with the run each was reported under.
    pub(crate) fn taken(&self) -> Vec<(String, RunId)> {
        lock(&self.taken).clone()
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
    if frame.observation.frame_kind.split('/').next() == Some("result")
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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
