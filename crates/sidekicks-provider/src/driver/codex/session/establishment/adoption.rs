//! A session's conversation adopted in place by its handle on its account's service, under the
//! binding its resume names. A conversation the service holds loaded is joined as it runs, with no
//! setting sent, since Codex applies none to a loaded conversation, so its running turns, waiting
//! asks and helpers go on, and its calls to the daemon's tool servers, at the address it kept, are
//! answered by the adopting spawn; one no client holds is loaded again with every setting the
//! session holds. The resume asks for the conversation's newest turn beside its paged history. The
//! session's record is rebuilt from the live runs the resume names: a lead run whose turn the end
//! of the daemon's own service cut continued in a new turn, a lead whose cut turn Codex continued
//! itself on a service the daemon only joined held to the turn that newest one shows, every other
//! open turn Codex lists bound to its run, and what Codex holds of each run's turns answered. A
//! lead held on the person waits with its cut turn unbound, and a pausing lead's cut turn is gone,
//! so the daemon ends it as the pause owes; both keep their deliveries' binding for the person's
//! continue. Each live helper is answered from its newest turn, parents first: a loaded one is
//! reopened on the daemon's connection, which Codex sends its frames on only after that, and an
//! unloaded one is listed, which loads nothing. A helper Codex runs, or whose newest turn is over,
//! is bound to its child run again, the end of that turn owed as the session opens; a helper held
//! on the person whose newest turn is over has it marked held, so its end is the daemon's.

use std::error::Error;
use std::sync::Arc;

use serde_json::value::RawValue;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use tokio::time::Instant;

use super::continuation::{answer_continued_runs, read_cut_turns};
use super::helpers::{bind_codex_helper_run, order_parents_first, reopen_codex_helper};
use super::{
    CodexEstablishedSession, CodexHandleResume, CodexResumedThread, CodexSessionEstablishment,
    compose_failed_resume, prepare_adoption, read_resumed_thread, request_thread_resume,
};
use crate::driver::codex::delivery::memory::{CodexBoundChildRun, CodexChildRun};
use crate::driver::codex::run::routes::{CodexRunBinding, CodexRunRoutes};
use crate::driver::codex::run::turn_interrupt::interrupt_codex_running_turn;
use crate::driver::codex::service::home::CodexConversationHome;
use crate::driver::codex::service::supervisor::start::read_codex_loaded_threads;
use crate::driver::codex::service::supervisor::{CODEX_UNLOAD_TIMEOUT, CodexService};
use crate::driver::codex::service::trust::confirm_codex_daemon_hook_rows;
use crate::driver::codex::session::context_reading::{
    CodexFixedStart, read_codex_kept_fixed_start,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::settings::{
    compose_resume_settings_request, require_execution_posture,
};
use crate::driver::codex::session::history::{
    CodexListedTurn, compose_codex_newest_turn_page, read_codex_newest_turn,
};
use crate::driver::codex::session::inbound::codex_session_inbound;
use crate::driver::codex::session::owed_turn_ends::is_codex_turn_in_progress;
use crate::driver::codex::session::slots::let_go_codex_thread;
use crate::driver::codex::session::state::{CodexEstablishedConversation, CodexSessionRecord};
use crate::driver::codex::thread::settings::hook_rows::sends_codex_daemon_hook_rows;
use crate::driver::codex::thread::settings::memories::compose_codex_bare_thread_resume_with_memory_switch;
use crate::driver::codex::thread::settings::tool_servers::CodexDaemonToolServers;
use crate::driver::codex::thread::view::CodexThreadStatus;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, ProviderTurnAnswer, ResumeSessionParams, ResumedRunAnswer,
};
use crate::run::turn_end::StartedTurn;
use crate::usage_delta_accountant::UsageAxisCounts;

/// A helper an adopted conversation holds again: its conversation, its newest turn, and what was
/// already metered on it, which its usage is based on.
pub(crate) struct CodexRestoredHelper {
    /// The helper's conversation, whose id is the helper's own.
    pub(crate) thread_id: String,
    /// Its newest turn as Codex read it at the adoption; one listed over is ended as the session
    /// opens, since Codex sent its end while the daemon was away, as the daemon's where it is held.
    pub(crate) newest_turn: CodexListedTurn,
    /// The spend already metered on it; zero until the caller reads it.
    pub(crate) prior_emitted: UsageAxisCounts,
    /// The model its reopen named, `None` for one only listed or a reply naming none.
    pub(crate) model: Option<String>,
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
        let home = CodexConversationHome::read(&params.runtime_metadata);
        let service = Arc::clone(
            started.insert(
                self.start_service(&params.provider_account_id, home)
                    .await?,
            ),
        );
        let connection = service.connection()?;
        let loaded = read_codex_loaded_threads(&connection).await?;
        let session_id = params.session_id;
        let thread_id = params.resume_handle.clone();
        let is_loaded = loaded.contains(&thread_id);
        let callback_tools = params.callback_tools.clone().unwrap_or_default();
        // A loaded conversation takes no new table, so it keeps calling at the address and with
        // the secret an earlier start of the daemon gave it, which the adopted entries answer.
        let daemon_tool_servers = if is_loaded {
            CodexDaemonToolServers::adopt(
                &self.dependencies.tool_server_route,
                &self.dependencies.callback_tool_host,
                &self.dependencies.hook_tools,
                &service,
                session_id,
                callback_tools,
            )?
        } else {
            self.open_tool_servers(&service, session_id, callback_tools)?
        };
        let (inbound, receiver) = codex_session_inbound(session_id);
        let mut record = CodexSessionRecord::new(CodexEstablishedConversation {
            session_id,
            lead_agent_id: params.agent_id,
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
            // The resume's own sink, bound to the binding it runs under.
            on_mcp_server_status: params.on_mcp_server_status.clone(),
            daemon_tool_servers,
        });
        let mut helpers = order_parents_first(
            find_live_helpers(&params.live_runs, &loaded),
            |helper| helper.run_id,
            |helper| Some(helper.parent_run_id),
        );
        let registered: Vec<String> = std::iter::once(thread_id.clone())
            .chain(
                helpers
                    .iter()
                    .filter(|helper| helper.is_loaded)
                    .map(|helper| helper.subagent_id.as_str().to_owned()),
            )
            .collect();
        let claim = service.begin_thread_claim();
        // Attached and registered before the resume, since Codex sends a loaded conversation's
        // waiting asks again right after its reply, and one no session's conversation names is
        // refused.
        service.attach_session(inbound);
        for registering in &registered {
            service.register_thread(registering.clone(), session_id);
        }
        let reply = match self
            .request_adoption(&mut record, &service, &connection, is_loaded)
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
            read_helper_newest_turns(&connection, session_id, &mut helpers).await;
            let runs = answer_live_runs(&params.live_runs, &resumed, &helpers);
            let result =
                prepare_adoption(&record, &service, &resumed, &params.binding_id, runs).await?;
            Ok::<_, CodexError>((resumed, result))
        }
        .await;
        let (mut resumed, mut result) = match adopted {
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
        record.declared_output_speed = resumed.declared_output_speed.take();
        record.reasoning_effort = resumed.reasoning_effort.take();
        let binding = CodexRunBinding {
            session_id,
            binding_id: params.binding_id.clone(),
            agent_id: params.agent_id,
            step_bound: composed.step_bound,
        };
        // After every step that can fail, so a failed adoption never leaves a continuation running.
        let held_run_continue = params.held_run_continue.as_ref();
        let mut continued = self
            .continue_cut_runs(
                &mut record,
                &connection,
                &params.live_runs,
                &resumed,
                &binding,
                held_run_continue,
            )
            .await;
        let answer_steer = self
            .continue_held_lead(
                &mut record,
                &connection,
                &params.live_runs,
                resumed.status,
                &resumed.listed_turns,
                &binding,
                held_run_continue,
                &mut continued,
            )
            .await;
        answer_continued_runs(&mut result, &continued);
        self.bind_listed_turns(
            &mut record,
            &params.live_runs,
            &resumed.listed_turns,
            &binding,
            &continued,
            &result,
        );
        let mut restored = Vec::new();
        for helper in helpers {
            if let Some(helper) = restore_helper(
                &mut record,
                helper,
                &binding,
                &self.dependencies.run_routes,
                &service,
            ) {
                restored.push(helper);
            }
        }
        let established = CodexEstablishedSession {
            record,
            receiver,
            claim,
            fixed_start: CodexFixedStart::Kept(read_codex_kept_fixed_start(
                &params.runtime_metadata,
            )),
            listed_turns: resumed.listed_turns,
            helpers: restored,
            answer_steer,
        };
        Ok((result, established))
    }

    // `thread/resume` of the record's conversation: with no setting where the service holds it
    // loaded, its hook rows then checked as a cold resume's are, else with every setting the record
    // holds. One Codex refuses while it closes the conversation is sent again, loading it anew,
    // once the close is confirmed within the unload's bound; a loaded one whose hook rows would not
    // run is let go and, once Codex unloads it within that bound, loaded anew with the settings,
    // else fails with the check's error. A conversation loaded anew takes fresh entries in place of
    // the adopted ones. Answers the reply.
    async fn request_adoption(
        &self,
        record: &mut CodexSessionRecord,
        service: &Arc<CodexService>,
        connection: &CodexAppServerConnection,
        mut is_loaded: bool,
    ) -> Result<Box<RawValue>, CodexError> {
        let deadline = Instant::now() + CODEX_UNLOAD_TIMEOUT;
        loop {
            let reply = if is_loaded {
                // Codex applies no setting to a loaded conversation, so none is sent.
                request_bare_thread_resume(connection, &record.thread_id, None).await
            } else {
                // The adoption holds no conversation of the session's before its resume.
                self.request_resume_with_settings(
                    record,
                    service,
                    connection,
                    record.daemon_tool_servers.as_ref(),
                    false,
                )
                .await
            };
            let (error, is_let_go) = match reply {
                Ok(reply)
                    if is_loaded
                        && sends_codex_daemon_hook_rows(
                            record
                                .daemon_tool_servers
                                .as_ref()
                                .map(CodexDaemonToolServers::route),
                        ) =>
                {
                    let Err(error) =
                        confirm_codex_daemon_hook_rows(connection, &record.thread_id).await
                    else {
                        return Ok(reply);
                    };
                    let_go_codex_thread(service, &record.thread_id).await;
                    (error, true)
                }
                Err(error) if error.is_closing_refusal() => (error, false),
                reply => return reply,
            };
            if Instant::now() >= deadline
                || !service.await_unloaded(&record.thread_id, deadline).await
            {
                return Err(error);
            }
            if is_let_go {
                // The let-go dropped the registration the adoption made before its resume.
                service.register_thread(record.thread_id.clone(), record.session_id);
            }
            if is_loaded {
                self.reopen_tool_servers(record, service)?;
            }
            is_loaded = false;
        }
    }

    // Replaces the record's adopted entries with ones opened for its conversation loaded anew, so
    // the addresses an earlier start of the daemon gave the session are answered no longer.
    fn reopen_tool_servers(
        &self,
        record: &mut CodexSessionRecord,
        service: &Arc<CodexService>,
    ) -> Result<(), CodexError> {
        let Some(adopted) = record.daemon_tool_servers.take() else {
            return Ok(());
        };
        let callback_tools = adopted.callback_tools().to_vec();
        adopted.rollback();
        record.daemon_tool_servers =
            self.open_tool_servers(service, record.session_id, callback_tools)?;
        Ok(())
    }

    // Binds each lead run not in `continued` by its answer in `result`, which binds nothing where
    // it answers no runs. A lead Codex still runs or ended has each open turn Codex lists bound
    // to it, numbered and started as its log recorded it, and its deliveries onto `binding`; a
    // listed turn Codex ended is bound too, so its end, which Codex sent while the daemon was
    // away, ends it, and a pausing lead's turn listed running is marked to pause at its next step
    // end, as a pause asked of it would. A lead waiting on the person, and a pausing or paused one
    // with no turn Codex runs and no stop pending, binds no turn, since a cut turn's listed end
    // would end the run, but keeps its deliveries' binding for the person's continue; that
    // binding leaves with the run's routes, at its next turn's end or the session's close. Any
    // other lead Codex holds no turn of binds nothing: its turns are the daemon's to end. A run in
    // `continued` is skipped: its cut turns are ended in the log.
    fn bind_listed_turns(
        &self,
        record: &mut CodexSessionRecord,
        live_runs: &[LiveRunResume],
        listed_turns: &[CodexListedTurn],
        binding: &CodexRunBinding,
        continued: &[ResumedRunAnswer],
        result: &DriverResumeResult,
    ) {
        let DriverResumeResult::Resumed { runs: answers, .. } = result else {
            return;
        };
        let run_routes = &self.dependencies.run_routes;
        let is_continued = |run: &LiveRunResume| {
            continued
                .iter()
                .any(|continued| continued.run_id == run.run_id)
        };
        for run in live_runs
            .iter()
            .filter(|run| run.subagent_id.is_none() && !is_continued(run))
        {
            let Some(answer) = answers.iter().find(|answer| answer.run_id == run.run_id) else {
                continue;
            };
            let is_bound = match answer.turn {
                ProviderTurnAnswer::StillRunning | ProviderTurnAnswer::EndedByProvider => {
                    bind_open_turns(record, run, listed_turns)
                }
                ProviderTurnAnswer::Waiting => true,
                ProviderTurnAnswer::Gone => {
                    !run.is_stopping
                        && matches!(run.run_state, RunState::Pausing | RunState::Paused)
                }
            };
            if is_bound {
                run_routes.bind_run(run.run_id, record.session_id);
                run_routes.bind_run_delivery(run.run_id, binding.clone());
            }
        }
    }
}

/// `thread/resume` of `thread_id` as it stands, with no setting but the session's memory switch
/// where `auto_memory` is set, asking for its newest turn, and the reply. Fails as the request
/// does, and when the reply names another conversation.
pub(crate) async fn request_bare_thread_resume(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    auto_memory: Option<bool>,
) -> Result<Box<RawValue>, CodexError> {
    let mut bare =
        compose_codex_bare_thread_resume_with_memory_switch(thread_id.to_owned(), auto_memory);
    bare.initial_turns_page = Some(compose_codex_newest_turn_page());
    request_thread_resume(connection, thread_id, &bare).await
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

// Binds each open turn of lead `run` that `listed_turns` names to the run, numbered and started
// as its log recorded it, and marks a pausing run's turn listed running to pause at its next step
// end. Answers whether any turn is bound.
fn bind_open_turns(
    record: &mut CodexSessionRecord,
    run: &LiveRunResume,
    listed_turns: &[CodexListedTurn],
) -> bool {
    let mut is_bound = false;
    for turn in &run.open_turns {
        let Some(turn_id) = turn.provider_turn_id.as_ref().map(ProviderTurnId::as_str) else {
            continue;
        };
        let Some(listed) = listed_turns.iter().find(|listed| listed.id == turn_id) else {
            continue;
        };
        record.add_active_turn(turn_id.to_owned(), run.run_id);
        record.delivery.started_turn_by_turn_id.insert(
            turn_id.to_owned(),
            StartedTurn {
                turn_number: turn.turn_number,
                event_id: turn.started_event_id.clone(),
            },
        );
        if run.run_state == RunState::Pausing && is_codex_turn_in_progress(&listed.turn) {
            record
                .pause_run_id_by_turn_id
                .insert(turn_id.to_owned(), run.run_id);
        }
        is_bound = true;
    }
    is_bound
}

/// A live helper run, with the run it was started beneath, whether the service holds its
/// conversation loaded, whether it is held on the person, and its newest turn and model once read.
struct AdoptedHelper {
    // Its id, which is its conversation's.
    subagent_id: SubagentId,
    run_id: RunId,
    parent_run_id: RunId,
    is_loaded: bool,
    is_held: bool,
    newest_turn: Option<CodexListedTurn>,
    model: Option<String>,
}

impl AdoptedHelper {
    // What Codex holds of the helper's turn, read from its newest turn: one over ended, one running
    // on a loaded conversation still runs, and one running on an unloaded conversation is gone,
    // since Codex unloads only an idle helper, so its turn died with a service; with no turn read,
    // the helper is gone.
    fn answer(&self) -> ProviderTurnAnswer {
        match &self.newest_turn {
            Some(newest) if !is_codex_turn_in_progress(&newest.turn) => {
                ProviderTurnAnswer::EndedByProvider
            }
            Some(_) if self.is_loaded => ProviderTurnAnswer::StillRunning,
            Some(_) | None => ProviderTurnAnswer::Gone,
        }
    }
}

// The live helper runs of `live_runs` whose parent run the log names, so a child run can be bound
// to each, each marked loaded where `loaded` holds its conversation.
fn find_live_helpers(live_runs: &[LiveRunResume], loaded: &[String]) -> Vec<AdoptedHelper> {
    live_runs
        .iter()
        .filter_map(|run| {
            let subagent_id = run.subagent_id.clone()?;
            let parent_run_id = run.parent_run_id?;
            Some(AdoptedHelper {
                is_loaded: loaded.iter().any(|held| held == subagent_id.as_str()),
                is_held: run.is_held(live_runs),
                subagent_id,
                run_id: run.run_id,
                parent_run_id,
                newest_turn: None,
                model: run.model_id.as_ref().map(|model| model.as_str().to_owned()),
            })
        })
        .collect()
}

// Reads each of `helpers`' newest turns on `connection`, in their order: a loaded one reopened,
// so its frames reach the daemon's connection, with the model its reply names, an unloaded one
// listed, which loads nothing. A read Codex refuses is logged and leaves the helper with no turn,
// which reads `Gone`; a loaded one's running turn is then interrupted, so it does not run on with
// no run to answer for it.
async fn read_helper_newest_turns(
    connection: &CodexAppServerConnection,
    session_id: SessionId,
    helpers: &mut [AdoptedHelper],
) {
    for helper in helpers {
        let thread_id = helper.subagent_id.as_str();
        let read = if helper.is_loaded {
            // Codex applies no setting to a loaded conversation, so none is sent.
            reopen_codex_helper(connection, thread_id, None)
                .await
                .map(|reopened| (reopened.newest_turn, reopened.model))
        } else {
            read_codex_newest_turn(connection, thread_id)
                .await
                .map(|newest_turn| (newest_turn, None))
        };
        match read {
            Ok((newest_turn, model)) => {
                helper.newest_turn = newest_turn;
                // The reopen's model, else the one the helper's node keeps.
                helper.model = model.or(helper.model.take());
            }
            Err(error) => {
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %helper.run_id,
                    thread_id = %thread_id,
                    error = &error as &(dyn Error + 'static),
                    "codex refused the read of an adopted helper's newest turn"
                );
                if helper.is_loaded
                    && let Err(error) =
                        interrupt_codex_running_turn(connection, thread_id, None).await
                {
                    tracing::warn!(
                        session_id = %session_id,
                        run_id = %helper.run_id,
                        thread_id = %thread_id,
                        error = &error as &(dyn Error + 'static),
                        "codex refused the interrupt of an unread adopted helper"
                    );
                }
            }
        }
    }
}

// Each live run's answer. A lead whose turns the service's end cut answers `Waiting` where it is
// held on the person, so its cut turn stays unbound until the person's answer continues it, and
// `Gone` where it is pausing with no stop pending, so the daemon ends the cut turn as the pause
// owes; any other lead answers from its open turns as Codex lists them. A helper answers
// `Waiting` where it is held on the person, else from its newest turn.
fn answer_live_runs(
    live_runs: &[LiveRunResume],
    resumed: &CodexResumedThread,
    helpers: &[AdoptedHelper],
) -> Vec<ResumedRunAnswer> {
    let is_conversation_read = matches!(
        resumed.status,
        Some(CodexThreadStatus::Active | CodexThreadStatus::Idle)
    );
    live_runs
        .iter()
        .map(|run| {
            let turn = if run.subagent_id.is_some() {
                if run.is_held(live_runs) {
                    ProviderTurnAnswer::Waiting
                } else {
                    helpers
                        .iter()
                        .find(|helper| helper.run_id == run.run_id)
                        .map_or(ProviderTurnAnswer::Gone, AdoptedHelper::answer)
                }
            } else {
                let is_cut =
                    is_conversation_read && read_cut_turns(run, &resumed.listed_turns).is_some();
                if is_cut && run.is_held(live_runs) {
                    ProviderTurnAnswer::Waiting
                } else if is_cut && run.run_state == RunState::Pausing && !run.is_stopping {
                    ProviderTurnAnswer::Gone
                } else {
                    let turn_ids: Vec<&str> = run
                        .open_turns
                        .iter()
                        .filter_map(|turn| {
                            turn.provider_turn_id.as_ref().map(ProviderTurnId::as_str)
                        })
                        .collect();
                    answer_turns(resumed.status, &resumed.listed_turns, &turn_ids)
                }
            };
            ResumedRunAnswer {
                run_id: run.run_id,
                turn,
            }
        })
        .collect()
}

// Binds a helper Codex runs, or whose newest turn is over, to its child run, started beneath its
// parent, so its rows and asks land on that run and its end completes it, and routes the run to
// the helper's conversation, which an interrupt of the run reaches; a helper held on the person is
// bound the same, a newest turn of it that is over marked held, so that turn's end is written as
// the daemon's and the run keeps waiting, while one still running runs on as the run's own.
// Answers it restored, with its newest turn. Any other helper's turn is gone, and a loaded one's
// conversation is let go on `service`.
fn restore_helper(
    record: &mut CodexSessionRecord,
    helper: AdoptedHelper,
    binding: &CodexRunBinding,
    run_routes: &CodexRunRoutes,
    service: &CodexService,
) -> Option<CodexRestoredHelper> {
    let thread_id = helper.subagent_id.as_str().to_owned();
    let is_gone = helper.answer() == ProviderTurnAnswer::Gone;
    let Some(newest_turn) = helper.newest_turn.filter(|_| !is_gone) else {
        if helper.is_loaded {
            service.release_thread(&thread_id);
        }
        return None;
    };
    let child = CodexChildRun {
        bound: Some(CodexBoundChildRun {
            child_run_id: helper.run_id,
            parent_run_id: helper.parent_run_id,
            start_row_event_id: None,
        }),
        agent_id: binding.agent_id,
        binding_id: binding.binding_id.clone(),
        subagent_id: helper.subagent_id,
        parent_tool_call_id: None,
    };
    bind_codex_helper_run(record, run_routes, thread_id.clone(), child);
    if helper.is_held && !is_codex_turn_in_progress(&newest_turn.turn) {
        record
            .held_continuation_turn_ids
            .insert(newest_turn.id.clone());
    }
    Some(CodexRestoredHelper {
        thread_id,
        newest_turn,
        prior_emitted: UsageAxisCounts::default(),
        model: helper.model,
    })
}

// Takes back what an adoption that failed set up on `service` before its resume: the session's
// queue and the conversations it registered.
fn release_registered(service: &CodexService, record: &CodexSessionRecord, registered: &[String]) {
    for thread_id in registered {
        service.release_thread(thread_id);
    }
    service.detach_session(&record.session_id);
}
