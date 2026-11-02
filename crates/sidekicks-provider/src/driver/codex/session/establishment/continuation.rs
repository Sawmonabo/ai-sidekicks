//! A lead run whose turn the end of the daemon's own Codex service cut, continued at the next
//! start: Codex gives a client no continue, so the daemon ends the cut turns in the log and starts
//! one turn with Codex's own continuation words, which the run holds as its next turn, as Codex's
//! own recovery does for itself. The run then answers still running.

use std::error::Error;

use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::integer::SafeInt;

use super::CodexSessionEstablishment;
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::record::{
    CodexTurnRequest, apply_run_turn_acceptance, compose_run_turn, route_accepted_turn,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::history::CodexListedTurn;
use crate::driver::codex::session::owed_turn_ends::read_codex_listed_turn;
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
struct CutTurns {
    // The number of each open turn Codex knows by id, oldest first.
    turn_numbers: Vec<SafeInt<1>>,
    // The newest cut turn's root as Codex lists it; `None` where it is not listed or names none.
    root_turn_id: Option<String>,
}

impl CodexSessionEstablishment {
    /// Continues each lead run of `live_runs` whose turns the end of the daemon's own service cut,
    /// on the conversation `record` holds on `connection`, which the resume read at `status` with
    /// `listed_turns`: its cut turns ended in the log as the daemon's restart interrupted them, and
    /// one turn started with Codex's own continuation words, held as the run's next turn on
    /// `binding`. Answers each run it took: `StillRunning`, or `Gone` where Codex refused the turn.
    /// A run whose cut turn's end could not be written is not taken, and answers as Codex's
    /// listing has it.
    pub(super) async fn continue_cut_runs(
        &self,
        record: &mut CodexSessionRecord,
        connection: &CodexAppServerConnection,
        live_runs: &[LiveRunResume],
        status: Option<CodexThreadStatus>,
        listed_turns: &[CodexListedTurn],
        binding: &CodexRunBinding,
    ) -> Vec<ResumedRunAnswer> {
        // On a service the daemon only joined, Codex continues the turn itself; a thread not idle
        // would fold the turn into the one it runs.
        if !record.service.kind().is_daemons_own() || status != Some(CodexThreadStatus::Idle) {
            return Vec::new();
        }
        let mut continued = Vec::new();
        for run in live_runs {
            let Some(cut) = find_cut_turns(run, live_runs, listed_turns) else {
                continue;
            };
            if !self.end_cut_turns(record, run, &cut.turn_numbers).await {
                continue;
            }
            let turn = match self
                .start_continuation(record, connection, run, cut.root_turn_id, binding)
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
    // next turn. Fails as the composition or the request fails.
    async fn start_continuation(
        &self,
        record: &mut CodexSessionRecord,
        connection: &CodexAppServerConnection,
        run: &LiveRunResume,
        root_turn_id: Option<String>,
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
        let reply = connection.request(TURN_START_METHOD, &params).await?;
        let turn_id = read_turn_id(&reply, TURN_START_METHOD)?;
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

// `run`'s cut turns, where it is a running lead with no stop pending and no helper of it held on
// the person, and each of its open turns Codex knows by id the service's end cut: listed
// interrupted with no end time, which a cold load gives a turn that was running, or not listed.
// A turn listed running, finished, failed, or stopped with its end time answers as it stands.
fn find_cut_turns(
    run: &LiveRunResume,
    live_runs: &[LiveRunResume],
    listed_turns: &[CodexListedTurn],
) -> Option<CutTurns> {
    if run.subagent_id.is_some() || run.is_stopping || run.run_state != RunState::Running {
        return None;
    }
    let is_helper_held = live_runs.iter().any(|helper| {
        helper.parent_run_id == Some(run.run_id)
            && matches!(
                helper.run_state,
                RunState::WaitingForApproval
                    | RunState::WaitingForInput
                    | RunState::Pausing
                    | RunState::Paused
            )
    });
    if is_helper_held {
        return None;
    }
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
