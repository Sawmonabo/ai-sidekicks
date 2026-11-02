//! A Codex helper stopped alone, its lead going on: the person's interrupt of the helper's run, and
//! its stop from the console. Both stop the running turn of the helper's own conversation, read as
//! its newest turn, and end the commands that turn left running.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::run::control::CodexRunControl;
use crate::driver::codex::run::turn_interrupt::{
    CodexTurnInterrupt, TURN_INTERRUPT_METHOD, interrupt_codex_turn,
};
use crate::driver::codex::session::background_terminals::end_codex_running_commands;
use crate::driver::codex::session::calls::call_codex_session;
use crate::driver::codex::session::detached_conversation::CODEX_DETACHED_INTERRUPT_DEADLINE;
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::session::history::read_codex_newest_turn;
use crate::driver::codex::session::inbound::CodexSessionCall;
use crate::driver::codex::session::owed_turn_ends::read_codex_listed_turn;
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::contract::error::DriverError;
use crate::driver::run_control::{HelperStopOutcome, HelperStopParams};

impl CodexRunControl {
    /// Interrupts a helper's running turn on its own conversation and ends the commands it left
    /// running; the route is marked first, so the helper's end reads as this interrupt's however
    /// soon it arrives. A run with no helper route answers at once with nothing sent. Answers no
    /// steers, since a helper holds none of the queue's; fails as the helper's stop fails, the mark
    /// cleared.
    pub(super) async fn interrupt_helper_run(
        &self,
        run_id: RunId,
    ) -> Result<Vec<QueueItemId>, CodexError> {
        let Some(route) = self.dependencies.run_routes.begin_helper_interrupt(run_id) else {
            return Ok(Vec::new());
        };
        if let Err(error) = self
            .stop_helper_turn(route.session_id, &route.thread_id)
            .await
        {
            self.dependencies.run_routes.end_helper_interrupt(run_id);
            return Err(error);
        }
        Ok(Vec::new())
    }

    /// Stops the helper `params.subagent_id` names from the console, its lead going on: its
    /// running turn is interrupted, which Codex can continue, and its commands ended. Answers
    /// `Interrupted` for a turn it stopped, `AlreadyInterrupted` for a newest turn that ended
    /// interrupted, and `AlreadyEnded` for one that ended otherwise, for a helper no message has
    /// reached and for a conversation Codex does not hold. A bound route is marked first, as an
    /// interrupt marks it, and cleared when the stop fails. Codex holds no helper's hook call
    /// here, so no pausing or paused helper is stopped differently. Fails as a request fails, and
    /// with `CodexError::Unanswered` past [`CODEX_DETACHED_INTERRUPT_DEADLINE`].
    pub(crate) async fn stop_child_run(
        &self,
        params: &HelperStopParams,
    ) -> Result<HelperStopOutcome, CodexError> {
        // A helper with no route bound is stopped all the same.
        self.dependencies
            .run_routes
            .begin_helper_interrupt(params.run_id);
        // A Codex helper's id is its own conversation's.
        let stopped = self
            .stop_helper_turn(params.session_id, params.subagent_id.as_str())
            .await;
        if stopped.is_err() {
            self.dependencies
                .run_routes
                .end_helper_interrupt(params.run_id);
        }
        stopped
    }

    // Interrupts the running turn of the helper conversation `thread_id`, read as its newest
    // turn, then ends its commands, within the detached interrupt's deadline.
    async fn stop_helper_turn(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Result<HelperStopOutcome, CodexError> {
        tokio::time::timeout(CODEX_DETACHED_INTERRUPT_DEADLINE, async {
            let inbound = self.dependencies.slots.require_live(session_id)?;
            let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
                thread_id: None,
                reply,
            })
            .await?;
            let connection = reading.connection?;
            let newest = match read_codex_newest_turn(&connection, thread_id).await {
                Ok(Some(newest)) => newest,
                Ok(None) => return Ok(HelperStopOutcome::AlreadyEnded),
                Err(error) if error.is_thread_not_found() => {
                    return Ok(HelperStopOutcome::AlreadyEnded);
                }
                Err(error) => return Err(error),
            };
            match read_codex_listed_turn(&newest.turn).status {
                Some(CodexTurnStatus::InProgress) => {}
                Some(CodexTurnStatus::Interrupted) => {
                    return Ok(HelperStopOutcome::AlreadyInterrupted);
                }
                Some(CodexTurnStatus::Completed | CodexTurnStatus::Failed) | None => {
                    return Ok(HelperStopOutcome::AlreadyEnded);
                }
            }
            match interrupt_codex_turn(&connection, thread_id, &newest.id).await {
                Ok(CodexTurnInterrupt::Stopped) => {
                    end_codex_running_commands(&connection, thread_id, false).await;
                    Ok(HelperStopOutcome::Interrupted)
                }
                Ok(CodexTurnInterrupt::AlreadyEnded) => Ok(HelperStopOutcome::AlreadyEnded),
                Err(error) if error.is_thread_not_found() => Ok(HelperStopOutcome::AlreadyEnded),
                Err(error) => Err(error),
            }
        })
        .await
        .unwrap_or_else(|_elapsed| {
            Err(CodexError::Unanswered {
                method: TURN_INTERRUPT_METHOD.to_owned(),
                cause: CodexUnansweredCause::Deadline {
                    timeout: CODEX_DETACHED_INTERRUPT_DEADLINE,
                },
            })
        })
    }
}

impl CodexDriver {
    /// Stops one helper from the console, its lead going on, answering how Codex took it; see the
    /// run control's stop. Fails as that stop fails.
    pub(crate) async fn stop_child_run(
        &self,
        params: HelperStopParams,
    ) -> Result<HelperStopOutcome, DriverError> {
        Ok(self.parts()?.run_control.stop_child_run(&params).await?)
    }
}

#[cfg(test)]
mod tests;
