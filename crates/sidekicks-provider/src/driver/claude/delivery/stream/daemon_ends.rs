//! Runs whose end the daemon writes itself: a choice's refusal end the dialogs settled, or the
//! interrupt an intervention is about to send, whose end comes from the interrupt's answer. The
//! turn end Claude Code then sends is no second end: it is held while the daemon's end is not
//! certain, dropped once the daemon's end lands, delivered as Claude Code sent it when the daemon's
//! end did not happen, and delivered `interrupted` once Claude Code answered the interrupt. A mark
//! is made at once under the session's readings, so a `result` already queued sees it; a
//! settlement from off the session's task is queued, so it keeps its place among the frames.

use std::sync::Arc;

use futures::FutureExt;
use futures::future::{BoxFuture, ready};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use super::{ClaudeDeliveryStream, ClaudeSessionStream, ClaudeSessionStreams};
use crate::driver::claude::delivery::dialogs::ClaudeDialogPorts;
use crate::driver::claude::delivery::run_readings::{
    ClaudeEndedAs, ClaudeMessageKey, ClaudeStreamSession, ClaudeTurnEndDelivery,
};
use crate::driver::claude::delivery::turn_end::ClaudeTurnEnd;
use crate::driver::claude::run::routes::{ClaudeRunRoute, ClaudeRunRoutes};
use crate::driver::claude::session::arrivals::{
    ClaudeOwnDelivery, ClaudeSessionArrival, deliver_in_session_order,
};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::run::delivery::{InboundDelivery, InboundOutcome};
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use crate::run::turn_end::TurnOutcome;

/// A run whose end the daemon writes itself, and the turn end held back until that end is certain.
#[derive(Debug)]
pub(crate) struct ClaudeDaemonEndedRun {
    /// Whether an interrupt the daemon sent on the run's turn writes the end from its answer.
    pub(crate) is_for_interrupt: bool,
    /// Whether the daemon's end is certain.
    pub(crate) is_confirmed: bool,
    /// The turn end Claude Code sent while the daemon's end was not certain.
    pub(crate) held: Option<ClaudeTurnEndDelivery>,
    /// Whether the run holds the session's turn into the one Claude Code starts with the steers it
    /// kept, decided as the held end arrived.
    pub(crate) is_carried: bool,
}

/// How the daemon's own end of a run settled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeDaemonEndSettlement {
    /// It landed: a held turn end is dropped.
    Confirmed,
    /// It did not happen, or the interrupt never reached Claude Code: a held turn end is
    /// delivered as Claude Code sent it.
    Released,
    /// Claude Code answered the interrupt: the turn end, held or still coming, is delivered
    /// `interrupted`.
    Interrupted,
}

impl ClaudeStreamSession {
    /// Marks `run_id`'s end as the daemon's: `is_confirmed` when nothing will confirm or release
    /// it, `is_for_interrupt` when an interrupt's answer writes it; a mark already made takes the
    /// confirmation.
    pub(crate) fn mark_daemon_end(
        &mut self,
        run_id: RunId,
        is_confirmed: bool,
        is_for_interrupt: bool,
    ) {
        self.daemon_ended
            .entry(run_id)
            .and_modify(|marked| marked.is_confirmed |= is_confirmed)
            .or_insert(ClaudeDaemonEndedRun {
                is_for_interrupt,
                is_confirmed,
                held: None,
                is_carried: false,
            });
    }

    /// Holds a turn end of a marked run until the daemon's end settles.
    pub(crate) fn hold_daemon_turn_end(
        &mut self,
        run_id: RunId,
        delivery: ClaudeTurnEndDelivery,
        is_carried: bool,
    ) {
        if let Some(marked) = self.daemon_ended.get_mut(&run_id) {
            marked.held = Some(delivery);
            marked.is_carried = is_carried;
        }
    }

    /// The turn's end of a run whose daemon end is already certain: the mark goes and the run's
    /// readings settle; nothing is delivered.
    pub(crate) fn settle_confirmed_daemon_end(
        &mut self,
        routes: &ClaudeRunRoutes,
        run_id: RunId,
        ended: ClaudeEndedAs,
        is_carried: bool,
    ) {
        self.daemon_ended.remove(&run_id);
        self.settle_ended_run(routes, run_id, ended, is_carried);
    }

    /// Settles the daemon's end of `run_id` as `settlement` says, answering the turn end to
    /// deliver now, if any.
    pub(crate) fn settle_daemon_end(
        &mut self,
        routes: &ClaudeRunRoutes,
        run_id: RunId,
        settlement: ClaudeDaemonEndSettlement,
    ) -> Option<ClaudeTurnEndDelivery> {
        match settlement {
            ClaudeDaemonEndSettlement::Confirmed => {
                let marked = self.daemon_ended.get_mut(&run_id)?;
                let Some(held) = marked.held.take() else {
                    marked.is_confirmed = true;
                    return None;
                };
                self.daemon_ended.remove(&run_id);
                self.settle_ended_run(
                    routes,
                    run_id,
                    ClaudeEndedAs::of(held.end.change.as_ref()),
                    false,
                );
                None
            }
            ClaudeDaemonEndSettlement::Released => {
                let marked = self.daemon_ended.remove(&run_id)?;
                let held = marked.held?;
                self.settle_ended_run(
                    routes,
                    run_id,
                    ClaudeEndedAs::of(held.end.change.as_ref()),
                    marked.is_carried,
                );
                Some(held)
            }
            ClaudeDaemonEndSettlement::Interrupted => {
                self.settle_interrupted_daemon_end(routes, run_id)
            }
        }
    }

    /// Claude Code answered the interrupt of a marked run: a turn end already held is delivered
    /// `interrupted`, and one still coming is marked to be.
    pub(crate) fn settle_interrupted_daemon_end(
        &mut self,
        routes: &ClaudeRunRoutes,
        run_id: RunId,
    ) -> Option<ClaudeTurnEndDelivery> {
        let marked = self.daemon_ended.remove(&run_id)?;
        let Some(held) = marked.held else {
            self.interrupted_runs.insert(run_id);
            return None;
        };
        let interrupted = ClaudeTurnEndDelivery {
            end: ClaudeTurnEnd {
                change: Some(RunStateReport::new(
                    run_id,
                    RunStateEntry::Interrupted {
                        intended_close: None,
                        trigger: None,
                    },
                )),
                outcome: TurnOutcome::Interrupted(None),
                is_daemon_interrupt_end: true,
                is_too_long: false,
            },
            ..held
        };
        self.settle_ended_run(
            routes,
            run_id,
            ClaudeEndedAs::Interrupted,
            marked.is_carried,
        );
        Some(interrupted)
    }
}

impl ClaudeSessionStream {
    /// Marks a run whose turn an intervention's interrupt is about to stop, whose end the daemon
    /// writes from the interrupt's answer; settled by [`Self::interrupt_daemon_end`] or
    /// [`Self::release_daemon_end`].
    pub(crate) fn hold_turn_end_for_interrupt(&self, run_id: RunId) {
        self.lock().mark_daemon_end(run_id, false, true);
    }

    /// Marks a run whose turn the driver's own interrupt is stopping, so the turn end Claude Code
    /// then sends is delivered `interrupted`.
    pub(crate) fn mark_interrupted(&self, run_id: RunId) {
        self.lock().interrupted_runs.insert(run_id);
    }

    /// The interrupt was not sent: the run's turn end is delivered as Claude Code reports it.
    pub(crate) fn unmark_interrupted(&self, run_id: RunId) {
        self.lock().interrupted_runs.remove(&run_id);
    }

    /// Whether an interrupt is stopping `run_id`'s turn whose end has not yet arrived, so the
    /// run's next turn waits for that end.
    pub(crate) fn is_turn_ending_for_interrupt(&self, run_id: RunId) -> bool {
        let readings = self.lock();
        readings.interrupted_runs.contains(&run_id)
            || readings
                .daemon_ended
                .get(&run_id)
                .is_some_and(|marked| marked.is_for_interrupt)
    }

    /// Claude Code answered the interrupt of a marked run; settled on the session's task.
    pub(crate) fn interrupt_daemon_end(&self, run_id: RunId) {
        self.settle_on_task(run_id, ClaudeDaemonEndSettlement::Interrupted);
    }

    /// The daemon's end of a marked run did not happen; settled on the session's task.
    pub(crate) fn release_daemon_end(&self, run_id: RunId) {
        self.settle_on_task(run_id, ClaudeDaemonEndSettlement::Released);
    }

    /// The daemon's end of a marked run landed; settled on the session's task.
    pub(crate) fn confirm_daemon_end(&self, run_id: RunId) {
        self.settle_on_task(run_id, ClaudeDaemonEndSettlement::Confirmed);
    }

    /// A steer the run carried its turn over for was taken back or never written; settled on the
    /// session's task.
    pub(crate) fn release_carried_turn(&self, run_id: RunId) {
        self.arrivals.push(ClaudeSessionArrival::Deliver(
            ClaudeOwnDelivery::CarriedRelease { run_id },
        ));
    }

    fn settle_on_task(&self, run_id: RunId, settlement: ClaudeDaemonEndSettlement) {
        self.arrivals.push(ClaudeSessionArrival::Deliver(
            ClaudeOwnDelivery::DaemonEnd { run_id, settlement },
        ));
    }
}

impl ClaudeDeliveryStream {
    /// Takes one delivery a caller off the session's task queued, in its place among the frames.
    pub(crate) async fn take_own_delivery(
        &self,
        session: &ClaudeSessionStream,
        delivery: ClaudeOwnDelivery,
    ) {
        match delivery {
            ClaudeOwnDelivery::Dispatch { delivery, outcome } => {
                let answered = self.send(session, *delivery, None).await;
                // A caller that stopped waiting needs no outcome.
                outcome.send(answered).unwrap_or(());
            }
            ClaudeOwnDelivery::DaemonEnd { run_id, settlement } => {
                let settled =
                    session
                        .lock()
                        .settle_daemon_end(&self.dependencies.routes, run_id, settlement);
                if let Some(delivery) = settled {
                    self.deliver_turn_end(session, run_id, delivery).await;
                }
            }
            ClaudeOwnDelivery::CarriedRelease { run_id } => {
                self.release_carried_turn(session, run_id).await;
            }
        }
    }
}

/// The ports the session's dialogs deliver through, each delivery in its session's order; the
/// daemon-end marks and settlements are the stream's.
pub(crate) struct ClaudeStreamDialogPorts {
    dispatch: Arc<dyn InboundDispatch>,
    routes: Arc<ClaudeRunRoutes>,
    streams: Arc<ClaudeSessionStreams>,
}

impl ClaudeStreamDialogPorts {
    /// Ports over the run engine's dispatch, the runs' routes and every session's stream.
    pub(crate) fn new(
        dispatch: Arc<dyn InboundDispatch>,
        routes: Arc<ClaudeRunRoutes>,
        streams: Arc<ClaudeSessionStreams>,
    ) -> Self {
        Self {
            dispatch,
            routes,
            streams,
        }
    }

    // The stream of the session `run_id` is bound to as a lead run.
    fn lead_stream(&self, run_id: RunId) -> Option<Arc<ClaudeSessionStream>> {
        match self.routes.route_of(run_id)? {
            ClaudeRunRoute::Lead { session_id, .. } => self.streams.get(session_id),
            ClaudeRunRoute::Child(_) | ClaudeRunRoute::Apart => None,
        }
    }
}

impl ClaudeDialogPorts for ClaudeStreamDialogPorts {
    fn deliver(
        &self,
        session_id: SessionId,
        delivery: InboundDelivery<'static>,
    ) -> BoxFuture<'_, Option<InboundOutcome>> {
        deliver_in_session_order(&*self.dispatch, &self.streams, session_id, delivery)
    }

    fn event_ids_for_messages(
        &self,
        session_id: SessionId,
        message_uuids: Vec<String>,
    ) -> BoxFuture<'_, Vec<String>> {
        let Some(stream) = self.streams.get(session_id) else {
            return ready(Vec::new()).boxed();
        };
        let readings = stream.lock();
        let mut event_ids = Vec::new();
        for uuid in message_uuids {
            let block_key = readings.streamed_blocks.block_key_for(&uuid).cloned();
            for key in [
                Some(ClaudeMessageKey::Uuid(uuid)),
                block_key.map(ClaudeMessageKey::Block),
            ]
            .into_iter()
            .flatten()
            {
                event_ids.extend(
                    readings
                        .event_ids_by_message_key
                        .get(&key)
                        .into_iter()
                        .flatten()
                        .map(|event_id| event_id.as_str().to_owned()),
                );
            }
        }
        ready(event_ids).boxed()
    }

    fn mark_daemon_ended(&self, run_id: RunId, is_confirmed: bool) {
        // A run bound to no session holds no turn, so no turn end of it is coming.
        if let Some(stream) = self.lead_stream(run_id) {
            stream.lock().mark_daemon_end(run_id, is_confirmed, false);
        }
    }

    fn confirm_daemon_end(&self, run_id: RunId) {
        if let Some(stream) = self.streams.holding_daemon_end(run_id) {
            stream.confirm_daemon_end(run_id);
        }
    }

    fn release_daemon_end(&self, run_id: RunId) {
        if let Some(stream) = self.streams.holding_daemon_end(run_id) {
            stream.release_daemon_end(run_id);
        }
    }
}
