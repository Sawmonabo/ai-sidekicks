//! A Codex session live in the composed driver: its record on a scripted service, its task the
//! driver's own, one run on a live turn, and the run engine's and the run queue's intake recorded;
//! and a driver on a Codex folder of a test's own, with a service of the test's listening there.

mod at_rest;
mod caller_check;
mod capability_read;
mod commands;
mod controls;
mod diagnostic_recorders;
mod export_usage;
mod intake;
mod kept_turns;
mod questions;
mod resume;
mod rule_revoke;
mod sessions;
mod status_legs;
mod terminal_reach;
pub(super) mod usage;

use std::error::Error;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::bind_socket_listener;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::CodexDriver;
use super::intake::CodexSessionIntake;
use crate::driver::DriverServices;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::service::registry::{CodexServiceRegistry, home_socket_path};
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, StandInReplies, answer_as_codex_service, start_scripted_codex_service,
    write_failing_codex,
};
use crate::driver::codex::session::context_reading::CodexFixedStart;
use crate::driver::codex::session::inbound::codex_session_inbound;
use crate::driver::codex::session::state::{CodexTurnInput, CodexTurnMessage};
use crate::driver::codex::session::test_fixture::one_folder::OneFolder;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestDaemonTurnBindings, open_test_record, turn_completed,
};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::schema::schema_parts;
use crate::driver::session_control::SessionToolServer;
use crate::driver::test_registry::{
    RecordedQueue, new_agent_id, new_run_id, new_session_id, test_driver_services,
};
use crate::port::question::QuestionPort;
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::run::posture::ExecutionPostureService;
use crate::runtime_binding::store::{
    CreateRuntimeBindingInput, RuntimeBindingRebind, RuntimeBindingStore,
};
use crate::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// The live turn the session's run is on.
pub(super) const TEST_TURN: &str = "turn-1";

/// A session live in the composed driver and its run, running on [`TEST_TURN`] unless the session
/// opened idle or on turns of its own.
pub(super) struct LiveCodexSession {
    pub(super) driver: CodexDriver,
    pub(super) session_id: SessionId,
    pub(super) run_id: RunId,
    pub(super) binding_id: RuntimeBindingId,
    pub(super) scripted: ScriptedCodexService,
    pub(super) queue: Arc<RecordedQueue>,
    /// Where the questions card registers, which no test registers until it asks a question.
    pub(super) questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    /// The run engine and its dispatch, which record each call the driver makes.
    pub(super) engine: Arc<RecordingRunEngine>,
    /// The database the binding store writes, which the driver's binding writer holds too, so no
    /// test that leaves this field unbound drops the file under the driver.
    pub(super) database: Arc<TestDatabase>,
}

/// The binding store the driver writes, holding the database its file is in for as long as the
/// driver holds the store.
struct DatabaseHeldBindings {
    store: Arc<RuntimeBindingStore>,
    _database: Arc<TestDatabase>,
}

impl RuntimeBindingWriter for DatabaseHeldBindings {
    fn rebind(
        &self,
        rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.store.rebind(rebind)
    }

    fn keep_recovery_data(
        &self,
        binding_id: RuntimeBindingId,
        runtime_metadata: Map<String, Value>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.store.keep_recovery_data(binding_id, runtime_metadata)
    }

    fn move_account(
        &self,
        binding_id: RuntimeBindingId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        RuntimeBindingWriter::move_account(&*self.store, binding_id, provider_account_id)
    }

    fn replace_tool_servers(
        &self,
        run_id: RunId,
        tool_servers: Vec<SessionToolServer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        RuntimeBindingWriter::replace_tool_servers(&*self.store, run_id, tool_servers)
    }
}

impl LiveCodexSession {
    /// The session with `steers` sent into its turn and not yet echoed.
    pub(super) async fn start(steers: &[QueueItemId]) -> Self {
        Self::open(None, &[TEST_TURN], steers, &[], false).await
    }

    /// The session with `steers` sent into its turn and not yet echoed, and the turn's input
    /// kept, so a faster-model retry can stop the turn and send that input again.
    pub(super) async fn retriable(steers: &[QueueItemId]) -> Self {
        Self::open(None, &[TEST_TURN], steers, &[], true).await
    }

    /// The session with its run open on each of `turns`, none of them started yet.
    pub(super) async fn on_turns(turns: &[&str]) -> Self {
        Self::open(None, turns, &[], &[], false).await
    }

    /// The session with no turn running, its run bound but not started.
    pub(super) async fn idle() -> Self {
        Self::open(None, &[], &[], &[], false).await
    }

    /// The session running on [`TEST_TURN`] with `released`, notifications Codex sent before its
    /// task ran, routed as one batch its task applies first.
    pub(super) async fn with_released(released: &[Value]) -> Self {
        Self::open(None, &[TEST_TURN], &[], released, false).await
    }

    /// The session on `scripted`'s service, which the driver's registry holds as the daemon's
    /// stop finds it, its run open on each of `turns`.
    pub(super) async fn on_held_service(scripted: ScriptedCodexService, turns: &[&str]) -> Self {
        Self::open(Some(scripted), turns, &[], &[], false).await
    }

    // The session on `held`'s service, which the driver's registry holds, or else on a scripted
    // service of its own; its run open on each of `turns` with `steers` unechoed in [`TEST_TURN`],
    // that turn's input kept for a retry where `is_retriable`, and `released` routed for its task
    // to apply first.
    async fn open(
        held: Option<ScriptedCodexService>,
        turns: &[&str],
        steers: &[QueueItemId],
        released: &[Value],
        is_retriable: bool,
    ) -> Self {
        let is_held = held.is_some();
        let scripted = held.unwrap_or_else(start_scripted_codex_service);
        let database = Arc::new(TestDatabase::new(schema_parts()));
        let engine = Arc::new(RecordingRunEngine::default());
        let session_id = new_session_id();
        let agent_id = new_agent_id();
        let mut services = test_driver_services();
        // The retry's fork points the run's binding at the conversation it moves onto.
        let bindings = Arc::new(open_store(&database).await);
        services.runtime_bindings = Arc::new(DatabaseHeldBindings {
            store: Arc::clone(&bindings),
            _database: Arc::clone(&database),
        });
        let queue = Arc::new(RecordedQueue::default());
        let ports = &services.ports;
        assert!(ports.run_engine.register(Arc::clone(&engine) as _).is_ok());
        assert!(
            ports
                .inbound_dispatch
                .register(Arc::clone(&engine) as _)
                .is_ok()
        );
        assert!(
            ports
                .daemon_turn_bindings
                .register(Arc::new(TestDaemonTurnBindings::new(agent_id)))
                .is_ok()
        );
        assert!(ports.message_taken.register(queue.clone()).is_ok());
        assert!(ports.message_refused.register(queue.clone()).is_ok());
        assert!(ports.message_given_back.register(queue.clone()).is_ok());
        assert!(ports.continue_given_back.register(queue.clone()).is_ok());
        let questions = Arc::clone(&ports.questions);
        let mut driver = CodexDriver::new(&services);
        if is_held {
            // Before the driver composes, whose parts dial through the registry.
            driver.registry = CodexServiceRegistry::holding(&scripted);
        }
        let parts = Arc::clone(driver.parts().expect("the driver composes"));

        let run_id = new_run_id();
        // The run's own binding, whose stored set a switch of its tool servers writes.
        let binding_id = bindings
            .create(CreateRuntimeBindingInput {
                run_id,
                ..binding_input(
                    spawn_config_on(test_provider_account_id()),
                    spawned_build("0.130.0", "/opt/codex/bin"),
                )
            })
            .await
            .expect("the binding is recorded")
            .id;
        parts.run_routes.bind_run_delivery(
            run_id,
            CodexRunBinding {
                session_id,
                binding_id: binding_id.clone(),
                agent_id,
                step_bound: None,
            },
        );

        let (inbound, receiver) = codex_session_inbound(session_id);
        parts
            .slots
            .claim_establishing(session_id)
            .await
            .expect("the session's slot is free")
            .install(inbound.clone());
        let (mut record, mut routing) = open_test_record(
            &scripted,
            session_id,
            agent_id,
            inbound,
            &parts.delivery,
            parts.pending_compactions.clone(),
        )
        .await;
        // As the run's turn start adopts its binding.
        record.binding_id = Some(binding_id.clone());
        for turn_id in turns {
            record.add_active_turn((*turn_id).to_owned(), run_id);
        }
        if !turns.is_empty() {
            parts.run_routes.bind_run(run_id, session_id);
        }
        if !steers.is_empty() {
            let unechoed = record
                .unechoed_steers_by_turn_id
                .entry(TEST_TURN.to_owned())
                .or_default();
            for steer in steers {
                unechoed.register(*steer);
            }
        }
        if is_retriable {
            // As the turn's start keeps what it sent and its place in the conversation.
            record.turn_boundaries.push(TEST_TURN.to_owned());
            record.turn_input_by_turn_id.insert(
                TEST_TURN.to_owned(),
                CodexTurnInput {
                    messages: vec![CodexTurnMessage {
                        text: "Fix the build.".to_owned(),
                        skills: Vec::new(),
                        attachments: Vec::new(),
                    }],
                    client_message_ids: vec!["message-1".to_owned()],
                    output_speed_for_turn: None,
                    sent_output_speed_for_turn: None,
                    model: "gpt-5.5".to_owned(),
                },
            );
        }
        let mut routed = CodexRoutedFrames::default();
        for frame in released {
            let method = frame["method"]
                .as_str()
                .expect("a notification names its method");
            let params = RawValue::from_string(frame["params"].to_string())
                .expect("a notification's params are JSON");
            routed.extend(
                routing
                    .route_notification(&parts.delivery, &mut record, method.to_owned(), params)
                    .await,
            );
        }
        let intake = CodexSessionIntake::new(
            record,
            routing,
            Arc::clone(&parts),
            CodexFixedStart::FirstRequest,
        );
        driver.tasks.spawn(intake.run(receiver, routed));
        Self {
            driver,
            session_id,
            run_id,
            binding_id,
            scripted,
            queue,
            questions,
            engine,
            database,
        }
    }
}

/// The person's own Codex folder the driver of [`driver_on_codex_folder`] runs on, under its
/// folder.
const CODEX_FOLDER_NAME: &str = "codex-home";

/// A driver whose person's own Codex folder is `codex-home` under `folder`, its Codex command a
/// stand-in that fails at once with nothing printed, so a service it launches never answers; with
/// the services it was built on. `folder` is a `short_socket_folder`, so a socket's path in it
/// fits the system's limit.
pub(super) fn driver_on_codex_folder(folder: &Path) -> (CodexDriver, DriverServices) {
    let codex_home = folder.join(CODEX_FOLDER_NAME);
    let programs = folder.join("bin");
    for made in [&codex_home, &programs, &folder.join("data")] {
        std::fs::create_dir_all(made).expect("a test folder is made");
    }
    // Found first on the search path as Codex's command.
    write_failing_codex(&programs);
    let mut services = test_driver_services();
    services.data_folder = folder.join("data");
    services.home_folder = folder.join("home");
    services.base_environment = Arc::from([
        (
            DESCRIPTOR.credential_home_environment_names[0].to_owned(),
            codex_home.display().to_string(),
        ),
        ("PATH".to_owned(), programs.display().to_string()),
    ]);
    (CodexDriver::new(&services), services)
}

/// Listens on the home socket of the Codex folder of [`driver_on_codex_folder`] under `folder`
/// as a service the person started, with no conversation loaded, so a start there joins it.
pub(super) fn listen_on_codex_folder(folder: &Path) {
    let socket = home_socket_path(&folder.join(CODEX_FOLDER_NAME));
    std::fs::create_dir_all(socket.parent().expect("the socket has a folder"))
        .expect("the socket's folder is made");
    let listener = bind_socket_listener(&socket).expect("the test service listens");
    tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            tokio::spawn(answer_as_codex_service(
                stream,
                StandInReplies::default(),
                |_request| {},
            ));
        }
    });
}

/// The composed driver on the test's one account whose registry holds `scripted`'s service, every
/// session running in `folder`'s `work`, its runs on a recording engine.
pub(super) fn driver_holding(scripted: &ScriptedCodexService, folder: &Path) -> CodexDriver {
    let engine = Arc::new(RecordingRunEngine::default());
    let mut services = test_driver_services();
    let one_folder = Arc::new(OneFolder(folder.join("work")));
    services
        .ports
        .spawn_contexts
        .register(Arc::clone(&one_folder) as _)
        .expect("the spawn contexts register once");
    services
        .ports
        .provider_accounts
        .register(Arc::new(one_folder.accounts()))
        .expect("the provider accounts register once");
    services.execution_postures = Arc::new(ExecutionPostureService::new(
        folder,
        folder.join("session-token"),
    ));
    let ports = &services.ports;
    assert!(ports.run_engine.register(Arc::clone(&engine) as _).is_ok());
    assert!(ports.inbound_dispatch.register(engine as _).is_ok());
    let agent_id = new_agent_id();
    assert!(
        ports
            .daemon_turn_bindings
            .register(Arc::new(TestDaemonTurnBindings::new(agent_id)))
            .is_ok()
    );
    let mut driver = CodexDriver::new(&services);
    driver.registry = CodexServiceRegistry::holding(scripted);
    driver
}

/// Yields until `holds` reads true, failing after a bound.
pub(super) async fn wait_until(mut holds: impl FnMut() -> bool) {
    for _turn in 0..2_000 {
        if holds() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the condition never held");
}

/// Answers what stopping a turn sends, a close's or an interrupt's: an interrupt, with the end of
/// the turn it names as Codex sends it on the abort, the running-command list as empty, and the
/// rest with nothing.
pub(super) fn answer_stopping_request(script: &ScriptedService, sent: &Value) {
    match sent["method"].as_str() {
        Some("turn/interrupt") => {
            script.answer(sent, &json!({}));
            let turn_id = sent["params"]["turnId"]
                .as_str()
                .expect("an interrupt names its turn");
            script.send(&turn_completed(TEST_THREAD, turn_id, "interrupted"));
        }
        Some("thread/backgroundTerminals/list") => {
            script.answer(sent, &json!({"data": [], "nextCursor": null}));
        }
        _ => script.answer(sent, &json!({})),
    }
}
