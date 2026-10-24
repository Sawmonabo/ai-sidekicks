//! A session's goal on Codex's own thread goal. The goal is the person's own `/goal`, so it goes
//! out as `origin: "user"`: Codex records only such a goal in the model's history as the person's
//! instruction, which its automatic reviewer reads as authorization. Codex may work on the goal in
//! a turn of its own, whose run opens when that turn starts. Setting or clearing one records a
//! message in the conversation, and setting one can start that turn, so each waits for a turn the
//! daemon is stopping to end and goes apart from the session's turn starts; a set keeps them apart
//! until the turn it starts begins, within the turn-start deadline, since Codex starts it only
//! after answering.

use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::codex::app_server_protocol::{
    ThreadGoalClearParams, ThreadGoalMutationOrigin, ThreadGoalSetParams,
};
use crate::provider::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::provider::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::provider::driver::codex::session::calls::{
    CodexSessionReading, call_codex_session, wait_for_codex_turns,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::session_control::{
    ClearSessionGoalParams, DriverGoalResult, SetSessionGoalParams,
};

const THREAD_GOAL_SET_METHOD: &str = "thread/goal/set";
const THREAD_GOAL_CLEAR_METHOD: &str = "thread/goal/clear";

/// Sets and clears each session's goal on its conversation.
pub(crate) struct CodexSessionGoals {
    slots: Arc<CodexSessionSlots>,
    config_forks: Arc<CodexConfigForks>,
    run_start: Arc<CodexRunStart>,
}

impl CodexSessionGoals {
    /// Goals reaching each session through `slots`, after any config fork in flight, apart from
    /// `run_start`'s turn starts.
    pub(crate) fn new(
        slots: Arc<CodexSessionSlots>,
        config_forks: Arc<CodexConfigForks>,
        run_start: Arc<CodexRunStart>,
    ) -> Self {
        Self {
            slots,
            config_forks,
            run_start,
        }
    }

    /// Sets the session's goal on its conversation and answers once Codex took it and the turn it
    /// starts began, or the turn-start deadline passed. Only the objective is sent; its status and
    /// token budget are Codex's own. Fails with `CodexError::SessionTurnInFlight`, nothing sent,
    /// while a turn runs, starts or outlives the request deadline ending, and as the request fails.
    #[expect(dead_code, reason = "the Codex driver's session goal set")]
    pub(crate) async fn set(
        &self,
        params: SetSessionGoalParams,
    ) -> Result<DriverGoalResult, CodexError> {
        self.send(params.session_id, |inbound, reading| async move {
            if reading.is_turn_in_flight {
                return Err(CodexError::SessionTurnInFlight {
                    session_id: inbound.session_id(),
                });
            }
            reading
                .connection?
                .request(
                    THREAD_GOAL_SET_METHOD,
                    &ThreadGoalSetParams {
                        thread_id: reading.thread_id,
                        origin: Some(ThreadGoalMutationOrigin::User),
                        objective: Some(params.goal_text),
                        status: None,
                        token_budget: None,
                    },
                )
                .await?;
            // A turn sent before the goal's own turn starts would fold into it or race it.
            wait_for_codex_turns(
                &inbound,
                CodexTurnWait::TurnInFlight,
                Some(&CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT)),
            )
            .await
            .map(drop)
        })
        .await
    }

    /// Clears the session's goal on its conversation; Codex answering that it had none still
    /// applies. Fails with `CodexError::SessionTurnInFlight`, nothing sent, while a turn the daemon
    /// is stopping outlives the request deadline, and as the request fails.
    #[expect(dead_code, reason = "the Codex driver's session goal clear")]
    pub(crate) async fn clear(
        &self,
        params: ClearSessionGoalParams,
    ) -> Result<DriverGoalResult, CodexError> {
        self.send(params.session_id, |_inbound, reading| async move {
            reading
                .connection?
                .request(
                    THREAD_GOAL_CLEAR_METHOD,
                    &ThreadGoalClearParams {
                        thread_id: reading.thread_id,
                        origin: Some(ThreadGoalMutationOrigin::User),
                    },
                )
                .await
                .map(drop)
        })
        .await
    }

    // Runs `request` on the session, after any config fork in flight, apart from its turn starts,
    // once every turn the daemon is stopping ended within the request deadline.
    async fn send<Request>(
        &self,
        session_id: SessionId,
        request: impl FnOnce(CodexSessionInboundSender, CodexSessionReading) -> Request,
    ) -> Result<DriverGoalResult, CodexError>
    where
        Request: Future<Output = Result<(), CodexError>>,
    {
        self.config_forks.join(session_id).await;
        let inbound = self.slots.require_live(session_id)?;
        self.run_start
            .send_apart_from_turn_starts(session_id, async {
                let has_stopped = wait_for_codex_turns(
                    &inbound,
                    CodexTurnWait::StoppedTurns,
                    Some(&CodexTurnEndDeadline::for_request()),
                )
                .await?;
                if !has_stopped {
                    return Err(CodexError::SessionTurnInFlight { session_id });
                }
                let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
                    thread_id: None,
                    reply,
                })
                .await?;
                request(inbound.clone(), reading).await
            })
            .await?;
        Ok(DriverGoalResult::Applied {})
    }
}
