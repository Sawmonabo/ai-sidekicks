//! A lead run whose turn the end of its Codex service cut, continued at the next start. On the
//! daemon's own service Codex gives a client no continue, so the daemon ends the cut turns in the
//! log and starts one turn with Codex's own continuation words, which the run holds as its next
//! turn, as Codex's own recovery does for itself; the run then answers still running. On a service
//! the daemon only joined, Codex continued the cut turn itself before the daemon came back and
//! sends it no start of that turn, so the daemon ends the cut turns in the log and holds the turn
//! the resume's page shows continuing them as the run's next, marked to pause at its next step
//! end where the lead was pausing. A lead held on the person is not continued at the start, nor a
//! pausing lead on its own service; neither is a pausing lead whose continuation is already over.

use std::error::Error;

use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::integer::SafeInt;

use super::adoption::request_bare_thread_resume;
use super::{CodexResumedThread, CodexSessionEstablishment};
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::record::{
    CodexTurnRequest, apply_run_turn_acceptance, compose_run_turn, route_accepted_turn,
};
use crate::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::driver::codex::session::history::{CodexListedTurn, read_codex_resumed_newest_turn};
use crate::driver::codex::session::owed_turn_ends::{
    is_codex_turn_in_progress, read_codex_listed_turn,
};
use crate::driver::codex::session::state::{CodexSessionRecord, CodexTurnMessage};
use crate::driver::codex::thread::view::{CodexThreadStatus, TURN_START_METHOD, read_turn_id};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, ProviderTurnAnswer, ResumedRunAnswer,
};
use crate::run::turn_end::TurnOutcome;

/// Codex's own words for the turn that continues work its server's restart interrupted.
const CODEX_CONTINUATION_TEXT: &str = "The server restarted and interrupted the previous turn. \
     Continue the unfinished work from the saved conversation. Check the current state before \
     repeating actions that may already have completed.";

/// Codex's own classification of the caller that starts a turn recovering from its restart.
const DAEMON_RECOVERY_TURN_TRIGGER: &str = "daemon_recovery";

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
    /// `StillRunning`, or `Gone` where Codex refused the turn. On a service the daemon only joined,
    /// the turn Codex continued it in is adopted instead, as `adopt_continued_turns` says.
    /// A run whose cut turn's end could not be written is not taken, and answers as Codex's
    /// listing has it.
    pub(super) async fn continue_cut_runs(
        &self,
        record: &mut CodexSessionRecord,
        connection: &CodexAppServerConnection,
        live_runs: &[LiveRunResume],
        resumed: &CodexResumedThread,
        binding: &CodexRunBinding,
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
            let turn = match self
                .start_continuation(
                    record,
                    connection,
                    run,
                    cut.root_turn_id,
                    listed_turns,
                    binding,
                )
                .await
            {
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
            };
            continued.push(ResumedRunAnswer {
                run_id: run.run_id,
                turn,
            });
        }
        continued
    }

    // Adopts, on a service the daemon only joined, the turn Codex continued each lead's cut turns
    // in before the daemon came back, since Codex sends a client that joins later no start of
    // it: a lead with no parent, running, pausing or waiting on the person, whose continuation the
    // resume's page shows. A continuation still running ends the cut turns in the log, is held as
    // the run's turn on `binding` and opened after their end, and answers `StillRunning`; a
    // pausing lead's is marked to pause at its next step end, as the pause asked of it would. One
    // already over, on a running or waiting lead with no stop pending, is held unopened, so its
    // listed end, routed as the session opens, opens it and ends the run, and answers
    // `EndedByProvider`. A stopping or pausing lead's ended continuation, a run whose cut turn's
    // end could not be written, and a lead with no continuation are not taken.
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
            let is_lead = run.subagent_id.is_none() && run.parent_run_id.is_none();
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
            // A stop pending on the lead settles it once its continuation is over, and a pause
            // pending on it is owed its continuation's end in the log.
            if (!is_running && (run.is_stopping || run.run_state == RunState::Pausing))
                || !self.end_cut_turns(record, run, &cut.turn_numbers).await
            {
                continue;
            }
            record.add_active_turn(continuation.id.clone(), run.run_id);
            run_routes.bind_run(run.run_id, record.session_id);
            run_routes.bind_run_delivery(run.run_id, binding.clone());
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
            } else {
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

    // Starts the turn that continues `run` on the record's conversation, composed as a run's turn
    // is, so it names the session's mode, reviewer, model and environments, and carrying no
    // message id, so it never reads as the person's; then holds the turn as the run's, its
    // deliveries on `binding`. Its `turn/started`, waiting in the session's queue, opens the run's
    // next turn. A start left unanswered past its deadline may still have started the turn, so the
    // conversation is resumed again, bare, and a newest turn on its page that none of
    // `listed_turns`, the turns listed before the start, names is held as the one it started;
    // `turn/start` is never sent again, since Codex would start a second turn. Fails as the
    // composition or the request fails, with the deadline's failure where the second resume shows
    // no new turn, and as the second resume fails.
    async fn start_continuation(
        &self,
        record: &mut CodexSessionRecord,
        connection: &CodexAppServerConnection,
        run: &LiveRunResume,
        root_turn_id: Option<String>,
        listed_turns: &[CodexListedTurn],
        binding: &CodexRunBinding,
    ) -> Result<(), CodexError> {
        let request = CodexTurnRequest {
            messages: vec![CodexTurnMessage {
                text: CODEX_CONTINUATION_TEXT.to_owned(),
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
        params.root_turn_id = root_turn_id;
        let turn_id = match connection.request(TURN_START_METHOD, &params).await {
            Ok(reply) => read_turn_id(&reply, TURN_START_METHOD)?,
            Err(
                error @ CodexError::Unanswered {
                    cause: CodexUnansweredCause::Deadline { .. },
                    ..
                },
            ) => find_started_continuation(record, connection, listed_turns)
                .await?
                .ok_or(error)?,
            Err(error) => return Err(error),
        };
        // The turn's frames wait unread in the session's queue, so it has settled no speed yet:
        // the acceptance answers a speed only for a turn already over.
        let (_, input) = apply_run_turn_acceptance(record, run.run_id, &turn_id, run_turn);
        let run_routes = &self.dependencies.run_routes;
        if route_accepted_turn(run_routes, record, run.run_id, &turn_id) {
            record.turn_input_by_turn_id.insert(turn_id, input);
        }
        run_routes.bind_run_delivery(run.run_id, binding.clone());
        Ok(())
    }
}

/// Puts each answer of `continued` in place of its run's in `result`.
pub(super) fn answer_continued_runs(
    result: &mut DriverResumeResult,
    continued: &[ResumedRunAnswer],
) {
    let DriverResumeResult::Resumed { runs, .. } = result else {
        return;
    };
    for answer in runs {
        if let Some(taken) = continued.iter().find(|taken| taken.run_id == answer.run_id) {
            answer.turn = taken.turn;
        }
    }
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
