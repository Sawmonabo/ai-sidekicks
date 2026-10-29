//! The relaunch of a Claude Code session the driver brings back itself: the resume it composes
//! from the ended process, the resume through the establishment, and the answer handed to the
//! session directory.

use std::error::Error;

use serde_json::Map;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use super::ClaudeSessionRestarts;
use crate::driver::claude::session::establishment::ClaudeResumeAnswer;
use crate::driver::claude::session::slots::ClaudeCloseStart;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::ultracode::relaunch_claude_options;
use crate::driver::contract::error::{DriverError, bound_failure_detail};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::driver::session_control::{DriverResumeResult, ResumeSessionParams};
use crate::runtime_binding::store::mint_runtime_binding_id;

impl ClaudeSessionRestarts {
    /// Resumes through the establishment, which is gone only once the driver is, under a binding
    /// the session directory opened first where `is_recorded`, so what the resumed process delivers
    /// at once is taken; a binding that cannot be opened fails the relaunch with no resume.
    pub(super) async fn resume(
        &self,
        params: Option<ResumeSessionParams>,
        is_recorded: bool,
    ) -> ClaudeResumeAnswer {
        let Some(params) = params else {
            return relaunch_failure(
                "The model the session ran on has no name the relaunch can carry.",
            );
        };
        let Some(establishment) = self.establishment.upgrade() else {
            return relaunch_failure("The Claude Code driver has stopped.");
        };
        if is_recorded
            && let Err(error) = self
                .open_relaunch_binding(params.session_id, params.binding_id.clone())
                .await
        {
            return relaunch_failure(&describe_error(&error as &(dyn Error + 'static)));
        }
        establishment.resume(params).await
    }

    // Has the session directory open the cursor of `binding_id`, the relaunch's binding.
    async fn open_relaunch_binding(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> Result<(), DriverError> {
        let listener = self
            .ports
            .session_relaunched
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
        listener
            .open_relaunch_binding(session_id, binding_id)
            .await
            .map_err(DriverError::Internal)
    }

    /// Hands the session directory a relaunch's answer, so it records the binding or the failure; a
    /// process the relaunch started whose binding was not recorded is ended, so none runs under a
    /// binding with no row.
    pub(super) async fn record_relaunch(
        &self,
        session_id: SessionId,
        answer: ClaudeResumeAnswer,
    ) -> Result<(), DriverError> {
        let recorded = self.report_relaunch(session_id, answer.result).await;
        if recorded.is_err()
            && answer.has_started_process
            && let ClaudeCloseStart::Closing(close) = self.slots.begin_close(session_id)
        {
            close.retire_for_bring_up(&self.routes, &self.ports).await;
        }
        recorded
    }

    /// Hands the session directory the relaunch's result, so it records the binding or the failure.
    pub(super) async fn report_relaunch(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> Result<(), DriverError> {
        let listener = self
            .ports
            .session_relaunched
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
        listener
            .session_relaunched(session_id, result)
            .await
            .map_err(DriverError::Internal)
    }
}

// A relaunch that failed for `detail` before any process started, which the run needs recovered.
fn relaunch_failure(detail: &str) -> ClaudeResumeAnswer {
    ClaudeResumeAnswer {
        result: DriverResumeResult::Failed {
            recovery_condition: RecoveryCondition::RecoveryNeeded,
            provider_failure_detail: bound_failure_detail(
                detail,
                UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
            ),
        },
        has_started_process: false,
    }
}

/// The resume that brings `live` back on the legs and level it ran at, the person's later moves
/// included, under the account it was admitted on, asking for the callback tools and Settings rows
/// its process was asked for, which the session's own advisor and style still override, under a
/// binding minted for it; `None` when the model it moved to has no name a resume carries.
pub(super) fn compose_claude_relaunch(live: &LiveClaudeSession) -> Option<ResumeSessionParams> {
    let settings = lock(&live.settings).clone();
    let legs = &live.spawn_bound_legs;
    Some(ResumeSessionParams {
        session_id: live.session_id,
        binding_id: mint_runtime_binding_id(),
        agent_id: live.agent_id,
        resume_handle: live.provider_session_id.clone(),
        // The model it runs on now, which a session-long switch by Claude Code may have moved.
        model: FreeFormText::new(settings.running_model).ok()?,
        // Claude Code's model id names its window, so the driver keeps no figure of its own.
        larger_window: None,
        runtime_metadata: Map::new(),
        mode: settings.session_mode,
        execution_posture: settings.execution_posture,
        output_speed: settings
            .applied_output_speed
            .and_then(|level| FreeFormText::new(level).ok()),
        options: relaunch_claude_options(settings.ultracode_requested),
        row_values: live.requested_spawn.row_values.clone(),
        callback_tools: live.requested_spawn.callback_tools.clone(),
        subagent_policy: legs.subagent_policy.clone(),
        tool_servers: Some(legs.tool_servers.clone()),
        output_schema: legs.output_schema.clone(),
        provider_account_id: live.admitted_provider_account_id.clone(),
        on_mcp_server_status: legs.on_mcp_server_status.clone(),
        // This daemon's idle sleep still holds the session's jobs across the relaunch.
        kept_schedules: Vec::new(),
        // A relaunch the driver takes itself names no runs for the daemon to settle.
        live_runs: Vec::new(),
    })
}
