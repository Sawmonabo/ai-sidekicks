//! A Codex session live in the composed driver: its record on a scripted service, its task the
//! driver's own, one run on a live turn, and the run queue's intake recorded.

mod caller_check;
mod intake;
mod sessions;

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::RUN_START_POSITION;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tempfile::TempDir;
use tokio::sync::Notify;

use super::CodexDriver;
use super::intake::CodexSessionIntake;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, insert_lead};
use crate::events::log_service::tests::open_log;
use crate::mutex_lock::lock;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::notification_routing::CodexRoutedFrames;
use crate::provider::driver::codex::run::routes::CodexRunBinding;
use crate::provider::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::provider::driver::codex::session::inbound::codex_session_inbound;
use crate::provider::driver::codex::session::test_session::{
    TestDaemonTurnBindings, UnreadRunStates, open_test_record,
};
use crate::provider::driver::ports::{MessageRefusedListener, MessageTakenListener};
use crate::provider::driver::test_registry::new_run_id;
use crate::provider::driver::test_registry::test_driver_services;
use crate::provider::runtime_binding::store::RuntimeBindingSpawnConfig;
use crate::provider::runtime_binding::test_store::{binding_input, open_store, spawned_build};
use crate::session::run::engine::RUN_ENGINE_STATEMENT_CAPACITY;
use crate::session::run::engine::tests::{insert_running_run, test_engine};
use crate::session::run::epochs::{EpochBinding, ExecutionEpochs};
use crate::session::run::inbound::RunInboundDispatch;

/// The live turn the session's run is on.
pub(super) const TEST_TURN: &str = "turn-1";

/// What the run queue's intake was told, telling a waiter at each.
#[derive(Default)]
pub(super) struct RecordedQueue {
    pub(super) taken: Mutex<Vec<String>>,
    pub(super) refused: Mutex<Vec<(String, QueueItemNotDeliveredReason)>>,
    pub(super) changed: Notify,
}

impl MessageTakenListener for RecordedQueue {
    fn message_taken(&self, _session_id: SessionId, message_id: &str, _run_id: RunId) {
        lock(&self.taken).push(message_id.to_owned());
        self.changed.notify_one();
    }
}

impl MessageRefusedListener for RecordedQueue {
    fn message_refused(
        &self,
        _session_id: SessionId,
        message_id: &str,
        reason: QueueItemNotDeliveredReason,
    ) {
        lock(&self.refused).push((message_id.to_owned(), reason));
        self.changed.notify_one();
    }
}

/// A session live in the composed driver and its run, running on [`TEST_TURN`] unless the session
/// opened idle.
pub(super) struct LiveCodexSession {
    pub(super) driver: CodexDriver,
    pub(super) session_id: SessionId,
    pub(super) run_id: RunId,
    pub(super) binding_id: RuntimeBindingId,
    pub(super) scripted: ScriptedCodexService,
    pub(super) queue: Arc<RecordedQueue>,
    pub(super) database: TestDatabase,
    _home: TempDir,
}

impl LiveCodexSession {
    /// The session with `steers` sent into its turn and not yet echoed.
    pub(super) async fn start(steers: &[QueueItemId]) -> Self {
        Self::open(Some(steers)).await
    }

    /// The session with no turn running, its run bound but not started.
    pub(super) async fn idle() -> Self {
        Self::open(None).await
    }

    // The session, its run on a turn with `steers` unechoed in it where they are given.
    async fn open(steers: Option<&[QueueItemId]>) -> Self {
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
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        let agent_id = insert_lead(&database, session_id, DESCRIPTOR.id);
        let mut services = test_driver_services();
        services.pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            RUN_ENGINE_STATEMENT_CAPACITY,
        ));
        let queue = Arc::new(RecordedQueue::default());
        let ports = &services.ports;
        assert!(ports.run_engine.register(engine).is_ok());
        assert!(ports.inbound_dispatch.register(dispatch).is_ok());
        assert!(
            ports
                .daemon_turn_bindings
                .register(Arc::new(TestDaemonTurnBindings::new(agent_id)))
                .is_ok()
        );
        assert!(ports.message_taken.register(queue.clone()).is_ok());
        assert!(ports.message_refused.register(queue.clone()).is_ok());
        let driver = CodexDriver::new(&services);
        let parts = Arc::clone(driver.parts().expect("the driver composes"));

        let run_id = new_run_id();
        insert_running_run(&database, session_id, run_id);
        let binding_id = open_store(&database)
            .await
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
        let (mut record, routing) = open_test_record(
            &scripted,
            session_id,
            inbound,
            &parts.delivery,
            parts.pending_compactions.clone(),
        )
        .await;
        if let Some(steers) = steers {
            record.add_active_turn(TEST_TURN.to_owned(), run_id);
            parts.run_routes.bind_run(run_id, session_id);
            if !steers.is_empty() {
                record
                    .unechoed_steers_by_turn_id
                    .insert(TEST_TURN.to_owned(), steers.to_vec());
            }
        }
        let intake = CodexSessionIntake::new(record, routing, Arc::clone(&parts));
        driver
            .tasks
            .spawn(intake.run(receiver, CodexRoutedFrames::default()));
        Self {
            driver,
            session_id,
            run_id,
            binding_id,
            scripted,
            queue,
            database,
            _home: home,
        }
    }
}
