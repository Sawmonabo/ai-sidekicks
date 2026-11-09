//! A walk seeded with steps an earlier run settled: each time the walk readies a place the seed
//! reuses, the place's next earlier step settles in its stead at once, with that step's output
//! lengths, and is answered as a skip that carries its data, so only the other places run.

use std::collections::VecDeque;
use std::sync::Arc;

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

impl RunWalk {
    /// The walk of `run_id` over `graph` that readies no place outside `covered`, by place (`None`
    /// covers every place), and replays `reused`: each node's steps in the order its earlier run
    /// executed them, the next one settling each time the walk readies that node.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn reusing(
        graph: Arc<RunGraph>,
        run_id: WorkflowRunId,
        covered: Option<Arc<[bool]>>,
        reused: Vec<ReusedSeedStep>,
    ) -> Self {
        let mut walk = Self::new(graph, run_id);
        walk.covered = covered;
        for step in reused {
            let place = walk.graph.place(&step.node_id);
            walk.reused.entry(place).or_default().push_back(step);
        }
        walk
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
