//! The run's walk: which steps the settles it is handed ready or skip, as a pure function of those
//! settles in log order. Each settle feeds its outputs into the input slots of the nodes they
//! enter, a node's slots fill in rounds by run index, and a full round with items is decided; a
//! first-to-arrive node's round is decided by its first input with items. Every step and round
//! still pending when such a win is decided is overtaken by it, and so is all it leads to, in that
//! turn or a later one: at a losing place of the win it is canceled, and into the won node it
//! feeds only the won round. Once the run is quiet, the flush decides what still waits, a node only
//! once none of its ancestors waits.

mod first_to_arrive;
mod graph;
mod round;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::events::WorkflowStepSkipReason;
use sidekicks_contracts::workflow::run::step::record::{WorkflowStepKey, WorkflowStepSource};

use self::first_to_arrive::FirstToArriveWin;
pub(crate) use self::graph::RunGraph;
use self::graph::SlotTarget;
use self::round::{NodeRounds, Round, RoundSlot, SlotOpenings};
use crate::expressions::lineage::{StepKey, StepOutputs};

/// What one walk turn answers: the steps it readied, the steps it skipped, the first-to-arrive
/// wins it decided and the steps on a losing branch of a win of the turn that it canceled, each in
/// the order it handed out their execution indices.
#[derive(Default)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct WalkTurn {
    /// The steps readied to run.
    pub(crate) ready: Vec<WalkReady>,
    /// The steps skipped without running.
    pub(crate) skipped: Vec<WalkSkip>,
    /// The first-to-arrive wins, whose losers are to be canceled.
    pub(crate) wins: Vec<FirstToArriveWin>,
    /// The steps of this turn on a losing branch of a win they were overtaken by, readied earlier
    /// in the win's turn or decided after it: never dispatched, they settle canceled.
    pub(crate) canceled: Vec<WalkReady>,
}

/// A step the walk readied.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct WalkReady {
    /// The step at its own execution index: attempt 1, or a retry's next attempt.
    pub(crate) step: WorkflowStepKey,
    /// The node's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// The feed of each main input slot in slot order, `None` for a slot nothing fed.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
}

/// A step the walk skipped, settled as it is skipped.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct WalkSkip {
    /// The step: attempt 1 at its own execution index.
    pub(crate) step: WorkflowStepKey,
    /// The node's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// Why it was skipped.
    pub(crate) reason: WorkflowStepSkipReason,
    /// The feed of each main input slot in slot order, `None` for a slot nothing fed.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
    /// How many items each main output carries on, in output order.
    pub(crate) output_lengths: Vec<usize>,
}

/// A first-to-arrive win the walk decided: the node that won and which places lost.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
struct DecidedWin {
    /// The won node's place.
    place: usize,
    /// Whether each place, by place, is on a losing branch of the win.
    is_losing: Arc<[bool]>,
}

/// A step the walk readied and that has not settled.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
struct LiveStep {
    /// The step.
    step: WorkflowStepKey,
    /// Its node's place in the graph.
    place: usize,
    /// The node's run index.
    run_index: u64,
    /// The feed of each main input slot in slot order, which a retry runs on again.
    sources: Vec<Option<WorkflowStepSource>>,
    /// The wins, by index, decided while this step or a step it descends from was pending.
    overtaken_by: BTreeSet<usize>,
}

/// The walk of one run over its graph: the steps live, each node's open rounds, the feeds its
/// disabled skips passed on, the first-to-arrive wins decided, and the next execution index.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunWalk {
    /// The run's graph.
    graph: Arc<RunGraph>,
    /// The run whose steps the walk keys.
    run_id: WorkflowRunId,
    /// The execution index the next step takes.
    next_execution_index: u64,
    /// The steps readied and not yet settled, by execution index.
    live: BTreeMap<u64, LiveStep>,
    /// Each node's rounds, by its place in the graph.
    rounds: Vec<NodeRounds>,
    /// Each disabled skip that passed items on, by execution index: the feed of its first slot,
    /// which its first output carries on, since a skip records no outputs of its own.
    passed_on: BTreeMap<u64, Option<WorkflowStepSource>>,
    /// Every first-to-arrive win decided, by index, which the steps and rounds it overtook name.
    wins: Vec<DecidedWin>,
    /// The losing places of a win of the node at a place on a slot, by `(place, slot)`, worked out
    /// once each, so wins of one node share them.
    losing_places: BTreeMap<(usize, usize), Arc<[bool]>>,
}

impl RunWalk {
    /// The walk of `run_id` over `graph`, before any step.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn new(graph: Arc<RunGraph>, run_id: WorkflowRunId) -> Self {
        let rounds = (0..graph.node_count())
            .map(|place| NodeRounds {
                openings: graph
                    .node(place)
                    .slots
                    .iter()
                    .map(|_| SlotOpenings::default())
                    .collect(),
                ..NodeRounds::default()
            })
            .collect();
        Self {
            graph,
            run_id,
            next_execution_index: 0,
            live: BTreeMap::new(),
            rounds,
            passed_on: BTreeMap::new(),
            wins: Vec::new(),
            losing_places: BTreeMap::new(),
        }
    }

    /// Readies the trigger at execution index 0 and run index 0, with no sources.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn start(&mut self) -> WalkTurn {
        let trigger = self.graph.trigger();
        self.rounds[trigger].next_run_index = 1;
        let step = self.take_step(trigger);
        let mut turn = WalkTurn::default();
        self.ready(trigger, step, 0, Vec::new(), BTreeSet::new(), &mut turn);
        turn
    }

    /// Settles `step` with `output_lengths` items on each main output in output order, and
    /// answers the steps that readies or skips. An output past the end of `output_lengths` reads
    /// as empty, as a completed step's unused error output does; an empty output still settles
    /// the slots it feeds.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn settle(&mut self, step: &WorkflowStepKey, output_lengths: &[usize]) -> WalkTurn {
        let execution_index = step.execution_index;
        let settled = self
            .live
            .remove(&execution_index.get())
            .expect("a settle names a step the walk readied and has not settled");
        let mut turn = WalkTurn::default();
        let fed = self.feed(
            settled.place,
            execution_index,
            output_lengths,
            &settled.overtaken_by,
        );
        self.visit(fed, &mut turn);
        turn
    }

    /// Readies the next attempt of the live `step` under the next execution index, with the same
    /// run index and sources, in its place among the live steps. A failed step's retry and a
    /// Resume both take it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn retry(&mut self, step: &WorkflowStepKey) -> WalkReady {
        let live_step = self
            .live
            .remove(&step.execution_index.get())
            .expect("a retry names a step the walk readied and has not settled");
        let next_step = WorkflowStepKey {
            attempt: SafeInt::new(live_step.step.attempt.get() + 1)
                .expect("a step's attempts are far below the largest safe integer"),
            execution_index: self.take_execution_index(),
            ..live_step.step
        };
        let ready = WalkReady {
            step: next_step.clone(),
            run_index: live_step.run_index,
            sources: live_step.sources.clone(),
        };
        self.live.insert(
            next_step.execution_index.get(),
            LiveStep {
                step: next_step,
                ..live_step
            },
        );
        ready
    }

    /// Removes the live `step`, canceled or ended with no outputs, so it feeds nothing.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn drop_step(&mut self, step: &WorkflowStepKey) {
        self.live
            .remove(&step.execution_index.get())
            .expect("a dropped step is one the walk readied and has not settled");
    }

    /// Decides what waits once no step is live: each open round not won, its unfilled slots read
    /// as settled empty with no source, one at a time, lowest run index first, of the node first
    /// by `(order, id)` among those none of whose ancestors along forward edges still has a round
    /// waiting, so a feed still to come from an ancestor is never cut off. A round with items is
    /// readied, or skipped on a disabled node, which passes its first input on; a round without is
    /// skipped, feeding nothing. The flush ends at the first step it readies, since that step's
    /// outputs may still feed what waits after it; a flush that readies nothing also drops the won
    /// rounds still open. Answers nothing while a step is live.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn flush(&mut self) -> WalkTurn {
        let mut turn = WalkTurn::default();
        if !self.live.is_empty() {
            return turn;
        }
        while let Some((place, run_index)) = self.next_flushed_round() {
            let mut round = self.take_round(place, run_index);
            for slot in &mut round.slots {
                if matches!(slot, RoundSlot::Unfilled) {
                    *slot = RoundSlot::Filled {
                        source: None,
                        count: 0,
                    };
                }
            }
            self.decide_flushed(place, run_index, &round, &mut turn);
            if !turn.ready.is_empty() {
                return turn;
            }
        }
        for place in 0..self.graph.node_count() {
            let won: Vec<u64> = self.rounds[place].open.keys().copied().collect();
            for run_index in won {
                self.take_round(place, run_index);
            }
        }
        turn
    }

    /// The round the flush decides next: of the first node by `(order, id)` that has a round no
    /// win took while none of its ancestors does, that node's lowest such run index. A graph's
    /// forward edges hold no loop, so while any node waits, one of them has no waiting ancestor.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn next_flushed_round(&self) -> Option<(usize, u64)> {
        (0..self.graph.node_count())
            .filter_map(|place| Some((place, self.first_waiting_round(place)?)))
            .find(|&(place, _)| {
                self.graph
                    .ancestors(place)
                    .all(|ancestor| self.first_waiting_round(ancestor).is_none())
            })
    }

    /// The lowest run index of the node at `place`'s open rounds that no win took.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn first_waiting_round(&self, place: usize) -> Option<u64> {
        self.rounds[place]
            .open
            .iter()
            .find(|(_, round)| !round.is_won())
            .map(|(&run_index, _)| run_index)
    }

    /// Decides a `round` the flush took, every slot filled: run as a full round when it holds
    /// items, else skipped with all outputs empty, `disabled` on a disabled node and `noItems`
    /// on any other.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn decide_flushed(&mut self, place: usize, run_index: u64, round: &Round, turn: &mut WalkTurn) {
        if round.first_slot_with_items().is_some() {
            self.run_round(place, run_index, round, turn);
            return;
        }
        let graph = Arc::clone(&self.graph);
        let node = graph.node(place);
        let step = self.take_step(place);
        turn.skipped.push(WalkSkip {
            step,
            run_index,
            reason: if node.is_disabled {
                WorkflowStepSkipReason::Disabled
            } else {
                WorkflowStepSkipReason::NoItems
            },
            sources: round.sources(),
            output_lengths: vec![0; node.outputs.len()],
        });
    }

    /// Applies every feed of the step of `place` at `execution_index`, overtaken by the wins
    /// `overtaken_by`: its outputs in order, each output's slots in the graph's order. Answers the
    /// rounds the feeds entered, in visiting order.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn feed(
        &mut self,
        place: usize,
        execution_index: SafeInt<0>,
        output_lengths: &[usize],
        overtaken_by: &BTreeSet<usize>,
    ) -> BTreeSet<(usize, u64)> {
        let graph = Arc::clone(&self.graph);
        let node = graph.node(place);
        let mut fed = BTreeSet::new();
        for (output_index, targets) in node.outputs.iter().enumerate() {
            let count = output_lengths.get(output_index).copied().unwrap_or(0);
            let source = WorkflowStepSource {
                node_id: node.id.clone(),
                output_index: SafeInt::from_usize(output_index),
                execution_index,
            };
            for &target in targets {
                if let Some(run_index) = self.fill(target, &source, count, overtaken_by) {
                    fed.insert((target.node, run_index));
                }
            }
        }
        fed
    }

    /// Puts one feed of `count` items from `source`, overtaken by the wins `overtaken_by`, into
    /// `target`'s slot and answers the run index of the round it entered, or `None` for a feed
    /// dropped: an empty one while the node has an open round, one a win of the node overtook
    /// that no round of that win takes, or one into a loop node that precedes the node of a win
    /// that overtook it, so a step that win overtook never starts the loop's next pass. Items
    /// enter the lowest open round admitting the feed whose slot is unfilled or settled empty; an
    /// empty feed the lowest admitting one whose slot is unfilled; with no such round the feed
    /// opens one. A won round admits only the feeds its win overtook, so the winner never runs
    /// again on its own pass.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn fill(
        &mut self,
        target: SlotTarget,
        source: &WorkflowStepSource,
        count: usize,
        overtaken_by: &BTreeSet<usize>,
    ) -> Option<u64> {
        let graph = &self.graph;
        if graph.node(target.node).is_loop
            && overtaken_by
                .iter()
                .any(|&win| graph.is_ancestor(target.node, self.wins[win].place))
        {
            return None;
        }
        let is_claimed = overtaken_by
            .iter()
            .any(|&win| self.wins[win].place == target.node);
        let rounds = &mut self.rounds[target.node];
        let openings = &rounds.openings[target.slot];
        let open = &rounds.open;
        let first_admitting = |run_indices: &BTreeSet<u64>| {
            run_indices.iter().copied().find(|run_index| {
                open.get(run_index)
                    .is_some_and(|round| round.admits(overtaken_by, is_claimed))
            })
        };
        let fitting = if count > 0 {
            match (
                first_admitting(&openings.unfilled),
                first_admitting(&openings.empty),
            ) {
                (Some(unfilled), Some(empty)) => Some(unfilled.min(empty)),
                (fitting, None) | (None, fitting) => fitting,
            }
        } else {
            first_admitting(&openings.unfilled)
        };
        let run_index = match fitting {
            Some(run_index) => run_index,
            None if is_claimed || (count == 0 && !rounds.open.is_empty()) => return None,
            None => self.open_round(target.node),
        };
        let rounds = &mut self.rounds[target.node];
        let openings = &mut rounds.openings[target.slot];
        openings.unfilled.remove(&run_index);
        openings.empty.remove(&run_index);
        if count == 0 {
            openings.empty.insert(run_index);
        }
        let round = rounds
            .open
            .get_mut(&run_index)
            .expect("a slot opening names an open round");
        round.slots[target.slot] = RoundSlot::Filled {
            source: Some(source.clone()),
            count,
        };
        round.overtaken_by.extend(overtaken_by.iter().copied());
        Some(run_index)
    }

    /// Opens a round of the node at `place` under its next run index, its unwired slots settled
    /// empty, and answers that run index.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn open_round(&mut self, place: usize) -> u64 {
        let node = self.graph.node(place);
        let rounds = &mut self.rounds[place];
        let run_index = rounds.next_run_index;
        rounds.next_run_index += 1;
        let mut slots = Vec::with_capacity(node.slots.len());
        for (slot, openings) in node.slots.iter().zip(&mut rounds.openings) {
            if slot.feeders.is_empty() {
                slots.push(RoundSlot::Filled {
                    source: None,
                    count: 0,
                });
            } else {
                openings.unfilled.insert(run_index);
                slots.push(RoundSlot::Unfilled);
            }
        }
        rounds.open.insert(
            run_index,
            Round {
                slots,
                won: None,
                overtaken_by: BTreeSet::new(),
            },
        );
        run_index
    }

    /// Decides the `fed` rounds in visiting order: by the node's `(order, id)`, then lowest run
    /// index first.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn visit(&mut self, fed: BTreeSet<(usize, u64)>, turn: &mut WalkTurn) {
        for (place, run_index) in fed {
            self.decide_round(place, run_index, turn);
        }
    }

    /// Decides the round of the node at `place` under `run_index`. A first-to-arrive node's round
    /// readies on its lowest slot with items, the other slots read as fed nothing, and stays open
    /// for the late feeds its win overtook until no slot can still be fed. The win overtakes every live
    /// step and every other open round; a loser readied earlier in this turn is taken back from
    /// its ready steps and canceled undispatched, and one the win overtook decided later, in this
    /// turn or another, is canceled. Any other node's round is run once every slot is filled and
    /// one holds items. A round decided already, or whose filled slots are all empty, is left as
    /// it is.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn decide_round(&mut self, place: usize, run_index: u64, turn: &mut WalkTurn) {
        let graph = Arc::clone(&self.graph);
        let node = graph.node(place);
        let Some(round) = self.rounds[place].open.get(&run_index) else {
            return;
        };
        if !node.readies_on_first_input {
            if round.is_full_with_items() {
                let round = self.take_round(place, run_index);
                self.run_round(place, run_index, &round, turn);
            }
            return;
        }
        if round.is_won() {
            if self.is_spent(place, round) {
                self.take_round(place, run_index);
            }
            return;
        }
        let Some(winning_slot) = round.first_slot_with_items() else {
            return;
        };
        if self.is_overtaken_loser(place, &round.overtaken_by) {
            let round = self.take_round(place, run_index);
            self.cancel_round(place, run_index, &round, turn);
            return;
        }
        let sources = round
            .sources()
            .into_iter()
            .enumerate()
            .map(|(slot, source)| source.filter(|_| slot == winning_slot))
            .collect();
        let overtaken_by = round.overtaken_by.clone();
        let is_losing = self.losing_places_of(place, winning_slot);
        let win = self.wins.len();
        self.wins.push(DecidedWin {
            place,
            is_losing: Arc::clone(&is_losing),
        });
        let mut losers: Vec<WorkflowStepKey> = self
            .live
            .values()
            .filter(|live_step| is_losing[live_step.place])
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
            live_step.overtaken_by.insert(win);
        }
        for (other_place, rounds) in self.rounds.iter_mut().enumerate() {
            for (&other_run_index, round) in &mut rounds.open {
                if (other_place, other_run_index) != (place, run_index) {
                    round.overtaken_by.insert(win);
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
        self.ready(place, step, run_index, sources, overtaken_by, turn);
    }

    /// Whether the won `round` of the node at `place` can take no more feeds: every slot not yet
    /// fed is fed only from places on a losing branch of its win, whose steps the win cancels.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn is_spent(&self, place: usize, round: &Round) -> bool {
        let Some(win) = round.won else {
            return false;
        };
        let is_losing = &self.wins[win].is_losing;
        round
            .slots
            .iter()
            .zip(&self.graph.node(place).slots)
            .all(|(slot, input)| {
                matches!(slot, RoundSlot::Filled { .. })
                    || input.feeders.iter().all(|&feeder| is_losing[feeder])
            })
    }

    /// Whether the node at `place` is on a losing branch of one of the wins `overtaken_by`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn is_overtaken_loser(&self, place: usize, overtaken_by: &BTreeSet<usize>) -> bool {
        overtaken_by
            .iter()
            .any(|&win| self.wins[win].is_losing[place])
    }

    /// Which places lose when the node at `place` wins on `winning_slot`, by place.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn losing_places_of(&mut self, place: usize, winning_slot: usize) -> Arc<[bool]> {
        let graph = &self.graph;
        Arc::clone(
            self.losing_places
                .entry((place, winning_slot))
                .or_insert_with(|| {
                    first_to_arrive::losing_places(graph, place, winning_slot).into()
                }),
        )
    }

    /// Runs a decided `round` of the node at `place`: one on a losing branch of a win it was
    /// overtaken by is canceled; a disabled node is skipped, passing its first slot on as its
    /// first output and feeding onward depth first when that carries items; any other is readied.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn run_round(&mut self, place: usize, run_index: u64, round: &Round, turn: &mut WalkTurn) {
        if self.is_overtaken_loser(place, &round.overtaken_by) {
            self.cancel_round(place, run_index, round, turn);
            return;
        }
        let step = self.take_step(place);
        let sources = round.sources();
        let graph = Arc::clone(&self.graph);
        let node = graph.node(place);
        if !node.is_disabled {
            let overtaken_by = round.overtaken_by.clone();
            self.ready(place, step, run_index, sources, overtaken_by, turn);
            return;
        }
        let mut output_lengths = vec![0; node.outputs.len()];
        if let (Some(first_output), Some(RoundSlot::Filled { count, .. })) =
            (output_lengths.first_mut(), round.slots.first())
        {
            *first_output = *count;
        }
        let execution_index = step.execution_index;
        let carries_items = output_lengths.iter().any(|&count| count > 0);
        if carries_items {
            let first_source = sources.first().cloned().flatten();
            self.passed_on.insert(execution_index.get(), first_source);
        }
        turn.skipped.push(WalkSkip {
            step,
            run_index,
            reason: WorkflowStepSkipReason::Disabled,
            sources,
            output_lengths: output_lengths.clone(),
        });
        if carries_items {
            let fed = self.feed(place, execution_index, &output_lengths, &round.overtaken_by);
            self.visit(fed, turn);
        }
    }

    /// Cancels a decided `round` of the node at `place` undispatched: its step takes its execution
    /// index and settles canceled, feeding nothing.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn cancel_round(&mut self, place: usize, run_index: u64, round: &Round, turn: &mut WalkTurn) {
        let step = self.take_step(place);
        turn.canceled.push(WalkReady {
            step,
            run_index,
            sources: round.sources(),
        });
    }

    /// Removes the open round of the node at `place` under `run_index` and every slot opening that
    /// names it, and answers it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn take_round(&mut self, place: usize, run_index: u64) -> Round {
        let rounds = &mut self.rounds[place];
        for openings in &mut rounds.openings {
            openings.unfilled.remove(&run_index);
            openings.empty.remove(&run_index);
        }
        rounds
            .open
            .remove(&run_index)
            .expect("a round taken is open")
    }

    /// Readies `step` of the node at `place`, overtaken by the wins `overtaken_by`, making it
    /// live. A loop node's step starts a new pass of what it leads to, so it drops the wins of the
    /// nodes it precedes that its round was pending at, whose rounds of that pass are new, and
    /// closes the rounds the earlier passes' wins left open.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn ready(
        &mut self,
        place: usize,
        step: WorkflowStepKey,
        run_index: u64,
        sources: Vec<Option<WorkflowStepSource>>,
        mut overtaken_by: BTreeSet<usize>,
        turn: &mut WalkTurn,
    ) {
        if self.graph.node(place).is_loop {
            overtaken_by.retain(|&win| !self.graph.is_ancestor(place, self.wins[win].place));
            self.close_passed_rounds(place);
        }
        self.live.insert(
            step.execution_index.get(),
            LiveStep {
                step: step.clone(),
                place,
                run_index,
                sources: sources.clone(),
                overtaken_by,
            },
        );
        turn.ready.push(WalkReady {
            step,
            run_index,
            sources,
        });
    }

    /// Closes the open rounds at the places the loop node at `loop_place` precedes that a win at
    /// such a place won or overtook: they belong to an earlier pass, so none takes the new pass's
    /// feeds and no won round outlives its pass.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn close_passed_rounds(&mut self, loop_place: usize) {
        let graph = &self.graph;
        let is_passed = |win: usize| graph.is_ancestor(loop_place, self.wins[win].place);
        let passed: Vec<(usize, u64)> = (0..graph.node_count())
            .filter(|&place| graph.is_ancestor(loop_place, place))
            .flat_map(|place| {
                self.rounds[place]
                    .open
                    .iter()
                    .filter(|(_, round)| {
                        round
                            .won
                            .into_iter()
                            .chain(round.overtaken_by.iter().copied())
                            .any(is_passed)
                    })
                    .map(move |(&run_index, _)| (place, run_index))
            })
            .collect();
        for (place, run_index) in passed {
            self.take_round(place, run_index);
        }
    }

    /// The key of the node at `place`'s next step: attempt 1 at the next execution index.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn take_step(&mut self, place: usize) -> WorkflowStepKey {
        WorkflowStepKey {
            workflow_run_id: self.run_id,
            node_id: self.graph.node(place).id.clone(),
            attempt: SafeInt::new(1).expect("1 is a whole number from 1"),
            execution_index: self.take_execution_index(),
        }
    }

    /// The next execution index, which no other step of the run takes.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn take_execution_index(&mut self) -> SafeInt<0> {
        let execution_index = SafeInt::new(self.next_execution_index)
            .expect("a run's execution count is far below the largest safe integer");
        self.next_execution_index += 1;
        execution_index
    }
}

impl RunWalk {
    /// The input lists the step `ready` runs on, one per input of its kind's spec in spec order: a
    /// main slot's list is its source output's items, cloned once, and a tool input's or an unfed
    /// slot's list is empty. A disabled skip's first output reads as the feed of its first slot,
    /// through any chain of them, and its other outputs as empty; every other source is a step
    /// `outputs` recorded.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn ready_inputs(
        &self,
        ready: &WalkReady,
        outputs: &StepOutputs,
    ) -> Vec<Vec<WorkflowItem>> {
        let node = self.graph.node(self.graph.place(&ready.step.node_id));
        let mut inputs = vec![Vec::new(); node.input_count];
        for (slot, source) in node.slots.iter().zip(&ready.sources) {
            let mut source = source.as_ref();
            while let Some((skip, passed)) = source
                .and_then(|skip| Some((skip, self.passed_on.get(&skip.execution_index.get())?)))
            {
                source = passed.as_ref().filter(|_| skip.output_index.get() == 0);
            }
            let Some(source) = source else {
                continue;
            };
            let source_step = outputs
                .step(&StepKey {
                    node_id: source.node_id.clone(),
                    execution_index: source.execution_index.get(),
                })
                .expect("a ready step's sources settled, and the run recorded their outputs");
            let output_index = usize::try_from(source.output_index.get())
                .expect("an output index fits in a pointer-sized integer");
            if let Some(items) = source_step.outputs.get(output_index) {
                inputs[slot.spec_position].clone_from(items);
            }
        }
        inputs
    }
}
