//! A resume of a session's conversation: brought up in a fresh process, or answered by the
//! session's live process, one a relaunch or the person's restart brought up, when that process
//! runs the conversation and settings the resume asks for; one on other settings is ended and
//! brought up again with the resume's own.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_std::mutex_lock::lock;

use super::{
    ClaudeEstablishmentError, ClaudeResumeAnswer, ClaudeSessionEstablishment, ClaudeSessionStart,
    ClaudeSpawnRequest,
};
use crate::driver::claude::output_speed::resolve_claude_output_speed;
use crate::driver::claude::run::start::claude_session_unavailable;
use crate::driver::claude::session::conversation_file::read_turn_count;
use crate::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionSlotState, ClaudeSessionUnavailableReason,
};
use crate::driver::claude::session::slots::ClaudeResumeSlot;
use crate::driver::claude::session::state::{ClaudeUsageEstablishment, LiveClaudeSession};
use crate::driver::claude::session::ultracode::requested_claude_ultracode;
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::contract::{SpawnedVersionBindingCarriers, bound_failure_detail};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::driver::session_control::{DriverResumeResult, ResumeSessionParams};

impl ClaudeSessionEstablishment {
    /// Resumes the conversation `params` names in a fresh process under the binding the caller
    /// minted into it, or answers the session's live process when it runs that conversation at the
    /// settings `params` asks for, on the binding the resume that brought it up answered, else on
    /// the minted one; every failure answers the `Failed` arm, nothing left running.
    pub(crate) async fn resume(&self, params: ResumeSessionParams) -> ClaudeResumeAnswer {
        match self.try_resume(params).await {
            Ok(answer) => answer,
            Err(error) => ClaudeResumeAnswer {
                result: resume_failure(error.recovery_condition(), &error),
                has_started_process: false,
            },
        }
    }

    // A resume's bring-up; its failures are the caller's to answer through the `Failed` arm.
    async fn try_resume(
        &self,
        params: ResumeSessionParams,
    ) -> Result<ClaudeResumeAnswer, ClaudeEstablishmentError> {
        let session_id = params.session_id;
        let binding_id = params.binding_id.clone();
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
                    return Ok(ClaudeResumeAnswer {
                        result: answer_came_up(&live, binding_id).await?,
                        has_started_process: false,
                    });
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
        let start = ClaudeSessionStart {
            resumed_binding_id: Some(binding_id.clone()),
            ..self
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
                .await?
        };
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
        Ok(ClaudeResumeAnswer {
            result: resumed(binding_id, session_position, resume_handle, started),
            has_started_process: true,
        })
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

// Whether `live` runs with everything `params` would start a process with: the lead, account, tool
// servers, callback tools, helper policy, output schema, model, level, mode, output speed,
// Ultracode value and Settings rows. The callback tools and rows are compared as `live`'s process
// was asked for them, before the host trimmed the tools and the session's own advisor and style
// overrode the rows, since a fresh process would be trimmed and overridden the same way. The output
// speed is compared as the level it resolves to, which is the one a process takes; none and an
// empty list of tools or callback tools are alike. The status sink is the caller's per binding and
// changes nothing a process starts with.
fn runs_as_asked(live: &LiveClaudeSession, params: &ResumeSessionParams) -> bool {
    let legs = &live.spawn_bound_legs;
    let requested = &live.requested_spawn;
    let settings = lock(&live.settings);
    live.agent_id == params.agent_id
        && live.admitted_provider_account_id == params.provider_account_id
        && legs.tool_servers.as_slice() == params.tool_servers.as_deref().unwrap_or_default()
        && requested.callback_tools.as_deref().unwrap_or_default()
            == params.callback_tools.as_deref().unwrap_or_default()
        && requested.row_values == params.row_values
        && legs.subagent_policy == params.subagent_policy
        && legs.output_schema == params.output_schema
        && settings.running_model == params.model.as_str()
        && settings.execution_posture == params.execution_posture
        && settings.session_mode == params.mode
        && settings.applied_output_speed.as_deref()
            == params
                .output_speed
                .as_ref()
                .map(|level| resolve_claude_output_speed(level.as_str()))
        && settings.ultracode_requested == requested_claude_ultracode(&params.options)
}

// The `Resumed` arm for the live process running the conversation asked for, on the binding its
// resume answered; a create's process has none, so it is answered on `binding_id`.
async fn answer_came_up(
    live: &LiveClaudeSession,
    binding_id: RuntimeBindingId,
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
        live.resumed_binding_id.clone().unwrap_or(binding_id),
        session_position,
        resume_handle,
        live.spawned_version.clone(),
    ))
}

// The `Resumed` arm for a process running conversation `resume_handle`, on `binding_id`.
fn resumed(
    binding_id: RuntimeBindingId,
    session_position: SafeInt<0>,
    resume_handle: String,
    spawned_version: SpawnedVersionBindingCarriers,
) -> DriverResumeResult {
    DriverResumeResult::Resumed {
        binding_id,
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
            &sidekicks_std::error_description::describe_error(error),
            UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
        ),
    }
}
