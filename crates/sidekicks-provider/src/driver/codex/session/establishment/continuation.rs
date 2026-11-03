//! A lead run whose turn the end of its Codex service cut, continued at the next start. On the
//! daemon's own service Codex gives a client no continue, so the daemon ends the cut turns in the
//! log and starts one turn with Codex's own continuation words, which the run holds as its next
//! turn, as Codex's own recovery does for itself; the run then answers still running. On a service
//! the daemon only joined, Codex continued the cut turn itself before the daemon came back and
//! sends it no start of that turn, so the daemon ends the cut turns in the log and holds the turn
//! the resume's page shows continuing them as the run's next, marked to pause at its next step
//! end where the lead was pausing, or ended as the pause's turn where it is already over. A lead
//! held on the person is not continued at the start, nor a pausing lead on its own service.
//! A joined service's continuation of a lead held on the person is marked held, so its end is
//! written as the daemon's and the lead keeps waiting for the person's answer.
//!
//! Once the person answered, the lead's continue carries the answers: a turn the daemon starts
//! for the lead holds them after Codex's continuation words, and a continuation Codex still runs
//! for it is held and the answers steered into it under the first answered card's or question's
//! id, a turn holding them started instead where that continuation ended first. The person's
//! restart of a session whose conversation resumes in place carries them the same way.

use std::error::Error;

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;

use super::adoption::request_bare_thread_resume;
use super::answer_steer::CodexAnswerSteer;
use super::{CodexResumedThread, CodexSessionEstablishment};
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::record::{
    CodexTurnRequest, apply_run_turn_acceptance, compose_run_turn, route_accepted_turn,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::history::{CodexListedTurn, read_codex_resumed_newest_turn};
use crate::driver::codex::session::owed_turn_ends::{
    is_codex_turn_in_progress, read_codex_listed_turn,
};
use crate::driver::codex::session::state::{CodexSessionRecord, CodexTurnMessage};
use crate::driver::codex::thread::view::{CodexThreadStatus, TURN_START_METHOD, read_turn_id};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::session_control::held_run_continue::{
    ContinueAnswer, HeldRunContinue, compose_continuation_text,
};
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, ProviderTurnAnswer, ResumedRunAnswer,
};
use crate::run::turn_end::TurnOutcome;

/// Codex's own words for the turn that continues work its server's restart interrupted.
pub(crate) const CODEX_CONTINUATION_TEXT: &str = "The server restarted and interrupted the previous turn. Continue the unfinished work from \
     the saved conversation. Check the current state before repeating actions that may already \
     have completed.";

/// Codex's own classification of the caller that starts a turn recovering from its restart.
const DAEMON_RECOVERY_TURN_TRIGGER: &str = "daemon_recovery";

/// The person's answers a restart carries to the session's held lead: its continue, the session's
/// live runs it reads, and the lead's agent, whose deliveries a turn carrying them goes to.
pub(crate) struct CodexHeldLeadContinue {
    /// The continue the queue composed.
    pub(crate) held_run_continue: HeldRunContinue,
    /// The session's live runs, the lead among them.
    pub(crate) live_runs: Vec<LiveRunResume>,
    /// The lead's agent.
    pub(crate) agent_id: AgentId,
}

// A continuation turn to start: the first turn of the chain it continues, as Codex names it, and
// its words.
struct ContinuationTurn {
    root_turn_id: Option<String>,
    words: String,
}

/// The turns of a lead run the service's end cut, and the first turn of the newest one's chain.
pub(super) struct CutTurns {
    // The number of each open turn Codex knows by id, oldest first.
    turn_numbers: Vec<SafeInt<1>>,
    // The newest cut turn's root as Codex lists it; `None` where it is not listed or names none.
    root_turn_id: Option<String>,
}

impl CodexSessionEstablishment {
    /// Continues each lead run of `live_runs` whose turns the end of its service cut, on the
    /// conversation `record` holds on `connection` as the resume read it, `resumed`, its
    /// deliveries on `binding`. On the daemon's own service, with the conversation idle, its cut
    /// turns are ended in the log as the daemon's restart interrupted them, and one turn started
    /// with Codex's own continuation words is held as the run's next turn: the run answers
    /// `StillRunning`, or `Gone` where Codex refused the turn; the lead `held_run_continue` names
    /// has the person's answers after the words. On a service the daemon only joined, the turn
    /// Codex continued it in is adopted instead, as `adopt_continued_turns` says. A run whose cut
    /// turn's end could not be written is not taken, and answers as Codex's listing has it.
    pub(super) async fn continue_cut_runs(
        &self,
        record: &mut CodexSessionRecord,
        connection: &CodexAppServerConnection,
        live_runs: &[LiveRunResume],
        resumed: &CodexResumedThread,
        binding: &CodexRunBinding,
        held_run_continue: Option<&HeldRunContinue>,
    ) -> Vec<ResumedRunAnswer> {
        if !record.service.kind().is_daemons_own() {
            return self
                .adopt_continued_turns(record, live_runs, resumed, binding)
                .await;
        }
        // A thread not idle would fold the turn into the one it runs.
        if resumed.status != Some(CodexThreadStatus::Idle) {
            return Vec::new();
        }
        let listed_turns = &resumed.listed_turns;
        let mut continued = Vec::new();
        for run in live_runs {
            let Some(cut) = find_cut_turns(run, live_runs, listed_turns) else {
                continue;
            };
            if !self.end_cut_turns(record, run, &cut.turn_numbers).await {
                continue;
            }
            let continuation = ContinuationTurn {
                root_turn_id: cut.root_turn_id,
                words: compose_continuation_words(
                    held_run_continue.filter(|held| held.lead_run_id == run.run_id),
                ),
            };
            let turn = self
                .answer_continuation(record, connection, run, continuation, listed_turns, binding)
                .await;
            continued.push(ResumedRunAnswer {
                run_id: run.run_id,
                turn,
            });
        }
        continued
    }

    /// Carries the person's answers `held_run_continue` holds to its lead where `continued`, the
    /// runs the cut turns' continue took, holds no turn carrying them yet. A lead with a
    /// continuation Codex still runs has it marked held, so its end leaves the lead live, and
    /// answers the steer owed it; a lead with no turn Codex runs, on an idle conversation, has
    /// its cut turns ended and a turn started with Codex's continuation words and the answers,
    /// added to `continued`. A lead the daemon's own service's continue already took, or one
    /// whose cut turns' end could not be written, is left as it stands.
    #[expect(
        clippy::too_many_arguments,
        reason = "the resume's record, connection, runs, status, turns, binding and continues"
    )]
    pub(super) async fn continue_held_lead(
        &self,
        record: &mut CodexSessionRecord,
        connection: &CodexAppServerConnection,
        live_runs: &[LiveRunResume],
        status: Option<CodexThreadStatus>,
        listed_turns: &[CodexListedTurn],
        binding: &CodexRunBinding,
        held_run_continue: Option<&HeldRunContinue>,
        continued: &mut Vec<ResumedRunAnswer>,
    ) -> Option<CodexAnswerSteer> {
        let held = held_run_continue?;
        let run = live_runs
            .iter()
            .find(|run| run.run_id == held.lead_run_id)?;
        let running_turn_id = match continued.iter().find(|taken| taken.run_id == run.run_id) {
            Some(_) if record.service.kind().is_daemons_own() => return None,
            Some(taken) if matches!(taken.turn, ProviderTurnAnswer::StillRunning) => {
                Some(record.newest_active_turn_for_run(run.run_id)?.to_owned())
            }
            Some(_) => return None,
            None => run
                .open_turns
                .iter()
                .filter_map(|turn| turn.provider_turn_id.as_ref().map(ProviderTurnId::as_str))
                .find(|turn_id| {
                    listed_turns.iter().any(|listed| {
                        listed.id == *turn_id && is_codex_turn_in_progress(&listed.turn)
                    })
                })
                .map(str::to_owned),
        };
        if let Some(turn_id) = running_turn_id {
            let message_id = read_answer_steer_key(held);
            record.held_continuation_turn_ids.insert(turn_id.clone());
            record
                .answer_steer_by_turn_id
                .insert(turn_id.clone(), message_id);
            return Some(CodexAnswerSteer {
                run_id: run.run_id,
                turn_id,
                message_id,
                answer_text: compose_answer_text(held),
                binding: binding.clone(),
            });
        }
        let cut = read_cut_turns(run, listed_turns);
        if status != Some(CodexThreadStatus::Idle) || (cut.is_none() && !run.open_turns.is_empty())
        {
            return None;
        }
        let root_turn_id = match cut {
            Some(cut) => {
                if !self.end_cut_turns(record, run, &cut.turn_numbers).await {
                    return None;
                }
                cut.root_turn_id
            }
            None => None,
        };
        let continuation = ContinuationTurn {
            root_turn_id,
            words: compose_continuation_words(Some(held)),
        };
        let turn = self
            .answer_continuation(record, connection, run, continuation, listed_turns, binding)
            .await;
        continued.push(ResumedRunAnswer {
            run_id: run.run_id,
            turn,
        });
        None
    }

    /// Carries `held`'s answers to its lead once the conversation `record` holds resumed in place,
    /// Codex reading it `status` with the turns `listed_turns`, as an adoption carries them: a
    /// continuation Codex still runs is held and answers the steer owed it, and a lead with no
    /// turn on an idle conversation gets one holding Codex's continuation words and the answers,
    /// its answer in `result` set still running. A lead whose step bound or connection could not
    /// be read gets nothing, so `result` gives its answers back; that is logged.
    pub(crate) async fn continue_held_lead_in_place(
        &self,
        record: &mut CodexSessionRecord,
        status: Option<CodexThreadStatus>,
        listed_turns: &[CodexListedTurn],
        held: &CodexHeldLeadContinue,
        result: &mut DriverResumeResult,
    ) -> Option<CodexAnswerSteer> {
        let binding_id = record.binding_id.clone()?;
        let read = async {
            let connection = record.service.connection()?;
            let context = self
                .resolve_spawn_context(record.session_id, &record.provider_account_id)
                .await?;
            Ok::<_, CodexError>((connection, context.step_bound))
        };
        let (connection, step_bound) = match read.await {
            Ok(read) => read,
            Err(error) => {
                tracing::warn!(
                    session_id = %record.session_id,
                    run_id = %held.held_run_continue.lead_run_id,
                    error = &error as &(dyn Error + 'static),
                    "the person's answers could not be carried to the codex lead the restart \
                     resumed"
                );
                return None;
            }
        };
        let binding = CodexRunBinding {
            session_id: record.session_id,
            binding_id,
            agent_id: held.agent_id,
            step_bound,
        };
        let mut continued = Vec::new();
        let answer_steer = self
            .continue_held_lead(
                record,
                &connection,
                &held.live_runs,
                status,
                listed_turns,
                &binding,
                Some(&held.held_run_continue),
                &mut continued,
            )
            .await;
        answer_continued_runs(result, &continued);
        answer_steer
    }

    // Starts `run`'s `continuation` as `start_continuation` does, answering `StillRunning`, or
    // `Gone` where Codex refused it, which is logged.
    async fn answer_continuation(
        &self,
        record: &mut CodexSessionRecord,
        connection: &CodexAppServerConnection,
        run: &LiveRunResume,
        continuation: ContinuationTurn,
        listed_turns: &[CodexListedTurn],
        binding: &CodexRunBinding,
    ) -> ProviderTurnAnswer {
        let started = self
            .start_continuation(record, connection, run, continuation, listed_turns, binding)
            .await;
        match started {
            Ok(()) => ProviderTurnAnswer::StillRunning,
            Err(error) => {
                tracing::warn!(
                    session_id = %record.session_id,
                    run_id = %run.run_id,
                    error = &error as &(dyn Error + 'static),
                    "codex refused the turn continuing a run its service's end cut"
                );
                ProviderTurnAnswer::Gone
            }
        }
    }

    // Adopts, on a service the daemon only joined, the turn Codex continued each lead's cut turns
    // in before the daemon came back, since Codex sends a client that joins later no start of
    // it: a lead with no parent, running, pausing or waiting on the person, whose continuation the
    // resume's page shows. A continuation still running ends the cut turns in the log, is held as
    // the run's turn on `binding` and opened after their end, and answers `StillRunning`; a
    // pausing lead's is marked to pause at its next step end, as the pause asked of it would. One
    // already over, on a running or waiting lead with no stop pending, is held unopened, so its
    // listed end, routed as the session opens, opens it and ends the run, and answers
    // `EndedByProvider`; on a pausing lead it is opened as the pause's turn, so its listed end
    // pauses the run. A lead held on the person, its own ask or a helper's beneath it, has its
    // continuation marked held, so either end of it, live or listed, is written as the daemon's
    // and leaves the run waiting for the answer: one already over answers `Waiting`. A stopping
    // lead's ended continuation, a run whose cut turn's end could not be written, and a lead with
    // no continuation are not taken.
    async fn adopt_continued_turns(
        &self,
        record: &mut CodexSessionRecord,
        live_runs: &[LiveRunResume],
        resumed: &CodexResumedThread,
        binding: &CodexRunBinding,
    ) -> Vec<ResumedRunAnswer> {
        if !matches!(
            resumed.status,
            Some(CodexThreadStatus::Active | CodexThreadStatus::Idle)
        ) {
            return Vec::new();
        }
        let run_routes = &self.dependencies.run_routes;
        let mut continued = Vec::new();
        for run in live_runs {
            let is_lead = run.is_lead();
            let is_live = matches!(
                run.run_state,
                RunState::Running
                    | RunState::Pausing
                    | RunState::WaitingForApproval
                    | RunState::WaitingForInput
            );
            if !is_lead || !is_live {
                continue;
            }
            let Some(cut) = read_cut_turns(run, &resumed.listed_turns) else {
                continue;
            };
            let Some(continuation) = find_continuation_turn(run, &cut, resumed) else {
                continue;
            };
            let is_running = is_codex_turn_in_progress(&continuation.turn);
            let is_held = run.is_held(live_runs);
            // A stop pending on the lead settles it once its continuation is over.
            if (!is_running && run.is_stopping)
                || !self.end_cut_turns(record, run, &cut.turn_numbers).await
            {
                continue;
            }
            record.add_active_turn(continuation.id.clone(), run.run_id);
            run_routes.bind_run(run.run_id, record.session_id);
            run_routes.bind_run_delivery(run.run_id, binding.clone());
            if is_held {
                record
                    .held_continuation_turn_ids
                    .insert(continuation.id.clone());
            }
            let turn = if is_running {
                if run.run_state == RunState::Pausing {
                    record
                        .pause_run_id_by_turn_id
                        .insert(continuation.id.clone(), run.run_id);
                }
                self.dependencies
                    .delivery
                    .open_started_turn(record, &continuation.id)
                    .await;
                ProviderTurnAnswer::StillRunning
            } else if is_held {
                ProviderTurnAnswer::Waiting
            } else {
                // A pausing lead's continuation is the pause's turn, so its listed end pauses it.
                if run.run_state == RunState::Pausing {
                    record
                        .paused_run_id_by_interrupted_turn_id
                        .insert(continuation.id.clone(), run.run_id);
                    self.dependencies
                        .delivery
                        .open_started_turn(record, &continuation.id)
                        .await;
                }
                ProviderTurnAnswer::EndedByProvider
            };
            continued.push(ResumedRunAnswer {
                run_id: run.run_id,
                turn,
            });
        }
        continued
    }

    // Ends `run`'s cut `turn_numbers` in the log as the daemon's restart interrupted them, never
    // as Codex's end, which would end the run. Answers whether every end holds; a failed write is
    // logged, and the run is left to the restart's settle.
    async fn end_cut_turns(
        &self,
        record: &CodexSessionRecord,
        run: &LiveRunResume,
        turn_numbers: &[SafeInt<1>],
    ) -> bool {
        let engine = self.dependencies.delivery.engine();
        for &turn_number in turn_numbers {
            let ended = engine
                .record_daemon_turn_end(
                    run.run_id,
                    turn_number,
                    TurnOutcome::Interrupted(Some(TurnEndCause::DaemonRestart)),
                )
                .await;
            if let Err(error) = ended {
                tracing::warn!(
                    session_id = %record.session_id,
                    run_id = %run.run_id,
                    turn_number = turn_number.get(),
                    error = &*error as &(dyn Error + 'static),
                    "a cut codex turn's end could not be written, so its run is not continued"
                );
                return false;
            }
        }
        true
    }

    // Starts `continuation`, the turn that continues `run`, on the record's conversation, composed
    // as a run's turn is, so it names the session's mode, reviewer, model and environments, and
    // carrying no message id, so it never reads as the person's; then holds the turn as the
    // run's, its deliveries on `binding`. Its `turn/started`, waiting in the session's queue,
    // opens the run's next turn. A start that failed once it went out, other than by Codex's
    // refusal, may still have started the turn, so the conversation is resumed again, bare, and a
    // newest turn on its page that none of `listed_turns`, the turns listed before the start,
    // names is held as the one it started; `turn/start` is never sent again, since Codex would
    // start a second turn. Fails as the composition fails, with Codex's refusal, with the
    // start's failure where the second resume shows no new turn, and as the second resume fails.
    async fn start_continuation(
        &self,
        record: &mut CodexSessionRecord,
        connection: &CodexAppServerConnection,
        run: &LiveRunResume,
        continuation: ContinuationTurn,
        listed_turns: &[CodexListedTurn],
        binding: &CodexRunBinding,
    ) -> Result<(), CodexError> {
        let request = CodexTurnRequest {
            messages: vec![CodexTurnMessage {
                text: continuation.words,
                skills: Vec::new(),
                attachments: Vec::new(),
            }],
            client_message_ids: Vec::new(),
            model: None,
            output_speed: None,
            output_speed_for_turn: None,
            output_schema: None,
            level: None,
        };
        let (mut params, run_turn) = compose_run_turn(record, connection, request).await?;
        params.turn_trigger = Some(DAEMON_RECOVERY_TURN_TRIGGER.to_owned());
        params.root_turn_id = continuation.root_turn_id;
        let started = connection
            .request(TURN_START_METHOD, &params)
            .await
            .and_then(|reply| read_turn_id(&reply, TURN_START_METHOD));
        let turn_id = match started {
            Ok(turn_id) => turn_id,
            // Codex answered that it started nothing.
            Err(refused @ CodexError::ProviderRequest { .. }) => return Err(refused),
            Err(error) => find_started_continuation(record, connection, listed_turns)
                .await?
                .ok_or(error)?,
        };
        // The turn's frames wait unread in the session's queue, so it has settled no speed yet:
        // the acceptance answers a speed only for a turn already over.
        let (_, input) = apply_run_turn_acceptance(record, run.run_id, &turn_id, run_turn);
        let run_routes = &self.dependencies.run_routes;
        // The continuation carries the daemon's words, not a queued message, so nothing opened it.
        if route_accepted_turn(run_routes, record, run.run_id, &turn_id, None) {
            record.turn_input_by_turn_id.insert(turn_id, input);
        }
        run_routes.bind_run_delivery(run.run_id, binding.clone());
        Ok(())
    }
}

/// Puts each answer of `continued` in place of its run's in `result`, adding one `result` does
/// not name.
pub(super) fn answer_continued_runs(
    result: &mut DriverResumeResult,
    continued: &[ResumedRunAnswer],
) {
    let DriverResumeResult::Resumed { runs, .. } = result else {
        return;
    };
    for taken in continued {
        match runs.iter_mut().find(|answer| answer.run_id == taken.run_id) {
            Some(answer) => answer.turn = taken.turn,
            None => runs.push(taken.clone()),
        }
    }
}

// Codex's continuation words, followed by the person's answers where `held_run_continue` is set.
fn compose_continuation_words(held_run_continue: Option<&HeldRunContinue>) -> String {
    held_run_continue.map_or_else(
        || CODEX_CONTINUATION_TEXT.to_owned(),
        |held| format!("{CODEX_CONTINUATION_TEXT}\n\n{}", compose_answer_text(held)),
    )
}

// The person's answers `held` carries, a helper's closed by asking the lead to continue it.
fn compose_answer_text(held: &HeldRunContinue) -> String {
    compose_continuation_text(held, ask_codex_helper_again)
}

// Codex's sentence asking the lead to continue its helper `subagent_id` where it left off.
fn ask_codex_helper_again(subagent_id: &SubagentId) -> String {
    format!(
        "Continue that helper with followup_task on {}, so it goes on with everything it knew.",
        subagent_id.as_str()
    )
}

// The id the answers' steer goes under: the first answered card's or question's, so the steer
// names the answer it carries; a fresh one where every entry is a continued helper.
fn read_answer_steer_key(held: &HeldRunContinue) -> QueueItemId {
    held.entries
        .iter()
        .find_map(|entry| match &entry.answer {
            ContinueAnswer::Approval {
                approval_request_id,
                ..
            } => QueueItemId::new(approval_request_id.text().as_str()).ok(),
            ContinueAnswer::Question { question_id, .. } => {
                QueueItemId::new(question_id.text().as_str()).ok()
            }
            ContinueAnswer::HelperContinued { .. } => None,
        })
        .unwrap_or_else(|| {
            QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item's id")
        })
}

// `run`'s cut turns as `read_cut_turns` reads them, where it is a running lead with no stop
// pending and not held on the person through a helper at any depth beneath it.
fn find_cut_turns(
    run: &LiveRunResume,
    live_runs: &[LiveRunResume],
    listed_turns: &[CodexListedTurn],
) -> Option<CutTurns> {
    if run.subagent_id.is_some() || run.is_stopping || run.run_state != RunState::Running {
        return None;
    }
    if run.is_held(live_runs) {
        return None;
    }
    read_cut_turns(run, listed_turns)
}

/// `run`'s cut turns: each of its open turns Codex knows by id the service's end cut, listed
/// interrupted with no end time, which a cold load gives a turn that was running, or not listed.
/// A turn listed running, finished, failed, or stopped with its end time answers none.
pub(super) fn read_cut_turns(
    run: &LiveRunResume,
    listed_turns: &[CodexListedTurn],
) -> Option<CutTurns> {
    let mut cut = CutTurns {
        turn_numbers: Vec::new(),
        root_turn_id: None,
    };
    for turn in &run.open_turns {
        let Some(turn_id) = turn.provider_turn_id.as_ref().map(ProviderTurnId::as_str) else {
            continue;
        };
        cut.root_turn_id = match listed_turns.iter().find(|listed| listed.id == turn_id) {
            Some(listed) => {
                let state = read_codex_listed_turn(&listed.turn);
                if state.status != Some(CodexTurnStatus::Interrupted) || state.has_completed_at {
                    return None;
                }
                state.root_turn_id
            }
            None => None,
        };
        cut.turn_numbers.push(turn.turn_number);
    }
    (!cut.turn_numbers.is_empty()).then_some(cut)
}

// The turn Codex continued `run`'s `cut` turns in: the resume's newest turn, where it is none of
// the run's open turns and leads back to the same first turn as the newest cut one. A cut turn
// whose root Codex names none of has no continuation, since any turn would then read as one.
fn find_continuation_turn<'resumed>(
    run: &LiveRunResume,
    cut: &CutTurns,
    resumed: &'resumed CodexResumedThread,
) -> Option<&'resumed CodexListedTurn> {
    let root_turn_id = cut.root_turn_id.as_deref()?;
    let newest_turn_id = resumed.newest_turn_id.as_deref()?;
    let is_open_turn = run.open_turns.iter().any(|turn| {
        turn.provider_turn_id.as_ref().map(ProviderTurnId::as_str) == Some(newest_turn_id)
    });
    if is_open_turn {
        return None;
    }
    let newest = resumed
        .listed_turns
        .iter()
        .find(|listed| listed.id == newest_turn_id)?;
    (read_codex_listed_turn(&newest.turn).root_turn_id.as_deref() == Some(root_turn_id))
        .then_some(newest)
}

// The turn an unanswered `turn/start` started on the record's conversation, as a bare resume's
// page shows it: its newest turn, where none of `listed_turns` names it. Fails as the resume does.
async fn find_started_continuation(
    record: &CodexSessionRecord,
    connection: &CodexAppServerConnection,
    listed_turns: &[CodexListedTurn],
) -> Result<Option<String>, CodexError> {
    let reply = request_bare_thread_resume(connection, &record.thread_id).await?;
    Ok(read_codex_resumed_newest_turn(&reply)
        .map(|newest| newest.id)
        .filter(|turn_id| !listed_turns.iter().any(|listed| listed.id == *turn_id)))
}
