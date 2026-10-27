//! The checks a started process passes before it is adopted: the model it runs is one its build
//! offers, or one Claude Code takes at the switch; it can run at the session's level; and the
//! output speed, a planning session's Plan and the Ultracode value asked for are set on it.

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::session::controls::methods::SessionMode;

use super::{ClaudeEstablishmentError, ClaudeModelCheck, ClaudeSessionEstablishment};
use crate::claude::output_speed::apply_claude_output_speed;
use crate::claude::session::errors::{ClaudeSessionError, ClaudeSessionUnavailableReason};
use crate::claude::session::permission_level::{can_run_claude_level, read_claude_sandbox_support};
use crate::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeControlSubtype, ClaudePermissionMode,
};
use crate::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::claude::session::ultracode::{ClaudeUltracodeReading, apply_claude_ultracode};
use crate::claude::spawn::launch::installed_build::ClaudeStartedSession;

impl ClaudeSessionEstablishment {
    /// Checks `started` before it is adopted and answers the output speed it took and
    /// Ultracode's state once the value asked for is set. A model the build's catalog does not
    /// list is set once with `set_model`, whose refusal answers `ModelNotOffered` for `agent_id`,
    /// the session's lead; fails `PermissionLevelUnavailable` where Claude Code cannot run the
    /// session's level.
    pub(super) async fn check_started(
        &self,
        started: &ClaudeStartedSession,
        legs: &ClaudeSpawnBoundLegs,
        agent_id: AgentId,
        (session_mode, output_speed): (SessionMode, Option<&str>),
        (model_check, ultracode): (ClaudeModelCheck, Option<bool>),
    ) -> Result<(Option<String>, Option<ClaudeUltracodeReading>), ClaudeEstablishmentError> {
        let session_id = legs.session_id;
        let channel = &*started.channel;
        if model_check == ClaudeModelCheck::Checked
            && started.initialize.offered_model(&legs.model).is_none()
        {
            // An unlisted model may still run; Claude Code's own check of it decides.
            channel
                .send_control_request(ClaudeControlRequest::SetModel {
                    model: legs.model.clone(),
                })
                .await
                .map_err(|error| match error {
                    ClaudeSessionError::ControlRequestRefused {
                        subtype: ClaudeControlSubtype::SetModel,
                        provider_error,
                    } => ClaudeSessionError::ModelNotOffered {
                        agent_id,
                        model: legs.model.clone(),
                        provider_error,
                    },
                    error @ (ClaudeSessionError::Unavailable { .. }
                    | ClaudeSessionError::InputUnwritable(_)
                    | ClaudeSessionError::AuthenticationRequired { .. }
                    | ClaudeSessionError::Unanswered { .. }
                    | ClaudeSessionError::ControlRequestRefused { .. }
                    | ClaudeSessionError::ModelNotOffered { .. }
                    | ClaudeSessionError::SessionAlreadyLive { .. }) => error,
                })?;
        }
        if let Some(posture) = &legs.execution_posture {
            let can_run_sandbox = read_claude_sandbox_support(
                &self.sources.spawner,
                &legs.spawn_environment,
                &legs.working_directory,
                Some(session_id),
            )
            .await;
            let level = posture.permission_level();
            if !can_run_claude_level(
                level,
                &legs.model,
                &started.initialize.auto_mode_models,
                can_run_sandbox,
            ) {
                return Err(ClaudeSessionError::Unavailable {
                    reason: ClaudeSessionUnavailableReason::PermissionLevelUnavailable,
                    detail: Some(format!("Level {}.", <&str>::from(level))),
                    session_id: Some(session_id),
                    run_id: None,
                }
                .into());
            }
        }
        // A fresh process holds no flag setting until it is told again.
        let applied = match output_speed {
            Some(level) => apply_claude_output_speed(channel, session_id, level)
                .await?
                .map(str::to_owned),
            None => None,
        };
        // A process starts at its level's own mode, so only Plan is carried.
        if session_mode == SessionMode::Plan {
            channel
                .send_control_request(ClaudeControlRequest::SetPermissionMode {
                    mode: ClaudePermissionMode::Plan,
                })
                .await?;
        }
        let ultracode = match ultracode {
            Some(is_on) => apply_claude_ultracode(channel, is_on).await?,
            None => None,
        };
        Ok((applied, ultracode))
    }
}
