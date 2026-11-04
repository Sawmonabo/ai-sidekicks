//! A session's goal on Codex's own thread goal. The goal is the person's own `/goal`, so it goes
//! out as `origin: "user"`: Codex records only such a goal in the model's history as the person's
//! instruction, which its automatic reviewer reads as authorization. A goal set while a turn runs
//! goes out at once, and Codex applies it to that turn, steering it. On an idle thread Codex may
//! work on the goal in a turn of its own, whose run opens when that turn starts. Setting or
//! clearing one records a message in the conversation, and setting one can start that turn, so
//! each waits for a turn the daemon is stopping to end, within the request deadline, and goes
//! apart from the session's turn starts; a set keeps them apart until the turn it starts begins,
//! within the turn-start deadline, since Codex starts it only after answering.

use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::app_server_protocol::{
    ThreadGoalClearParams, ThreadGoalMutationOrigin, ThreadGoalSetParams,
};
use crate::driver::codex::run::start::{CODEX_TURN_START_TIMEOUT, CodexRunStart};
use crate::driver::codex::run::turn_end_waiters::{CodexTurnEndDeadline, CodexTurnWait};
use crate::driver::codex::session::calls::{
    CodexSessionReading, call_codex_session, wait_for_codex_turns,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::session_control::{
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

    /// Sets the session's goal on its conversation and answers once Codex took it and a turn runs:
    /// at once when one already ran, which Codex steers with the goal, else once the turn the goal
    /// starts began or the turn-start deadline passed. Only the objective is sent; its status and
    /// token budget are Codex's own. Fails as the request fails.
    pub(crate) async fn set(
        &self,
        params: SetSessionGoalParams,
    ) -> Result<DriverGoalResult, CodexError> {
        self.send(params.session_id, |inbound, reading| async move {
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
            // A turn sent before the goal's own turn starts would fold into it or race it; a turn
            // already running answers at once.
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
    /// applies. Fails as the request fails.
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
    // once every turn the daemon is stopping ended or the request deadline passed: a goal sent
    // into a turn being stopped would steer a turn that is ending.
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
                wait_for_codex_turns(
                    &inbound,
                    CodexTurnWait::StoppedTurns,
                    Some(&CodexTurnEndDeadline::for_request()),
                )
                .await?;
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;

    use super::CodexSessionGoals;
    use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
    use crate::driver::session_control::{DriverGoalResult, SetSessionGoalParams};
    use crate::driver::test_registry::new_run_id;

    // Kills: a set refused while a turn runs, which Codex applies to that turn instead.
    #[tokio::test]
    async fn a_goal_set_while_a_turn_runs_goes_out_at_once() {
        let mut session = TestCodexSession::start().await;
        let binding_id = session.record_binding().await;
        let run_id = new_run_id();
        session
            .task
            .record
            .add_active_turn("turn-1".to_owned(), run_id);
        let goals = CodexSessionGoals::new(
            Arc::clone(&session.slots),
            Arc::clone(&session.task.calls.runs.config_forks),
            Arc::clone(&session.run_start),
        );
        let set = goals.set(SetSessionGoalParams {
            session_id: session.task.record.session_id,
            binding_id,
            run_id,
            goal_text: "ship the checkout fix".to_owned(),
        });
        let task = &mut session.task;
        let script = &mut session.scripted.script;
        let service = async {
            let sent = script.next_sent().await;
            assert_eq!(sent["method"], "thread/goal/set");
            assert_eq!(sent["params"]["threadId"], TEST_THREAD);
            assert_eq!(sent["params"]["objective"], "ship the checkout fix");
            assert_eq!(sent["params"]["origin"], "user");
            script.answer(&sent, &json!({}));
        };
        let (answered, ()) = tokio::time::timeout(
            Duration::from_secs(10),
            Box::pin(async { tokio::join!(task.drive(set), service) }),
        )
        .await
        .expect("the set settles while the turn runs");

        assert_eq!(
            answered.expect("Codex takes the goal mid-turn"),
            DriverGoalResult::Applied {}
        );
    }
}
