//! A turn's frames: its start, which opens its execution and its numbered turn on the run; its
//! end, which ends a live turn's run through the session's terminal gate, a held continuation's or
//! held helper's as the daemon's with its run left live, and empties an interrupted turn's task
//! list; its errors, which the end's failure reads and whose retries file a retried request's row;
//! the safety hold Codex keeps on it until its answer starts; the hook runs that block its prompt;
//! and the asks it held, which its end or Codex's own settle withdraws.

use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::{ApiRetryErrorKind, UsageApiRequestRetriedPayload};
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_TOKEN_MAX_LEN;
use sidekicks_contracts::run::events::{RunStateChangeState, TurnEndCause};
use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;
use sidekicks_contracts::turn::{ProviderTurnId, TurnTasksUpdate};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::delivery::failure_cause::{
    CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR, CODEX_RATE_LIMIT_EXCEEDED_ERROR,
    CODEX_USAGE_LIMIT_EXCEEDED_ERROR, read_codex_turn_failure_cause,
};
use crate::driver::codex::delivery::frames::{
    CodexFrameDelivery, CodexFrameDispatch, CodexPromptHookRun, CodexRunMove, CodexTurnEnding,
    CodexTurnMove, CodexTurnRun, read_turn_ending, report_unattributed,
};
use crate::driver::codex::delivery::memory::{CodexTurnErrorReading, read_codex_error_kind};
use crate::driver::codex::delivery::notices::{provider_words, release_reroute};
use crate::driver::codex::delivery::reviewer::end_codex_review_turn;
use crate::driver::codex::delivery::rows::{CodexRow, CodexRowDelivery, CodexRowRun};
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::record::add_run_turn;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::diagnostics::{CodexDeliveryPort, CodexTransportDiagnostic};
use crate::driver::codex::turn_evidence::{
    CodexTurnStatus, CodexTurnTerminalInput, compose_codex_turn_terminal,
};
use crate::driver::run_control::SteerTurnEndedError;
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::{
    DeliveryBinding, DeliveryOperation, InboundDelivery, LateAppendableRow,
};
use crate::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use crate::terminal_emission_gate::TerminalEmissionGate;
use crate::thread_frame_router::ThreadFrameRoute;

/// The hook event whose blocked or stopped run keeps the person's prompt from its turn.
const CODEX_USER_PROMPT_SUBMIT_HOOK: &str = "userPromptSubmit";

/// A `turn/completed` frame: its JSON text, its members and the router's route for it.
pub(super) struct TurnCompletedFrame<'frame> {
    /// The params' JSON text.
    pub(super) params: &'frame str,
    /// The params' members.
    pub(super) members: &'frame Map<String, Value>,
    /// The router's decision for it.
    pub(super) route: ThreadFrameRoute,
}

impl CodexFrameDelivery {
    /// Ends the live safety hold Codex kept on each of the session's turns, which a process exit
    /// leaves with no release, so the run's stream stops showing it.
    pub(crate) async fn end_safety_holds(&self, record: &mut CodexSessionRecord) {
        let holds: Vec<(String, CodexRowRun)> =
            record.delivery.safety_hold_run_by_turn_id.drain().collect();
        for (turn_id, run) in holds {
            self.send_safety_hold(record, &run, &turn_id, false, None)
                .await;
        }
    }

    // A turn opens its execution on the run's binding; a turn whose `turn/start` answer has not
    // arrived yet belongs to the oldest run still starting, since Codex accepts turns in send
    // order.
    pub(super) async fn deliver_turn_started(
        &self,
        record: &mut CodexSessionRecord,
        members: &Map<String, Value>,
    ) {
        let Some(turn_id) = read_completed_turn_id(members) else {
            return;
        };
        let Some(thread_id) = read_non_empty_string(members, "threadId") else {
            return;
        };
        if thread_id != record.thread_id {
            // A helper's conversation: one stopped alone runs no further turn.
            self.dependencies
                .stopped_helpers
                .interrupt_started_turn(record, thread_id, &turn_id);
            return;
        }
        // A new turn ends the hold of the one before it.
        let ended_holds: Vec<String> = record
            .delivery
            .safety_hold_run_by_turn_id
            .keys()
            .filter(|held| **held != turn_id)
            .cloned()
            .collect();
        for held in ended_holds {
            self.end_safety_hold(record, &held).await;
        }
        if record.active_turn_run(&turn_id).is_none()
            && !record.is_turn_settled(&turn_id)
            && !record.delivery.is_turn_taken_by_no_run(&turn_id)
            && let Some(starting) = record.delivery.starting_turns.pop_front()
        {
            add_run_turn(
                &self.dependencies.run_routes,
                record,
                turn_id.clone(),
                starting.run_id,
                starting.opening,
            );
        }
        self.open_started_turn(record, &turn_id).await;
    }

    /// Opens the started turn `turn_id` on the run that holds it: its run epoch given, then its
    /// execution and its numbered turn opened, once. A turn no run holds is reported unattributed.
    pub(crate) async fn open_started_turn(&self, record: &mut CodexSessionRecord, turn_id: &str) {
        let Some(turn_run) = self.turn_run_for(record, turn_id) else {
            report_unattributed("turn/started", Some(turn_id));
            return;
        };
        record
            .delivery
            .assign_turn_epoch(turn_id, || self.mint_turn_epoch());
        self.open_turn(record, turn_id, &turn_run).await;
    }

    // Opens the turn's execution and its numbered turn on the run, once, with the message that
    // opened it where a `turn/start` carried one.
    async fn open_turn(
        &self,
        record: &mut CodexSessionRecord,
        turn_id: &str,
        turn_run: &CodexTurnRun,
    ) {
        if record
            .delivery
            .started_turn_by_turn_id
            .contains_key(turn_id)
        {
            return;
        }
        let boundary = InboundDelivery::TurnBoundary {
            binding_id: turn_run.binding.binding_id.clone(),
        };
        self.send(record, boundary, "turn/started").await;
        match self
            .dependencies
            .engine
            .start_turn(
                turn_run.run_id,
                ProviderTurnId::new(turn_id.to_owned()).ok(),
                turn_run.binding.step_bound,
                record
                    .delivery
                    .turn_opening_by_turn_id
                    .get(turn_id)
                    .copied(),
            )
            .await
        {
            Ok(Some(started)) => {
                record
                    .delivery
                    .started_turn_by_turn_id
                    .insert(turn_id.to_owned(), started);
            }
            // The run ended before its turn opened, so the turn has no run to number it.
            Ok(None) => report_unattributed("turn/started", Some(turn_id)),
            Err(error) => CodexTransportDiagnostic::PortDeliveryFailed {
                provider_account_id: Some(record.provider_account_id.clone()),
                port: CodexDeliveryPort::TurnStart,
                session_id: Some(record.session_id),
                error,
            }
            .report(),
        }
    }

    // The turn's end: rows still held for their start go out, a switch still waiting for its
    // sentence goes without one, the reviewer's warning on a turn it stopped is flagged, and a
    // live turn's run ends through the terminal gate, as does a pause's turn that failed by itself.
    // A held continuation's end is written as the daemon's, its run left live. An interrupted
    // turn's end is written by the run engine, a paused one's by run control, and a retried one's
    // run goes on in the turn the retry sends.
    pub(super) async fn deliver_turn_completed(
        &self,
        record: &mut CodexSessionRecord,
        gate: &mut TerminalEmissionGate,
        frame: TurnCompletedFrame<'_>,
        dispatch: &mut CodexFrameDispatch,
    ) {
        let members = frame.members;
        let Some(thread_id) = read_non_empty_string(members, "threadId").map(str::to_owned) else {
            return;
        };
        if thread_id != record.thread_id {
            return;
        }
        let Some(turn_id) = read_completed_turn_id(members) else {
            return;
        };
        self.withdraw_ended_turn_asks(record, &thread_id, &turn_id);
        let pieces = record.delivery.streamed_text.end_turn(&turn_id);
        for piece in pieces {
            self.admit_prose_piece(record, &piece.key, piece.text).await;
        }
        let held = record
            .delivery
            .reorder_buffer
            .flush_all(tokio::time::Instant::now());
        self.send_rows(record, held).await;
        if let Some(reroute) = release_reroute(&mut record.delivery, &thread_id) {
            self.send_row(record, reroute).await;
        }
        record.delivery.spawn_calls_by_thread_id.remove(&thread_id);
        let status = read_turn_status(members).and_then(CodexTurnStatus::read);
        let turn_run = self
            .turn_run_for(record, &turn_id)
            .map(|turn_run| CodexTurnRun {
                ending: read_turn_ending(record, &turn_id, turn_run.ending, status),
                ..turn_run
            });
        // A live turn ending interrupted is one Codex itself stopped, since a turn the daemon
        // interrupted reads interrupted or paused.
        let is_stopped_by_codex = status == Some(CodexTurnStatus::Interrupted);
        let stopped_run = turn_run
            .as_ref()
            .filter(|turn_run| turn_run.ending == CodexTurnEnding::Live && is_stopped_by_codex)
            .map(CodexTurnRun::row_run);
        let about_event_id = record
            .delivery
            .started_turn_by_turn_id
            .get(&turn_id)
            .map(|started| started.event_id.clone());
        let flag = end_codex_review_turn(
            &mut record.delivery,
            &thread_id,
            about_event_id,
            Some(&turn_id),
            stopped_run,
        );
        if let Some(flag) = flag {
            self.send_review_flag(record, flag).await;
        }
        let held_tasks = record.delivery.turn_readings.end_turn(&turn_id);
        // An interrupted turn's list goes; it returns with the next turn's own.
        if status == Some(CodexTurnStatus::Interrupted)
            && held_tasks
            && let Some(turn_run) = &turn_run
            && let Ok(provider_turn_id) = ProviderTurnId::new(turn_id.clone())
        {
            dispatch.turn_tasks.push(TurnTasksUpdate {
                run_id: turn_run.run_id,
                turn_id: provider_turn_id,
                tasks: Vec::new(),
            });
        }
        match turn_run {
            None => {
                // A turn no run holds is a compaction's own, whose frame came before this end if
                // it ran.
                self.dependencies
                    .pending_compactions
                    .observe_turn_end(&codex_compaction_wait_key(record, &thread_id));
                report_unattributed("turn/completed", Some(&turn_id));
            }
            Some(turn_run) => {
                let answer_steer = record.answer_steer_by_turn_id.remove(&turn_id);
                let is_answer_steer_unechoed = answer_steer.is_some_and(|message_id| {
                    record
                        .unechoed_steers_by_turn_id
                        .get(&turn_id)
                        .is_some_and(|unechoed| {
                            unechoed.steers.iter().any(|(_, sent)| *sent == message_id)
                        })
                });
                if turn_run.ending == CodexTurnEnding::Live
                    && !is_answer_steer_unechoed
                    && record.held_continuation_turn_ids.remove(&turn_id)
                {
                    // Ended before the answers' steer was sent: they go in a turn of their own.
                    if answer_steer.is_some() {
                        record.answer_turn_owed_run_ids.insert(turn_run.run_id);
                    }
                    self.end_held_continuation(record, &turn_id, &turn_run)
                        .await;
                } else if turn_run.ending == CodexTurnEnding::Live {
                    // Codex was handed the answers' steer and ended the turn without taking it.
                    if is_answer_steer_unechoed {
                        record.held_continuation_turn_ids.remove(&turn_id);
                        dispatch.continues_given_back.push(turn_run.run_id);
                    }
                    self.deliver_terminal(record, gate, &frame, &turn_id, &turn_run, dispatch)
                        .await;
                } else if turn_run.ending == CodexTurnEnding::Interrupted {
                    self.dependencies.run_routes.forget_run(turn_run.run_id);
                }
                // Read before the turn's memory is forgotten below.
                let turn_end = match turn_run.ending {
                    CodexTurnEnding::Paused | CodexTurnEnding::Retried => {
                        read_turn_end(record, &turn_id, members)
                    }
                    CodexTurnEnding::Live | CodexTurnEnding::Interrupted => None,
                };
                // A pause's turn that failed by itself leaves nothing to pause; a continue that
                // waited on the pause is refused, so its resume leaves the messages waiting.
                if turn_run.ending == CodexTurnEnding::Live
                    && let Some(run_id) =
                        record.paused_run_id_by_interrupted_turn_id.remove(&turn_id)
                    && let Some(waiting) = record.continues_awaiting_pause.remove(&run_id)
                {
                    let _unheard = waiting
                        .started
                        .send(Err(SteerTurnEndedError { run_id }.into()));
                }
                dispatch.turns_ended.push(CodexTurnMove {
                    turn_id: turn_id.clone(),
                    run_id: turn_run.run_id,
                    ending: turn_run.ending,
                    turn_end,
                });
            }
        }
        self.end_safety_hold(record, &turn_id).await;
        record.delivery.spent_safety_hold_turn_ids.remove(&turn_id);
        record.delivery.forget_turn(&turn_id);
        record.turn_input_by_turn_id.remove(&turn_id);
    }

    // Ends the held continuation `turn_id` as the daemon's restart cut it, the end the cut turns
    // before it got, never as Codex's, which would end its run while the person's answer is owed;
    // the run's deliveries' binding goes, as an interrupted turn's does. A failed write is logged.
    async fn end_held_continuation(
        &self,
        record: &mut CodexSessionRecord,
        turn_id: &str,
        turn_run: &CodexTurnRun,
    ) {
        self.open_turn(record, turn_id, turn_run).await;
        let turn_number = record
            .delivery
            .started_turn_by_turn_id
            .get(turn_id)
            .map(|started| started.turn_number);
        if let Some(turn_number) = turn_number {
            let ended = self
                .dependencies
                .engine
                .record_daemon_turn_end(
                    turn_run.run_id,
                    turn_number,
                    TurnOutcome::Interrupted(Some(TurnEndCause::DaemonRestart)),
                )
                .await;
            if let Err(error) = ended {
                tracing::warn!(
                    session_id = %record.session_id,
                    run_id = %turn_run.run_id,
                    error = &*error as &(dyn std::error::Error + 'static),
                    "a held codex continuation's end could not be written"
                );
            }
        }
        self.dependencies.run_routes.forget_run(turn_run.run_id);
    }

    /// Ends a held helper's turn, the `turn/completed` whose params are `turn_params` on its
    /// conversation
    /// `helper_thread_id`, as a held continuation ends: the daemon's end written on the helper's
    /// child run, which stays live and waiting, and its binding and route gone. Answers `false`,
    /// ending nothing, for a turn not marked held or a helper with no bound child run.
    pub(crate) async fn end_held_helper_turn(
        &self,
        record: &mut CodexSessionRecord,
        helper_thread_id: &str,
        turn_params: &Map<String, Value>,
    ) -> bool {
        let Some(turn_id) = read_completed_turn_id(turn_params) else {
            return false;
        };
        let Some(child) = record.delivery.child_run_by_thread_id.get(helper_thread_id) else {
            return false;
        };
        let Some(bound) = &child.bound else {
            return false;
        };
        if !record.held_continuation_turn_ids.remove(&turn_id) {
            return false;
        }
        let turn_run = CodexTurnRun {
            run_id: bound.child_run_id,
            binding: CodexRunBinding {
                session_id: record.session_id,
                binding_id: child.binding_id.clone(),
                agent_id: child.agent_id,
                // The turn opens only to be ended, so it takes no step a bound would count.
                step_bound: None,
            },
            ending: CodexTurnEnding::Live,
        };
        self.end_held_continuation(record, &turn_id, &turn_run)
            .await;
        record
            .delivery
            .child_run_by_thread_id
            .remove(helper_thread_id);
        self.dependencies
            .run_routes
            .retire_helper_run(turn_run.run_id);
        record.delivery.forget_turn(&turn_id);
        true
    }

    async fn deliver_terminal(
        &self,
        record: &mut CodexSessionRecord,
        gate: &mut TerminalEmissionGate,
        frame: &TurnCompletedFrame<'_>,
        turn_id: &str,
        turn_run: &CodexTurnRun,
        dispatch: &mut CodexFrameDispatch,
    ) {
        self.open_turn(record, turn_id, turn_run).await;
        let Some(turn_number) = record
            .delivery
            .started_turn_by_turn_id
            .get(turn_id)
            .map(|started| started.turn_number)
        else {
            return;
        };
        let turn_error = frame
            .members
            .get("turn")
            .and_then(|turn| read_codex_error_kind(turn.get("error")));
        let final_error = record.delivery.final_error_by_turn_id.get(turn_id).cloned();
        let error_kind = turn_error.or_else(|| {
            final_error
                .as_ref()
                .and_then(|error| error.error_kind.clone())
        });
        let input = CodexTurnTerminalInput {
            params: frame.params,
            run_id: turn_run.run_id,
            turn_epoch: record
                .delivery
                .assign_turn_epoch(turn_id, || self.mint_turn_epoch()),
            turn_number,
            route: frame.route.clone(),
            failure_cause: read_codex_turn_failure_cause(
                record,
                turn_id,
                error_kind.as_deref(),
                &self.dependencies.provider_accounts,
            )
            .await,
            fallback_detail: final_error.and_then(|error| provider_words(&error.message)),
        };
        let Some(terminal) = compose_codex_turn_terminal(input, gate, &mut self.lock_diagnostics())
        else {
            return;
        };
        let to = terminal.change.entry.state();
        let lifecycle = InboundDelivery::RunLifecycle {
            binding: DeliveryBinding {
                binding_id: turn_run.binding.binding_id.clone(),
                operation: Some(DeliveryOperation {
                    correlation_key: turn_id,
                    is_opening: false,
                }),
            },
            change: terminal.change,
            turn_end: Some(terminal.turn_end),
            is_daemon_interrupt_end: false,
        };
        self.send(record, lifecycle, "turn/completed").await;
        dispatch.run_moves.push(CodexRunMove {
            run_id: turn_run.run_id,
            to,
        });
        self.dependencies.run_routes.forget_run(turn_run.run_id);
        if to == RunStateChangeState::Failed
            && error_kind.as_deref() == Some(CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR)
        {
            self.dependencies.effects.cut_oversized_turn(
                record.session_id,
                &record.thread_id,
                turn_id,
            );
        }
    }

    // Codex's safety hold on the session's current live turn, shown once and only until the turn's
    // answer starts: Codex flags it again while the answer streams and never lifts it itself, so
    // the hold ends here, on its answer, its end, the next turn's start or a lifting flag.
    pub(super) async fn deliver_safety_buffering(
        &self,
        record: &mut CodexSessionRecord,
        members: &Map<String, Value>,
    ) {
        let Some(run) = self.row_run_for(record, members, "model/safetyBuffering/updated") else {
            return;
        };
        if members.get("showBufferingUi").and_then(Value::as_bool) != Some(true) {
            self.end_safety_hold(record, &run.turn_id).await;
            return;
        }
        let is_live = self
            .turn_run_for(record, &run.turn_id)
            .is_some_and(|turn_run| turn_run.ending == CodexTurnEnding::Live);
        let is_current = record
            .active_turns
            .last()
            .is_some_and(|(current, _run_id)| *current == run.turn_id);
        let delivery = &record.delivery;
        if !is_live
            || !is_current
            || delivery
                .safety_hold_run_by_turn_id
                .contains_key(&run.turn_id)
            || delivery.spent_safety_hold_turn_ids.contains(&run.turn_id)
        {
            return;
        }
        record
            .delivery
            .safety_hold_run_by_turn_id
            .insert(run.turn_id.clone(), run.row.clone());
        let faster_model = read_non_empty_string(members, "fasterModel");
        self.send_safety_hold(record, &run.row, &run.turn_id, true, faster_model)
            .await;
    }

    /// Ends the turn `turn_id`'s safety hold, lifting it on the run's stream where one shows; a
    /// live turn of the session's own shows none again.
    pub(in crate::driver::codex::delivery) async fn end_safety_hold(
        &self,
        record: &mut CodexSessionRecord,
        turn_id: &str,
    ) {
        // Only a live turn is remembered, since only its end forgets it; a turn already
        // remembered takes no new copy of its id.
        if record.active_turn_run(turn_id).is_some()
            && !record.delivery.spent_safety_hold_turn_ids.contains(turn_id)
        {
            record
                .delivery
                .spent_safety_hold_turn_ids
                .insert(turn_id.to_owned());
        }
        if let Some(run) = record.delivery.safety_hold_run_by_turn_id.remove(turn_id) {
            self.send_safety_hold(record, &run, turn_id, false, None)
                .await;
        }
    }

    async fn send_safety_hold(
        &self,
        record: &CodexSessionRecord,
        run: &CodexRowRun,
        turn_id: &str,
        is_active: bool,
        faster_model: Option<&str>,
    ) {
        let Ok(turn_id) = ProviderTurnId::new(turn_id.to_owned()) else {
            return;
        };
        let state = RunSafetyBufferingUpdatedPayload {
            session_id: run.session_id,
            run_id: run.run_id,
            turn_id,
            active: is_active,
            faster_model: faster_model.and_then(|model| {
                FreeFormText::<PROVIDER_WIRE_TOKEN_MAX_LEN>::new(model.to_owned()).ok()
            }),
        };
        let delivery = InboundDelivery::LiveRunState {
            binding: DeliveryBinding {
                binding_id: run.binding_id.clone(),
                operation: None,
            },
            state,
        };
        self.send(record, delivery, "model/safetyBuffering/updated")
            .await;
    }

    /// A turn that ended answers no ask it held: their cards are withdrawn, its corrections
    /// dropped.
    pub(in crate::driver::codex::delivery) fn withdraw_ended_turn_asks(
        &self,
        record: &CodexSessionRecord,
        thread_id: &str,
        turn_id: &str,
    ) {
        // With no connection the asks it held were already let go of and withdrawn.
        if let Ok(connection) = record.service.connection() {
            for forgotten in connection.forget_held_requests_of_turn(thread_id, turn_id) {
                self.dependencies.effects.withdraw_ask(
                    record.session_id,
                    &record.provider_account_id,
                    &forgotten.request_id,
                    forgotten.ask_kind,
                );
            }
        }
        self.dependencies
            .effects
            .forget_turn_asks(record.session_id, turn_id);
    }

    // Codex resolved an ask. One still held, which Codex settled itself (such as at a turn's
    // interrupt), is let go of with no answer sent and its card withdrawn. One the daemon answered
    // is let go of by its answer's guard once the answer is sent, normally before this
    // notification arrives, so nothing changes for it here.
    pub(super) fn forget_resolved_request(
        &self,
        record: &CodexSessionRecord,
        members: &Map<String, Value>,
    ) {
        let Some(request_id) = members.get("requestId") else {
            return;
        };
        let request_id = match request_id {
            Value::String(request_id) => request_id.clone(),
            Value::Number(request_id) => request_id.to_string(),
            Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => return,
        };
        let ask_kind = record
            .service
            .connection()
            .ok()
            .and_then(|connection| connection.forget_held_request(&request_id));
        if let Some(ask_kind) = ask_kind {
            self.dependencies.effects.withdraw_ask(
                record.session_id,
                &record.provider_account_id,
                &request_id,
                ask_kind,
            );
        }
    }

    /// An `error` frame: one Codex retries files the retried request's row on the turn's run; one
    /// it will not retry is kept as the turn's final error.
    pub(super) async fn deliver_turn_error(
        &self,
        record: &mut CodexSessionRecord,
        members: &Map<String, Value>,
    ) {
        if !note_turn_error(record, members) {
            return;
        }
        let Some(run) = self.row_run_for(record, members, "error") else {
            return;
        };
        self.send_row(record, codex_request_retry(members, &run.row))
            .await;
    }
}

/// The compaction-wait key: session and thread together, since a fork or superseding resume moves
/// the thread and a session-only key would settle on the replacement's `thread/compacted`.
/// NUL-joined, since every bounded string on this leg refuses NUL.
pub(crate) fn codex_compaction_wait_key(record: &CodexSessionRecord, thread_id: &str) -> String {
    format!("{}\u{0}{thread_id}", record.session_id)
}

// An error Codex retries marks the turn retried; one it will not retry is the turn's final error.
// Answers whether Codex retries the request.
fn note_turn_error(record: &mut CodexSessionRecord, members: &Map<String, Value>) -> bool {
    let Some(turn_id) = read_non_empty_string(members, "turnId") else {
        return false;
    };
    let error = members.get("error");
    if members.get("willRetry").and_then(Value::as_bool) == Some(true) {
        record.delivery.retried_turn_ids.insert(turn_id.to_owned());
        return true;
    }
    let message = error
        .and_then(Value::as_object)
        .and_then(|error| read_non_empty_string(error, "message"))
        .unwrap_or_default();
    record.delivery.final_error_by_turn_id.insert(
        turn_id.to_owned(),
        CodexTurnErrorReading {
            message: message.to_owned(),
            error_kind: read_codex_error_kind(error),
        },
    );
    false
}

// The `usage.apiRequest.retried` row of an error Codex retries, on the turn's run, its kind read
// from Codex's error arm.
fn codex_request_retry(members: &Map<String, Value>, run: &CodexRowRun) -> CodexRowDelivery {
    let error_kind = match read_codex_error_kind(members.get("error")).as_deref() {
        Some("unauthorized") => ApiRetryErrorKind::AuthenticationFailed,
        Some(CODEX_RATE_LIMIT_EXCEEDED_ERROR | CODEX_USAGE_LIMIT_EXCEEDED_ERROR) => {
            ApiRetryErrorKind::RateLimit
        }
        Some("serverOverloaded") => ApiRetryErrorKind::Overloaded,
        Some("internalServerError") => ApiRetryErrorKind::ServerError,
        Some("badRequest") => ApiRetryErrorKind::InvalidRequest,
        Some(_) | None => ApiRetryErrorKind::Unknown,
    };
    CodexRowDelivery {
        binding_id: run.binding_id.clone(),
        operation: None,
        row: CodexRow::Late(LateAppendableRow::UsageApiRequestRetried(
            UsageApiRequestRetriedPayload {
                session_id: run.session_id,
                run_id: Some(run.run_id),
                provider: DESCRIPTOR.provider_id(),
                error_kind,
                retry_delay_ms: None,
                attempt: None,
                source_epoch: None,
                source_position: None,
            },
        )),
        body: None,
        method: "error",
    }
}

/// A `hook/completed` of a `userPromptSubmit` hook handler, of any status, with a blocking or
/// stopping handler's words; a frame with no `run.id` is dropped.
pub(super) fn read_prompt_hook_run(
    members: &Map<String, Value>,
    dispatch: &mut CodexFrameDispatch,
) {
    let Some(run) = members.get("run").and_then(Value::as_object) else {
        return;
    };
    if run.get("eventName").and_then(Value::as_str) != Some(CODEX_USER_PROMPT_SUBMIT_HOOK) {
        return;
    }
    let Some(run_id) = read_non_empty_string(run, "id") else {
        return;
    };
    let status = run.get("status").and_then(Value::as_str);
    let is_blocked = status == Some("blocked");
    let is_stopped = status == Some("stopped");
    let mut words: Vec<String> = Vec::new();
    if is_blocked || is_stopped {
        words.extend(
            run.get("entries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
        );
        if words.is_empty()
            && let Some(message) = read_non_empty_string(run, "statusMessage")
        {
            words.push(message.to_owned());
        }
    }
    dispatch.prompt_hook_runs.push(CodexPromptHookRun {
        turn_id: read_non_empty_string(members, "turnId").map(str::to_owned),
        run_id: run_id.to_owned(),
        is_blocked,
        is_stopped,
        words,
    });
}

/// The `turn.id` a turn frame names.
fn read_completed_turn_id(members: &Map<String, Value>) -> Option<String> {
    members
        .get("turn")
        .and_then(Value::as_object)
        .and_then(|turn| read_non_empty_string(turn, "id"))
        .map(str::to_owned)
}

/// The `turn.status` a turn frame names.
fn read_turn_status(members: &Map<String, Value>) -> Option<&str> {
    members.get("turn")?.get("status")?.as_str()
}

// The end a turn that moves no run reported, numbered as its start was; `None` for a turn never
// numbered or a status that ends nothing.
fn read_turn_end(
    record: &CodexSessionRecord,
    turn_id: &str,
    members: &Map<String, Value>,
) -> Option<ProviderTurnEnd> {
    let turn_number = record
        .delivery
        .started_turn_by_turn_id
        .get(turn_id)?
        .turn_number;
    let outcome = match CodexTurnStatus::read(read_turn_status(members)?)? {
        CodexTurnStatus::Completed => TurnOutcome::Completed,
        CodexTurnStatus::Interrupted => TurnOutcome::Interrupted(None),
        CodexTurnStatus::Failed => TurnOutcome::Failed(None),
        CodexTurnStatus::InProgress => return None,
    };
    Some(ProviderTurnEnd {
        turn_number,
        outcome,
    })
}

#[cfg(test)]
mod tests;
