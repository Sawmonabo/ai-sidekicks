//! A resume of a session's conversation: brought up in a fresh process, or answered by the
//! session's live process, one a relaunch or the person's restart brought up, when that process
//! runs the conversation and settings the resume asks for; one on other settings is ended and
//! brought up again with the resume's own. A fresh process continues the turn of the run in
//! progress where the resume names one, on that run and turn.

use std::error::Error;
use std::sync::Arc;

use jiff::Timestamp;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_std::mutex_lock::lock;

use super::{
    ClaudeEstablishmentError, ClaudeResumeAnswer, ClaudeSessionEstablishment, ClaudeSessionStart,
    ClaudeSpawnRequest,
};
use crate::driver::claude::output_speed::resolve_claude_output_speed;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoute, ClaudeRunRoutes};
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
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, OpenTurnResume, ProviderTurnAnswer, ResumeSessionParams,
    ResumedRunAnswer, answer_every_run_gone,
};

/// The turn a resumed process continues: the run in progress on the binding the resume answers,
/// at its newest open turn.
pub(crate) struct ClaudeContinuedTurn {
    /// The run and the binding its frames are attributed on.
    pub(crate) run: ClaudeBoundRun,
    /// The turn's number within its run.
    pub(crate) turn_number: SafeInt<1>,
    /// The id the turn's start recorded, where it recorded one.
    pub(crate) provider_turn_id: Option<ProviderTurnId>,
}

impl ClaudeSessionEstablishment {
    /// Resumes the conversation `params` names in a fresh process under the binding the caller
    /// minted into it, or answers the session's live process when it runs that conversation at the
    /// settings `params` asks for, on the binding the resume that brought it up answered, else on
    /// the minted one; every failure answers the `Failed` arm, nothing left running.
    pub(crate) async fn resume(&self, mut params: ResumeSessionParams) -> ClaudeResumeAnswer {
        let session_id = params.session_id;
        let schedules = std::mem::take(&mut params.kept_schedules);
        let answer = match self.try_resume(params).await {
            Ok(answer) => answer,
            Err(error) => ClaudeResumeAnswer {
                result: resume_failure(error.recovery_condition(), &error),
                has_started_process: false,
            },
        };
        // The timed fires stored for the session, which a fresh process does not keep, go to a
        // session whose process came up; a failed resume leaves none to fire.
        if matches!(answer.result, DriverResumeResult::Resumed { .. }) {
            self.task_services
                .idle_sleep
                .seed_schedules(session_id, schedules, Timestamp::now());
        }
        answer
    }

    // A resume's bring-up; its failures are the caller's to answer through the `Failed` arm.
    async fn try_resume(
        &self,
        params: ResumeSessionParams,
    ) -> Result<ClaudeResumeAnswer, ClaudeEstablishmentError> {
        let session_id = params.session_id;
        let binding_id = params.binding_id.clone();
        let in_progress = find_run_in_progress(&params.live_runs);
        let continued_run_id = in_progress.map(|(run, _)| run.run_id);
        let continued_turn = in_progress.map(|(run, turn)| ClaudeContinuedTurn {
            run: ClaudeBoundRun {
                run_id: run.run_id,
                binding_id: binding_id.clone(),
            },
            turn_number: turn.turn_number,
            provider_turn_id: turn.provider_turn_id.clone(),
        });
        let runs = answer_fresh_process(&params.live_runs, continued_run_id);
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
                    let runs = answer_held_turns(&self.routes, session_id, &params.live_runs);
                    return Ok(ClaudeResumeAnswer {
                        result: answer_came_up(&live, binding_id, runs).await?,
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
            continued_turn,
        };
        let output_speed = params.output_speed.map(FreeFormText::into_string);
        let (started, session_position) = self
            .spawn_on_command_channel(session_id, async |command_channel| {
                let start = ClaudeSessionStart {
                    resumed_binding_id: Some(binding_id.clone()),
                    ..self
                        .compose_start(
                            claim,
                            request,
                            command_channel,
                            resume_handle.clone(),
                            ClaudeConversationStart::Resume {
                                resume_handle: resume_handle.clone(),
                            },
                            (params.mode, output_speed),
                            ClaudeUsageEstablishment::Resume {
                                prior_emitted_thread_id: resume_handle.clone(),
                            },
                        )
                        .await?
                };
                // Where the conversation stood when it was resumed, read before the process adds
                // to it.
                let session_position =
                    match read_turn_count(&start.legs.spawn_environment, &resume_handle).await {
                        Ok(session_position) => session_position,
                        Err(source) => {
                            start.callback_tools.roll_back();
                            return Err(ClaudeEstablishmentError::ConversationUnreadable {
                                resume_handle: resume_handle.clone(),
                                source,
                            });
                        }
                    };
                // Held before the process is read, so its first frames, the `system/init` among
                // them, go to the run whose turn it continues and open no run of their own.
                if let Some(run_id) = continued_run_id
                    && self
                        .routes
                        .hold_turn(run_id, session_id, binding_id.clone())
                        .is_err()
                {
                    start.callback_tools.roll_back();
                    return Err(claude_session_unavailable(
                        ClaudeSessionUnavailableReason::SessionTurnInFlight,
                        session_id,
                        Some(run_id),
                    )
                    .into());
                }
                let brought_up = self
                    .bring_up_and(start, async |live| {
                        if continued_run_id.is_some() {
                            live.record_served_binding(binding_id.clone());
                        }
                        Ok(())
                    })
                    .await;
                if brought_up.is_err()
                    && let Some(run_id) = continued_run_id
                {
                    self.routes.unbind_run(run_id);
                }
                Ok((brought_up?, session_position))
            })
            .await?;
        Ok(ClaudeResumeAnswer {
            result: resumed(binding_id, session_position, resume_handle, started, runs),
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

// The run in progress among `live_runs` and its newest open turn, which a fresh process continues:
// a lead run, started on its own and no helper, with a turn started and not ended.
fn find_run_in_progress(live_runs: &[LiveRunResume]) -> Option<(&LiveRunResume, &OpenTurnResume)> {
    live_runs
        .iter()
        .filter(|run| run.subagent_id.is_none() && run.parent_run_id.is_none())
        .find_map(|run| run.open_turns.last().map(|turn| (run, turn)))
}

// What a fresh process holds of each run in `live_runs`: the turn of the run in progress, which it
// continues, still runs; every other run's turn, a helper's included, is gone.
fn answer_fresh_process(
    live_runs: &[LiveRunResume],
    in_progress: Option<RunId>,
) -> Vec<ResumedRunAnswer> {
    let mut runs = answer_every_run_gone(live_runs);
    if let Some(answer) = runs
        .iter_mut()
        .find(|answer| Some(answer.run_id) == in_progress)
    {
        answer.turn = ProviderTurnAnswer::StillRunning;
    }
    runs
}

// What the session's live process holds of each run in `live_runs`: the run holding the session's
// turn, and each helper's run started beneath it, still run there; every other run's turn is gone.
fn answer_held_turns(
    routes: &ClaudeRunRoutes,
    session_id: SessionId,
    live_runs: &[LiveRunResume],
) -> Vec<ResumedRunAnswer> {
    let held = routes.lead_run_on(session_id).map(|lead| lead.run_id);
    live_runs
        .iter()
        .map(|run| {
            let is_held = held.is_some_and(|held| {
                run.run_id == held
                    || matches!(
                        routes.route_of(run.run_id),
                        Some(ClaudeRunRoute::Child(child)) if child.parent_run_id == held
                    )
            });
            ResumedRunAnswer {
                run_id: run.run_id,
                turn: if is_held {
                    ProviderTurnAnswer::StillRunning
                } else {
                    ProviderTurnAnswer::Gone
                },
            }
        })
        .collect()
}

// The `Resumed` arm for the live process running the conversation asked for, on the binding its
// resume answered, with `runs`; a create's process has none, so it is answered on `binding_id`.
async fn answer_came_up(
    live: &LiveClaudeSession,
    binding_id: RuntimeBindingId,
    runs: Vec<ResumedRunAnswer>,
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
        runs,
    ))
}

// The `Resumed` arm for a process running conversation `resume_handle`, on `binding_id`, with
// what it holds of each run the resume named.
fn resumed(
    binding_id: RuntimeBindingId,
    session_position: SafeInt<0>,
    resume_handle: String,
    spawned_version: SpawnedVersionBindingCarriers,
    runs: Vec<ResumedRunAnswer>,
) -> DriverResumeResult {
    DriverResumeResult::Resumed {
        binding_id,
        session_position,
        resume_handle: NonEmptyText::new(resume_handle)
            .expect("a resumed conversation's id is never empty"),
        spawned_version,
        runs,
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
