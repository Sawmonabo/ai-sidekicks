//! Codex's own review of a set of changes, started with `review/start` as the turn of a run: one
//! the daemon starts on the session itself, or the run the queue admitted. Its start is recorded
//! once Codex took the request; its end once Codex leaves review mode.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::{ReviewStartParams, ReviewTarget};
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::daemon_turns::{
    CodexDaemonTurnError, CodexDaemonTurnOpening,
};
use crate::driver::codex::run::start::{
    CODEX_TURN_START_TIMEOUT, CodexRunStart, wait_out_stopped_turns,
};
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::view::read_turn_id;
use crate::driver::contract::StartRunParams;
use crate::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::run::delivery::InboundDelivery;

const REVIEW_START_METHOD: &str = "review/start";

impl CodexRunStart {
    /// Starts Codex's own review of `target` in the session's conversation as the session's own
    /// run and records its start. Fails as [`Self::start_daemon_turn`] does.
    pub(crate) async fn start_review(
        self: &Arc<Self>,
        session_id: SessionId,
        target: SessionReviewTarget,
    ) -> Result<(), CodexDaemonTurnError> {
        let opening = self.review_opening(session_id, target);
        self.start_daemon_turn(session_id, opening).await.map(drop)
    }

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
        self.send_bound_turn(
            &inbound,
            params.run_id,
            CodexRunBinding {
                session_id,
                binding_id: opening.binding_id.clone(),
                agent_id: opening.agent_id,
                step_bound: params.step_bound,
            },
            self.review_opening(session_id, target),
        )
        .await
    }

    // The `review/start` that opens a review of `target`, recording its start once Codex took it.
    fn review_opening(
        &self,
        session_id: SessionId,
        target: SessionReviewTarget,
    ) -> CodexDaemonTurnOpening {
        let dispatch = Arc::clone(&self.dependencies.dispatch);
        Arc::new(move |connection, thread_id, timeout| {
            let dispatch = Arc::clone(&dispatch);
            async move {
                let reply = connection
                    .request_within(
                        REVIEW_START_METHOD,
                        &ReviewStartParams {
                            delivery: None,
                            target: compose_review_target(target),
                            thread_id,
                        },
                        timeout,
                    )
                    .await?;
                record_review_started(&*dispatch, session_id, target).await;
                read_turn_id(&reply, REVIEW_START_METHOD)
            }
            .boxed()
        })
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
