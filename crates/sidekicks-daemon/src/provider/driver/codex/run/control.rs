//! Acting on a running Codex turn: interrupting it, steering it, and pausing and continuing its
//! run. An interrupt, the person's or the daemon's, marks its turn so no later steer goes into it,
//! lets every steer sent before it reach Codex first, and once the turn's end arrived answers the
//! steers Codex dropped unechoed, which the queue gives back. A steer goes out with its files as
//! soon as it is handed over, behind the conversation's steer before it. A pause interrupts its
//! turn at the next step's end, its run paused once that turn ended; a continue steers into a
//! turn still running, waits for a pause on its way, or starts the paused run's next turn.

pub(crate) mod record;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio_util::task::TaskTracker;

use crate::provider::driver::attachments::AttachmentResolver;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::app_server_protocol::UserInput;
use crate::provider::driver::codex::attachments::{
    compose_codex_message_input, resolve_codex_turn_message,
};
use crate::provider::driver::codex::intervention::{
    CodexInterventionRuntime, CodexSteerAcknowledgment, CodexSteerRunRequest,
};
use crate::provider::driver::codex::run::control::record::{
    CodexContinuePlace, CodexRunControlCall,
};
use crate::provider::driver::codex::run::faster_model_retry::{
    CodexFasterModelRetries, CodexStoppedRetry,
};
use crate::provider::driver::codex::run::routes::CodexRunRoutes;
use crate::provider::driver::codex::run::start::record::CodexTurnRequest;
use crate::provider::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::provider::driver::codex::run::steer::steer_codex_run;
use crate::provider::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::provider::driver::codex::run::turn_interrupt::interrupt_codex_turn;
use crate::provider::driver::codex::session::background_terminals::end_codex_running_commands;
use crate::provider::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::contract::{DriverError, bound_failure_detail};
use crate::provider::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::provider::driver::run_control::{
    InterruptRunRequest, PauseRunParams, ResumeRunParams, SteerTurnEndedError, WaitingMessage,
};
use crate::provider::port::registration::PortRegistration;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery, RunInboundDispatch};
use crate::session::run::pause::{ContinuedMessages, RunPauseControl};
use crate::session::run::state_change::{RunStateChange, RunStateEntry};

/// The words a continue that could not start fails its run with.
const CONTINUE_FAILED: &str = "Failed to continue the run";

/// What run control acts through.
pub(crate) struct CodexRunControlDependencies {
    /// The sessions' slots, through which run control reaches a session's queue.
    pub(crate) slots: Arc<CodexSessionSlots>,
    /// The config forks a continue waits for.
    pub(crate) config_forks: Arc<CodexConfigForks>,
    /// The driver's run routes.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The run start, which a continue starts its turn through and an interrupt withdraws a
    /// start in flight from.
    pub(crate) run_start: Arc<CodexRunStart>,
    /// The faster-model retries, which an interrupt stops.
    pub(crate) retries: Arc<CodexFasterModelRetries>,
    /// Binds a message's staged files.
    pub(crate) attachments: Arc<dyn AttachmentResolver>,
    /// The run engine's dispatch, which takes a run's `paused` and a lost continue's end.
    pub(crate) dispatch: Arc<RunInboundDispatch>,
    /// The pause and continue of runs, which settles the messages a continue's start took.
    pub(crate) run_pauses: Arc<PortRegistration<Arc<RunPauseControl>>>,
    /// The messages waiting for paused runs, as the queue holds them.
    pub(crate) continued_messages: Arc<PortRegistration<Arc<dyn ContinuedMessages>>>,
    /// The driver's tracked tasks: a pause's interrupt and a continue started off the session's
    /// task.
    pub(crate) tasks: TaskTracker,
}

/// Interrupts, steers, pauses and continues runs on their live turns.
pub(crate) struct CodexRunControl {
    dependencies: CodexRunControlDependencies,
}

impl CodexRunControl {
    /// Run control acting through `dependencies`.
    pub(crate) fn new(dependencies: CodexRunControlDependencies) -> Self {
        Self { dependencies }
    }

    /// Interrupts the run's live turn and answers the steers Codex dropped. A retry in flight is
    /// stopped instead, the commands its held turn left running ended, and answers the steers that
    /// turn dropped; a retry whose new turn already runs is interrupted as that live turn. A turn
    /// start in flight is withdrawn, its turn interrupted once Codex names it. A run with no turn
    /// in flight answers at once with nothing sent. Fails as [`interrupt_codex_run`] does.
    pub(crate) async fn interrupt_run(
        &self,
        run_id: RunId,
    ) -> Result<Vec<QueueItemId>, CodexError> {
        if let Some(mut stopped) = self.dependencies.retries.cancel(run_id).await? {
            let dropped = std::mem::take(&mut stopped.dropped_steers);
            self.end_held_turn_commands(stopped).await?;
            return Ok(dropped);
        }
        if self.dependencies.run_start.withdraw_turn_start(run_id) {
            return Ok(Vec::new());
        }
        let Some(session_id) = self.dependencies.run_routes.session_id_for(run_id) else {
            return Ok(Vec::new());
        };
        let inbound = self.dependencies.slots.require_live(session_id)?;
        interrupt_codex_run(&inbound, run_id).await
    }

    /// Steers one message and its files into the run's live turn as soon as it is handed over,
    /// once Codex answered the conversation's steer before it. Fails with `SteerTurnEnded` when
    /// the run's turn has ended or an interrupt is stopping it, before or while the steer waited,
    /// and as the files and the send fail.
    pub(crate) async fn steer_run(
        &self,
        request: CodexSteerRunRequest,
    ) -> Result<CodexSteerAcknowledgment, DriverError> {
        let run_id = request.run_id;
        let Some(session_id) = self.dependencies.run_routes.session_id_for(run_id) else {
            return Err(SteerTurnEndedError { run_id }.into());
        };
        let inbound = self.dependencies.slots.require_live(session_id)?;
        let input = self.compose_steer_input(
            session_id,
            WaitingMessage {
                id: request.client_idempotency_key,
                content: request.content,
                attachments: request.attachments,
                skills: request.skills,
            },
        );
        steer_codex_run(
            &inbound,
            run_id,
            request.expected_turn_id,
            request.client_idempotency_key,
            input,
        )
        .await
    }

    /// Pauses the run at its live turn's next step end, where its turn is interrupted; the run is
    /// reported paused once that turn ended. Fails with `CodexError::Transport` for a run with no
    /// live turn on the session, a helper's among them.
    pub(crate) async fn pause_run(&self, params: PauseRunParams) -> Result<(), CodexError> {
        let inbound = self.dependencies.slots.require_live(params.session_id)?;
        call_codex_session(&inbound, |reply| {
            CodexSessionCall::RunControl(CodexRunControlCall::MarkPause {
                run_id: params.run_id,
                reply,
            })
        })
        .await?
    }

    /// Continues a run with the messages that waited for it, files and all: a pause not yet taken
    /// effect is dropped and the messages steered into the turn still running, one whose
    /// interrupt is on its way continues once that turn ended, and a paused run starts its next
    /// turn with them. Fails as the steer or the turn's start fails.
    pub(crate) async fn resume_run(&self, params: ResumeRunParams) -> Result<(), DriverError> {
        let session_id = params.session_id;
        self.dependencies.config_forks.join(session_id).await;
        let inbound = self.dependencies.slots.require_live(session_id)?;
        let place = call_codex_session(&inbound, |reply| {
            CodexSessionCall::RunControl(CodexRunControlCall::PlaceContinue { params, reply })
        })
        .await?;
        match place {
            CodexContinuePlace::SteerInto { turn_id, params } => {
                self.steer_waiting(&inbound, &turn_id, params).await
            }
            CodexContinuePlace::AwaitsPause => Ok(()),
            CodexContinuePlace::StartTurn(params) => {
                Ok(self.continue_run(&inbound, params).await?)
            }
        }
    }

    /// Acts on the end of a step of the turn `turn_id`, on the session's task: a pause waiting
    /// for it interrupts the turn, its answer settled off the task. The pause's mark holds until
    /// the turn's end, which a continue asked for meanwhile waits for, whatever Codex answered.
    /// Never fails; what fails is reported.
    pub(crate) fn observe_step_end(
        self: &Arc<Self>,
        record: &mut CodexSessionRecord,
        turn_id: &str,
    ) {
        let Some(run_id) = record.pause_run_id_by_turn_id.remove(turn_id) else {
            return;
        };
        // Marked before the interrupt goes out, so a continue meanwhile waits for the turn's end.
        record
            .paused_run_id_by_interrupted_turn_id
            .insert(turn_id.to_owned(), run_id);
        record.interrupting_turn_ids.insert(turn_id.to_owned());
        let inbound = record.inbound.clone();
        let connection = record.service.connection();
        let thread_id = record.thread_id.clone();
        let turn_id = turn_id.to_owned();
        // Codex answers the interrupt once the turn aborted, while the session's frames go on.
        self.dependencies.tasks.spawn(async move {
            let interrupted = match connection {
                Ok(connection) => interrupt_codex_turn(&connection, &thread_id, &turn_id).await,
                Err(error) => Err(error),
            };
            let answer = match interrupted {
                Ok(answer) => Some(answer),
                Err(error) => {
                    CodexTransportDiagnostic::PauseInterruptFailed {
                        thread_id,
                        error: Box::new(error),
                    }
                    .report();
                    None
                }
            };
            // A session whose task ended keeps no turn to settle.
            let _unheard = inbound.push(CodexSessionInbound::Call(CodexSessionCall::RunControl(
                CodexRunControlCall::SettlePauseInterrupt { turn_id, answer },
            )));
        });
    }

    /// Acts on the end of the turn `turn_id`, on the session's task: a pause waiting for a step
    /// that never came is dropped, and a pause's interrupted turn reports its run paused, or
    /// starts the continue asked for meanwhile off the task. A continue that cannot start fails
    /// its run, which no turn would end.
    pub(crate) async fn observe_turn_ended(
        self: &Arc<Self>,
        record: &mut CodexSessionRecord,
        turn_id: &str,
    ) {
        record.pause_run_id_by_turn_id.remove(turn_id);
        let Some(run_id) = record.paused_run_id_by_interrupted_turn_id.remove(turn_id) else {
            return;
        };
        if let Some(params) = record.continues_awaiting_pause.remove(&run_id) {
            let control = Arc::clone(self);
            let inbound = record.inbound.clone();
            self.dependencies.tasks.spawn(async move {
                if let Err(error) = control.continue_run(&inbound, params).await
                    && let Some(binding) = control.dependencies.run_routes.binding_for(run_id)
                {
                    fail_codex_run(
                        &control.dependencies.dispatch,
                        run_id,
                        binding.binding_id,
                        CONTINUE_FAILED,
                        &error,
                    )
                    .await;
                }
            });
            return;
        }
        let Some(binding) = self.dependencies.run_routes.binding_for(run_id) else {
            return;
        };
        let change = RunStateChange {
            expected_state: Some(RunState::Pausing),
            ..RunStateChange::new(run_id, RunStateEntry::Paused)
        };
        Box::pin(dispatch_delivery(
            &self.dependencies.dispatch,
            DeliveryOrigin {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id: record.provider_account_id.clone(),
                raw_wire_type: Some("turn/completed"),
            },
            InboundDelivery::RunLifecycle {
                binding: DeliveryBinding {
                    binding_id: binding.binding_id,
                    operation: None,
                },
                change,
                turn_end: None,
                is_daemon_interrupt_end: false,
            },
        ))
        .await;
    }

    // Steers a run's waiting messages and their files, in send order, into its running turn.
    async fn steer_waiting(
        &self,
        inbound: &CodexSessionInboundSender,
        turn_id: &str,
        params: ResumeRunParams,
    ) -> Result<(), DriverError> {
        for message in params.messages {
            let message_id = message.id;
            let input = self.compose_steer_input(params.session_id, message);
            steer_codex_run(
                inbound,
                params.run_id,
                Some(turn_id.to_owned()),
                message_id,
                input,
            )
            .await?;
        }
        Ok(())
    }

    // Starts a paused run's next turn with the messages that waited for it and their files, then
    // settles as taken the messages earlier continues of the run kept with no answer back.
    async fn continue_run(
        &self,
        inbound: &CodexSessionInboundSender,
        params: ResumeRunParams,
    ) -> Result<(), CodexError> {
        let session_id = params.session_id;
        let run_id = params.run_id;
        let Some(binding) = self.dependencies.run_routes.binding_for(run_id) else {
            return Err(CodexError::Transport {
                detail: format!("Run \"{run_id}\" has no binding to continue on."),
                cause: None,
            });
        };
        let mut messages = Vec::with_capacity(params.messages.len());
        let mut client_message_ids = Vec::with_capacity(params.messages.len());
        for message in &params.messages {
            messages.push(
                resolve_codex_turn_message(
                    &*self.dependencies.attachments,
                    &session_id,
                    &message.content,
                    &message.attachments,
                    &message.skills,
                )
                .await
                .map_err(|cause| CodexError::PortFailed {
                    port: "attachments",
                    cause,
                })?,
            );
            client_message_ids.push(message.id.to_string());
        }
        let turn = CodexTurnRequest {
            messages,
            client_message_ids,
            model: None,
            output_speed: None,
            // The level the run alone was asked to run at holds for each turn it takes.
            output_speed_for_turn: self
                .dependencies
                .run_routes
                .output_speed_for_turn_of(run_id),
            output_schema: None,
            level: None,
        };
        self.dependencies
            .run_start
            .start_turn(
                inbound,
                run_id,
                binding.binding_id,
                turn,
                None,
                &CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT),
            )
            .await?;
        self.settle_kept_as_taken(session_id, run_id).await;
        Ok(())
    }

    // Codex's answer named the continue's turn, so it runs again: the messages an earlier continue
    // of the run sent with no answer back reached it. A failed settle is reported, since the run
    // runs either way.
    async fn settle_kept_as_taken(&self, session_id: SessionId, run_id: RunId) {
        let settled = match (
            self.dependencies.run_pauses.require_port(),
            self.dependencies.continued_messages.require_port(),
        ) {
            (Ok(pauses), Ok(continued)) => pauses
                .settle_kept_as_taken(session_id, run_id, continued.as_ref())
                .await
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>),
            (Err(error), _) | (_, Err(error)) => Err(Box::new(error) as _),
        };
        if let Err(error) = settled {
            tracing::warn!(
                session_id = %session_id,
                run_id = %run_id,
                error = &*error as &(dyn std::error::Error + 'static),
                "the messages a continued Codex run took could not be settled"
            );
        }
    }

    // The input of one steered message: its words, picked skills and files.
    fn compose_steer_input(
        &self,
        session_id: SessionId,
        message: WaitingMessage,
    ) -> BoxFuture<'static, Result<Vec<UserInput>, DriverError>> {
        let attachments = Arc::clone(&self.dependencies.attachments);
        async move {
            let message = resolve_codex_turn_message(
                &*attachments,
                &session_id,
                &message.content,
                &message.attachments,
                &message.skills,
            )
            .await
            .map_err(|cause| CodexError::PortFailed {
                port: "attachments",
                cause,
            })?;
            Ok(compose_codex_message_input(&[message]))
        }
        .boxed()
    }

    // A retry the interrupt stopped held its turn's commands running; they end, since an
    // interrupt stops none.
    async fn end_held_turn_commands(&self, stopped: CodexStoppedRetry) -> Result<(), CodexError> {
        let inbound = self.dependencies.slots.require_live(stopped.session_id)?;
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        end_codex_running_commands(&*reading.connection?, &stopped.held_thread_id, false).await;
        Ok(())
    }
}

impl CodexInterventionRuntime for CodexRunControl {
    fn steer_run(
        &self,
        request: CodexSteerRunRequest,
    ) -> BoxFuture<'_, Result<CodexSteerAcknowledgment, DriverError>> {
        self.steer_run(request).boxed()
    }

    fn interrupt_run(
        &self,
        params: InterruptRunRequest,
    ) -> BoxFuture<'_, Result<Vec<QueueItemId>, DriverError>> {
        async move { Ok(self.interrupt_run(params.run_id).await?) }.boxed()
    }
}

/// Interrupts `run_id`'s newest live turn on the session `inbound` reaches, for the person's and
/// the daemon's interrupts alike: the turn is marked first, so no later steer goes into it; the
/// steers sent before it reach Codex first; then `turn/interrupt` goes, the turn leaves its run's
/// routes and the commands it left running end. Once the turn's end arrived, or past the request
/// deadline, answers the steers it still held unechoed, which Codex's abort dropped. A run with no
/// live turn answers at once with nothing sent. Fails as the interrupt fails, the turn running on
/// as the run's.
pub(crate) async fn interrupt_codex_run(
    inbound: &CodexSessionInboundSender,
    run_id: RunId,
) -> Result<Vec<QueueItemId>, CodexError> {
    let send = call_codex_session(inbound, |reply| {
        CodexSessionCall::RunControl(CodexRunControlCall::BeginInterrupt { run_id, reply })
    })
    .await??;
    let Some(send) = send else {
        return Ok(Vec::new());
    };
    if let Some(steers_sent) = send.steers_sent {
        steers_sent.await;
    }
    let interrupted = interrupt_codex_turn(&send.connection, &send.thread_id, &send.turn_id).await;
    // A session whose task ended keeps no turn to settle.
    let _unheard = inbound.push(CodexSessionInbound::Call(CodexSessionCall::RunControl(
        CodexRunControlCall::SettleInterrupt {
            run_id,
            turn_id: send.turn_id.clone(),
            is_stopped: interrupted.is_ok(),
        },
    )));
    interrupted?;
    end_codex_running_commands(&send.connection, &send.thread_id, false).await;
    // Codex writes every echo of the turn before its end, so what the turn still holds then is
    // what the abort dropped; past the deadline the abort, which came before the interrupt's
    // answer, already dropped it.
    let ended = wait_for_codex_turns(
        inbound,
        CodexTurnWait::End {
            turn_id: send.turn_id.clone(),
        },
        Some(&CodexTurnEndDeadline::for_request()),
    )
    .await;
    if ended.is_err() {
        // The session closed or let its record go: its close settles every message it held.
        return Ok(Vec::new());
    }
    let dropped = call_codex_session(inbound, |reply| {
        CodexSessionCall::RunControl(CodexRunControlCall::TakeDroppedSteers {
            turn_id: send.turn_id,
            reply,
        })
    })
    .await;
    Ok(dropped.unwrap_or_default())
}

/// Ends `run_id` failed on `binding_id` with `failure` and the error that caused it, as a provider
/// failure, for a run no turn of Codex's will end.
pub(crate) async fn fail_codex_run(
    dispatch: &RunInboundDispatch,
    run_id: RunId,
    binding_id: RuntimeBindingId,
    failure: &str,
    error: &CodexError,
) {
    let detail = format!("{failure}: {error}");
    let fallback =
        FreeFormText::new(format!("{failure}.")).expect("a run failure's words are within the cap");
    let change = RunStateChange {
        failure_category: Some(RunFailureCategory::ProviderFailure),
        ..RunStateChange::new(
            run_id,
            RunStateEntry::Failed {
                intended_close: None,
                failure_cause: None,
                provider_failure_detail: Some(bound_failure_detail(&detail, fallback)),
                process_exit: None,
            },
        )
    };
    Box::pin(dispatch_delivery(
        dispatch,
        DeliveryOrigin {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: None,
            raw_wire_type: None,
        },
        InboundDelivery::RunLifecycle {
            binding: DeliveryBinding {
                binding_id,
                operation: None,
            },
            change,
            turn_end: None,
            is_daemon_interrupt_end: false,
        },
    ))
    .await;
}
