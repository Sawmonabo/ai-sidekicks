//! Starting a Codex turn for a run: the person's words, picked skills and staged files, the turn's
//! model, speed, mode, reviewer and output schema, and the route that lets the run's steers,
//! interrupts and terminal find the turn. The session's task checks and records the start and
//! reads Codex's answer; the request goes between, off the task, one turn start per session at a
//! time. Codex runs a turn the daemon stopped until its end arrives and folds a turn sent onto a
//! busy conversation into the running one, so no turn starts before every stopped turn ended, and
//! every wait and the request of one start share the start's own deadline. A conversation that
//! owes a fork onto a changed config forks before the turn, once its turns settled.

pub(crate) mod daemon_turns;
pub(crate) mod record;

use std::error::Error;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use crate::keyed_lock::{KeyHold, KeyedLock};
use crate::provider::driver::attachments::AttachmentResolver;
use crate::provider::driver::codex::attachments::resolve_codex_turn_message;
use crate::provider::driver::codex::output_speed::CodexSettledOutputSpeed;
use crate::provider::driver::codex::run::routes::{CodexRunBinding, CodexRunRoutes};
use crate::provider::driver::codex::run::start::record::{
    CodexAcceptedTurn, CodexTurnBegin, CodexTurnBeginAnswer, CodexTurnRequest, CodexTurnSend,
    CodexTurnStartOutcome,
};
use crate::provider::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::provider::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::codex::thread::view::read_turn_id;
use crate::provider::driver::codex::transport::diagnostics::{
    CodexDeliveryPort, CodexTransportDiagnostic,
};
use crate::provider::driver::contract::StartRunParams;
use crate::provider::driver::run_control::DaemonTurnBindingResolver;
use crate::session::console_state::read_session_max_steps_per_turn;
use crate::session::run::engine::RunEngine;

/// How long a turn's start may take before it counts as not started. `turn/start` answers once
/// Codex accepted the turn, so it matches the ordinary request deadline.
pub(crate) const CODEX_TURN_START_TIMEOUT: Duration = Duration::from_secs(60);

const TURN_START_METHOD: &str = "turn/start";

/// What starting turns acts through.
pub(crate) struct CodexRunStartDependencies {
    /// The sessions' slots, through which a start reaches a session's queue.
    pub(crate) slots: Arc<CodexSessionSlots>,
    /// The config forks a turn waits for and runs first.
    pub(crate) config_forks: Arc<CodexConfigForks>,
    /// The driver's run routes.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The run engine, which opens a turn the daemon starts as the session's own run and takes
    /// each run's settled output speed.
    pub(crate) engine: Arc<RunEngine>,
    /// Opens the binding of a turn the daemon starts.
    pub(crate) daemon_turn_bindings: Arc<dyn DaemonTurnBindingResolver>,
    /// Binds a message's staged files.
    pub(crate) attachments: Arc<dyn AttachmentResolver>,
    /// The read pool the session's step bound is read from.
    pub(crate) reads: Arc<DatabaseReadPool>,
}

/// Starts turns for runs and routes each accepted turn to its run.
pub(crate) struct CodexRunStart {
    dependencies: CodexRunStartDependencies,
    /// Each session's turn starts and the requests sent apart from them, one at a time.
    turn_sends: KeyedLock<SessionId>,
}

impl CodexRunStart {
    /// Turn starts acting through `dependencies`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the Codex driver builds its run start")
    )]
    pub(crate) fn new(dependencies: CodexRunStartDependencies) -> Self {
        Self {
            dependencies,
            turn_sends: KeyedLock::new(),
        }
    }

    /// Starts one run's turn with its opening message on the binding the daemon opened for it,
    /// after a config fork in flight on the session, once every turn the daemon is stopping ended,
    /// every wait within one turn-start deadline. A run whose turn did not start keeps no route,
    /// and the session keeps the binding it had. Fails with `CodexError::SessionTurnInFlight` when
    /// a stopping turn outlived the deadline or a turn Codex started runs, with
    /// `CodexError::PortFailed` when the message's files or the step bound cannot be read, and as
    /// the config fork and the request fail.
    #[expect(dead_code, reason = "the Codex driver's run start")]
    pub(crate) async fn start_run(&self, params: StartRunParams) -> Result<(), CodexError> {
        let opening = params.opening;
        let session_id = opening.session_id;
        let run_id = params.run_id;
        // A run arriving while the conversation forks onto its new config runs on the fork.
        self.dependencies.config_forks.join(session_id).await;
        let inbound = self.dependencies.slots.require_live(session_id)?;
        let message = resolve_codex_turn_message(
            &*self.dependencies.attachments,
            &session_id,
            &opening.content,
            &opening.attachments,
            &opening.skills,
        )
        .await
        .map_err(|cause| CodexError::PortFailed {
            port: "attachments",
            cause,
        })?;
        let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
        // Before the run's route is recorded: the end of its own interrupted turn forgets it.
        wait_out_stopped_turns(&inbound, &deadline).await?;
        let step_bound = read_codex_step_bound(&self.dependencies.reads, session_id).await?;
        let run_routes = &self.dependencies.run_routes;
        run_routes.bind_run_delivery(
            run_id,
            CodexRunBinding {
                session_id,
                binding_id: opening.binding_id.clone(),
                agent_id: opening.agent_id,
                step_bound,
            },
        );
        let output_speed_for_turn = params
            .output_speed_for_turn
            .map(|level| level.as_str().to_owned());
        if let Some(level) = &output_speed_for_turn {
            run_routes.keep_output_speed_for_turn(run_id, level.clone());
        }
        let turn = CodexTurnRequest {
            messages: vec![message],
            client_message_ids: vec![opening.message_id.to_string()],
            model: None,
            output_speed: params.output_speed.map(|level| level.as_str().to_owned()),
            output_speed_for_turn,
            output_schema: params.output_schema.map(serde_json::Value::Object),
            level: params.execution_posture.as_ref().map(posture_level),
        };
        let started = self
            .start_turn(&inbound, run_id, opening.binding_id, turn, None, &deadline)
            .await;
        if started.is_err() {
            run_routes.forget_run(run_id);
        }
        started
    }

    /// Starts one turn of `run_id` on the session `inbound` reaches and routes it to the run, on
    /// `binding_id`, after the fork onto any config the conversation still owes, waiting out every
    /// turn the daemon is stopping, every wait and the request within `deadline`. A refusal Codex
    /// answered leaves the session usable; any other failure may hide an accepted turn, so that
    /// turn is interrupted and the session's conversation let go before the failure is answered.
    /// Fails as [`Self::start_run`] does, and with `CodexError::TurnWithdrawn`, nothing sent, once
    /// `withdrawn` is set before the turn goes.
    pub(crate) async fn start_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        run_id: RunId,
        binding_id: RuntimeBindingId,
        turn: CodexTurnRequest,
        withdrawn: Option<Arc<AtomicBool>>,
        deadline: &CodexTurnEndDeadline,
    ) -> Result<(), CodexError> {
        let hold = self.turn_sends.acquire(inbound.session_id()).await;
        let begin = CodexTurnBegin {
            run_id,
            turn: Some(turn),
            binding_id,
            withdrawn,
        };
        let send = self.begin_turn(&hold, inbound, begin, deadline).await?;
        let params = send
            .params
            .as_ref()
            .expect("a run's own turn carries its params");
        let replied = send
            .connection
            .request_within(TURN_START_METHOD, params, deadline.remaining())
            .await
            .and_then(|reply| read_turn_id(&reply, TURN_START_METHOD));
        self.settle_turn(
            inbound,
            run_id,
            send.accepted,
            CodexTurnStartOutcome::of_request(replied),
        )
        .await
    }

    /// Runs `send` while no turn of `session_id` is being sent or awaits Codex's answer, holding
    /// the session's turn starts until it settles: for a request, such as a goal, that changes
    /// what Codex starts next.
    pub(crate) async fn send_apart_from_turn_starts<Answer>(
        &self,
        session_id: SessionId,
        send: impl Future<Output = Answer>,
    ) -> Answer {
        let _hold = self.turn_sends.acquire(session_id).await;
        send.await
    }

    // Takes the turn's start on the session's task once nothing holds it back: a turn the daemon
    // is stopping is waited out, and a config fork the conversation owes runs once the session is
    // idle, each within `deadline`, the start taken again after each.
    async fn begin_turn(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        inbound: &CodexSessionInboundSender,
        begin: CodexTurnBegin,
        deadline: &CodexTurnEndDeadline,
    ) -> Result<CodexTurnSend, CodexError> {
        loop {
            let answer = call_codex_session(inbound, |reply| CodexSessionCall::BeginTurnStart {
                begin: Box::new(begin.clone()),
                reply,
            })
            .await?;
            match answer {
                CodexTurnBeginAnswer::Ready(send) => return Ok(*send),
                CodexTurnBeginAnswer::WaitForStoppedTurns => {
                    wait_out_stopped_turns(inbound, deadline).await?;
                }
                CodexTurnBeginAnswer::ForkOwed => self.fork_before_turn(inbound, deadline).await?,
                CodexTurnBeginAnswer::Refused(error) => return Err(error),
            }
        }
    }

    // Settles the turn's start on the session's task with Codex's outcome, then hands the run
    // engine the speed a turn that already ended settled at.
    async fn settle_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        run_id: RunId,
        accepted: CodexAcceptedTurn,
        outcome: CodexTurnStartOutcome,
    ) -> Result<(), CodexError> {
        let settled = call_codex_session(inbound, |reply| CodexSessionCall::SettleTurnStart {
            run_id,
            accepted: Box::new(accepted),
            outcome,
            reply,
        })
        .await??;
        if let Some(settled) = settled {
            self.record_settled_output_speed(settled).await;
        }
        Ok(())
    }

    // The fork the conversation owes, once no turn runs, starts or ends on it within `deadline`,
    // else the turn is refused.
    async fn fork_before_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        deadline: &CodexTurnEndDeadline,
    ) -> Result<(), CodexError> {
        if !wait_for_codex_turns(inbound, CodexTurnWait::Idle, Some(deadline)).await? {
            return Err(CodexError::SessionTurnInFlight {
                session_id: inbound.session_id(),
            });
        }
        self.dependencies
            .config_forks
            .fork(inbound.session_id(), inbound)
            .await
            .map(drop)
            .map_err(|error| CodexError::Transport {
                detail: error.to_string(),
                cause: Some(Box::new(error)),
            })
    }

    async fn record_settled_output_speed(&self, settled: CodexSettledOutputSpeed) {
        if let Err(error) = self
            .dependencies
            .engine
            .record_settled_output_speed(settled.session_id, settled.run_id, &settled.state)
            .await
        {
            CodexTransportDiagnostic::PortDeliveryFailed {
                provider_account_id: settled.provider_account_id,
                port: CodexDeliveryPort::OutputSpeed,
                session_id: Some(settled.session_id),
                error: Box::new(error),
            }
            .report();
        }
    }
}

/// The session's own bound on the steps one turn may take, read as a run starts. Fails with
/// `CodexError::PortFailed` when the read fails.
pub(crate) async fn read_codex_step_bound(
    reads: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<Option<SafeInt<1>>, CodexError> {
    reads
        .read(ReadLength::Short, move |reader| {
            Ok::<_, Box<dyn Error + Send + Sync>>(read_session_max_steps_per_turn(
                reader,
                &session_id,
            )?)
        })
        .await
        .map_err(|cause| CodexError::PortFailed {
            port: "session console state",
            cause,
        })
}

// Waits for every turn the daemon is stopping to end within `deadline`, or refuses the turn.
async fn wait_out_stopped_turns(
    inbound: &CodexSessionInboundSender,
    deadline: &CodexTurnEndDeadline,
) -> Result<(), CodexError> {
    if wait_for_codex_turns(inbound, CodexTurnWait::StoppedTurns, Some(deadline)).await? {
        Ok(())
    } else {
        Err(CodexError::SessionTurnInFlight {
            session_id: inbound.session_id(),
        })
    }
}

// The level a run's posture runs at.
fn posture_level(posture: &ExecutionPosture) -> PermissionLevel {
    match posture {
        ExecutionPosture::Readonly { .. } => PermissionLevel::Readonly,
        ExecutionPosture::Ask { .. } => PermissionLevel::Ask,
        ExecutionPosture::Reviewed { .. } => PermissionLevel::Reviewed,
        ExecutionPosture::Sandboxed { .. } => PermissionLevel::Sandboxed,
        ExecutionPosture::Yolo { .. } => PermissionLevel::Yolo,
    }
}

#[cfg(test)]
mod tests;
