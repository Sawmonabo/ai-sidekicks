//! A turn's opening and its end on the session's task. The first frame of a run's turn opens and
//! numbers it; the turn-ending lead `result` composes its end, passes the session's terminal gate
//! once per turn, and is delivered, held while the daemon's own end of the run is not certain,
//! carried while a steer of the run waits for the turn Claude Code starts with it, or written as a
//! turn end alone where it moves no run. An end the run engine could not take is followed by a
//! failed end, so no run is left open.

use serde_json::Value;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::time::Instant;

use super::{ClaudeDeliveryStream, ClaudeSessionStream, bound, report_engine_failure};
use crate::claude::delivery::run_readings::{ClaudeEndedAs, ClaudeOpenTurn, ClaudeTurnEndDelivery};
use crate::claude::delivery::turn_end::{ClaudeTurnEndMarks, compose_claude_turn_end};
use crate::claude::event_normalizer::ClaudeWireFrameKind;
use crate::claude::run::routes::ClaudeBoundRun;
use crate::run::delivery::{DeliveryBinding, InboundDelivery};
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use crate::run::turn_end::ProviderTurnEnd;
use crate::terminal_emission_gate::{TerminalEmissionDecision, TerminalRunFrame};
use crate::thread_frame_router::ThreadFrameRoute;
use sidekicks_std::mutex_lock::lock;

/// Why a run ended failed when the run engine could not take the end Claude Code reported.
const CLAUDE_UNRECORDED_TURN_END_DETAIL: &str =
    "Claude Code ended this run's turn, but the end it reported could not be recorded.";

impl ClaudeDeliveryStream {
    // The first frame of a run's turn opens it: an interrupt still held answered as taken, the
    // continued run's report, the boundary, then the turn numbered, the readings of the turn
    // before emptied.
    pub(super) async fn open_turn(&self, session: &ClaudeSessionStream, lead: &ClaudeBoundRun) {
        let routes = &self.dependencies.routes;
        let (interrupted, continues) = {
            let mut readings = session.lock();
            if readings
                .turn
                .as_ref()
                .is_some_and(|turn| turn.run_id == lead.run_id)
            {
                return;
            }
            readings.carried_ends.remove(&lead.run_id);
            // Claude Code started its next turn with the steers it kept, so the interrupt took.
            let is_held_for_interrupt = readings
                .daemon_ended
                .get(&lead.run_id)
                .is_some_and(|marked| marked.is_for_interrupt && marked.held.is_some());
            let interrupted = is_held_for_interrupt
                .then(|| readings.settle_interrupted_daemon_end(routes, lead.run_id))
                .flatten();
            let continues = readings.take_continuable_run(routes, lead.run_id);
            readings.turn = Some(ClaudeOpenTurn {
                run_id: lead.run_id,
                binding_id: lead.binding_id.clone(),
                turn_number: None,
            });
            readings.failed_call_words.clear();
            readings.event_ids_by_message_key.clear();
            readings.counted_step_messages.clear();
            readings.streamed_blocks.open_turn();
            readings.refusal = None;
            readings.is_retries_spent = false;
            (interrupted, continues)
        };
        if let Some(interrupted) = interrupted {
            self.deliver_turn_end(session, lead.run_id, interrupted)
                .await;
        }
        if continues {
            let delivery = InboundDelivery::RunContinued {
                binding: bound(lead),
                run_id: lead.run_id,
            };
            self.send(session, delivery, None).await;
        }
        let boundary = InboundDelivery::TurnBoundary {
            binding_id: lead.binding_id.clone(),
        };
        self.send(session, boundary, None).await;
        let started = match self
            .dependencies
            .engine
            .start_turn(lead.run_id, session.step_bound)
            .await
        {
            Ok(started) => started,
            Err(error) => {
                report_engine_failure(session, "a turn's start", &*error);
                None
            }
        };
        if let Some(turn) = session.lock().turn.as_mut()
            && turn.run_id == lead.run_id
        {
            turn.turn_number = started.map(|started| started.turn_number);
        }
    }

    // The turn's end, through the gate once per turn: what streamed and what the buffer holds go
    // out first, the reviewer's blocks are captured at Reviewed, and the composed end is
    // delivered, held, carried or written alone. Answers the run whose turn did not fit even after
    // compaction.
    pub(super) async fn end_turn(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        frame: &Value,
        kind: &ClaudeWireFrameKind,
        route: ThreadFrameRoute,
        is_reviewed: bool,
    ) -> Option<RunId> {
        let (turn_number, run_version, pieces, released, failed_call_words) = {
            let mut readings = session.lock();
            let open_turn = readings
                .turn
                .take()
                .filter(|turn| turn.run_id == lead.run_id);
            let turn_number = open_turn.as_ref().and_then(|turn| turn.turn_number);
            // A turn the engine numbered settles under its number, and one it could not number
            // under a version of its own past every number, so a run's later turn is never taken
            // for one already settled; an end with no turn open settles under 0.
            let run_version = match (&open_turn, turn_number) {
                (_, Some(turn_number)) => turn_number.get(),
                (Some(_), None) => session.unnumbered_turn_version(),
                (None, None) => 0,
            };
            // A block the turn left unfinished keeps what streamed of it.
            let pieces = readings.streamed_blocks.end_turn(lead.run_id);
            let released = readings.buffer.flush_all(Instant::now());
            (
                turn_number,
                run_version,
                pieces,
                released,
                readings.failed_call_words.clone(),
            )
        };
        self.send_pieces(session, &lead.binding_id, pieces).await;
        self.send_rows(session, released, Some("result")).await;
        if is_reviewed {
            self.dependencies.reviewer.capture_result_denials(
                session.session_id,
                lead.run_id,
                frame,
                &failed_call_words,
            );
        }
        // Taken whatever the gate decides, so a pause never outlives the turn it was asked in.
        let (pause_effect, reported_pause) = {
            let mut pauses = lock(&self.dependencies.pauses);
            let effect = pauses.take_lead_pause_effect(&session.session_id);
            (
                effect,
                pauses.reported_lead_pause(&session.session_id).copied(),
            )
        };
        let newest_message_id = session
            .lock_prompts()
            .newest_for(session.session_id)
            .map(str::to_owned);
        let has_untaken_steer = session.lock_prompts().has_untaken_steer(lead.run_id);
        let (end, reader_carried, marked, intended_close) = {
            let mut readings = session.lock();
            let reader_carried = readings.reader_carried_run.take() == Some(lead.run_id);
            let decision = readings.gate.admit_terminal_frame(&TerminalRunFrame {
                run_id: lead.run_id,
                run_version,
                route,
            });
            let TerminalEmissionDecision::Emit { intended_close } = decision else {
                drop(readings);
                if reader_carried {
                    self.dependencies.routes.unbind_run(lead.run_id);
                }
                return None;
            };
            let is_interrupted = readings.interrupted_runs.remove(&lead.run_id);
            let marked = readings
                .daemon_ended
                .get(&lead.run_id)
                .map(|marked| (marked.is_for_interrupt, marked.is_confirmed));
            let marks = ClaudeTurnEndMarks {
                is_interrupted,
                is_held_for_interrupt: marked.is_some_and(|(is_for_interrupt, _)| is_for_interrupt),
                is_intended_close: intended_close,
                is_pause_effect: pause_effect == Some(lead.run_id),
                is_resting_paused: pause_effect.is_none() && reported_pause == Some(lead.run_id),
                refusal: readings.refusal.clone(),
                is_retries_spent: readings.is_retries_spent,
                newest_message_id,
            };
            (
                compose_claude_turn_end(frame, kind, lead.run_id, marks),
                reader_carried,
                marked,
                intended_close,
            )
        };
        let delivery = ClaudeTurnEndDelivery {
            binding_id: lead.binding_id.clone(),
            end: end.clone(),
            turn_number,
        };
        // A turn Claude Code started by itself on a paused run moves no run.
        let Some(change) = &end.change else {
            self.release_reader_carry(lead.run_id, reader_carried, false);
            self.record_turn_end_alone(session, lead.run_id, &delivery)
                .await;
            return None;
        };
        // Claude Code starts its next turn at once with a steer this turn did not take, so a run
        // that completed cleanly with one waiting goes on into that turn, whose end ends the run.
        if matches!(change.entry, RunStateEntry::Completed { .. })
            && !intended_close
            && marked.is_none()
            && has_untaken_steer
        {
            self.release_reader_carry(lead.run_id, reader_carried, true);
            self.record_turn_end_alone(session, lead.run_id, &delivery)
                .await;
            session.lock().carried_ends.insert(
                lead.run_id,
                ClaudeTurnEndDelivery {
                    turn_number: None,
                    ..delivery
                },
            );
            return None;
        }
        // The same holds for a run an interrupt stops: Claude Code starts its next turn with the
        // steers the interrupt left it, which the run holds and goes on in.
        let is_carried = (end.is_daemon_interrupt_end
            || marked.is_some_and(|(is_for_interrupt, _)| is_for_interrupt))
            && has_untaken_steer;
        self.release_reader_carry(lead.run_id, reader_carried, is_carried);
        let routes = &self.dependencies.routes;
        if let Some((_, is_confirmed)) = marked {
            // The daemon writes this run's end; a turn end is held while that write is uncertain.
            if is_confirmed {
                session.lock().settle_confirmed_daemon_end(
                    routes,
                    lead.run_id,
                    ClaudeEndedAs::of(end.change.as_ref()),
                    is_carried,
                );
                self.record_turn_end_alone(session, lead.run_id, &delivery)
                    .await;
            } else {
                session
                    .lock()
                    .hold_daemon_turn_end(lead.run_id, delivery, is_carried);
            }
            return None;
        }
        session.lock().settle_ended_run(
            routes,
            lead.run_id,
            ClaudeEndedAs::of(end.change.as_ref()),
            is_carried,
        );
        self.deliver_turn_end(session, lead.run_id, delivery).await;
        end.is_too_long.then_some(lead.run_id)
    }

    // The reader kept the run holding the turn when a steer of it waited; the turn's end decides
    // otherwise where the run does not go on, or takes the turn back where a steer was written
    // after the reader read the end.
    fn release_reader_carry(&self, run_id: RunId, reader_carried: bool, is_carried: bool) {
        let routes = &self.dependencies.routes;
        match (reader_carried, is_carried) {
            (true, false) => routes.unbind_run(run_id),
            (false, true) => {
                if let Err(refusal) = routes.hold_turn_again(run_id) {
                    tracing::debug!(
                        %run_id,
                        ?refusal,
                        "a run that goes on into Claude Code's next turn found its turn taken"
                    );
                }
            }
            (true, true) | (false, false) => {}
        }
    }

    /// Delivers a turn's end on its run; an end the run engine did not take ends the run failed
    /// instead, naming why.
    pub(super) async fn deliver_turn_end(
        &self,
        session: &ClaudeSessionStream,
        run_id: RunId,
        delivery: ClaudeTurnEndDelivery,
    ) {
        let ClaudeTurnEndDelivery {
            binding_id,
            end,
            turn_number,
        } = delivery;
        let Some(change) = end.change else {
            return;
        };
        let binding = DeliveryBinding {
            binding_id: binding_id.clone(),
            operation: None,
        };
        let outcome = self
            .send(
                session,
                InboundDelivery::RunLifecycle {
                    binding,
                    change,
                    turn_end: turn_number.map(|turn_number| ProviderTurnEnd {
                        turn_number,
                        outcome: end.outcome,
                    }),
                    is_daemon_interrupt_end: end.is_daemon_interrupt_end,
                },
                Some("result"),
            )
            .await;
        if outcome.is_some() {
            return;
        }
        let failed = RunStateReport {
            failure_category: Some(RunFailureCategory::ProviderFailure),
            ..RunStateReport::new(
                run_id,
                RunStateEntry::Failed {
                    intended_close: None,
                    failure_cause: None,
                    provider_failure_detail: Some(
                        FreeFormText::new(CLAUDE_UNRECORDED_TURN_END_DETAIL.to_owned())
                            .expect("the unrecorded end's words fit a failure's detail"),
                    ),
                    process_exit: None,
                },
            )
        };
        let binding = DeliveryBinding {
            binding_id,
            operation: None,
        };
        self.send(
            session,
            InboundDelivery::RunLifecycle {
                binding,
                change: failed,
                turn_end: None,
                is_daemon_interrupt_end: false,
            },
            None,
        )
        .await;
    }

    // Writes a turn's end that moves no run, so every started turn gets exactly one end.
    async fn record_turn_end_alone(
        &self,
        session: &ClaudeSessionStream,
        run_id: RunId,
        delivery: &ClaudeTurnEndDelivery,
    ) {
        let Some(turn_number) = delivery.turn_number else {
            return;
        };
        let turn_end = ProviderTurnEnd {
            turn_number,
            outcome: delivery.end.outcome,
        };
        if let Err(error) = self
            .dependencies
            .engine
            .record_turn_end(run_id, turn_end)
            .await
        {
            report_engine_failure(session, "a turn's end", &*error);
        }
    }

    /// A steer a run carried its turn over for was taken back or never written: with none left for
    /// Claude Code to start that turn with, the run ends as its last turn did.
    pub(crate) async fn release_carried_turn(&self, session: &ClaudeSessionStream, run_id: RunId) {
        if session.lock_prompts().has_untaken_steer(run_id) {
            return;
        }
        let Some(carried) = session.lock().carried_ends.remove(&run_id) else {
            return;
        };
        // A run that ended meanwhile holds no turn and has nothing left to end.
        if self.dependencies.routes.route_of(run_id).is_none() {
            return;
        }
        self.dependencies.routes.unbind_run(run_id);
        session.lock().settle_ended_run(
            &self.dependencies.routes,
            run_id,
            ClaudeEndedAs::of(carried.end.change.as_ref()),
            false,
        );
        self.deliver_turn_end(session, run_id, carried).await;
    }
}
