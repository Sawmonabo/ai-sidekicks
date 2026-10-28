//! Turns the daemon starts on a session itself, such as a review: each runs as the session's own
//! run, opened through the run engine before its request is sent, so every row of the turn has a
//! run. Refused, before any run exists, while a turn runs, starts or is still ending on the
//! session, since Codex would fold it into that turn. A run the queue admitted sends such an
//! opening the same way, on the binding the daemon opened for it.

use std::error::Error;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::run::control::interrupt_codex_run;
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::record::{CodexTurnBegin, CodexTurnStartOutcome};
use crate::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::session::calls::call_codex_session;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::port::run_host::RunHostError;
use crate::run::start_request::DaemonTurnStartRequest;

/// Sends the request that makes Codex start a turn the daemon starts, on the connection and
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

/// Why a turn the daemon starts did not start.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexDaemonTurnError {
    /// The session refused it, or its opening failed before the run engine had a run for it.
    #[error(transparent)]
    Codex(#[from] CodexError),
    /// The run engine refused the session's own run, or its start failed and ended it failed.
    #[error(transparent)]
    Engine(#[from] RunHostError),
}

impl CodexRunStart {
    /// Starts a turn the daemon starts on `session_id` itself as the session's own run, at the
    /// session's current posture, sending it through `opening`, and answers the run's id once
    /// Codex started the turn and the run is running. Fails with
    /// `CodexError::SessionTurnInFlight`, before any run exists, while a turn runs, starts or still
    /// ends on the session; as the run engine refuses or fails the run, a session whose next turn
    /// is held for another run among them; and with the opening's failure, which ends the run
    /// failed.
    pub(crate) async fn start_daemon_turn(
        self: &Arc<Self>,
        session_id: SessionId,
        opening: CodexDaemonTurnOpening,
    ) -> Result<RunId, CodexDaemonTurnError> {
        let inbound = self.dependencies.slots.require_live(session_id)?;
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        if reading.is_turn_in_flight {
            return Err(CodexError::SessionTurnInFlight { session_id }.into());
        }
        let start = Arc::clone(self);
        let start_inbound = inbound.clone();
        let interrupt_inbound = inbound;
        let run_id = self
            .dependencies
            .engine
            .start_daemon_turn(DaemonTurnStartRequest {
                session_id,
                provider: DESCRIPTOR.provider_id(),
                admitted_provider_account_id: reading.provider_account_id,
                execution_posture: reading.execution_posture,
                is_provider_started: false,
                is_apart: false,
                start_turn: Box::new(move |run_id| {
                    let start = Arc::clone(&start);
                    let inbound = start_inbound.clone();
                    let opening = Arc::clone(&opening);
                    async move {
                        start
                            .open_daemon_turn(&inbound, run_id, opening)
                            .await
                            .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
                    }
                    .boxed()
                }),
                // A turn that ended before its run could be recorded has nothing to stop.
                interrupt_turn: Box::new(move |run_id| {
                    let inbound = interrupt_inbound.clone();
                    async move {
                        interrupt_codex_run(&inbound, run_id)
                            .await
                            .map(drop)
                            .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
                    }
                    .boxed()
                }),
            })
            .await?;
        Ok(run_id)
    }

    // Opens the run's binding and sends the turn on it, after a config fork in flight, which moves
    // the session onto its new conversation; a failed start leaves the run no route.
    async fn open_daemon_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        run_id: RunId,
        opening: CodexDaemonTurnOpening,
    ) -> Result<(), CodexError> {
        let session_id = inbound.session_id();
        let binding = self
            .dependencies
            .daemon_turn_bindings
            .open_daemon_turn_binding(run_id, session_id)
            .await
            .map_err(|error| CodexError::PortFailed {
                port: "daemon turn binding",
                cause: Box::new(error),
            })?;
        self.dependencies.config_forks.join(session_id).await;
        self.send_bound_turn(
            inbound,
            run_id,
            CodexRunBinding {
                session_id,
                binding_id: binding.binding_id,
                agent_id: binding.agent_id,
                step_bound: binding.step_bound,
            },
            opening,
        )
        .await
    }

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
