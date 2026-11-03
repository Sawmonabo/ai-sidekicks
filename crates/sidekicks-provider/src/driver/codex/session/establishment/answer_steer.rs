//! The person's answers carried to a held lead whose continuation Codex still runs: steered into
//! that continuation under the first answered card's or question's id once the session's task
//! runs, or, where the continuation ended before the steer was sent, put in a turn of their own
//! after Codex's continuation words. Answers that reach the lead by neither fail its run as a
//! provider failure and are given back to the queue for the next relaunch.

use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::task::TaskTracker;

use super::continuation::CODEX_CONTINUATION_TEXT;
use crate::driver::codex::attachments::compose_codex_message_input;
use crate::driver::codex::run::control::fail_codex_run;
use crate::driver::codex::run::routes::{CodexRunBinding, CodexRunRoutes};
use crate::driver::codex::run::start::record::CodexTurnRequest;
use crate::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::driver::codex::run::steer::steer_codex_run;
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::session::calls::call_codex_session;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::session::state::CodexTurnMessage;
use crate::driver::contract::error::DriverError;
use crate::driver::ports::ContinueGivenBackListener;
use crate::port::inbound_dispatch::InboundDispatch;

/// The words a held lead's run is failed with when the person's answers could not reach it.
const ANSWERS_UNDELIVERED_FAILURE: &str = "The person's answers could not reach the Codex lead";

/// The steer a held lead's running continuation owes the person's answers, sent once the
/// session's task runs, and the turn that carries them where that continuation ended first.
pub(crate) struct CodexAnswerSteer {
    /// The lead.
    pub(super) run_id: RunId,
    /// The continuation Codex runs for it.
    pub(super) turn_id: String,
    /// The first answered card's or question's id, which the steer goes under.
    pub(super) message_id: QueueItemId,
    /// The answers' words.
    pub(super) answer_text: String,
    /// Where the lead's deliveries go.
    pub(super) binding: CodexRunBinding,
}

/// What the answers' steers act through.
pub(crate) struct CodexAnswerSteerDependencies {
    /// The runs' routes, which bind a lead's deliveries again for the answers' own turn.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// Starts the answers' own turn.
    pub(crate) run_start: Arc<CodexRunStart>,
    /// The run engine's dispatch, which takes the failure of a lead the answers did not reach.
    pub(crate) dispatch: Arc<dyn InboundDispatch>,
    /// The run queue's intake of a continue the lead did not carry.
    pub(crate) continue_given_back: Arc<PortRegistration<Arc<dyn ContinueGivenBackListener>>>,
    /// The driver's tracked tasks, which each steer is sent on.
    pub(crate) tasks: TaskTracker,
}

/// Sends each held lead's answers once its session's task runs.
pub(crate) struct CodexAnswerSteers {
    dependencies: CodexAnswerSteerDependencies,
}

impl CodexAnswerSteers {
    /// The steers acting through `dependencies`.
    pub(crate) fn new(dependencies: CodexAnswerSteerDependencies) -> Self {
        Self { dependencies }
    }

    /// Sends `steer` to the session `inbound` reaches, on the driver's tasks, so the session's task
    /// that takes it runs meanwhile.
    pub(crate) fn send(
        self: &Arc<Self>,
        steer: CodexAnswerSteer,
        inbound: CodexSessionInboundSender,
    ) {
        let steers = Arc::clone(self);
        self.dependencies.tasks.spawn(async move {
            steers.deliver(steer, &inbound).await;
        });
    }

    // Steers the answers into the lead's running continuation. Where that continuation ended
    // before the steer was sent, the lead's deliveries are bound to it again and a turn holding
    // Codex's continuation words and the answers is started instead; one that ended with the steer
    // sent ended its run, its answers given back, so nothing more is sent. A steer or a turn that
    // fails otherwise fails the lead's run with the failure and gives the answers back.
    async fn deliver(&self, steer: CodexAnswerSteer, inbound: &CodexSessionInboundSender) {
        let input = compose_codex_message_input(&[CodexTurnMessage {
            text: steer.answer_text.clone(),
            skills: Vec::new(),
            attachments: Vec::new(),
        }]);
        let steered = steer_codex_run(
            inbound,
            steer.run_id,
            Some(steer.turn_id.clone()),
            steer.message_id,
            std::future::ready(Ok(input)),
        )
        .await;
        let failed = match steered {
            Ok(_) => return,
            Err(DriverError::SteerTurnEnded(_)) => {
                let is_owed =
                    call_codex_session(inbound, |reply| CodexSessionCall::TakeAnswerTurnOwed {
                        run_id: steer.run_id,
                        reply,
                    })
                    .await;
                match is_owed {
                    Ok(true) => match self.start_answer_turn(&steer, inbound).await {
                        Ok(()) => return,
                        Err(error) => error,
                    },
                    Ok(false) => return,
                    Err(error) => error,
                }
            }
            Err(error) => CodexError::Driver(error),
        };
        self.fail_undelivered(&steer, inbound, &failed).await;
    }

    // Fails the lead's run as a provider failure with `failed`, its route let go as a failed turn's
    // is, and tells the queue the answers did not reach it, so it gives them back.
    async fn fail_undelivered(
        &self,
        steer: &CodexAnswerSteer,
        inbound: &CodexSessionInboundSender,
        failed: &CodexError,
    ) {
        fail_codex_run(
            &*self.dependencies.dispatch,
            steer.run_id,
            steer.binding.binding_id.clone(),
            ANSWERS_UNDELIVERED_FAILURE,
            failed,
        )
        .await;
        self.dependencies.run_routes.forget_run(steer.run_id);
        if let Some(listener) = self.dependencies.continue_given_back.port() {
            listener.continue_given_back(inbound.session_id(), steer.run_id);
        }
    }

    // Starts the lead's turn holding Codex's continuation words and the answers, its deliveries
    // bound to it again. Fails as the start fails.
    async fn start_answer_turn(
        &self,
        steer: &CodexAnswerSteer,
        inbound: &CodexSessionInboundSender,
    ) -> Result<(), CodexError> {
        let run_routes = &self.dependencies.run_routes;
        run_routes.bind_run(steer.run_id, steer.binding.session_id);
        run_routes.bind_run_delivery(steer.run_id, steer.binding.clone());
        let turn = CodexTurnRequest {
            messages: vec![CodexTurnMessage {
                text: format!("{CODEX_CONTINUATION_TEXT}\n\n{}", steer.answer_text),
                skills: Vec::new(),
                attachments: Vec::new(),
            }],
            client_message_ids: Vec::new(),
            model: None,
            output_speed: None,
            output_speed_for_turn: run_routes.output_speed_for_turn_of(steer.run_id),
            output_schema: None,
            level: None,
        };
        self.dependencies
            .run_start
            .start_turn(
                inbound,
                steer.run_id,
                steer.binding.binding_id.clone(),
                turn,
                None,
                &CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT),
            )
            .await
    }
}

#[cfg(test)]
mod tests;
