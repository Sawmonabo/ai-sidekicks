//! The run's walk: which steps the settles it is handed ready or skip, as a pure function of those
//! settles in log order. Each settle feeds its outputs into the input slots of the nodes they
//! enter, a node's slots fill in rounds by run index, and a full round with items is decided; a
//! first-to-arrive node's round is decided by its first input with items. Every step and round
//! of the win's loop passes still pending, when such a win is decided, at a losing place or at a
//! place that leads into the won node without passing a loop node whose body holds it, is
//! overtaken by it, and so is all it leads to, in that turn or a later one: at a losing place of
//! the win it is canceled, and into the won node it feeds only the won round. A loop's later pass,
//! started before the win, and a step that reaches the won node only through the next pass of a
//! loop holding it are not its to reach. Once the run is quiet, the flush decides what still
//! waits, a node only once none of its ancestors waits.

mod first_to_arrive;
mod graph;
mod lineage;
mod reuse;
mod round;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowContentHash;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::events::WorkflowReusedStep;
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};

use self::first_to_arrive::{DecidedWin, FirstToArriveWin};
use self::graph::SlotTarget;
pub(crate) use self::graph::{RunGraph, RunGraphError};
use self::lineage::StepLineage;
pub(crate) use self::reuse::{KeptStep, ReusedSeedStep};
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
    /// Why it was skipped, with the step a reused skip carries the data of.
    pub(crate) reason: WalkSkipReason,
    /// The feed of each main input slot in slot order, `None` for a slot nothing fed.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
    /// How many items each main output carries on, in output order.
    pub(crate) output_lengths: Vec<usize>,
}

/// Why the walk skipped a step.
#[derive(Debug)]
pub(crate) enum WalkSkipReason {
    /// No main input carried items.
    NoItems,
    /// Its node is disabled, so its input passes on.
    Disabled,
    /// An earlier step's data stands in for it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    Reused(ReusedStepRecord),
}

/// The earlier step a reused skip carries the data of, as its row and event record it.
#[derive(Debug)]
pub(crate) struct ReusedStepRecord {
    /// The step and the version its run executed.
    pub(crate) from: WorkflowReusedStep,
    /// That step's output, which the skip passes on.
    pub(crate) output_ref: WorkflowPayloadRef,
    /// The hash of the pin that step ran on, where it recorded one.
    pub(crate) pin_hash: Option<WorkflowContentHash>,
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
    /// The wins, by index, that overtook this step or a step it descends from, and the loop
    /// passes it belongs to.
    lineage: StepLineage,
}

/// The walk of one run over its graph: the steps live, each node's open rounds, the feeds its
/// disabled skips passed on, the first-to-arrive wins decided, the next execution index, for a
/// partial run the places it covers and the earlier steps it replays, and for a walk rebuilt on
/// another version the steps it keeps and the attempts its steps run again carry.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunWalk {
    /// The run's graph.
    graph: Arc<RunGraph>,
    /// The run whose steps the walk keys.
    run_id: WorkflowRunId,
    /// The execution index the next step takes.
    next_execution_index: u64,
    /// Whether each place, by place, may be readied: `None` for a whole run, which covers all.
    covered: Option<Arc<[bool]>>,
    /// The earlier steps still to replay at each place, by place, in their run's execution order.
    reused: BTreeMap<usize, VecDeque<ReusedSeedStep>>,
    /// For a walk rebuilt on another version, the run's own steps still to settle again under
    /// their own keys at each place, by place, in execution order.
    kept: BTreeMap<usize, VecDeque<KeptStep>>,
    /// For a walk rebuilt on another version, the attempt each place's next step readied to run
    /// takes, by place, in order: a step run again keeps counting its tries.
    carried_attempts: BTreeMap<usize, VecDeque<SafeInt<1>>>,
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
    /// The places a win of the node at a place on a slot reaches, by `(place, slot)`, worked out
    /// once each beside its losing places.
    reached_places: BTreeMap<(usize, usize), Arc<[bool]>>,
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
            covered: None,
            reused: BTreeMap::new(),
            kept: BTreeMap::new(),
            carried_attempts: BTreeMap::new(),
            live: BTreeMap::new(),
            rounds,
            passed_on: BTreeMap::new(),
            wins: Vec::new(),
            losing_places: BTreeMap::new(),
            reached_places: BTreeMap::new(),
        }
    }

    /// Readies the trigger at execution index 0 and run index 0, with no sources.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn start(&mut self) -> WalkTurn {
        let trigger = self.graph.trigger();
        self.rounds[trigger].next_run_index = 1;
        let step = self.take_step(trigger);
        let mut turn = WalkTurn::default();
        self.ready(
            trigger,
            step,
            0,
            Vec::new(),
            StepLineage::default(),
            &mut turn,
        );
        turn
    }

    /// Settles `step` with `output_lengths` items on each main output in output order, and
    /// answers the steps that readies or skips. An output past the end of `output_lengths` reads
    /// as empty, as a completed step's unused error output does; an empty output still settles
    /// the slots it feeds.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn settle(&mut self, step: &WorkflowStepKey, output_lengths: &[usize]) -> WalkTurn {
        let mut turn = WalkTurn::default();
        self.settle_into(step, output_lengths, &mut turn);
        turn
    }

    /// Settles `step` as [`RunWalk::settle`] does, adding what that readies or skips to `turn`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn settle_into(
        &mut self,
        step: &WorkflowStepKey,
        output_lengths: &[usize],
        turn: &mut WalkTurn,
    ) {
        let execution_index = step.execution_index;
        let settled = self
            .live
            .remove(&execution_index.get())
            .expect("a settle names a step the walk readied and has not settled");
        let fed = self.feed(
            settled.place,
            execution_index,
            settled.run_index,
            output_lengths,
            &settled.lineage,
        );
        self.visit(fed, turn);
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

    /// Each step the walk readied and has not settled, in execution order, as it was readied.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn unsettled(&self) -> impl Iterator<Item = WalkReady> + '_ {
        self.live.values().map(|live_step| WalkReady {
            step: live_step.step.clone(),
            run_index: live_step.run_index,
            sources: live_step.sources.clone(),
        })
    }

    /// Whether `step` is one the walk readied and has not settled.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn is_unsettled(&self, step: &WorkflowStepKey) -> bool {
        self.live
            .get(&step.execution_index.get())
            .is_some_and(|live_step| live_step.step == *step)
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
            round.settle_unfilled();
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
                WalkSkipReason::Disabled
            } else {
                WalkSkipReason::NoItems
            },
            sources: round.sources(),
            output_lengths: vec![0; node.outputs.len()],
        });
    }

    /// Applies every feed of the step of `place` at `execution_index` and `run_index`, of
    /// `lineage`: its outputs in order, each output's slots in the graph's order; a loop node's
    /// loop output feeds its pass under `run_index`. Answers the rounds the feeds entered, in
    /// visiting order.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn feed(
        &mut self,
        place: usize,
        execution_index: SafeInt<0>,
        run_index: u64,
        output_lengths: &[usize],
        lineage: &StepLineage,
    ) -> BTreeSet<(usize, u64)> {
        let graph = Arc::clone(&self.graph);
        let node = graph.node(place);
        let pass_lineage = node.loop_output.map(|loop_output| {
            let mut pass_lineage = lineage.clone();
            pass_lineage.passes.enter(place, run_index);
            (loop_output, pass_lineage)
        });
        let mut fed = BTreeSet::new();
        for (output_index, targets) in node.outputs.iter().enumerate() {
            let lineage = match &pass_lineage {
                Some((loop_output, pass_lineage)) if *loop_output == output_index => pass_lineage,
                _ => lineage,
            };
            let count = output_lengths.get(output_index).copied().unwrap_or(0);
            let source = WorkflowStepSource {
                node_id: node.id.clone(),
                output_index: SafeInt::from_usize(output_index),
                execution_index,
            };
            for &target in targets {
                if let Some(run_index) = self.fill(place, target, &source, count, lineage) {
                    fed.insert((target.node, run_index));
                }
            }
        }
        fed
    }

    /// Puts one feed of `count` items from `source`, the step at `source_place`, of `lineage`, into
    /// `target`'s slot and answers the run index of the round it entered, or `None` for a feed
    /// dropped: one into a place the run does not cover, an empty one while the node has an open
    /// round, one a win of the node overtook that no round of that win takes, or one from a place
    /// in the body of a loop node whose body holds the node of a win that overtook it, so an
    /// overtaken step never restarts its own loop. A step outside that body keeps its feed into
    /// the loop node, even when the win reached it through its direct edge into the won node: its
    /// feed into that node enters the won round, and its feed into the loop node starts the next
    /// pass. Items enter the lowest open round of the feed's loop passes admitting it whose slot is
    /// unfilled or settled empty; an empty feed the lowest admitting one whose slot is unfilled;
    /// with no such round the feed opens one. A won round admits only the feeds its win overtook,
    /// so the winner never runs again on its own pass.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn fill(
        &mut self,
        source_place: usize,
        target: SlotTarget,
        source: &WorkflowStepSource,
        count: usize,
        lineage: &StepLineage,
    ) -> Option<u64> {
        if self
            .covered
            .as_ref()
            .is_some_and(|covered| !covered[target.node])
        {
            return None;
        }
        let graph = &self.graph;
        if graph.is_in_loop_body(source_place, target.node)
            && lineage
                .overtaken_by
                .iter()
                .any(|&win| graph.is_in_loop_body(self.wins[win].place, target.node))
        {
            return None;
        }
        let is_claimed = lineage
            .overtaken_by
            .iter()
            .any(|&win| self.wins[win].place == target.node);
        let rounds = &mut self.rounds[target.node];
        let openings = &rounds.openings[target.slot];
        let open = &rounds.open;
        let first_admitting = |run_indices: &BTreeSet<u64>| {
            run_indices.iter().copied().find(|run_index| {
                open.get(run_index)
                    .is_some_and(|round| round.admits(lineage, is_claimed))
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
        round.lineage.join(lineage);
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
                lineage: StepLineage::default(),
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
    /// for the late feeds its win overtook until no slot can still be fed. The win overtakes every
    /// live step and every other open round of its loop passes at a place it reaches, as
    /// `reached_places_of` tells; a loser readied earlier in this turn is taken back from its ready
    /// steps and canceled undispatched, and one the win overtook decided later, in this turn or
    /// another, is canceled. Any other node's round is run once every slot is filled and one holds
    /// items. A round decided already, or whose filled slots are all empty, is left as it is.
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
        if self.is_overtaken_loser(place, &round.lineage.overtaken_by) {
            let round = self.take_round(place, run_index);
            self.cancel_round(place, run_index, &round, turn);
            return;
        }
        self.decide_win(place, run_index, winning_slot, turn);
    }

    /// Runs a decided `round` of the node at `place`: one on a losing branch of a win it was
    /// overtaken by is canceled; a disabled node is skipped, passing its first slot on as its
    /// first output and feeding onward depth first when that carries items; any other is readied.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn run_round(&mut self, place: usize, run_index: u64, round: &Round, turn: &mut WalkTurn) {
        if self.is_overtaken_loser(place, &round.lineage.overtaken_by) {
            self.cancel_round(place, run_index, round, turn);
            return;
        }
        let step = self.take_step(place);
        let sources = round.sources();
        let graph = Arc::clone(&self.graph);
        let node = graph.node(place);
        if !node.is_disabled {
            let lineage = round.lineage.clone();
            self.ready(place, step, run_index, sources, lineage, turn);
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
            reason: WalkSkipReason::Disabled,
            sources,
            output_lengths: output_lengths.clone(),
        });
        if carries_items {
            let fed = self.feed(
                place,
                execution_index,
                run_index,
                &output_lengths,
                &round.lineage,
            );
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

    /// Readies `step` of the node at `place`, of `lineage`, making it live, or, where the place
    /// keeps a step of the run's own, settles that step again in its stead, writing nothing, or,
    /// where it has an earlier step left to replay, settles it at once as that step. A loop node's
    /// step belongs to the passes around its loop, not its own; it starts a new pass of what it leads
    /// to, so it closes the rounds of earlier passes nothing can fill, and no win at a node its
    /// body holds reaches it: such a win's pass is over, and the new pass's feeds open new rounds.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn ready(
        &mut self,
        place: usize,
        step: WorkflowStepKey,
        run_index: u64,
        sources: Vec<Option<WorkflowStepSource>>,
        mut lineage: StepLineage,
        turn: &mut WalkTurn,
    ) {
        if self.graph.node(place).loop_output.is_some() {
            lineage.passes.leave(place);
            let (graph, wins) = (&self.graph, &self.wins);
            lineage
                .overtaken_by
                .retain(|&win| !graph.is_in_loop_body(wins[win].place, place));
            self.close_passed_rounds(place, turn);
        }
        if let Some(kept) = self.take_kept(place, &step) {
            self.live.insert(
                kept.step.execution_index.get(),
                LiveStep {
                    step: kept.step.clone(),
                    place,
                    run_index,
                    sources,
                    lineage,
                },
            );
            self.settle_into(&kept.step, &kept.output_lengths, turn);
            return;
        }
        self.live.insert(
            step.execution_index.get(),
            LiveStep {
                step: step.clone(),
                place,
                run_index,
                sources: sources.clone(),
                lineage,
            },
        );
        if !self.replay_reused(place, &step, run_index, &sources, turn) {
            let step = self.carry_attempt(place, step);
            turn.ready.push(WalkReady {
                step,
                run_index,
                sources,
            });
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
    /// The input lists `step`, readied or skipped with `sources`, runs on, one per input of its
    /// kind's spec in spec order: a main slot's list is its source output's items, cloned once,
    /// and a tool input's or an unfed slot's list is empty. A disabled skip's first output reads
    /// as the feed of its first slot, through any chain of them, and its other outputs as empty;
    /// every other source is a step `outputs` recorded.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn ready_inputs(
        &self,
        step: &WorkflowStepKey,
        sources: &[Option<WorkflowStepSource>],
        outputs: &StepOutputs,
    ) -> Vec<Vec<WorkflowItem>> {
        let node = self.graph.node(self.graph.place(&step.node_id));
        let mut inputs = vec![Vec::new(); node.input_count];
        for (slot, source) in node.slots.iter().zip(sources) {
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
