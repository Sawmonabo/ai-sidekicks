//! A first-to-arrive node's win: the step it readies on its first main input to settle with items,
//! and the branches that feed only its other inputs, which lose.

use std::collections::BTreeSet;
use std::sync::Arc;

use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use super::graph::RunGraph;
use super::round::{Round, RoundSlot};
use super::{RunWalk, WalkTurn};

/// A first-to-arrive node took its first main input with items: the step that readied, and the
/// live steps on its losing branches, which are to be canceled.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct FirstToArriveWin {
    /// The node's step the win readied.
    pub(crate) deciding: WorkflowStepKey,
    /// The live steps on the losing branches, by execution index.
    pub(crate) losers: Vec<WorkflowStepKey>,
}

/// A first-to-arrive win the walk decided: the node that won and which places lost.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) struct DecidedWin {
    /// The won node's place.
    pub(super) place: usize,
    /// Whether each place, by place, is on a losing branch of the win.
    pub(super) is_losing: Arc<[bool]>,
}

/// Which places lose when the node at `place` takes `winning_slot`, by place: the ancestors of the
/// node's other slots that feed nothing but those slots and other such nodes. Ancestors are
/// followed along forward edges only, so inside a loop the pass that comes back round never counts
/// the losing branch as feeding the winner. The trigger, the node itself and every ancestor of the
/// winning slot never lose.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn losing_places(graph: &RunGraph, place: usize, winning_slot: usize) -> Vec<bool> {
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
        dropping.extend(
            graph
                .forward_feeders(ancestor)
                .iter()
                .copied()
                .filter(|&feeder| is_losing[feeder]),
        );
    }
    is_losing
}

/// Marks in `marked` every node reached from `starts` by walking back along forward main edges,
/// entering only the nodes `may_enter` accepts.
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
        for &feeder in graph.forward_feeders(node) {
            if !marked[feeder] && may_enter(feeder) {
                marked[feeder] = true;
                pending.push(feeder);
            }
        }
    }
}

impl RunWalk {
    /// Decides the win of the first-to-arrive node at `place` on its round under `run_index`,
    /// readied on `winning_slot`, its lowest slot with items, as `decide_round` describes it: the
    /// win overtakes what it reaches, cancels its losers readied earlier in this turn, and readies
    /// the node's step on that slot alone.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn decide_win(
        &mut self,
        place: usize,
        run_index: u64,
        winning_slot: usize,
        turn: &mut WalkTurn,
    ) {
        let round = &self.rounds[place].open[&run_index];
        let sources = round
            .sources()
            .into_iter()
            .enumerate()
            .map(|(slot, source)| source.filter(|_| slot == winning_slot))
            .collect();
        let lineage = round.lineage.clone();
        let is_losing = self.losing_places_of(place, winning_slot);
        let is_reached = self.reached_places_of(place, winning_slot);
        let win = self.wins.len();
        self.wins.push(DecidedWin {
            place,
            is_losing: Arc::clone(&is_losing),
        });
        let passes = &lineage.passes;
        let mut losers: Vec<WorkflowStepKey> = self
            .live
            .values()
            .filter(|live_step| {
                is_losing[live_step.place] && passes.is_same_as(&live_step.lineage.passes)
            })
            .map(|live_step| live_step.step.clone())
            .collect();
        losers.retain(|loser| {
            let Some(position) = turn.ready.iter().position(|ready| ready.step == *loser) else {
                return true;
            };
            self.live.remove(&loser.execution_index.get());
            turn.canceled.push(turn.ready.remove(position));
            false
        });
        for live_step in self.live.values_mut() {
            if is_reached[live_step.place] && passes.is_same_as(&live_step.lineage.passes) {
                live_step.lineage.overtaken_by.insert(win);
            }
        }
        for (other_place, rounds) in self.rounds.iter_mut().enumerate() {
            for (&other_run_index, round) in &mut rounds.open {
                if (other_place, other_run_index) != (place, run_index)
                    && is_reached[other_place]
                    && passes.is_same_as(&round.lineage.passes)
                {
                    round.lineage.overtaken_by.insert(win);
                }
            }
        }
        let round = self.rounds[place]
            .open
            .get_mut(&run_index)
            .expect("the round being decided is open");
        round.won = Some(win);
        if self.is_spent(place, &self.rounds[place].open[&run_index]) {
            self.take_round(place, run_index);
        }
        let step = self.take_step(place);
        turn.wins.push(FirstToArriveWin {
            deciding: step.clone(),
            losers,
        });
        self.ready(place, step, run_index, sources, lineage, turn);
    }

    /// Whether the `round` of the node at `place`, which a win won or overtook, can take no more
    /// feeds: every slot not yet fed is fed only from places on a losing branch of such a win,
    /// whose steps of the round's pass that win cancels. A slot settled empty counts as not yet
    /// fed while a feeder of it has a live step on the round's pass, whose items it still takes.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn is_spent(&self, place: usize, round: &Round) -> bool {
        let wins = round.won.iter().chain(&round.lineage.overtaken_by);
        round
            .slots
            .iter()
            .zip(&self.graph.node(place).slots)
            .all(|(slot, input)| {
                let is_fed = match slot {
                    RoundSlot::Unfilled => false,
                    RoundSlot::Filled { count, .. } => {
                        *count > 0
                            || !self.live.values().any(|live_step| {
                                input.feeders.contains(&live_step.place)
                                    && round.lineage.passes.is_same_as(&live_step.lineage.passes)
                            })
                    }
                };
                is_fed
                    || input
                        .feeders
                        .iter()
                        .all(|&feeder| wins.clone().any(|&win| self.wins[win].is_losing[feeder]))
            })
    }

    /// Whether the node at `place` is on a losing branch of one of the wins `overtaken_by`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn is_overtaken_loser(&self, place: usize, overtaken_by: &BTreeSet<usize>) -> bool {
        overtaken_by
            .iter()
            .any(|&win| self.wins[win].is_losing[place])
    }

    /// Which places, by place, a win of the node at `place` on `winning_slot` reaches: the node,
    /// every losing place, and every place that leads into the node without passing a loop node
    /// whose body holds it, through whose steps the late feeds into the node run. A place that
    /// leads into the node only through such a loop node is not reached, since its feeds into that
    /// loop node start the loop's next pass rather than straggle on this one; a loop node before
    /// the node that does not hold it is reached like any other place.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn reached_places_of(&mut self, place: usize, winning_slot: usize) -> Arc<[bool]> {
        let is_losing = self.losing_places_of(place, winning_slot);
        let graph = &self.graph;
        Arc::clone(
            self.reached_places
                .entry((place, winning_slot))
                .or_insert_with(|| {
                    let mut is_reached = vec![false; is_losing.len()];
                    is_reached[place] = true;
                    mark_ancestors(
                        graph,
                        graph.forward_feeders(place).iter().copied(),
                        |ancestor| !graph.is_in_loop_body(place, ancestor),
                        &mut is_reached,
                    );
                    // Losing places join after the walk, so it passes through them to the places
                    // that lead into the node only through a losing one.
                    for (reached, &losing) in is_reached.iter_mut().zip(is_losing.iter()) {
                        *reached |= losing;
                    }
                    is_reached.into()
                }),
        )
    }

    /// Which places lose when the node at `place` wins on `winning_slot`, by place.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn losing_places_of(&mut self, place: usize, winning_slot: usize) -> Arc<[bool]> {
        let graph = &self.graph;
        Arc::clone(
            self.losing_places
                .entry((place, winning_slot))
                .or_insert_with(|| losing_places(graph, place, winning_slot).into()),
        )
    }

    /// Closes the open rounds at the places in the body of the loop node at `loop_place` that a win
    /// at such a place won or overtook and that nothing can fill any more: every slot still unfed
    /// waits only on such a win's losers. A round still waiting on a live step of its own pass
    /// stays open, and the pass check keeps the new pass's feeds out of it. A won round closes
    /// silently; any other is decided as the flush decides it, so a loser's is canceled.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn close_passed_rounds(&mut self, loop_place: usize, turn: &mut WalkTurn) {
        let walk = &*self;
        let graph = &walk.graph;
        let is_passed = |win: usize| graph.is_in_loop_body(walk.wins[win].place, loop_place);
        let passed: Vec<(usize, u64)> = (0..graph.node_count())
            .filter(|&place| graph.is_in_loop_body(place, loop_place))
            .flat_map(|place| {
                walk.rounds[place]
                    .open
                    .iter()
                    .filter(move |(_, round)| {
                        round
                            .won
                            .into_iter()
                            .chain(round.lineage.overtaken_by.iter().copied())
                            .any(is_passed)
                            && walk.is_spent(place, round)
                    })
                    .map(move |(&run_index, _)| (place, run_index))
            })
            .collect();
        for (place, run_index) in passed {
            let mut round = self.take_round(place, run_index);
            if !round.is_won() {
                round.settle_unfilled();
                self.decide_flushed(place, run_index, &round, turn);
            }
        }
    }
}
