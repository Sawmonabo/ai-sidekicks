use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::driver::codex::lifecycle::account_move::CodexBindingMove;
use crate::driver::codex::server_requests::{
    CodexInboundServerRequest, CodexServerRequestDecision,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::inbound::{
    CodexAccountMove, CodexSessionCall, CodexSessionInboundHandler, codex_session_inbound,
    drain_codex_session_inbound,
};
use crate::driver::codex::session::lifecycle_call::CodexLifecycleCall;
use crate::driver::codex::telemetry::exported_response::CodexExportedResponse;
use crate::driver::codex::transport::connection::CodexForgottenRequest;
use crate::driver::contract::account::{FirstRequestAfterMove, SessionAccountMove};
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::SessionToolServer;
use crate::port::session_account_move::SessionAccountMoveRecorder;
use crate::runtime_binding::store::RuntimeBindingRebind;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// Each binding move the store was asked for, each move reported as no switch's with the person
/// it names, and the first request of each reported move.
#[derive(Default)]
pub(crate) struct RecordedMoves {
    /// Each binding moved, with the account it moved onto, in order.
    pub(crate) bindings: Mutex<Vec<(RuntimeBindingId, ProviderAccountId)>>,
    reported: Mutex<Vec<(SessionId, ProviderAccountId, Option<DeviceId>)>>,
    first_requests: Mutex<Vec<BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>>>>,
}

impl RecordedMoves {
    /// Each reported move: its session, the account it moved onto, and the person it names.
    pub(crate) fn reported(&self) -> Vec<(SessionId, ProviderAccountId, Option<DeviceId>)> {
        lock(&self.reported).clone()
    }

    /// Settles the first request of each move reported so far, in order.
    pub(crate) async fn settle_reported(&self) -> Vec<FirstRequestAfterMove> {
        let first_requests = std::mem::take(&mut *lock(&self.first_requests));
        let mut settled = Vec::new();
        for first_request in first_requests {
            settled.push(first_request.await.expect("the first request settles"));
        }
        settled
    }

    /// The account each of `binding_ids` was last moved onto, `None` where it never moved.
    pub(crate) fn last_accounts(
        &self,
        binding_ids: &[&RuntimeBindingId],
    ) -> Vec<Option<ProviderAccountId>> {
        let bindings = lock(&self.bindings);
        binding_ids
            .iter()
            .map(|binding_id| {
                bindings
                    .iter()
                    .rev()
                    .find(|(moved, _account)| moved == *binding_id)
                    .map(|(_moved, account)| account.clone())
            })
            .collect()
    }
}

/// The person whose switch the tests make.
pub(crate) fn switching_person() -> DeviceId {
    DeviceId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a device id")
}

impl RuntimeBindingWriter for RecordedMoves {
    fn rebind(
        &self,
        _rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        unreachable!("a switch points no binding at another conversation")
    }

    fn keep_recovery_data(
        &self,
        _binding_id: RuntimeBindingId,
        _runtime_metadata: Map<String, Value>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        unreachable!("a switch keeps no recovery data")
    }

    fn move_account(
        &self,
        binding_id: RuntimeBindingId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.bindings).push((binding_id, provider_account_id));
        async { Ok(()) }.boxed()
    }

    fn replace_tool_servers(
        &self,
        _run_id: RunId,
        _tool_servers: Vec<SessionToolServer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        unreachable!("a switch writes no tool server set")
    }
}

impl SessionAccountMoveRecorder for RecordedMoves {
    fn record_account_moved(
        &self,
        moved: SessionAccountMove,
        provider_account_id: ProviderAccountId,
        actor: Option<DeviceId>,
    ) -> BoxFuture<'_, ()> {
        lock(&self.reported).push((moved.session_id, provider_account_id, actor));
        lock(&self.first_requests).push(moved.first_request);
        async {}.boxed()
    }
}

/// A session's task: what it saw, in order, each frame by method and each move by its account,
/// and its record, whose account and binding each move lands as the session's task lands it.
#[derive(Clone)]
pub(crate) struct SessionQueue {
    seen: Arc<Mutex<Vec<String>>>,
    /// The session.
    pub(crate) session_id: SessionId,
    /// The account its record runs on.
    pub(crate) record_account: Arc<Mutex<ProviderAccountId>>,
    /// Its record's own binding.
    pub(crate) record_binding: RuntimeBindingId,
    moves: Arc<RecordedMoves>,
    recorder: Arc<PortRegistration<Arc<dyn SessionAccountMoveRecorder>>>,
}

impl SessionQueue {
    /// The task of `session_id`, its record on `record_account`, its moves kept in `moves`.
    pub(crate) fn new(
        session_id: SessionId,
        record_account: ProviderAccountId,
        moves: &Arc<RecordedMoves>,
    ) -> Self {
        let recorder = Arc::new(PortRegistration::new("session account moves"));
        assert!(
            recorder
                .register(Arc::clone(moves) as Arc<dyn SessionAccountMoveRecorder>)
                .is_ok()
        );
        Self {
            seen: Arc::default(),
            session_id,
            record_account: Arc::new(Mutex::new(record_account)),
            record_binding: RuntimeBindingId::new(mint_uuid_v7().to_string())
                .expect("a binding id"),
            moves: Arc::clone(moves),
            recorder,
        }
    }

    /// Attaches this session to `service` and drains what reaches it on a task of its own.
    pub(crate) fn attach(&self, service: &CodexService) -> tokio::task::JoinHandle<()> {
        let (sender, receiver) = codex_session_inbound(self.session_id);
        service.attach_session(sender);
        let mut handler = self.clone();
        tokio::spawn(async move {
            drain_codex_session_inbound(receiver, &mut handler).await;
        })
    }

    /// What the session's task saw, in order.
    pub(crate) fn seen(&self) -> Vec<String> {
        lock(&self.seen).clone()
    }

    /// Waits until this session's task saw `count` items, as the service's reader routes them on
    /// its own task.
    pub(crate) async fn wait_until_seen(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.seen().len() < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the session's task sees the frames");
    }
}

impl CodexSessionInboundHandler for SessionQueue {
    fn frame(&mut self, method: String, _params: Box<RawValue>) -> BoxFuture<'_, ()> {
        lock(&self.seen).push(method);
        async {}.boxed()
    }

    fn ask(
        &mut self,
        _request: CodexInboundServerRequest,
        _decision: oneshot::Sender<Result<CodexServerRequestDecision, DriverError>>,
    ) -> BoxFuture<'_, ()> {
        unreachable!("the service asks nothing")
    }

    fn asks_withdrawn(&mut self, _dropped: Vec<CodexForgottenRequest>) -> BoxFuture<'_, ()> {
        unreachable!("the connection stays open")
    }

    fn held_thread(&mut self, _thread_id: String, _is_held: bool) {}

    fn side_question_released(&mut self, _thread_id: String) {}

    fn call(&mut self, _call: CodexSessionCall) -> BoxFuture<'_, ()> {
        unreachable!("the driver makes no call")
    }

    fn lifecycle(&mut self, _call: CodexLifecycleCall) -> BoxFuture<'_, ()> {
        unreachable!("the driver makes no call")
    }

    fn account_moved(&mut self, account_move: CodexAccountMove) -> BoxFuture<'_, ()> {
        lock(&self.seen).push(format!(
            "moved to {}",
            account_move.provider_account_id.as_str()
        ));
        let binding_move = {
            let mut record_account = lock(&self.record_account);
            CodexBindingMove::plan(
                self.session_id,
                Some((&mut *record_account, Some(&self.record_binding))),
                account_move,
            )
        };
        // The test's task meters no spend, so the bindings move at once.
        async move { binding_move.land(&*self.moves, &self.recorder).await }.boxed()
    }

    fn exported_responses(&mut self, _responses: Vec<CodexExportedResponse>) -> BoxFuture<'_, ()> {
        async {}.boxed()
    }

    fn next_deadline(&self) -> Option<Instant> {
        None
    }

    fn deadline_reached(&mut self, _now: Instant) -> BoxFuture<'_, ()> {
        unreachable!("no deadline waits")
    }
}
