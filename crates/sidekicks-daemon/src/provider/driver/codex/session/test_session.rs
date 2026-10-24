//! A Codex session the tests drive as its task would: a record on a scripted service with its
//! routing band and waits, a run engine and binding store on a real database, and each item of
//! the session's queue handed to the test, which handles it the way the session's task does.

use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use tempfile::TempDir;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_util::task::TaskTracker;

use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, insert_lead};
use crate::events::log_service::tests::open_log;
use crate::policy::execution_posture_service::{
    ExecutionPostureService, compose_execution_posture,
};
use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::attachments::{AttachmentResolver, ProviderAttachment};
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::commands::CodexProviderCommandCache;
use crate::provider::driver::codex::delivery::frames::{
    CodexFrameDelivery, CodexFrameDeliveryDependencies, CodexFrameEffects,
};
use crate::provider::driver::codex::delivery::rows::CodexRowRun;
use crate::provider::driver::codex::lifecycle::intake::{
    CodexLifecycleCall, CodexRoutedFramesIntake, apply_codex_routed_frames,
    observe_codex_session_frame,
};
use crate::provider::driver::codex::notification_routing::{
    CodexRoutedFrames, CodexSessionRouting,
};
use crate::provider::driver::codex::permission_level::{
    CodexProfileFolders, compose_codex_profile_name,
};
use crate::provider::driver::codex::run::control::{CodexRunControl, CodexRunControlDependencies};
use crate::provider::driver::codex::run::faster_model_retry::{
    CodexFasterModelRetries, CodexFasterModelRetryDependencies,
};
use crate::provider::driver::codex::run::routes::CodexRunRoutes;
use crate::provider::driver::codex::run::self_started_turns::{
    CodexSelfStartedTurnDependencies, open_codex_self_started_turn,
};
use crate::provider::driver::codex::run::start::record::{
    CodexBindingAdoptions, CodexRunCallDependencies, CodexSessionDisposal,
};
use crate::provider::driver::codex::run::start::{CodexRunStart, CodexRunStartDependencies};
use crate::provider::driver::codex::run::turn_end_waiters::CodexTurnEndWaiters;
use crate::provider::driver::codex::server_requests::{
    CodexAskKind, CodexInboundServerRequest, CodexServerRequestDecision,
};
use crate::provider::driver::codex::service::registry::CodexServiceRegistry;
use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::provider::driver::codex::session::calls::{
    CodexSessionCallDependencies, CodexSessionTask, run_codex_session_call,
};
use crate::provider::driver::codex::session::establishment::{
    CodexSessionEstablishment, CodexSessionEstablishmentDependencies,
};
use crate::provider::driver::codex::session::fork::CodexForkDependencies;
use crate::provider::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundHandler, CodexSessionInboundSender,
    codex_session_inbound, drain_codex_session_inbound,
};
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::codex::session::state::{
    CodexEstablishedConversation, CodexSessionRecord,
};
use crate::provider::driver::codex::thread::settings::CodexThreadSettings;
use crate::provider::driver::codex::transport::connection::CodexForgottenRequest;
use crate::provider::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::ports::DriverPorts;
use crate::provider::driver::run_control::{
    DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver, RunToolBoundary,
};
use crate::provider::driver::test_registry::RecordedQueue;
use crate::provider::driver::{
    PROVIDERS, ProviderAccountFolders, SessionSpawnContext, SessionSpawnContextResolver,
};
use crate::provider::port::registration::PortRegistration;
use crate::provider::process_registry::ProviderProcessRegistry;
use crate::provider::runtime_binding::rebinder::RuntimeBindingRebinder;
use crate::provider::runtime_binding::store::{RuntimeBindingSpawnConfig, RuntimeBindingStore};
use crate::provider::runtime_binding::test_store::{binding_input, open_store, spawned_build};
use crate::provider::spawn_environment::ReservedEnvironmentNames;
use crate::session::run::engine::tests::test_engine;
use crate::session::run::engine::{RUN_ENGINE_STATEMENT_CAPACITY, RunEngine};
use crate::session::run::epochs::{EpochBinding, ExecutionEpochs};
use crate::session::run::inbound::RunInboundDispatch;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// The conversation a test session starts on.
pub(crate) const TEST_THREAD: &str = "thread-1";

/// A session on a scripted service, the parts its task holds and the database under them.
pub(crate) struct TestCodexSession {
    /// The service and its script.
    pub(crate) scripted: ScriptedCodexService,
    /// What the session's task holds.
    pub(crate) task: TestCodexTask,
    /// The binding store on the database.
    pub(crate) bindings: Arc<RuntimeBindingStore>,
    /// The run engine's dispatch.
    pub(crate) dispatch: Arc<RunInboundDispatch>,
    /// The session's slot, holding its queue live.
    pub(crate) slots: Arc<CodexSessionSlots>,
    /// The run start on the session.
    pub(crate) run_start: Arc<CodexRunStart>,
    /// The binding each turn the daemon starts opens on.
    pub(crate) daemon_turn_bindings: Arc<TestDaemonTurnBindings>,
    /// The database.
    pub(crate) database: TestDatabase,
    /// Which provider process runs each session, as the test's establishments record it.
    pub(crate) processes: Arc<ProviderProcessRegistry>,
    /// What the session's intake told the run queue.
    pub(crate) queue: Arc<RecordedQueue>,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    _home: TempDir,
}

/// What the session's task holds: the record, its band and waits, its queue's items as they come,
/// and what its calls act through.
pub(crate) struct TestCodexTask {
    /// The record.
    pub(crate) record: CodexSessionRecord,
    /// Its routing band.
    pub(crate) routing: CodexSessionRouting,
    /// The waits on its turns.
    pub(crate) waiters: CodexTurnEndWaiters,
    /// What its calls act through.
    pub(crate) calls: CodexSessionCallDependencies,
    /// The run routes its deliveries read.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// What the open of a turn Codex started acts through.
    pub(crate) self_started: CodexSelfStartedTurnDependencies,
    /// The driver's ports the session's intake tells, the queue's intake among them.
    pub(crate) ports: Arc<DriverPorts>,
    /// The run engine an ended turn's end is recorded in.
    pub(crate) engine: Arc<RunEngine>,
    /// Run control on the session, which an ended turn's pause or continue is acted on through.
    pub(crate) run_control: Arc<CodexRunControl>,
    items: mpsc::UnboundedReceiver<CodexSessionInbound>,
}

impl TestCodexSession {
    /// A session on conversation [`TEST_THREAD`] at Ask, registered on its service, with no
    /// binding.
    pub(crate) async fn start() -> Self {
        let scripted = start_scripted_codex_service();
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let engine = test_engine(&database, Arc::clone(&log.service), home.path());
        let epochs = Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        )));
        let dispatch = Arc::new(RunInboundDispatch::new(
            Arc::clone(&engine),
            Arc::clone(&epochs),
            Arc::new(UnreadRunStates),
            log.service,
        ));
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            RUN_ENGINE_STATEMENT_CAPACITY,
        ));
        let bindings = Arc::new(open_store(&database).await);
        let run_routes = Arc::new(CodexRunRoutes::default());
        let pending_compactions = PendingCompactionRegistry::default();
        let delivery = Arc::new(CodexFrameDelivery::new(CodexFrameDeliveryDependencies {
            engine: Arc::clone(&engine),
            dispatch: Arc::clone(&dispatch),
            run_routes: Arc::clone(&run_routes),
            reviewer_denials: Arc::new(PortRegistration::new("reviewer denial")),
            command_output: Arc::new(PortRegistration::new("command output")),
            pending_compactions: pending_compactions.clone(),
            effects: Arc::new(NoEffects),
        }));
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let lead_agent_id = insert_lead(&database, session_id, DESCRIPTOR.id);
        let (inbound, receiver) = codex_session_inbound(session_id);
        let slots = Arc::new(CodexSessionSlots::new());
        slots
            .claim_establishing(session_id)
            .await
            .expect("the session's slot is free")
            .install(inbound.clone());
        let (record, routing) = open_test_record(
            &scripted,
            session_id,
            inbound,
            &delivery,
            pending_compactions.clone(),
        )
        .await;
        let (items_sender, items) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            drain_codex_session_inbound(
                receiver,
                &mut ItemsToTest {
                    items: items_sender,
                },
            )
            .await;
        });
        let config_forks = Arc::new(CodexConfigForks::new(
            Arc::clone(&slots),
            TaskTracker::new(),
        ));
        let calls = CodexSessionCallDependencies {
            forks: CodexForkDependencies {
                delivery,
                release: Arc::clone(&scripted.dependencies.release),
                bindings: Arc::clone(&bindings) as Arc<dyn RuntimeBindingRebinder>,
                tool_server_route: Arc::new(PortRegistration::new("tool server route")),
                pending_compactions,
            },
            runs: CodexRunCallDependencies {
                run_routes: Arc::clone(&run_routes),
                config_forks: Arc::clone(&config_forks),
                adoptions: Arc::new(CodexBindingAdoptions::default()),
                bindings: Arc::clone(&bindings) as Arc<dyn RuntimeBindingRebinder>,
                disposal: Arc::new(NoDisposal),
            },
        };
        let daemon_turn_bindings = Arc::new(TestDaemonTurnBindings::new(lead_agent_id));
        let run_start = Arc::new(CodexRunStart::new(CodexRunStartDependencies {
            slots: Arc::clone(&slots),
            config_forks,
            run_routes: Arc::clone(&run_routes),
            engine: Arc::clone(&engine),
            daemon_turn_bindings: Arc::clone(&daemon_turn_bindings)
                as Arc<dyn DaemonTurnBindingResolver>,
            attachments: Arc::new(NoAttachments),
            reads: Arc::clone(&reads),
        }));
        let self_started = CodexSelfStartedTurnDependencies {
            engine: Arc::clone(&engine),
            daemon_turn_bindings: Arc::clone(&daemon_turn_bindings)
                as Arc<dyn DaemonTurnBindingResolver>,
            reads,
        };
        let retries = Arc::new(CodexFasterModelRetries::new(
            CodexFasterModelRetryDependencies {
                slots: Arc::clone(&slots),
                run_routes: Arc::clone(&run_routes),
                run_start: Arc::clone(&run_start),
                dispatch: Arc::clone(&dispatch),
            },
        ));
        let ports = Arc::new(DriverPorts::new());
        let queue = Arc::new(RecordedQueue::default());
        assert!(ports.message_taken.register(queue.clone()).is_ok());
        assert!(ports.message_refused.register(queue.clone()).is_ok());
        let run_control = Arc::new(CodexRunControl::new(CodexRunControlDependencies {
            slots: Arc::clone(&slots),
            config_forks: Arc::clone(&calls.runs.config_forks),
            run_routes: Arc::clone(&run_routes),
            run_start: Arc::clone(&run_start),
            retries,
            attachments: Arc::new(NoAttachments),
            dispatch: Arc::clone(&dispatch),
            run_pauses: Arc::clone(&ports.run_pauses),
            continued_messages: Arc::clone(&ports.continued_messages),
            tasks: TaskTracker::new(),
        }));
        Self {
            scripted,
            task: TestCodexTask {
                record,
                routing,
                waiters: CodexTurnEndWaiters::default(),
                calls,
                run_routes,
                self_started,
                ports,
                engine,
                run_control,
                items,
            },
            bindings,
            dispatch,
            slots,
            run_start,
            daemon_turn_bindings,
            database,
            processes: Arc::new(ProviderProcessRegistry::default()),
            queue,
            epochs,
            _home: home,
        }
    }

    /// Records a binding on conversation `conversation-1` and answers its id.
    pub(crate) async fn record_binding(&self) -> RuntimeBindingId {
        self.bindings
            .create(binding_input(
                RuntimeBindingSpawnConfig::default(),
                spawned_build("0.130.0", "/opt/codex/bin"),
            ))
            .await
            .expect("the binding is recorded")
            .id
    }

    /// Opens the epoch cursor of `binding_id` on `run_id` at the run's start, as the binding's
    /// spawn does, so the run's rows are attributed.
    pub(crate) fn open_epoch(&self, binding_id: RuntimeBindingId, run_id: RunId) {
        self.epochs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .open_binding(
                EpochBinding {
                    id: binding_id,
                    run_id,
                    provider_name: DESCRIPTOR.provider_id(),
                    provider_account_id: None,
                },
                RUN_START_POSITION,
            )
            .expect("the binding has no cursor yet");
    }
}

impl TestCodexSession {
    /// An establishment on the session's service and delivery, every conversation it composes
    /// running in `folder`'s `work` on the person's own sign-in.
    pub(crate) fn establishment(&self, folder: &Path) -> CodexSessionEstablishment {
        CodexSessionEstablishment::new(CodexSessionEstablishmentDependencies {
            services: CodexServiceRegistry::holding(&self.scripted),
            spawn_contexts: Arc::new(OneFolder(folder.join("work"))),
            execution_postures: Arc::new(ExecutionPostureService::new(
                folder,
                folder.join("session-token"),
            )),
            base_environment: Arc::from([]),
            reserved_names: Arc::new(ReservedEnvironmentNames::of_providers(PROVIDERS)),
            helper_roles_folder: folder.join("roles"),
            tool_server_route: Arc::new(PortRegistration::new("tool server route")),
            delivery: Arc::clone(&self.task.calls.forks.delivery),
            pending_compactions: self.task.calls.forks.pending_compactions.clone(),
            provider_commands: CodexProviderCommandCache::new(
                Arc::new(PortRegistration::new("server prompts")),
                Arc::new(|_session_id| None),
            ),
            processes: Arc::clone(&self.processes),
        })
    }
}

/// Every session runs in one folder on the person's own sign-in, whose generation is never read.
pub(crate) struct OneFolder(pub(crate) PathBuf);

impl SessionSpawnContextResolver for OneFolder {
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

    fn read_credential_generation(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn std::error::Error + Send + Sync>>> {
        async { Err("the test reads no generation".into()) }.boxed()
    }
}

impl TestCodexTask {
    /// What the session's task holds, beside what its calls act through.
    pub(crate) fn split(&mut self) -> (CodexSessionTask<'_>, &CodexSessionCallDependencies) {
        (
            CodexSessionTask {
                record: &mut self.record,
                routing: &mut self.routing,
                waiters: &mut self.waiters,
            },
            &self.calls,
        )
    }

    /// The next item of the session's queue.
    pub(crate) async fn next_item(&mut self) -> CodexSessionInbound {
        self.items
            .recv()
            .await
            .expect("the session's queue is open")
    }

    /// Handles the next item of the session's queue as the session's task does.
    pub(crate) async fn handle_next(&mut self) {
        let item = self.next_item().await;
        self.handle(item).await;
    }

    /// Handles `item` as the session's task does: a frame observed, routed and delivered, a call
    /// run on the record, and what each delivered applied through the session's intake; the waits
    /// settled after each.
    pub(crate) async fn handle(&mut self, item: CodexSessionInbound) {
        match item {
            CodexSessionInbound::Frame { method, params } => {
                open_codex_self_started_turn(
                    &mut CodexSessionTask {
                        record: &mut self.record,
                        routing: &mut self.routing,
                        waiters: &mut self.waiters,
                    },
                    &self.calls.runs,
                    &self.self_started,
                    &method,
                    &params,
                )
                .await;
                observe_codex_session_frame(&mut self.record, &method, &params);
                let delivery = Arc::clone(&self.calls.forks.delivery);
                let routed = self
                    .routing
                    .route_notification(&delivery, &mut self.record, method, params)
                    .await;
                self.apply(routed).await;
            }
            CodexSessionInbound::Call(call) => {
                let routed = Box::pin(run_codex_session_call(
                    call,
                    &mut CodexSessionTask {
                        record: &mut self.record,
                        routing: &mut self.routing,
                        waiters: &mut self.waiters,
                    },
                    &self.calls,
                ))
                .await;
                self.apply(routed).await;
            }
            CodexSessionInbound::HeldThread { .. } | CodexSessionInbound::Barrier(_) => {}
            CodexSessionInbound::Ask { .. }
            | CodexSessionInbound::AsksWithdrawn { .. }
            | CodexSessionInbound::Lifecycle(_) => {
                panic!("the test's service asks nothing and its driver calls nothing of its own")
            }
        }
        self.waiters.settle(&self.record);
    }

    // What a frame's delivery reported, applied as the session's intake applies it.
    async fn apply(&mut self, routed: CodexRoutedFrames) {
        apply_codex_routed_frames(
            &CodexRoutedFramesIntake {
                ports: &self.ports,
                engine: &self.engine,
                run_routes: &self.run_routes,
                run_control: &self.run_control,
                config_forks: &self.calls.runs.config_forks,
            },
            &mut self.record,
            routed,
        )
        .await;
    }

    /// Runs `flow` while handling each item of the session's queue as the session's task does,
    /// in arrival order, and answers `flow`'s output.
    pub(crate) async fn drive<Output>(&mut self, flow: impl Future<Output = Output>) -> Output {
        let mut flow = std::pin::pin!(flow);
        loop {
            tokio::select! {
                biased;
                output = &mut flow => return output,
                item = self.items.recv() => {
                    self.handle(item.expect("the session's queue is open")).await;
                }
            }
        }
    }
}

/// The record of `session_id`'s conversation [`TEST_THREAD`] at Ask on `scripted`'s service, its
/// queue `inbound` attached there and its frames routed through `delivery`, and its routing band.
pub(crate) async fn open_test_record(
    scripted: &ScriptedCodexService,
    session_id: SessionId,
    inbound: CodexSessionInboundSender,
    delivery: &Arc<CodexFrameDelivery>,
    pending_compactions: PendingCompactionRegistry,
) -> (CodexSessionRecord, CodexSessionRouting) {
    scripted.service.attach_session(inbound.clone());
    scripted
        .service
        .register_thread(TEST_THREAD.to_owned(), session_id);
    let mut routing = CodexSessionRouting::new(pending_compactions);
    let mut record = CodexSessionRecord::new(CodexEstablishedConversation {
        session_id,
        service: Arc::clone(&scripted.service),
        inbound,
        thread_id: TEST_THREAD.to_owned(),
        binding_id: None,
        provider_account_id: None,
        turn_boundaries: Vec::new(),
        thread_settings: test_thread_settings(session_id),
        execution_posture: compose_execution_posture(
            PermissionLevel::Readonly,
            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
        ),
        session_mode: SessionMode::Build,
        output_speed_request: None,
        declared_output_speed: None,
        reasoning_effort: None,
    });
    routing
        .bind_session_thread(
            delivery,
            &mut record,
            TEST_THREAD.to_owned(),
            crate::provider::usage_delta_accountant::ThreadBaseEstablishment::Fresh,
        )
        .await;
    (record, routing)
}

/// The settings of a test session's conversation at Ask.
pub(crate) fn test_thread_settings(session_id: SessionId) -> CodexThreadSettings {
    CodexThreadSettings {
        session_id,
        working_directory: PathBuf::from("/work/repository"),
        model: "gpt-5".to_owned(),
        model_context_window: None,
        level: PermissionLevel::Ask,
        profile_folders: CodexProfileFolders {
            working_directory: PathBuf::from("/work/repository"),
            git_common_folder: None,
            deny_paths: Vec::new(),
        },
        command_environment: Vec::new(),
        subagent_policy: None,
        helper_roles: Vec::new(),
        tool_servers: Vec::new(),
        base_instructions: None,
    }
}

/// A `thread/fork` reply naming `thread_id` under the profile `settings` asks for.
pub(crate) fn fork_reply(thread_id: &str, settings: &CodexThreadSettings) -> Value {
    json!({
        "thread": {"id": thread_id, "sessionId": "codex-session"},
        "activePermissionProfile": {
            "id": compose_codex_profile_name(settings.level, &settings.profile_folders),
        },
    })
}

/// Answers, as the service, a fork of [`TEST_THREAD`] onto `fork_thread_id` under `settings`
/// and the let-go of the conversation left, answering the fork's model to the caller.
pub(crate) async fn answer_fork(
    script: &mut ScriptedService,
    fork_thread_id: &str,
    settings: &CodexThreadSettings,
) -> Value {
    let forked = script.next_sent().await;
    assert_eq!(forked["method"], "thread/fork");
    assert_eq!(forked["params"]["threadId"], TEST_THREAD);
    script.answer(&forked, &fork_reply(fork_thread_id, settings));
    let mode = script.next_sent().await;
    assert_eq!(mode["method"], "thread/settings/update");
    script.answer(&mode, &json!({}));
    let turns = script.next_sent().await;
    assert_eq!(turns["method"], "thread/turns/list");
    script.answer(&turns, &no_turns());
    let listed = script.next_sent().await;
    assert_eq!(listed["method"], "thread/backgroundTerminals/list");
    script.answer(&listed, &json!({"data": []}));
    let unsubscribed = script.next_sent().await;
    assert_eq!(unsubscribed["method"], "thread/unsubscribe");
    assert_eq!(unsubscribed["params"]["threadId"], TEST_THREAD);
    script.answer(&unsubscribed, &json!({"status": "unsubscribed"}));
    forked["params"]["model"].clone()
}

/// A `thread/turns/list` page with no turns on it.
pub(crate) fn no_turns() -> Value {
    json!({"data": [], "nextCursor": null})
}

/// A `turn/started` of `turn_id` on [`TEST_THREAD`], as the service sends it.
pub(crate) fn turn_started(turn_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "turn/started",
        "params": {
            "threadId": TEST_THREAD,
            "turn": {"id": turn_id, "items": [], "status": "inProgress"},
        },
    })
}

/// A `turn/completed` of `turn_id` on `thread_id` ending `status`, as the service sends it.
pub(crate) fn turn_completed(thread_id: &str, turn_id: &str, status: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "turn/completed",
        "params": {
            "threadId": thread_id,
            "turn": {"id": turn_id, "items": [], "status": status},
        },
    })
}

/// A `turn/start` reply naming `turn_id`.
pub(crate) fn turn_reply(turn_id: &str) -> Value {
    json!({"turn": {"id": turn_id, "items": [], "status": "inProgress"}})
}

/// Opens each turn the daemon starts on the binding the test names, for the session's lead.
pub(crate) struct TestDaemonTurnBindings {
    /// The session's lead.
    pub(crate) agent_id: AgentId,
    binding_id: Mutex<Option<RuntimeBindingId>>,
}

impl TestDaemonTurnBindings {
    /// Opens no turn until [`Self::open_on`] names a binding.
    pub(crate) fn new(agent_id: AgentId) -> Self {
        Self {
            agent_id,
            binding_id: Mutex::new(None),
        }
    }

    /// Opens every later turn on `binding_id`.
    pub(crate) fn open_on(&self, binding_id: RuntimeBindingId) {
        *self.lock() = Some(binding_id);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<RuntimeBindingId>> {
        self.binding_id
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl DaemonTurnBindingResolver for TestDaemonTurnBindings {
    fn open_daemon_turn_binding(
        &self,
        _run_id: RunId,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
        let binding = self.lock().clone().map(|binding_id| DaemonTurnBinding {
            binding_id,
            agent_id: self.agent_id,
        });
        async move { binding.ok_or(DaemonTurnBindingError::NoConversation { session_id }) }.boxed()
    }
}

/// A disposal the tests read none of.
struct NoDisposal;

impl CodexSessionDisposal for NoDisposal {
    fn dispose(&self, _session_id: SessionId) {}
}

/// Binds no file: the tests' messages carry none.
pub(crate) struct NoAttachments;

impl AttachmentResolver for NoAttachments {
    fn resolve_attachments(
        &self,
        _session_id: SessionId,
        _artifact_ids: Vec<ArtifactId>,
    ) -> BoxFuture<'_, Result<Vec<ProviderAttachment>, Box<dyn std::error::Error + Send + Sync>>>
    {
        async { Ok(Vec::new()) }.boxed()
    }
}

/// Hands each item of the session's queue to the test.
struct ItemsToTest {
    items: mpsc::UnboundedSender<CodexSessionInbound>,
}

impl ItemsToTest {
    fn hand(&self, item: CodexSessionInbound) {
        // A test that ended reads no more.
        let _unread = self.items.send(item);
    }
}

impl CodexSessionInboundHandler for ItemsToTest {
    fn frame(&mut self, method: String, params: Box<RawValue>) -> BoxFuture<'_, ()> {
        self.hand(CodexSessionInbound::Frame { method, params });
        async {}.boxed()
    }

    fn ask(
        &mut self,
        request: CodexInboundServerRequest,
        decision: oneshot::Sender<Result<CodexServerRequestDecision, DriverError>>,
    ) -> BoxFuture<'_, ()> {
        self.hand(CodexSessionInbound::Ask { request, decision });
        async {}.boxed()
    }

    fn asks_withdrawn(&mut self, dropped: Vec<CodexForgottenRequest>) -> BoxFuture<'_, ()> {
        self.hand(CodexSessionInbound::AsksWithdrawn { dropped });
        async {}.boxed()
    }

    fn held_thread(&mut self, thread_id: String, is_held: bool) {
        self.hand(CodexSessionInbound::HeldThread { thread_id, is_held });
    }

    fn call(&mut self, call: CodexSessionCall) -> BoxFuture<'_, ()> {
        self.hand(CodexSessionInbound::Call(call));
        async {}.boxed()
    }

    fn lifecycle(&mut self, call: CodexLifecycleCall) -> BoxFuture<'_, ()> {
        self.hand(CodexSessionInbound::Lifecycle(call));
        async {}.boxed()
    }

    fn next_deadline(&self) -> Option<Instant> {
        None
    }

    fn deadline_reached(&mut self, _now: Instant) -> BoxFuture<'_, ()> {
        async {}.boxed()
    }
}

/// A run-state stream no one reads.
pub(crate) struct UnreadRunStates;

impl crate::provider::port::run_state_publisher::RunStatePublisher for UnreadRunStates {
    fn publish(
        &self,
        _hold: sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload,
    ) {
    }
}

/// Frame effects the tests read none of.
struct NoEffects;

impl CodexFrameEffects for NoEffects {
    fn withdraw_ask(
        &self,
        _session_id: SessionId,
        _provider_account_id: Option<&ProviderAccountId>,
        _request_id: &str,
        _ask_kind: CodexAskKind,
    ) {
    }

    fn forget_turn_corrections(&self, _session_id: SessionId, _turn_id: &str) {}

    fn cut_oversized_turn(&self, _session_id: SessionId, _thread_id: &str, _turn_id: &str) {}

    fn on_tool_boundary(&self, _boundary: RunToolBoundary) {}

    fn plan_proposed(&self, _run: &CodexRowRun, _text: &str, _turn_id: &str, _item_id: &str) {}
}
