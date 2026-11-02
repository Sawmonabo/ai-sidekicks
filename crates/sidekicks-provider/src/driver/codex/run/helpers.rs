//! A Codex helper stopped alone, its lead going on: the person's interrupt of the helper's run, and
//! its stop from the console. Both stop the running turn of the helper's own conversation, read as
//! its newest turn, and end the commands that turn left running. Also a session's helpers
//! reopened after a restart.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::run::control::CodexRunControl;
use crate::driver::codex::run::turn_interrupt::{
    CodexRunningTurnInterrupt, CodexTurnInterrupt, TURN_INTERRUPT_METHOD,
    interrupt_codex_running_turn,
};
use crate::driver::codex::session::background_terminals::end_codex_running_commands;
use crate::driver::codex::session::calls::call_codex_session;
use crate::driver::codex::session::detached_conversation::CODEX_DETACHED_INTERRUPT_DEADLINE;
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::session::establishment::helpers::reopen_registered_codex_helper;
use crate::driver::codex::session::inbound::CodexSessionCall;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::contract::error::DriverError;
use crate::driver::prior_usage::read_prior_emitted;
use crate::driver::run_control::{HelperStopOutcome, HelperStopParams, ReattachHelpersParams};
use crate::port::usage_sink::UsageSink;

impl CodexRunControl {
    /// Interrupts a helper's running turn on its own conversation and ends the commands it left
    /// running; the route is marked first, so the helper's end reads as this interrupt's however
    /// soon it arrives, and cleared unless Codex stopped a running turn, so any other end reads as
    /// the helper's own. A run with no helper route answers at once with nothing sent. Answers no
    /// steers, since a helper holds none of the queue's; fails as the helper's stop fails.
    pub(super) async fn interrupt_helper_run(
        &self,
        run_id: RunId,
    ) -> Result<Vec<QueueItemId>, CodexError> {
        let Some(route) = self.dependencies.run_routes.begin_helper_interrupt(run_id) else {
            return Ok(Vec::new());
        };
        let stopped = self
            .stop_helper_turn(route.session_id, &route.thread_id)
            .await;
        self.settle_helper_interrupt(run_id, &stopped);
        stopped.map(|_| Vec::new())
    }

    /// Stops the helper `params.subagent_id` names from the console, its lead going on: its
    /// running turn is interrupted, which Codex can continue, and its commands ended; how each
    /// newest turn answers is the shared body's table. A bound route is marked first, as an
    /// interrupt marks it, and cleared unless Codex stopped a running turn. Codex holds no
    /// helper's hook call here, so no pausing or paused helper is stopped differently. Fails as a request fails, and
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
        self.settle_helper_interrupt(params.run_id, &stopped);
        stopped
    }

    // Clears the daemon's interrupt mark on the helper route of `run_id` unless `stopped` says
    // Codex stopped a running turn, whose end alone is the interrupt's.
    fn settle_helper_interrupt(
        &self,
        run_id: RunId,
        stopped: &Result<HelperStopOutcome, CodexError>,
    ) {
        if !matches!(stopped, Ok(HelperStopOutcome::Interrupted)) {
            self.dependencies.run_routes.end_helper_interrupt(run_id);
        }
    }

    /// The connection of the session's live conversation, reached as run control reaches it;
    /// `None` for a session not live (asleep, closing or starting again). Fails as the session's
    /// reading fails or its service has no connection.
    pub(crate) async fn live_connection(
        &self,
        session_id: SessionId,
    ) -> Result<Option<Arc<CodexAppServerConnection>>, CodexError> {
        let Ok(inbound) = self.dependencies.slots.require_live(session_id) else {
            return Ok(None);
        };
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        reading.connection.map(Some)
    }

    /// Reopens each of `params.helpers` that holds no helper route, in the order given, parents
    /// first, ancestors included, since Codex reopens a helper only once its parent is loaded: a
    /// helper an adoption reopened holds a route. Each is registered on the session's service
    /// first, so its frames reach the session. One whose own run was live is then bound to that
    /// run and registered in the session's routing, its usage based on what `usage` reads was
    /// already metered on it; an ancestor reopened only so its descendants load binds no run, so
    /// nothing reaches its ended run. Reopening an unloaded helper loads it, which has Codex
    /// record the turn the restart cut as interrupted. A refused reopen, or a restore the
    /// session's task did not take, is logged and the rest go on. Fails only for a session not
    /// live or a service not running.
    pub(crate) async fn reattach_helpers(
        &self,
        params: &ReattachHelpersParams,
        usage: &PortRegistration<Arc<dyn UsageSink>>,
    ) -> Result<(), CodexError> {
        let inbound = self.dependencies.slots.require_live(params.session_id)?;
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        let connection = reading.connection?;
        for helper in &params.helpers {
            if self.dependencies.run_routes.has_helper_route(helper.run_id) {
                continue;
            }
            // A Codex helper's id is its own conversation's.
            let thread_id = helper.subagent_id.as_str();
            let reopened = reopen_registered_codex_helper(
                &reading.service,
                &connection,
                params.session_id,
                thread_id,
            )
            .await;
            if let Err(error) = reopened {
                tracing::warn!(
                    session_id = %params.session_id,
                    run_id = %helper.run_id,
                    thread_id = %thread_id,
                    error = &error as &(dyn Error + 'static),
                    "codex refused the reopen of a helper after a restart"
                );
                continue;
            }
            if !helper.was_live {
                continue;
            }
            let prior_emitted = read_prior_emitted(
                usage,
                DESCRIPTOR.provider_id(),
                params.session_id,
                thread_id,
            )
            .await;
            let restored = call_codex_session(&inbound, |reply| CodexSessionCall::RestoreHelper {
                helper: Box::new(helper.clone()),
                prior_emitted,
                reply,
            })
            .await;
            if let Err(error) = restored {
                tracing::warn!(
                    session_id = %params.session_id,
                    run_id = %helper.run_id,
                    thread_id = %thread_id,
                    error = &error as &(dyn Error + 'static),
                    "a helper reopened after a restart was not restored on its session"
                );
            }
        }
        Ok(())
    }

    // Stops the helper conversation `thread_id` by its newest turn, within the detached interrupt's
    // deadline, its commands ended as a lead's interrupt ends them:
    //
    // | Session or newest turn                           | Commands ended | Answer               |
    // |--------------------------------------------------|----------------|----------------------|
    // | session not live (asleep, closing, re-starting)  | no             | `AlreadyEnded`       |
    // | no turn yet, or Codex does not hold the thread   | no             | `AlreadyEnded`       |
    // | interrupted                                      | no             | `AlreadyInterrupted` |
    // | completed, failed, or a status Codex adds        | yes            | `AlreadyEnded`       |
    // | running, Codex stopped it                        | yes            | `Interrupted`        |
    // | running, it ended before the interrupt           | yes            | `AlreadyEnded`       |
    // | a failed request, or the deadline passed         | no             | `Err`                |
    async fn stop_helper_turn(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Result<HelperStopOutcome, CodexError> {
        tokio::time::timeout(CODEX_DETACHED_INTERRUPT_DEADLINE, async {
            // Its helpers end with the session, as Claude Code's end with its process.
            let Some(connection) = self.live_connection(session_id).await? else {
                return Ok(HelperStopOutcome::AlreadyEnded);
            };
            let stopped = match interrupt_codex_running_turn(&connection, thread_id, None).await {
                Ok(CodexRunningTurnInterrupt::Running(CodexTurnInterrupt::Stopped)) => {
                    HelperStopOutcome::Interrupted
                }
                Ok(
                    CodexRunningTurnInterrupt::Running(CodexTurnInterrupt::AlreadyEnded)
                    | CodexRunningTurnInterrupt::Untouched(
                        Some(
                            CodexTurnStatus::Completed
                            | CodexTurnStatus::Failed
                            | CodexTurnStatus::InProgress,
                        )
                        | None,
                    ),
                ) => HelperStopOutcome::AlreadyEnded,
                Ok(CodexRunningTurnInterrupt::Untouched(Some(CodexTurnStatus::Interrupted))) => {
                    return Ok(HelperStopOutcome::AlreadyInterrupted);
                }
                Ok(CodexRunningTurnInterrupt::NoTurn) => {
                    return Ok(HelperStopOutcome::AlreadyEnded);
                }
                Err(error) if error.is_thread_not_found() => {
                    return Ok(HelperStopOutcome::AlreadyEnded);
                }
                Err(error) => return Err(error),
            };
            // Ending an ended turn's commands again is harmless, and ends one whose end the
            // daemon missed.
            end_codex_running_commands(&connection, thread_id, false).await;
            Ok(stopped)
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

    /// Reopens a session's helpers after a restart, each live one's usage based on what was
    /// already metered on its conversation; see the run control's re-attach. Fails only for a
    /// session not live.
    pub(crate) async fn reattach_helpers(
        &self,
        params: ReattachHelpersParams,
    ) -> Result<(), DriverError> {
        let parts = self.parts()?;
        Ok(parts
            .run_control
            .reattach_helpers(&params, &parts.ports.usage)
            .await?)
    }
}

#[cfg(test)]
mod tests;
