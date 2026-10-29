//! A session's conversation adopted in place by its handle on its account's service, under the
//! binding its resume names. A conversation the service holds loaded is joined as it runs, with no
//! setting sent, since Codex applies none to a loaded conversation, so its running turns, waiting
//! asks and helpers go on; one no client holds is loaded again with every setting the session
//! holds. The session's record is rebuilt from the live runs the resume names: each open turn
//! Codex lists bound to its run, each loaded helper bound to its child run, and what Codex holds
//! of each run's turns answered.

use std::sync::Arc;

use serde_json::value::RawValue;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::turn::ProviderTurnId;
use tokio::time::Instant;

use super::{
    CodexEstablishedSession, CodexHandleResume, CodexResumedThread, CodexSessionEstablishment,
    compose_failed_resume, prepare_adoption, read_resumed_thread, request_thread_resume,
};
use crate::driver::codex::delivery::memory::{CodexChildRun, CodexStartedChildRun};
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::service::supervisor::start::read_codex_loaded_threads;
use crate::driver::codex::service::supervisor::{CODEX_UNLOAD_TIMEOUT, CodexService};
use crate::driver::codex::session::context_reading::{
    CodexFixedStart, read_codex_kept_fixed_start,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::settings::{
    compose_resume_settings_request, require_execution_posture,
};
use crate::driver::codex::session::history::CodexListedTurn;
use crate::driver::codex::session::inbound::codex_session_inbound;
use crate::driver::codex::session::owed_turn_ends::is_codex_turn_in_progress;
use crate::driver::codex::session::slots::let_go_codex_thread;
use crate::driver::codex::session::state::{CodexEstablishedConversation, CodexSessionRecord};
use crate::driver::codex::thread::settings::compose_codex_bare_thread_resume_params;
use crate::driver::codex::thread::view::CodexThreadStatus;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, ProviderTurnAnswer, ResumeSessionParams, ResumedRunAnswer,
};
use crate::run::turn_end::StartedTurn;
use crate::usage_delta_accountant::UsageAxisCounts;

/// A helper an adopted conversation holds again: its conversation, and what was already metered
/// on it, which its usage is based on.
pub(crate) struct CodexRestoredHelper {
    /// The helper's conversation, whose id is the helper's own.
    pub(crate) thread_id: String,
    /// The spend already metered on it; zero until the caller reads it.
    pub(crate) prior_emitted: UsageAxisCounts,
}

impl CodexSessionEstablishment {
    /// Resumes the session's conversation in place by its handle on its account's service: joined
    /// as it runs, with no setting sent, where the service holds it loaded, else loaded again with
    /// every setting the session holds. A resume Codex refuses while it closes the loaded
    /// conversation waits for the close and loads it again. The result answers what Codex holds of
    /// each live run's turns. Every failure answers `Failed`, nothing left behind.
    pub(crate) async fn resume_by_handle(&self, params: &ResumeSessionParams) -> CodexHandleResume {
        let mut service = None;
        match self.adopt_conversation(params, &mut service).await {
            Ok((result, established)) => CodexHandleResume {
                result,
                established: Some(established),
            },
            Err(error) => CodexHandleResume {
                result: compose_failed_resume(service.as_deref(), &error).await,
                established: None,
            },
        }
    }

    async fn adopt_conversation(
        &self,
        params: &ResumeSessionParams,
        started: &mut Option<Arc<CodexService>>,
    ) -> Result<(DriverResumeResult, CodexEstablishedSession), CodexError> {
        let composed = self
            .compose_thread_settings(compose_resume_settings_request(params))
            .await?;
        let execution_posture = require_execution_posture(params.execution_posture.as_ref())?;
        let service =
            Arc::clone(started.insert(self.start_service(&params.provider_account_id).await?));
        let connection = service.connection()?;
        let loaded = read_codex_loaded_threads(&connection).await?;
        let session_id = params.session_id;
        let thread_id = params.resume_handle.clone();
        let (inbound, receiver) = codex_session_inbound(session_id);
        let mut record = CodexSessionRecord::new(CodexEstablishedConversation {
            session_id,
            service: Arc::clone(&service),
            inbound: inbound.clone(),
            thread_id: thread_id.clone(),
            binding_id: Some(params.binding_id.clone()),
            provider_account_id: params.provider_account_id.clone(),
            turn_boundaries: Vec::new(),
            thread_settings: composed.thread_settings,
            execution_posture,
            session_mode: params.mode,
            output_speed_request: params
                .output_speed
                .as_ref()
                .map(|level| level.as_str().to_owned()),
            declared_output_speed: None,
            reasoning_effort: None,
        });
        let helpers = find_loaded_helpers(&params.live_runs, &loaded);
        let registered: Vec<String> = std::iter::once(thread_id.clone())
            .chain(helpers.iter().map(|helper| helper.thread_id.clone()))
            .collect();
        let claim = service.begin_thread_claim();
        // Attached and registered before the resume, since Codex sends a loaded conversation's
        // waiting asks again right after its reply, and one no session's conversation names is
        // refused.
        service.attach_session(inbound);
        for registering in &registered {
            service.register_thread(registering.clone(), session_id);
        }
        let is_loaded = loaded.contains(&thread_id);
        let reply = match self
            .request_adoption(&record, &service, &connection, is_loaded)
            .await
        {
            Ok(reply) => reply,
            Err(error) => {
                release_registered(&service, &record, &registered);
                return Err(error);
            }
        };
        let adopted = async {
            let resumed = read_resumed_thread(&record, &connection, &reply, false).await?;
            let runs = answer_live_runs(&params.live_runs, &resumed, &helpers);
            let result =
                prepare_adoption(&record, &service, &resumed, &params.binding_id, runs).await?;
            Ok::<_, CodexError>((resumed, result))
        }
        .await;
        let (resumed, result) = match adopted {
            Ok(adopted) => adopted,
            Err(error) => {
                release_registered(&service, &record, &registered);
                let_go_codex_thread(&service, &thread_id).await;
                return Err(error);
            }
        };
        record.turn_boundaries = resumed
            .listed_turns
            .iter()
            .map(|listed| listed.id.clone())
            .collect();
        record.declared_output_speed = resumed.declared_output_speed;
        record.reasoning_effort = resumed.reasoning_effort;
        let binding = CodexRunBinding {
            session_id,
            binding_id: params.binding_id.clone(),
            agent_id: params.agent_id,
            step_bound: composed.step_bound,
        };
        self.bind_listed_turns(
            &mut record,
            &params.live_runs,
            &resumed.listed_turns,
            &binding,
        );
        for helper in &helpers {
            restore_helper(&mut record, helper, &binding);
        }
        let established = CodexEstablishedSession {
            record,
            receiver,
            claim,
            fixed_start: CodexFixedStart::Kept(read_codex_kept_fixed_start(
                &params.runtime_metadata,
            )),
            listed_turns: resumed.listed_turns,
            helpers: helpers
                .into_iter()
                .map(|helper| CodexRestoredHelper {
                    thread_id: helper.thread_id,
                    prior_emitted: UsageAxisCounts::default(),
                })
                .collect(),
        };
        Ok((result, established))
    }

    // `thread/resume` of the record's conversation: with no setting where the service holds it
    // loaded, else with every setting the record holds. One Codex refuses while it closes the
    // conversation is sent again, loading it anew, once the close is confirmed within the unload's
    // bound. Answers the reply.
    async fn request_adoption(
        &self,
        record: &CodexSessionRecord,
        service: &CodexService,
        connection: &CodexAppServerConnection,
        mut is_loaded: bool,
    ) -> Result<Box<RawValue>, CodexError> {
        let deadline = Instant::now() + CODEX_UNLOAD_TIMEOUT;
        loop {
            let reply = if is_loaded {
                let bare = compose_codex_bare_thread_resume_params(record.thread_id.clone());
                request_thread_resume(connection, &record.thread_id, &bare).await
            } else {
                self.request_resume_with_settings(record, connection).await
            };
            match reply {
                Err(error)
                    if error.is_closing_refusal()
                        && Instant::now() < deadline
                        && service.await_unloaded(&record.thread_id, deadline).await =>
                {
                    is_loaded = false;
                }
                reply => return reply,
            }
        }
    }

    // Binds each open turn of a lead run that Codex lists to its run, numbered and started as its
    // log recorded it, and the run's deliveries onto `binding`; a listed turn Codex ended is
    // bound too, so its end, which Codex sent while the daemon was away, ends it.
    fn bind_listed_turns(
        &self,
        record: &mut CodexSessionRecord,
        live_runs: &[LiveRunResume],
        listed_turns: &[CodexListedTurn],
        binding: &CodexRunBinding,
    ) {
        let run_routes = &self.dependencies.run_routes;
        for run in live_runs.iter().filter(|run| run.subagent_id.is_none()) {
            let mut is_bound = false;
            for turn in &run.open_turns {
                let Some(turn_id) = turn.provider_turn_id.as_ref().map(ProviderTurnId::as_str)
                else {
                    continue;
                };
                if !listed_turns.iter().any(|listed| listed.id == turn_id) {
                    continue;
                }
                record.add_active_turn(turn_id.to_owned(), run.run_id);
                record.delivery.started_turn_by_turn_id.insert(
                    turn_id.to_owned(),
                    StartedTurn {
                        turn_number: turn.turn_number,
                        event_id: turn.started_event_id.clone(),
                    },
                );
                is_bound = true;
            }
            if is_bound {
                run_routes.bind_run(run.run_id, record.session_id);
                run_routes.bind_run_delivery(run.run_id, binding.clone());
            }
        }
    }
}

/// What Codex holds of each run's turns after a resume, `turns_by_run` naming each run's turns by
/// Codex's ids: a run with a turn listed as running reads `StillRunning`, one whose turns are
/// listed only as over `EndedByProvider`, and one with no listed turn, or on a conversation Codex
/// runs no turn of, `Gone`.
pub(super) fn answer_codex_resumed_turns<'turns>(
    status: Option<CodexThreadStatus>,
    listed_turns: &[CodexListedTurn],
    turns_by_run: impl IntoIterator<Item = (RunId, Vec<&'turns str>)>,
) -> Vec<ResumedRunAnswer> {
    turns_by_run
        .into_iter()
        .map(|(run_id, turn_ids)| ResumedRunAnswer {
            run_id,
            turn: answer_turns(status, listed_turns, &turn_ids),
        })
        .collect()
}

// What Codex holds of one run's turns `turn_ids`, as `answer_codex_resumed_turns` reads it.
fn answer_turns(
    status: Option<CodexThreadStatus>,
    listed_turns: &[CodexListedTurn],
    turn_ids: &[&str],
) -> ProviderTurnAnswer {
    match status {
        Some(CodexThreadStatus::Active | CodexThreadStatus::Idle) => {}
        Some(CodexThreadStatus::NotLoaded | CodexThreadStatus::SystemError) | None => {
            return ProviderTurnAnswer::Gone;
        }
    }
    let mut listed = listed_turns
        .iter()
        .filter(|listed| turn_ids.contains(&listed.id.as_str()))
        .peekable();
    if listed.peek().is_none() {
        return ProviderTurnAnswer::Gone;
    }
    if listed.any(|listed| is_codex_turn_in_progress(&listed.turn)) {
        ProviderTurnAnswer::StillRunning
    } else {
        ProviderTurnAnswer::EndedByProvider
    }
}

/// A live helper run whose conversation the service holds loaded, with the run it was started
/// beneath.
struct LoadedHelper {
    thread_id: String,
    run: LiveRunResume,
    parent_run_id: RunId,
}

// The live helper runs of `live_runs` whose conversations `loaded` holds and whose parent run the
// log names, so a child run can be bound to each.
fn find_loaded_helpers(live_runs: &[LiveRunResume], loaded: &[String]) -> Vec<LoadedHelper> {
    live_runs
        .iter()
        .filter_map(|run| {
            let thread_id = run.subagent_id.as_ref()?.as_str();
            let parent_run_id = run.parent_run_id?;
            loaded
                .iter()
                .any(|held| held == thread_id)
                .then(|| LoadedHelper {
                    thread_id: thread_id.to_owned(),
                    run: run.clone(),
                    parent_run_id,
                })
        })
        .collect()
}

// Each live run's answer: a lead's from its open turns as Codex lists them, a helper's
// `StillRunning` where its conversation is loaded and bound again, else `Gone`.
fn answer_live_runs(
    live_runs: &[LiveRunResume],
    resumed: &CodexResumedThread,
    helpers: &[LoadedHelper],
) -> Vec<ResumedRunAnswer> {
    live_runs
        .iter()
        .map(|run| {
            let turn = if run.subagent_id.is_some() {
                if helpers.iter().any(|helper| helper.run.run_id == run.run_id) {
                    ProviderTurnAnswer::StillRunning
                } else {
                    ProviderTurnAnswer::Gone
                }
            } else {
                let turn_ids: Vec<&str> = run
                    .open_turns
                    .iter()
                    .filter_map(|turn| turn.provider_turn_id.as_ref().map(ProviderTurnId::as_str))
                    .collect();
                answer_turns(resumed.status, &resumed.listed_turns, &turn_ids)
            };
            ResumedRunAnswer {
                run_id: run.run_id,
                turn,
            }
        })
        .collect()
}

// Binds a loaded helper's conversation to its child run, started beneath its parent, so its rows
// and asks land on that run and its end completes it.
fn restore_helper(
    record: &mut CodexSessionRecord,
    helper: &LoadedHelper,
    binding: &CodexRunBinding,
) {
    let Some(subagent_id) = helper.run.subagent_id.clone() else {
        return;
    };
    record.delivery.child_run_by_thread_id.insert(
        helper.thread_id.clone(),
        CodexChildRun {
            started: Some(CodexStartedChildRun {
                child_run_id: helper.run.run_id,
                parent_run_id: helper.parent_run_id,
                start_row_event_id: None,
            }),
            agent_id: binding.agent_id,
            binding_id: binding.binding_id.clone(),
            subagent_id,
            parent_tool_call_id: None,
        },
    );
    record
        .delivery
        .child_thread_id_by_run_id
        .insert(helper.run.run_id, helper.thread_id.clone());
}

// Takes back what an adoption that failed set up on `service` before its resume: the session's
// queue and the conversations it registered.
fn release_registered(service: &CodexService, record: &CodexSessionRecord, registered: &[String]) {
    for thread_id in registered {
        service.release_thread(thread_id);
    }
    service.detach_session(&record.session_id);
}
