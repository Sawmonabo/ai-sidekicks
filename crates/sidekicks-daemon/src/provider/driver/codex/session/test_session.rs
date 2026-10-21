//! A Codex session the tests drive as its task would: a record on a scripted service with its
//! routing band and waits, a run engine and binding store on a real database, and each item of
//! the session's queue handed to the test, which handles it the way the session's task does.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;
use tempfile::TempDir;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::database::writer::test_file::TestDatabase;
use crate::events::log_service::tests::open_log;
use crate::policy::execution_posture_service::compose_execution_posture;
use crate::provider::compaction_wait::PendingCompactionRegistry;
use crate::provider::driver::codex::delivery::frames::{
    CodexFrameDelivery, CodexFrameDeliveryDependencies, CodexFrameEffects,
};
use crate::provider::driver::codex::delivery::memory::CodexDeliveryMemory;
use crate::provider::driver::codex::delivery::rows::CodexRowRun;
use crate::provider::driver::codex::notification_routing::{
    CodexRoutedFrames, CodexSessionRouting,
};
use crate::provider::driver::codex::permission_level::{
    CodexProfileFolders, compose_codex_profile_name,
};
use crate::provider::driver::codex::run::routes::CodexRunRoutes;
use crate::provider::driver::codex::run::turn_end_waiters::CodexTurnEndWaiters;
use crate::provider::driver::codex::server_requests::{
    CodexAskKind, CodexInboundServerRequest, CodexServerRequestDecision,
};
use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::provider::driver::codex::session::calls::{
    CodexSessionCallDependencies, CodexSessionTask, run_codex_session_call,
};
use crate::provider::driver::codex::session::fork::CodexForkDependencies;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundHandler, codex_session_inbound,
    drain_codex_session_inbound,
};
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::thread::permission_profiles::CodexThreadPermissionProfiles;
use crate::provider::driver::codex::thread::settings::CodexThreadSettings;
use crate::provider::driver::codex::transport::connection::CodexForgottenRequest;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::run_control::RunToolBoundary;
use crate::provider::port::registration::PortRegistration;
use crate::provider::runtime_binding::store::{RuntimeBindingSpawnConfig, RuntimeBindingStore};
use crate::provider::runtime_binding::test_store::{binding_input, open_store, spawned_build};
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::test_engine;
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
    /// The run engine on the database.
    pub(crate) engine: Arc<RunEngine>,
    /// The binding store on the database.
    pub(crate) bindings: Arc<RuntimeBindingStore>,
    /// The database.
    pub(crate) database: TestDatabase,
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
        let dispatch = Arc::new(RunInboundDispatch::new(
            Arc::clone(&engine),
            Arc::new(std::sync::Mutex::new(
                crate::session::run::epochs::ExecutionEpochs::new(
                    std::num::NonZeroUsize::new(8).expect("the cap is not zero"),
                ),
            )),
            Arc::new(UnreadRunStates),
            log.service,
        ));
        let bindings = Arc::new(open_store(&database).await);
        let run_routes = Arc::new(CodexRunRoutes::default());
        let pending_compactions = PendingCompactionRegistry::default();
        let delivery = Arc::new(CodexFrameDelivery::new(CodexFrameDeliveryDependencies {
            engine: Arc::clone(&engine),
            dispatch,
            run_routes: Arc::clone(&run_routes),
            reviewer_denials: Arc::new(PortRegistration::new("reviewer denial")),
            command_output: Arc::new(PortRegistration::new("command output")),
            pending_compactions: pending_compactions.clone(),
            effects: Arc::new(NoEffects),
        }));
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let (inbound, receiver) = codex_session_inbound(session_id);
        scripted.service.attach_session(inbound.clone());
        scripted
            .service
            .register_thread(TEST_THREAD.to_owned(), session_id);
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
        let thread_settings = test_thread_settings(session_id);
        let mut routing = CodexSessionRouting::new(pending_compactions.clone());
        let mut record = CodexSessionRecord {
            session_id,
            service: Arc::clone(&scripted.service),
            inbound,
            thread_id: TEST_THREAD.to_owned(),
            binding_id: None,
            provider_account_id: None,
            turn_boundaries: Vec::new(),
            turn_id_by_client_message_id: std::collections::HashMap::new(),
            permission_profiles: CodexThreadPermissionProfiles::established(&thread_settings),
            thread_settings,
            is_config_fork_owed: false,
            left_thread_ids_awaiting_binding: Vec::new(),
            execution_posture: compose_execution_posture(
                PermissionLevel::Readonly,
                FilesystemPath::new("/".to_owned()).expect("the root is a path"),
            ),
            session_mode: SessionMode::Build,
            output_speed_request: None,
            declared_output_speed: None,
            reasoning_effort: None,
            unsettled_output_speed_runs: std::collections::HashMap::new(),
            active_turns: Vec::new(),
            settled_turn_ids: std::collections::VecDeque::new(),
            interrupted_run_by_turn_id: Vec::new(),
            interrupting_turn_ids: std::collections::HashSet::new(),
            unechoed_steers_by_turn_id: std::collections::HashMap::new(),
            last_steer_send: None,
            pause_run_id_by_turn_id: std::collections::HashMap::new(),
            paused_run_id_by_interrupted_turn_id: std::collections::HashMap::new(),
            continues_awaiting_pause: std::collections::HashMap::new(),
            turn_input_by_turn_id: std::collections::HashMap::new(),
            delivery: CodexDeliveryMemory::new(),
        };
        routing
            .bind_session_thread(
                &delivery,
                &mut record,
                TEST_THREAD.to_owned(),
                crate::provider::usage_delta_accountant::ThreadBaseEstablishment::Fresh,
            )
            .await;
        let calls = CodexSessionCallDependencies {
            forks: CodexForkDependencies {
                delivery,
                release: Arc::clone(&scripted.dependencies.release),
                bindings: Arc::clone(&bindings),
                tool_server_route: Arc::new(PortRegistration::new("tool server route")),
                pending_compactions,
            },
        };
        Self {
            scripted,
            task: TestCodexTask {
                record,
                routing,
                waiters: CodexTurnEndWaiters::default(),
                calls,
                run_routes,
                items,
            },
            engine,
            bindings,
            database,
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

    /// Handles `item` as the session's task does: a frame routed and delivered, a turn's end
    /// remembered, a call run on the record; the waits settled after each.
    pub(crate) async fn handle(&mut self, item: CodexSessionInbound) {
        match item {
            CodexSessionInbound::Frame { method, params } => {
                let delivery = Arc::clone(&self.calls.forks.delivery);
                let routed = self
                    .routing
                    .route_notification(&delivery, &mut self.record, method, params)
                    .await;
                self.apply(routed);
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
                self.apply(routed);
            }
            CodexSessionInbound::HeldThread { .. } | CodexSessionInbound::Barrier(_) => {}
            CodexSessionInbound::Ask { .. } | CodexSessionInbound::AsksWithdrawn { .. } => {
                panic!("the test's service asks nothing")
            }
        }
        self.waiters.settle(&self.record);
    }

    // The turns a frame ended leave the record, as the session's intake leaves them.
    fn apply(&mut self, routed: CodexRoutedFrames) {
        for dispatch in routed.dispatches {
            for ended in dispatch.turns_ended {
                self.record.remove_active_turn(&ended.turn_id);
                self.record.remember_settled_turn(ended.turn_id);
            }
        }
    }

    /// Runs `call` on the record as the session's task does.
    pub(crate) async fn run_call(&mut self, call: CodexSessionCall) {
        self.handle(CodexSessionInbound::Call(call)).await;
    }
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

/// A `thread/turns/list` page with no turns on it.
pub(crate) fn no_turns() -> Value {
    json!({"data": [], "nextCursor": null})
}

/// A minted run id.
pub(crate) fn new_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
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

    fn next_deadline(&self) -> Option<Instant> {
        None
    }

    fn deadline_reached(&mut self, _now: Instant) -> BoxFuture<'_, ()> {
        async {}.boxed()
    }
}

/// A run-state stream no one reads.
struct UnreadRunStates;

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
    fn withdraw_ask(&self, _session_id: SessionId, _request_id: &str, _ask_kind: CodexAskKind) {}

    fn forget_turn_corrections(&self, _session_id: SessionId, _turn_id: &str) {}

    fn cut_oversized_turn(&self, _session_id: SessionId, _thread_id: &str, _turn_id: &str) {}

    fn on_tool_boundary(&self, _boundary: RunToolBoundary) {}

    fn plan_proposed(&self, _run: &CodexRowRun, _text: &str, _turn_id: &str, _item_id: &str) {}
}
