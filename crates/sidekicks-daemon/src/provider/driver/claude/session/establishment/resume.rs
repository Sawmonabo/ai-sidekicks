//! A resume of a session's conversation: brought up in a fresh process, or answered by the process
//! a bring-up it waited out left running, as a restart's relaunch does, when that process runs the
//! conversation and settings the resume asks for; one on other settings is ended and brought up
//! again with the resume's own.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};

use super::{ClaudeEstablishmentError, ClaudeSessionEstablishment, ClaudeSpawnRequest};
use crate::mutex_lock::lock;
use crate::provider::driver::claude::output_speed::resolve_claude_output_speed;
use crate::provider::driver::claude::run::start::claude_session_unavailable;
use crate::provider::driver::claude::session::conversation_file::read_turn_count;
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionSlotState, ClaudeSessionUnavailableReason,
};
use crate::provider::driver::claude::session::slots::ClaudeResumeSlot;
use crate::provider::driver::claude::session::state::{
    ClaudeUsageEstablishment, LiveClaudeSession,
};
use crate::provider::driver::claude::session::ultracode::requested_claude_ultracode;
use crate::provider::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::provider::driver::contract::{SpawnedVersionBindingCarriers, bound_failure_detail};
use crate::provider::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::provider::driver::session_control::{DriverResumeResult, ResumeSessionParams};

impl ClaudeSessionEstablishment {
    /// Resumes the conversation `params` names in a fresh process, or answers the process a
    /// bring-up it waited out left running that conversation at the settings `params` asks for;
    /// every failure answers the `Failed` arm, nothing left running.
    pub(crate) async fn resume(&self, params: ResumeSessionParams) -> DriverResumeResult {
        match self.try_resume(params).await {
            Ok(result) => result,
            Err(error) => resume_failure(error.recovery_condition(), &error),
        }
    }

    // A resume's bring-up; its failures are the caller's to answer through the `Failed` arm.
    async fn try_resume(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, ClaudeEstablishmentError> {
        let session_id = params.session_id;
        if params.larger_window.is_some() {
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::LargerWindowFigureUnsupported,
                session_id,
                None,
            )
            .into());
        }
        let claim = loop {
            match self.slots.claim_resume(session_id).await? {
                ClaudeResumeSlot::Claimed(claim) => break claim,
                // A process on another conversation is no resume of the one asked for.
                ClaudeResumeSlot::CameUp(live)
                    if live.provider_session_id != params.resume_handle =>
                {
                    return Err(ClaudeSessionError::SessionAlreadyLive {
                        holder_state: ClaudeSessionSlotState::Live,
                    }
                    .into());
                }
                ClaudeResumeSlot::CameUp(live) if runs_as_asked(&live, &params) => {
                    return answer_came_up(&live).await;
                }
                ClaudeResumeSlot::CameUp(live) => self.end_came_up(&live).await,
            }
        };
        let resume_handle = params.resume_handle.clone();
        let request = ClaudeSpawnRequest {
            session_id,
            agent_id: params.agent_id,
            model: params.model.as_str().to_owned(),
            execution_posture: params.execution_posture,
            callback_tools: params.callback_tools,
            subagent_policy: params.subagent_policy,
            tool_servers: params.tool_servers,
            output_schema: params.output_schema,
            on_mcp_server_status: params.on_mcp_server_status,
            provider_account_id: params.provider_account_id,
            ultracode: requested_claude_ultracode(&params.options),
            row_values: params.row_values,
        };
        let start = self
            .compose_start(
                claim,
                request,
                resume_handle.clone(),
                ClaudeConversationStart::Resume {
                    resume_handle: resume_handle.clone(),
                },
                (
                    params.mode,
                    params.output_speed.map(FreeFormText::into_string),
                ),
                ClaudeUsageEstablishment::Resume {
                    prior_emitted_thread_id: resume_handle.clone(),
                },
            )
            .await?;
        // Where the conversation stood when it was resumed, read before the process adds to it.
        let session_position =
            match read_turn_count(&start.legs.spawn_environment, &resume_handle).await {
                Ok(session_position) => session_position,
                Err(source) => {
                    start.callback_tools.roll_back();
                    return Err(ClaudeEstablishmentError::ConversationUnreadable {
                        resume_handle,
                        source,
                    });
                }
            };
        let started = self.bring_up(start).await?;
        Ok(resumed(session_position, resume_handle, started))
    }

    // Ends a process the resume found on other settings than it asks for, the way a relaunch ends
    // one: a frame read before the close still reaches its run, and the runs stay bound for the
    // process brought up next. Nothing once the slot no longer holds it.
    async fn end_came_up(&self, live: &Arc<LiveClaudeSession>) {
        let Some(close) = self.slots.begin_close_of(live) else {
            return;
        };
        close
            .retire_for_bring_up(&self.routes, &self.sources.ports)
            .await;
    }
}

// Whether `live` runs at the model, level, mode, output speed and Ultracode value `params` asks
// for; the output speed compared as the level it resolves to, which is the one a process takes.
fn runs_as_asked(live: &LiveClaudeSession, params: &ResumeSessionParams) -> bool {
    let settings = lock(&live.settings);
    settings.running_model == params.model.as_str()
        && settings.execution_posture == params.execution_posture
        && settings.session_mode == params.mode
        && settings.applied_output_speed.as_deref()
            == params
                .output_speed
                .as_ref()
                .map(|level| resolve_claude_output_speed(level.as_str()))
        && settings.ultracode_requested == requested_claude_ultracode(&params.options)
}

// The `Resumed` arm for a process a waited bring-up left running the conversation asked for.
async fn answer_came_up(
    live: &LiveClaudeSession,
) -> Result<DriverResumeResult, ClaudeEstablishmentError> {
    let resume_handle = live.provider_session_id.clone();
    let session_position =
        read_turn_count(&live.spawn_bound_legs.spawn_environment, &resume_handle)
            .await
            .map_err(|source| ClaudeEstablishmentError::ConversationUnreadable {
                resume_handle: resume_handle.clone(),
                source,
            })?;
    Ok(resumed(
        session_position,
        resume_handle,
        live.spawned_version.clone(),
    ))
}

// The `Resumed` arm for a process running conversation `resume_handle`, on a binding minted for it.
fn resumed(
    session_position: SafeInt<0>,
    resume_handle: String,
    spawned_version: SpawnedVersionBindingCarriers,
) -> DriverResumeResult {
    DriverResumeResult::Resumed {
        binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string())
            .expect("a minted UUID is a binding id"),
        session_position,
        resume_handle: NonEmptyText::new(resume_handle)
            .expect("a resumed conversation's id is never empty"),
        spawned_version,
    }
}

// The `Failed` resume arm for `error`, its words fitted to the detail's cap.
fn resume_failure(
    recovery_condition: RecoveryCondition,
    error: &(dyn Error + 'static),
) -> DriverResumeResult {
    DriverResumeResult::Failed {
        recovery_condition,
        provider_failure_detail: bound_failure_detail(
            &crate::error_description::describe_error(error),
            UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
        ),
    }
}
