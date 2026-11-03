//! A first-to-arrive node's win: the step it readies on its first main input to settle with items,
//! and the live steps on the branches that feed only its other inputs, which lose.

use std::collections::BTreeMap;

use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use super::LiveStep;
use super::graph::RunGraph;

/// A first-to-arrive node took its first main input with items: the step that readied, and the
/// live steps on its losing branches, which are to be canceled.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct FirstToArriveWin {
    /// The node's step the win readied.
    pub(crate) deciding: WorkflowStepKey,
    /// The live steps on the losing branches, by execution index.
    pub(crate) losers: Vec<WorkflowStepKey>,
}

/// The `live` steps that lose when the node at `place` takes `winning_slot`: those whose node is an
/// ancestor of the node's other slots and feeds nothing but those slots and other such nodes. The
/// trigger, the node itself and every ancestor of the winning slot never lose.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) fn losers(
    graph: &RunGraph,
    place: usize,
    winning_slot: usize,
    live: &BTreeMap<u64, LiveStep>,
) -> Vec<WorkflowStepKey> {
    let node_count = graph.node_count();
    let slots = &graph.node(place).slots;
    let mut feeds_winner = vec![false; node_count];
    mark_ancestors(
        graph,
        slots[winning_slot].feeders.iter().copied(),
        |_| true,
        &mut feeds_winner,
    );
    let trigger = graph.trigger();
    let mut is_losing = vec![false; node_count];
    mark_ancestors(
        graph,
        slots
            .iter()
            .enumerate()
            .filter(|&(slot, _)| slot != winning_slot)
            .flat_map(|(_, slot)| slot.feeders.iter().copied()),
        |ancestor| !feeds_winner[ancestor] && ancestor != place && ancestor != trigger,
        &mut is_losing,
    );
    let mut dropping: Vec<usize> = (0..node_count)
        .filter(|&ancestor| is_losing[ancestor])
        .filter(|&ancestor| {
            graph.node(ancestor).outputs.iter().flatten().any(|target| {
                let is_losing_slot = target.node == place && target.slot != winning_slot;
                !is_losing[target.node] && !is_losing_slot
            })
        })
        .collect();
    while let Some(ancestor) = dropping.pop() {
        if !is_losing[ancestor] {
            continue;
        }
        is_losing[ancestor] = false;
        dropping.extend(graph.feeders(ancestor).filter(|&feeder| is_losing[feeder]));
    }
    live.values()
        .filter(|live_step| is_losing[live_step.place])
        .map(|live_step| live_step.step.clone())
        .collect()
}

/// Marks in `marked` every node reached from `starts` by walking back along main edges, entering
/// only the nodes `may_enter` accepts.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn mark_ancestors(
    graph: &RunGraph,
    starts: impl Iterator<Item = usize>,
    may_enter: impl Fn(usize) -> bool,
    marked: &mut [bool],
) {
    let mut pending = Vec::new();
    for start in starts {
        if !marked[start] && may_enter(start) {
            marked[start] = true;
            pending.push(start);
        }
    }
    while let Some(node) = pending.pop() {
        for feeder in graph.feeders(node) {
            if !marked[feeder] && may_enter(feeder) {
                marked[feeder] = true;
                pending.push(feeder);
            }
        }
    }
}
