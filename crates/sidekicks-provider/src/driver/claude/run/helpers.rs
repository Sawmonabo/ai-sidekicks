//! The stops of one helper on a live Claude run: at its token limit, where its tool uses are
//! denied so it reports and finishes, and from the console, where Claude Code's `stop_task` ends it
//! for good.

use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::ClaudeDriver;
use crate::driver::claude::intervention::stop_on_cut_write;
use crate::driver::claude::run::controls::ClaudeRunControls;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::contract::error::DriverError;
use crate::driver::run_control::{HelperStopOutcome, HelperStopParams, HelperStopReason};

impl ClaudeRunControls {
    /// Stops a helper at its token limit: its next tool use, and each after, is denied with the
    /// reason it reads, so it reports and finishes while its lead goes on. Fails `NoLiveSession`.
    pub(crate) fn stop_helper_at_token_limit(
        &self,
        params: &HelperStopParams,
    ) -> Result<(), DriverError> {
        self.start.live_session(params.session_id)?;
        lock(&self.pauses).stop_helper(
            params.session_id,
            params.subagent_id.as_str(),
            HelperStopReason::TokenLimit,
        );
        Ok(())
    }

    /// Stops a helper for good from the console: it is marked stopped first, so each tool use from
    /// the next on is denied, then Claude Code's `stop_task` goes to its task. Answers `AlreadyEnded`
    /// with no live session or when Claude Code refuses the stop, and `Stopped` once it took it or
    /// a cut write stopped the process; fails as the request otherwise fails, a passed deadline
    /// included, the mark and any pause kept.
    pub(crate) async fn stop_child_run(
        &self,
        params: &HelperStopParams,
    ) -> Result<HelperStopOutcome, DriverError> {
        let session_id = params.session_id;
        // Claude Code's helpers end with its process.
        let Ok(live) = self.start.live_session(session_id) else {
            return Ok(HelperStopOutcome::AlreadyEnded);
        };
        // The helper's task id is its agent id.
        let agent_id = params.subagent_id.as_str();
        // Marked before anything is sent, so a tool use racing the stop is denied.
        lock(&self.pauses).stop_helper(session_id, agent_id, HelperStopReason::StopAll);
        let stopped = live
            .channel
            .send_control_request(ClaudeControlRequest::StopTask {
                task_id: agent_id.to_owned(),
            })
            .await;
        match stopped {
            Ok(_) => {
                // Claude Code withdraws a stopped helper's held callbacks itself, so the pause is
                // dropped without answering them.
                lock(&self.pauses).resume_helper(&session_id, agent_id, None);
                Ok(HelperStopOutcome::Stopped)
            }
            // A refusal names a task Claude Code no longer holds.
            Err(ClaudeSessionError::ControlRequestRefused { .. }) => {
                Ok(HelperStopOutcome::AlreadyEnded)
            }
            // Every helper ends with the process.
            Err(error) if stop_on_cut_write(&*live.channel, &error).await => {
                Ok(HelperStopOutcome::Stopped)
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl ClaudeDriver {
    /// Stops a helper at its token limit by denying its tool uses from the next on. Fails
    /// `NoLiveSession`.
    pub(crate) fn stop_helper_at_token_limit(
        &self,
        params: &HelperStopParams,
    ) -> Result<(), DriverError> {
        self.live_run_controls(params.session_id)?
            .stop_helper_at_token_limit(params)
    }

    /// Stops a helper for good from the console, answering how Claude Code took it. Fails as the
    /// stop request fails.
    #[expect(dead_code, reason = "the driver trait's per-helper stop calls it")]
    pub(crate) async fn stop_child_run(
        &self,
        params: &HelperStopParams,
    ) -> Result<HelperStopOutcome, DriverError> {
        // No part is composed before a session is live, so no helper runs.
        let Ok(controls) = self.live_run_controls(params.session_id) else {
            return Ok(HelperStopOutcome::AlreadyEnded);
        };
        controls.stop_child_run(params).await
    }
}

#[cfg(test)]
mod tests;
