//! The run's walk: which steps the settles it is handed ready or skip, as a pure function of those
//! settles in log order. Each settle feeds its outputs into the input slots of the nodes they
//! enter, a node's slots fill in rounds by run index, and a full round with items is decided.

mod graph;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::events::WorkflowStepSkipReason;
use sidekicks_contracts::workflow::run::step::record::{WorkflowStepKey, WorkflowStepSource};

use self::graph::{RunGraph, SlotTarget};

/// What one walk turn answers: the steps it readied and the steps it skipped, each in the order
/// it handed out their execution indices.
#[derive(Default)]
pub(crate) struct WalkTurn {
    /// The steps readied to run.
    pub(crate) ready: Vec<WalkReady>,
    /// The steps skipped without running.
    pub(crate) skipped: Vec<WalkSkip>,
}

/// A step the walk readied.
pub(crate) struct WalkReady {
    /// The step: attempt 1 at its own execution index.
    pub(crate) step: WorkflowStepKey,
    /// The node's run index, `$runIndex`.
    pub(crate) run_index: u64,
    /// The feed of each main input slot in slot order, `None` for a slot nothing fed.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
}

/// A step the walk skipped, settled as it is skipped.
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

/// One main input slot of an open round.
enum RoundSlot {
    /// Nothing has fed the slot yet.
    Unfilled,
    /// A feed settled the slot, with no items when `count` is 0.
    Filled {
        /// The feed, `None` for an unwired slot.
        source: Option<WorkflowStepSource>,
        /// How many items the feed carries.
        count: usize,
    },
}

/// One round of a node: the slots one execution of it reads, filled as feeds arrive.
struct Round {
    /// The slots, slot k at index k.
    slots: Vec<RoundSlot>,
}

impl Round {
    /// Whether every slot is filled and at least one holds items.
    fn is_full_with_items(&self) -> bool {
        let mut has_items = false;
        for slot in &self.slots {
            match slot {
                RoundSlot::Unfilled => return false,
                RoundSlot::Filled { count, .. } => has_items |= *count > 0,
            }
        }
        has_items
    }

    /// Each slot's feed, `None` for one no feed filled.
    fn sources(&self) -> Vec<Option<WorkflowStepSource>> {
        self.slots
            .iter()
            .map(|slot| match slot {
                RoundSlot::Unfilled => None,
                RoundSlot::Filled { source, .. } => source.clone(),
            })
            .collect()
    }
}

/// For one wired slot of a node, the open rounds a feed may enter, by run index.
#[derive(Default)]
struct SlotOpenings {
    /// The rounds whose slot nothing has fed.
    unfilled: BTreeSet<u64>,
    /// The rounds whose slot was settled empty, which a feed with items replaces.
    empty: BTreeSet<u64>,
}

/// One node's rounds: the open ones by run index and the run index the next one takes.
#[derive(Default)]
struct NodeRounds {
    /// The open rounds by run index.
    open: BTreeMap<u64, Round>,
    /// The run index the node's next round takes.
    next_run_index: u64,
    /// Per slot, the open rounds a feed may enter.
    openings: Vec<SlotOpenings>,
}

/// The walk of one run over its graph: the steps live, each node's open rounds, and the next
/// execution index.
pub(crate) struct RunWalk {
    /// The run's graph.
    graph: Arc<RunGraph>,
    /// The run whose steps the walk keys.
    run_id: WorkflowRunId,
    /// The execution index the next step takes.
    next_execution_index: u64,
    /// The steps readied and not yet settled, by execution index, each to its node's place.
    live: BTreeMap<u64, usize>,
    /// Each node's rounds, by its place in the graph.
    rounds: Vec<NodeRounds>,
}

impl RunWalk {
    /// The walk of `run_id` over `graph`, before any step.
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
        }
    }

    /// Readies the trigger at execution index 0 and run index 0, with no sources.
    pub(crate) fn start(&mut self) -> WalkTurn {
        let trigger = self.graph.trigger();
        self.rounds[trigger].next_run_index = 1;
        let step = self.take_step(trigger);
        self.live.insert(step.execution_index.get(), trigger);
        WalkTurn {
            ready: vec![WalkReady {
                step,
                run_index: 0,
                sources: Vec::new(),
            }],
            skipped: Vec::new(),
        }
    }

    /// Settles `step` with `output_lengths` items on each main output in output order, and
    /// answers the steps that readies or skips. An output past the end of `output_lengths` reads
    /// as empty, as a completed step's unused error output does; an empty output still settles
    /// the slots it feeds.
    pub(crate) fn settle(&mut self, step: &WorkflowStepKey, output_lengths: &[usize]) -> WalkTurn {
        let execution_index = step.execution_index;
        let place = self
            .live
            .remove(&execution_index.get())
            .expect("a settle names a step the walk readied and has not settled");
        let mut turn = WalkTurn::default();
        let fed = self.feed(place, execution_index, output_lengths);
        self.visit(fed, &mut turn);
        turn
    }

    /// Applies every feed of the step of `place` at `execution_index`: its outputs in order, each
    /// output's slots in the graph's order. Answers the rounds the feeds entered, in visiting order.
    fn feed(
        &mut self,
        place: usize,
        execution_index: SafeInt<0>,
        output_lengths: &[usize],
    ) -> BTreeSet<(usize, u64)> {
        let graph = Arc::clone(&self.graph);
        let node = graph.node(place);
        let mut fed = BTreeSet::new();
        for (output_index, targets) in node.outputs.iter().enumerate() {
            let count = output_lengths.get(output_index).copied().unwrap_or(0);
            let source = WorkflowStepSource {
                node_id: node.id.clone(),
                output_index: SafeInt::new(
                    u64::try_from(output_index).expect("an output index fits in 64 bits"),
                )
                .expect("a kind's output count is far below the largest safe integer"),
                execution_index,
            };
            for &target in targets {
                if let Some(run_index) = self.fill(target, &source, count) {
                    fed.insert((target.node, run_index));
                }
            }
        }
        fed
    }

    /// Puts one feed of `count` items from `source` into `target`'s slot and answers the run
    /// index of the round it entered, or `None` for an empty feed dropped while the node has an
    /// open round. Items enter the lowest open round whose slot is unfilled or settled empty; an
    /// empty feed the lowest whose slot is unfilled; with no such round the feed opens one.
    fn fill(
        &mut self,
        target: SlotTarget,
        source: &WorkflowStepSource,
        count: usize,
    ) -> Option<u64> {
        let rounds = &mut self.rounds[target.node];
        let openings = &rounds.openings[target.slot];
        let fitting = if count > 0 {
            match (openings.unfilled.first(), openings.empty.first()) {
                (Some(&unfilled), Some(&empty)) => Some(unfilled.min(empty)),
                (fitting, None) | (None, fitting) => fitting.copied(),
            }
        } else {
            openings.unfilled.first().copied()
        };
        let run_index = match fitting {
            Some(run_index) => run_index,
            None if count == 0 && !rounds.open.is_empty() => return None,
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
        Some(run_index)
    }

    /// Opens a round of the node at `place` under its next run index, its unwired slots settled
    /// empty, and answers that run index.
    fn open_round(&mut self, place: usize) -> u64 {
        let node = self.graph.node(place);
        let rounds = &mut self.rounds[place];
        let run_index = rounds.next_run_index;
        rounds.next_run_index += 1;
        let mut slots = Vec::with_capacity(node.slots.len());
        for (slot, openings) in node.slots.iter().zip(&mut rounds.openings) {
            if slot.is_wired {
                openings.unfilled.insert(run_index);
                slots.push(RoundSlot::Unfilled);
            } else {
                slots.push(RoundSlot::Filled {
                    source: None,
                    count: 0,
                });
            }
        }
        rounds.open.insert(run_index, Round { slots });
        run_index
    }

    /// Decides the `fed` rounds in visiting order: by the node's `(order, id)`, then lowest run
    /// index first.
    fn visit(&mut self, fed: BTreeSet<(usize, u64)>, turn: &mut WalkTurn) {
        for (place, run_index) in fed {
            self.decide_round(place, run_index, turn);
        }
    }

    /// Decides the round of the node at `place` under `run_index` when every slot is filled and at
    /// least one holds items: a disabled node is skipped, passing its first slot on as its first
    /// output and feeding onward depth first; any other is readied. A round decided already, or
    /// whose filled slots are all empty, is left as it is.
    fn decide_round(&mut self, place: usize, run_index: u64, turn: &mut WalkTurn) {
        let rounds = &mut self.rounds[place];
        if !rounds
            .open
            .get(&run_index)
            .is_some_and(Round::is_full_with_items)
        {
            return;
        }
        let round = rounds
            .open
            .remove(&run_index)
            .expect("the round was just found open");
        for openings in &mut rounds.openings {
            openings.unfilled.remove(&run_index);
            openings.empty.remove(&run_index);
        }
        let step = self.take_step(place);
        let sources = round.sources();
        let graph = Arc::clone(&self.graph);
        let node = graph.node(place);
        if !node.is_disabled {
            self.live.insert(step.execution_index.get(), place);
            turn.ready.push(WalkReady {
                step,
                run_index,
                sources,
            });
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
        turn.skipped.push(WalkSkip {
            step,
            run_index,
            reason: WorkflowStepSkipReason::Disabled,
            sources,
            output_lengths: output_lengths.clone(),
        });
        if carries_items {
            let fed = self.feed(place, execution_index, &output_lengths);
            self.visit(fed, turn);
        }
    }

    /// The key of the node at `place`'s next step: attempt 1 at the next execution index.
    fn take_step(&mut self, place: usize) -> WorkflowStepKey {
        let execution_index = SafeInt::new(self.next_execution_index)
            .expect("a run's execution count is far below the largest safe integer");
        self.next_execution_index += 1;
        WorkflowStepKey {
            workflow_run_id: self.run_id,
            node_id: self.graph.node(place).id.clone(),
            attempt: SafeInt::new(1).expect("1 is a whole number from 1"),
            execution_index,
        }
    }
}
