//! A Codex session live in the composed driver: its record on a scripted service, its task the
//! driver's own, one run on a live turn, and the run queue's intake recorded; and a driver on a
//! Codex folder of a test's own, with a service of the test's listening there.

mod caller_check;
mod intake;
mod sessions;
mod terminal_reach;

use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;

use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_platforms::{LeftoverSweep, bind_socket_listener, replace_file_atomically};
use tempfile::TempDir;

use super::CodexDriver;
use super::intake::CodexSessionIntake;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, insert_lead};
use crate::events::session::followers::SessionEventFollowers;
use crate::mutex_lock::lock;
use crate::plans::schema::schema_parts;
use crate::provider::driver::DriverServices;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::notification_routing::CodexRoutedFrames;
use crate::provider::driver::codex::run::routes::CodexRunBinding;
use crate::provider::driver::codex::service::registry::home_socket_path;
use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, answer_as_codex_service, start_scripted_codex_service,
};
use crate::provider::driver::codex::session::inbound::codex_session_inbound;
use crate::provider::driver::codex::session::state::{CodexTurnInput, CodexTurnMessage};
use crate::provider::driver::codex::session::test_session::{
    TEST_THREAD, TestDaemonTurnBindings, open_test_record, turn_completed,
};
use crate::provider::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::provider::driver::test_registry::new_session_id;
use crate::provider::driver::test_registry::{
    RecordedQueue, TestRunPorts, new_run_id, test_driver_services,
};
use crate::provider::port::question::QuestionPort;
use crate::provider::port::registration::PortRegistration;
use crate::provider::runtime_binding::store::RuntimeBindingSpawnConfig;
use crate::provider::runtime_binding::test_store::{binding_input, open_store, spawned_build};
use crate::session::run::engine::RUN_ENGINE_STATEMENT_CAPACITY;
use crate::session::run::engine::tests::insert_running_run;
use crate::session::run::epochs::{EpochBinding, ExecutionEpochs};

/// The live turn the session's run is on.
pub(super) const TEST_TURN: &str = "turn-1";

/// A session live in the composed driver and its run, running on [`TEST_TURN`] unless the session
/// opened idle.
pub(super) struct LiveCodexSession {
    pub(super) driver: CodexDriver,
    pub(super) session_id: SessionId,
    pub(super) run_id: RunId,
    pub(super) binding_id: RuntimeBindingId,
    pub(super) scripted: ScriptedCodexService,
    pub(super) queue: Arc<RecordedQueue>,
    /// Where the questions card registers, which no test registers until it asks a question.
    pub(super) questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    pub(super) database: TestDatabase,
    pub(super) followers: Arc<SessionEventFollowers>,
    _home: TempDir,
}

impl LiveCodexSession {
    /// The session with `steers` sent into its turn and not yet echoed.
    pub(super) async fn start(steers: &[QueueItemId]) -> Self {
        Self::open(Some(steers), &[], false).await
    }

    /// The session with `steers` sent into its turn and not yet echoed, and the turn's input
    /// kept, so a faster-model retry can stop the turn and send that input again.
    pub(super) async fn retriable(steers: &[QueueItemId]) -> Self {
        Self::open(Some(steers), &[], true).await
    }

    /// The session with no turn running, its run bound but not started.
    pub(super) async fn idle() -> Self {
        Self::open(None, &[], false).await
    }

    /// The session running on [`TEST_TURN`] with `released`, notifications Codex sent before its
    /// task ran, routed as one batch its task applies first.
    pub(super) async fn with_released(released: &[Value]) -> Self {
        Self::open(Some(&[]), released, false).await
    }

    // The session, its run on a turn with `steers` unechoed in it where they are given, that turn's
    // input kept for a retry where `is_retriable`, and `released` routed for its task to apply
    // first.
    async fn open(steers: Option<&[QueueItemId]>, released: &[Value], is_retriable: bool) -> Self {
        let scripted = start_scripted_codex_service();
        let database = TestDatabase::new(schema_parts());
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let run_ports = TestRunPorts::open(
            &database,
            home.path(),
            ExecutionEpochs::new(NonZeroUsize::new(8).expect("the cap is not zero")),
        )
        .await;
        let epochs = Arc::clone(&run_ports.epochs);
        let session_id = new_session_id();
        let agent_id = insert_lead(&database, session_id, DESCRIPTOR.id);
        let mut services = test_driver_services();
        services.pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            RUN_ENGINE_STATEMENT_CAPACITY,
        ));
        // The retry's fork points the run's binding at the conversation it moves onto.
        let bindings = Arc::new(open_store(&database).await);
        services.runtime_bindings = Arc::clone(&bindings) as _;
        let queue = Arc::new(RecordedQueue::default());
        let ports = &services.ports;
        run_ports.register_on(ports);
        assert!(
            ports
                .daemon_turn_bindings
                .register(Arc::new(TestDaemonTurnBindings::new(agent_id)))
                .is_ok()
        );
        assert!(ports.message_taken.register(queue.clone()).is_ok());
        assert!(ports.message_refused.register(queue.clone()).is_ok());
        assert!(ports.message_given_back.register(queue.clone()).is_ok());
        let questions = Arc::clone(&ports.questions);
        let driver = CodexDriver::new(&services);
        let parts = Arc::clone(driver.parts().expect("the driver composes"));

        let run_id = new_run_id();
        insert_running_run(&database, session_id, run_id);
        let binding_id = bindings
            .create(binding_input(
                RuntimeBindingSpawnConfig::default(),
                spawned_build("0.130.0", "/opt/codex/bin"),
            ))
            .await
            .expect("the binding is recorded")
            .id;
        let opened = lock(&epochs).open_binding(
            EpochBinding {
                id: binding_id.clone(),
                run_id,
                provider_name: DESCRIPTOR.provider_id(),
                provider_account_id: None,
            },
            RUN_START_POSITION,
        );
        assert!(opened.is_ok(), "the binding's epoch opens");
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
            inbound,
            &parts.delivery,
            parts.pending_compactions.clone(),
        )
        .await;
        // As the run's turn start adopts its binding.
        record.binding_id = Some(binding_id.clone());
        if let Some(steers) = steers {
            record.add_active_turn(TEST_TURN.to_owned(), run_id);
            parts.run_routes.bind_run(run_id, session_id);
            if !steers.is_empty() {
                let unechoed = record
                    .unechoed_steers_by_turn_id
                    .entry(TEST_TURN.to_owned())
                    .or_default();
                for steer in steers {
                    unechoed.register(*steer);
                }
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
        let intake = CodexSessionIntake::new(record, routing, Arc::clone(&parts));
        driver.tasks.spawn(intake.run(receiver, routed));
        Self {
            driver,
            session_id,
            run_id,
            binding_id,
            scripted,
            queue,
            questions,
            database,
            followers: run_ports.log.followers,
            _home: home,
        }
    }
}

/// The person's own Codex folder the driver of [`driver_on_codex_folder`] runs on, under its
/// folder.
const CODEX_FOLDER_NAME: &str = "codex-home";

/// A driver whose person's own Codex folder is `codex-home` under `folder`, its Codex command a
/// script that exits at once, so a service it launches never answers; with the services it was
/// built on. `folder` sits under `/tmp`, so a socket's path in it fits the system's limit.
pub(super) fn driver_on_codex_folder(folder: &Path) -> (CodexDriver, DriverServices) {
    let codex_home = folder.join(CODEX_FOLDER_NAME);
    let programs = folder.join("bin");
    for made in [&codex_home, &programs, &folder.join("data")] {
        std::fs::create_dir_all(made).expect("a test folder is made");
    }
    // Found first on the search path as Codex's command.
    replace_file_atomically(
        &programs.join("codex"),
        b"#!/bin/sh\nexit 1\n",
        0o755,
        LeftoverSweep::Unswept,
    )
    .expect("the command is written");
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
            tokio::spawn(answer_as_codex_service(stream));
        }
    });
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
