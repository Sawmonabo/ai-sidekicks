//! Codex's own review of a set of changes, started with `review/start` as the turn of the run the
//! queue admitted: sent on the binding the daemon opened for that run, with the run waiting as the
//! turn starting next, so every row of the turn has a run. Its start is recorded once Codex took
//! the request; its end once Codex leaves review mode.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::{ReviewStartParams, ReviewTarget};
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::record::{CodexTurnBegin, CodexTurnStartOutcome};
use crate::driver::codex::run::start::{
    CODEX_TURN_START_TIMEOUT, CodexRunStart, wait_out_stopped_turns,
};
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::CodexSessionInboundSender;
use crate::driver::codex::thread::view::read_turn_id;
use crate::driver::contract::StartRunParams;
use crate::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::run::delivery::InboundDelivery;

const REVIEW_START_METHOD: &str = "review/start";

impl CodexRunStart {
    /// Starts Codex's own review of `target` as the turn of the run the queue admitted in
    /// `params`, on the binding the daemon opened for it, after a config fork in flight and once
    /// every turn the daemon is stopping ended, within one turn-start deadline. A run whose review
    /// did not start keeps no route. Fails as [`Self::start_run`] does for a message.
    pub(super) async fn start_queued_review(
        &self,
        params: &StartRunParams,
        target: SessionReviewTarget,
    ) -> Result<(), CodexError> {
        let opening = &params.opening;
        let session_id = opening.session_id;
        self.dependencies.config_forks.join(session_id).await;
        let inbound = self.dependencies.slots.require_live(session_id)?;
        // Before the run's route is recorded: the end of its own interrupted turn forgets it.
        wait_out_stopped_turns(
            &inbound,
            &CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT),
        )
        .await?;
        let run_id = params.run_id;
        self.dependencies.run_routes.bind_run_delivery(
            run_id,
            CodexRunBinding {
                session_id,
                binding_id: opening.binding_id.clone(),
                agent_id: opening.agent_id,
                step_bound: params.step_bound,
            },
        );
        let sent = self
            .send_review_turn(&inbound, run_id, opening.binding_id.clone(), target)
            .await;
        if sent.is_err() {
            self.dependencies.run_routes.forget_run(run_id);
        }
        sent
    }

    // Sends `review/start` with the run waiting as the turn starting next, so the turn's first
    // frames reach it even when they come before the reply, and records the review's start once
    // Codex took it; the run's interrupt withdraws it meanwhile.
    async fn send_review_turn(
        &self,
        inbound: &CodexSessionInboundSender,
        run_id: RunId,
        binding_id: RuntimeBindingId,
        target: SessionReviewTarget,
    ) -> Result<(), CodexError> {
        let session_id = inbound.session_id();
        let withdrawn = Arc::new(AtomicBool::new(false));
        self.withdrawable(inbound, run_id, Arc::clone(&withdrawn), async {
            let hold = self.turn_sends.acquire(session_id).await;
            let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
            let begin = CodexTurnBegin {
                run_id,
                turn: None,
                binding_id,
                withdrawn: Some(withdrawn),
            };
            let send = self.begin_turn(&hold, inbound, begin, &deadline).await?;
            let turn_id = async {
                let reply = send
                    .connection
                    .request_within(
                        REVIEW_START_METHOD,
                        &ReviewStartParams {
                            delivery: None,
                            target: compose_review_target(target),
                            thread_id: send.thread_id.clone(),
                        },
                        deadline.remaining(),
                    )
                    .await?;
                record_review_started(&*self.dependencies.dispatch, session_id, target).await;
                read_turn_id(&reply, REVIEW_START_METHOD)
            }
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

// What each review target asks Codex for. Codex names no staged set and the daemon holds no base
// branch for the session, so both are asked in words with the git command that reads them.
fn compose_review_target(target: SessionReviewTarget) -> ReviewTarget {
    match target {
        SessionReviewTarget::WorkingTree => ReviewTarget::UncommittedChanges,
        SessionReviewTarget::Staged => ReviewTarget::Custom {
            instructions: "Review the changes staged for commit, as `git diff --cached` shows \
                           them."
                .to_owned(),
        },
        SessionReviewTarget::Branch => ReviewTarget::Custom {
            instructions: "Review the commits on the current branch that its upstream does not \
                           have, as `git diff @{upstream}...HEAD` shows them."
                .to_owned(),
        },
    }
}

// Posts the review's start notice.
async fn record_review_started(
    dispatch: &dyn InboundDispatch,
    session_id: SessionId,
    target: SessionReviewTarget,
) {
    Box::pin(dispatch_delivery(
        dispatch,
        DeliveryOrigin {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: None,
            raw_wire_type: Some(REVIEW_START_METHOD),
        },
        InboundDelivery::SessionNotice {
            session_id,
            notice: SessionNoticePostedPayload::Notice(SessionNotice::ReviewStarted {
                session_id,
                target,
            }),
        },
    ))
    .await;
}
