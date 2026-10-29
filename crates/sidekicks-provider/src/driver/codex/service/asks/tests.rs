use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::driver::codex::server_requests::{
    CodexInboundServerRequest, CodexServerRequestDecision,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInboundHandler, codex_session_inbound,
    drain_codex_session_inbound,
};
use crate::driver::codex::session::lifecycle_call::CodexLifecycleCall;
use crate::driver::codex::transport::connection::CodexForgottenRequest;
use crate::driver::contract::error::DriverError;

/// How many items the test queues for its session.
const QUEUED_ITEMS: usize = 3;

// Records what reached the session, in order, and lets the session go once all of it arrived.
struct ArrivalOrder {
    service: Arc<CodexService>,
    session_id: SessionId,
    arrived: Vec<String>,
}

impl ArrivalOrder {
    fn note(&mut self, arrival: String) {
        self.arrived.push(arrival);
        if self.arrived.len() == QUEUED_ITEMS {
            self.service.detach_session(&self.session_id);
        }
    }
}

impl CodexSessionInboundHandler for ArrivalOrder {
    fn frame(&mut self, method: String, _params: Box<RawValue>) -> BoxFuture<'_, ()> {
        self.note(method);
        async {}.boxed()
    }

    fn ask(
        &mut self,
        request: CodexInboundServerRequest,
        _decision: oneshot::Sender<Result<CodexServerRequestDecision, DriverError>>,
    ) -> BoxFuture<'_, ()> {
        self.note(format!("ask {}", request.method.method()));
        async {}.boxed()
    }

    fn asks_withdrawn(&mut self, _dropped: Vec<CodexForgottenRequest>) -> BoxFuture<'_, ()> {
        unreachable!("the connection stays open")
    }

    fn held_thread(&mut self, _thread_id: String, _is_held: bool) {
        unreachable!("no conversation is held")
    }

    fn next_deadline(&self) -> Option<Instant> {
        None
    }

    fn deadline_reached(&mut self, _now: Instant) -> BoxFuture<'_, ()> {
        unreachable!("no deadline waits")
    }

    fn call(&mut self, _call: CodexSessionCall) -> BoxFuture<'_, ()> {
        unreachable!("the driver makes no call")
    }

    fn lifecycle(&mut self, _call: CodexLifecycleCall) -> BoxFuture<'_, ()> {
        unreachable!("the driver makes no call")
    }
}

// Fails when an ask is queued for its session from a task the reader spawns rather than on the
// reader itself, which lands it after the frame that followed it: on a runtime of one thread the
// spawned task cannot run before the reader yields.
#[tokio::test(flavor = "current_thread")]
async fn an_ask_keeps_its_place_among_the_frames_around_it() {
    let scripted = start_scripted_codex_service();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    let (sender, receiver) = codex_session_inbound(session_id);
    scripted.service.attach_session(sender);
    scripted
        .service
        .register_thread("thread-1".to_owned(), session_id);
    let thread = json!({"threadId": "thread-1", "turnId": "turn-1"});
    scripted
        .script
        .send(&json!({"jsonrpc": "2.0", "method": "turn/started",
        "params": {"threadId": "thread-1", "turn": {"id": "turn-1"}}}));
    scripted.script.send(&json!({"jsonrpc": "2.0", "id": 7,
        "method": "item/commandExecution/requestApproval", "params": thread}));
    scripted
        .script
        .send(&json!({"jsonrpc": "2.0", "method": "turn/completed",
        "params": {"threadId": "thread-1", "turn": {"id": "turn-1"}}}));

    let mut order = ArrivalOrder {
        service: Arc::clone(&scripted.service),
        session_id,
        arrived: Vec::new(),
    };
    drain_codex_session_inbound(receiver, &mut order).await;

    assert_eq!(
        order.arrived,
        [
            "turn/started",
            "ask item/commandExecution/requestApproval",
            "turn/completed"
        ]
    );
}
