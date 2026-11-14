//! A walk seeded with steps an earlier run settled: each time the walk readies a place the seed
//! reuses, the place's next earlier step settles in its stead at once, with that step's output
//! lengths, and is answered as a skip that carries its data, so only the other places run. A run
//! moved to another version rebuilds its walk on the steps it keeps: each settles again under its
//! own key, writing nothing, its execution indices going on and each step it runs again keeping
//! its count of tries.

use std::collections::VecDeque;
use std::sync::Arc;

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{WorkflowStepKey, WorkflowStepSource};

use super::{ReusedStepRecord, RunGraph, RunWalk, WalkSkip, WalkSkipReason, WalkTurn};

/// One settled step of an earlier run that a seeded walk replays in place of running its node.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct ReusedSeedStep {
    /// The node whose step it stands in for, a node of the walk's graph.
    pub(crate) node_id: WorkflowNodeId,
    /// How many items each main output of the earlier step holds, in output order.
    pub(crate) output_lengths: Vec<usize>,
    /// The earlier step, as the reused skip records it.
    pub(crate) record: ReusedStepRecord,
}

/// A settled step of the walk's own run that a walk rebuilt on another version settles again
/// under its own key in place of running its node, answered as nothing new.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct KeptStep {
    /// The step, of a node of the walk's graph.
    pub(crate) step: WorkflowStepKey,
    /// How many items each main output of the step holds, in output order.
    pub(crate) output_lengths: Vec<usize>,
}

impl RunWalk {
    /// The walk of `run_id` over `graph` that readies no place outside `covered`, by place (`None`
    /// covers every place), feeds nothing from `sealed`, a node run's target's place, and replays
    /// `reused`: each node's steps in the order its earlier run executed them, the next one
    /// settling each time the walk readies that node.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn reusing(
        graph: Arc<RunGraph>,
        run_id: WorkflowRunId,
        covered: Option<Arc<[bool]>>,
        sealed: Option<usize>,
        reused: Vec<ReusedSeedStep>,
    ) -> Self {
        let mut walk = Self::new(graph, run_id);
        walk.covered = covered;
        walk.sealed = sealed;
        for step in reused {
            let place = walk.graph.place(&step.node_id);
            walk.reused.entry(place).or_default().push_back(step);
        }
        walk
    }

    /// The walk of this walk's run over `graph`, another version's, readying no place outside
    /// `covered`, by place, sealing a node run's target where `graph` holds it, and settling again
    /// each step of `kept`, in execution order, the next one each time the walk readies its node;
    /// its execution indices go on after this walk's, and each step of `again`, a step of this walk
    /// to run again whose node `graph` holds, in execution order, is carried: the next step the new
    /// walk readies to run at its node takes its next attempt.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn rebuilt(
        &self,
        graph: Arc<RunGraph>,
        covered: Arc<[bool]>,
        kept: Vec<KeptStep>,
        again: &[WorkflowStepKey],
    ) -> Self {
        // A node run's target stays sealed where the version holds it.
        let sealed = self
            .sealed
            .and_then(|place| graph.find_place(&self.graph.node(place).id));
        let mut walk = Self::reusing(graph, self.run_id, Some(covered), sealed, Vec::new());
        walk.next_execution_index = self.next_execution_index;
        for step in kept {
            let place = walk.graph.place(&step.step.node_id);
            walk.kept.entry(place).or_default().push_back(step);
        }
        for step in again {
            let place = walk.graph.place(&step.node_id);
            let attempt = SafeInt::new(step.attempt.get() + 1)
                .expect("a step's attempts are far below the largest safe integer");
            walk.carried_attempts
                .entry(place)
                .or_default()
                .push_back(attempt);
        }
        walk
    }

    /// The place's next kept step, where it keeps one, which `step`, just taken at `place` with
    /// the last execution index, gives way to: that index goes back, since no step takes it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn take_kept(&mut self, place: usize, step: &WorkflowStepKey) -> Option<KeptStep> {
        let kept = self.kept.get_mut(&place).and_then(VecDeque::pop_front)?;
        debug_assert_eq!(
            step.execution_index.get() + 1,
            self.next_execution_index,
            "a step gives way to a kept step just as it is taken"
        );
        self.next_execution_index = step.execution_index.get();
        Some(kept)
    }

    /// `step`, just readied at `place` to run, at the next attempt `place` carries, where it
    /// carries one, its live entry renumbered with it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn carry_attempt(&mut self, place: usize, step: WorkflowStepKey) -> WorkflowStepKey {
        let Some(attempt) = self
            .carried_attempts
            .get_mut(&place)
            .and_then(VecDeque::pop_front)
        else {
            return step;
        };
        let step = WorkflowStepKey { attempt, ..step };
        self.live
            .get_mut(&step.execution_index.get())
            .expect("a readied step is live")
            .step
            .attempt = attempt;
        step
    }

    /// Settles `step`, just readied at `place` on `run_index` from `sources`, as the place's next
    /// earlier step, answering it in `turn` as a reused skip ahead of what its outputs ready, and
    /// answers whether the place had one left.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn replay_reused(
        &mut self,
        place: usize,
        step: &WorkflowStepKey,
        run_index: u64,
        sources: &[Option<WorkflowStepSource>],
        turn: &mut WalkTurn,
    ) -> bool {
        let Some(reused) = self.reused.get_mut(&place).and_then(VecDeque::pop_front) else {
            return false;
        };
        turn.skipped.push(WalkSkip {
            step: step.clone(),
            run_index,
            reason: WalkSkipReason::Reused(reused.record),
            sources: sources.to_vec(),
            output_lengths: reused.output_lengths.clone(),
        });
        self.settle_into(step, &reused.output_lengths, turn);
        true
    }
}
