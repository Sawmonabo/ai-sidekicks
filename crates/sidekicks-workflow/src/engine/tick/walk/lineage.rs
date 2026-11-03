//! What a step or round descends from: the first-to-arrive wins that overtook it and the pass of
//! each loop it belongs to, so a win reaches only the steps and rounds of its own pass.

use std::collections::{BTreeMap, BTreeSet};

/// The pass of each loop a step or round belongs to, by the loop node's place: that node's run
/// index on the pass. A loop it does not belong to leaves no entry.
#[derive(Clone, Default)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) struct LoopPasses(BTreeMap<usize, u64>);

impl LoopPasses {
    /// Whether the two are on the same pass of every loop both belong to.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn is_same_as(&self, other: &Self) -> bool {
        self.0.iter().all(|(loop_place, run_index)| {
            other
                .0
                .get(loop_place)
                .is_none_or(|other_run_index| other_run_index == run_index)
        })
    }

    /// Starts the pass of the loop node at `loop_place` under its `run_index`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn enter(&mut self, loop_place: usize, run_index: u64) {
        self.0.insert(loop_place, run_index);
    }

    /// Leaves the loop of the loop node at `loop_place`, as that node's own step does.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn leave(&mut self, loop_place: usize) {
        self.0.remove(&loop_place);
    }
}

/// What a step or round descends from.
#[derive(Clone, Default)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) struct StepLineage {
    /// The wins, by index, that overtook it or a step it descends from.
    pub(super) overtaken_by: BTreeSet<usize>,
    /// The pass of each loop it belongs to.
    pub(super) passes: LoopPasses,
}

impl StepLineage {
    /// Takes in the wins and passes of `other`, a feed of the same pass of each loop.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn join(&mut self, other: &Self) {
        self.overtaken_by.extend(other.overtaken_by.iter().copied());
        self.passes.0.extend(other.passes.0.iter());
    }
}
