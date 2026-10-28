//! Turns the daemon opens with a request of its own rather than a message, such as Codex's own
//! review: sent on the binding the daemon opened for the run the queue admitted, with the run
//! waiting as the turn starting next, so every row of the turn has a run.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;

use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::record::{CodexTurnBegin, CodexTurnStartOutcome};
use crate::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::CodexSessionInboundSender;
use crate::driver::codex::transport::connection::CodexAppServerConnection;

/// Sends the request that makes Codex start a turn the daemon opens, on the connection and
/// conversation it names, within the time left of the start's deadline, and answers the turn its
/// reply names.
pub(crate) type CodexDaemonTurnOpening = Arc<
    dyn Fn(
            Arc<CodexAppServerConnection>,
            String,
            Duration,
        ) -> BoxFuture<'static, Result<String, CodexError>>
        + Send
        + Sync,
>;

impl CodexRunStart {
    /// Routes `run_id` to `binding` and sends the turn `opening` makes on it; a failed start
    /// leaves the run no route.
    pub(super) async fn send_bound_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        run_id: RunId,
        binding: CodexRunBinding,
        opening: CodexDaemonTurnOpening,
    ) -> Result<(), CodexError> {
        let binding_id = binding.binding_id.clone();
        self.dependencies
            .run_routes
            .bind_run_delivery(run_id, binding);
        let sent = self
            .send_daemon_turn(inbound, run_id, binding_id, opening)
            .await;
        if sent.is_err() {
            self.dependencies.run_routes.forget_run(run_id);
        }
        sent
    }

    // Sends the opening with the run waiting as the turn starting next, so the turn's first frames
    // reach it even when they come before the reply; the run's interrupt withdraws it meanwhile.
    async fn send_daemon_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        run_id: RunId,
        binding_id: RuntimeBindingId,
        opening: CodexDaemonTurnOpening,
    ) -> Result<(), CodexError> {
        let withdrawn = Arc::new(AtomicBool::new(false));
        self.withdrawable(inbound, run_id, Arc::clone(&withdrawn), async {
            let hold = self.turn_sends.acquire(inbound.session_id()).await;
            let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
            let begin = CodexTurnBegin {
                run_id,
                turn: None,
                binding_id,
                withdrawn: Some(withdrawn),
            };
            let send = self.begin_turn(&hold, inbound, begin, &deadline).await?;
            let turn_id = opening(
                Arc::clone(&send.connection),
                send.thread_id.clone(),
                deadline.remaining(),
            )
            .await;
            self.settle_turn(
                inbound,
                run_id,
                send.accepted,
                CodexTurnStartOutcome::of_request(turn_id),
            )
            .await
        })
        .await
    }
}
