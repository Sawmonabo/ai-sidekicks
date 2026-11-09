//! The readying path of the tick's loop: a settled step's outputs kept, and what the walk then
//! readies, skips, wins or cancels added to the run's turn, each readied step's first main input
//! stored for its `pending` row and each reused step's outputs kept as a settled step's.

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::{EngineTick, ReadiedNext, RunTurn, TurnReadied, failed_at_once, reports, step_failure};
use crate::engine::event_record::EngineFault;
use crate::engine::tick::branch_cancellation::{BranchLoser, cancel_branches};
use crate::engine::tick::live_runs::LiveRun;
use crate::engine::tick::node_settings::main_inputs;
use crate::engine::tick::step_failure::{RunSibling, SiblingState};
use crate::engine::tick::walk::{WalkSkip, WalkSkipReason, WalkTurn};
use crate::expressions::lineage::{StepKey, StepOutput};
use crate::kinds::StepFailure;
use crate::runs::step_payload::write_step_payload;

impl EngineTick {
    /// Settles `step` in the walk with `outputs`, which move into the run's outputs beside its
    /// sources, and adds what the walk readies or skips to the turn on `readying`, the event
    /// whose write settles it and its instant.
    pub(super) async fn settle_step(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        step: &WorkflowStepKey,
        readying: (usize, WireInstant),
        outputs: Vec<Vec<WorkflowItem>>,
    ) {
        let output_lengths: Vec<usize> = outputs.iter().map(Vec::len).collect();
        let walked = live.walk.settle(step, &output_lengths);
        let settled = live
            .remove_step(step.execution_index.get())
            .expect("a settled step is live");
        live.outputs.record(
            StepKey {
                node_id: step.node_id.clone(),
                execution_index: step.execution_index.get(),
            },
            StepOutput {
                sources: settled.sources,
                outputs,
            },
        );
        turn.last_readying_event = Some(readying.clone());
        self.take_walk(live, turn, walked, readying).await;
    }

    /// Flushes the quiet run of `live` until the walk answers nothing, each answer in this turn's
    /// write on the turn's last event that carries readied steps.
    pub(super) async fn flush(&self, live: &mut LiveRun, turn: &mut RunTurn) {
        loop {
            let flushed = live.walk.flush();
            if flushed.ready.is_empty()
                && flushed.skipped.is_empty()
                && flushed.wins.is_empty()
                && flushed.canceled.is_empty()
            {
                return;
            }
            let readying = turn.last_readying_event.clone().expect(
                "a run goes quiet only in a turn whose last step left with an event that carries \
                 what its leaving readies",
            );
            self.take_walk(live, turn, flushed, readying).await;
        }
    }

    /// Adds what the walk answered to the turn: each skip's row and event, a reused skip's outputs
    /// kept as its step's and its earlier step's payloads recorded as its own, then each readied
    /// step's `pending` row on its stored first main input, on the event of the last skip it
    /// names as a source, or else on `readying`'s event.
    pub(super) async fn take_walk(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        walked: WalkTurn,
        (readying_event, at): (usize, WireInstant),
    ) {
        let WalkTurn {
            ready,
            mut skipped,
            wins,
            canceled,
        } = walked;
        let mut skip_events: Vec<(u64, usize)> = Vec::with_capacity(skipped.len());
        for skip in &mut skipped {
            let (input_ref, output_ref) = match &mut skip.reason {
                WalkSkipReason::Disabled => {
                    let payload = self.store_skipped_input(live, skip).await;
                    (payload.clone(), payload)
                }
                WalkSkipReason::Reused(reused) => {
                    live.outputs.record(
                        StepKey {
                            node_id: skip.step.node_id.clone(),
                            execution_index: skip.step.execution_index.get(),
                        },
                        StepOutput {
                            sources: skip.sources.clone(),
                            outputs: std::mem::take(&mut reused.outputs),
                        },
                    );
                    (reused.input_ref.clone(), reused.output_ref.clone())
                }
                WalkSkipReason::NoItems => (
                    WorkflowPayloadRef::Inline { items: Vec::new() },
                    WorkflowPayloadRef::Inline { items: Vec::new() },
                ),
            };
            let index = turn
                .commit
                .skipped(skip, &input_ref, &output_ref, at.clone());
            skip_events.push((skip.step.execution_index.get(), index));
            turn.last_readying_event = Some((index, at.clone()));
        }
        // A stopped run starts nothing new; the walk left the steps it canceled itself.
        let is_stopped = live.stop.is_some();
        let readied = ready
            .into_iter()
            .map(|ready| (ready, is_stopped, is_stopped))
            .chain(canceled.into_iter().map(|ready| (ready, true, false)));
        for (ready, is_canceled, is_walk_live) in readied {
            let event = ready
                .sources
                .iter()
                .flatten()
                .filter_map(|source| {
                    skip_events
                        .iter()
                        .find(|(skip, _)| *skip == source.execution_index.get())
                        .map(|&(_, index)| index)
                })
                .max()
                .unwrap_or(readying_event);
            let inputs = live
                .walk
                .ready_inputs(&ready.step, &ready.sources, &live.outputs);
            let stored = self.store_input(live, &ready.step, &inputs).await;
            let (input_ref, next) = match stored {
                Ok(input_ref) if is_canceled => (input_ref, ReadiedNext::Canceled),
                Ok(input_ref) => (input_ref, ReadiedNext::Dispatch),
                // As a skip's, a canceled step's input that cannot be stored is left empty.
                Err(_) if is_canceled => (
                    WorkflowPayloadRef::Inline { items: Vec::new() },
                    ReadiedNext::Canceled,
                ),
                Err(message) => {
                    let failure = step_failure(live, &ready.step, StepFailure::Failed, message);
                    (
                        WorkflowPayloadRef::Inline { items: Vec::new() },
                        ReadiedNext::Fail(failed_at_once(&ready.step, failure)),
                    )
                }
            };
            turn.commit.readied(&ready, input_ref.clone(), event);
            if is_canceled {
                // The walk cancels only a first-to-arrive merge's losers; a stopped run its own.
                let reason = if is_walk_live {
                    live.stop_cancellation_reason()
                } else {
                    WorkflowPhaseCancellationReason::MergeFirstToArrive
                };
                turn.commit.canceled_unrun(&ready.step, &at, reason);
                if is_walk_live {
                    live.leave_walk(&ready.step, &inputs, &input_ref);
                }
            }
            turn.readied.push(TurnReadied {
                ready,
                inputs,
                input_ref,
                next,
            });
        }
        // A stopped run's own wave already holds every running step, so its wins are not
        // followed.
        if is_stopped {
            return;
        }
        for win in wins {
            let losers = reports::sort_losers(live, turn, win.losers, &at, true).await;
            let mut branch_losers = Vec::with_capacity(losers.len());
            for RunSibling { step, state } in losers {
                match state {
                    SiblingState::Running(cancel) => branch_losers.push(BranchLoser {
                        step,
                        is_running: true,
                        cancel,
                    }),
                    SiblingState::Held(cancel) => branch_losers.push(BranchLoser {
                        step,
                        is_running: false,
                        cancel,
                    }),
                    SiblingState::Waiting => {
                        let merge = Some(WorkflowPhaseCancellationReason::MergeFirstToArrive);
                        reports::cancel_now(live, turn, step, &at, merge).await;
                    }
                }
            }
            let (cancelings, wave) = cancel_branches(
                win.deciding,
                WorkflowPhaseCancellationReason::MergeFirstToArrive,
                branch_losers,
            );
            turn.follow_ups.extend(cancelings);
            live.waves.extend(wave);
        }
    }

    /// The first main input of `skip` as the ref its row stores. A payload that cannot be stored
    /// is recorded on the skip as an empty input, and the skip passes its items on all the same.
    async fn store_skipped_input(&self, live: &LiveRun, skip: &WalkSkip) -> WorkflowPayloadRef {
        let inputs = live
            .walk
            .ready_inputs(&skip.step, &skip.sources, &live.outputs);
        self.store_input(live, &skip.step, &inputs)
            .await
            .unwrap_or(WorkflowPayloadRef::Inline { items: Vec::new() })
    }

    /// The first main input of `inputs`, the input lists of `step`, as the ref its row stores.
    /// Fails with the write's message when it cannot be stored, which is recorded on the step.
    async fn store_input(
        &self,
        live: &LiveRun,
        step: &WorkflowStepKey,
        inputs: &[Vec<WorkflowItem>],
    ) -> Result<WorkflowPayloadRef, String> {
        let spec = self.spec(
            live.scope
                .nodes
                .get(&step.node_id)
                .expect("a step's node is the run's"),
        );
        let first = main_inputs(spec, inputs)
            .next()
            .map_or(&[][..], Vec::as_slice);
        match write_step_payload(self.payloads.as_ref(), live.scope.session_id, step, first).await {
            Ok(input_ref) => Ok(input_ref),
            Err(error) => {
                live.record
                    .fault(Some(step), EngineFault::SettlementWriteFailed, &error)
                    .await;
                Err(error.to_string())
            }
        }
    }
}
