//! A node's rounds: the slots one execution of it reads, filled as feeds arrive, and the open
//! rounds a feed may enter.

use std::collections::{BTreeMap, BTreeSet};

use sidekicks_contracts::workflow::run::step::record::WorkflowStepSource;

/// One main input slot of an open round.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) enum RoundSlot {
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
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) struct Round {
    /// The slots, slot k at index k.
    pub(super) slots: Vec<RoundSlot>,
    /// Where a first-to-arrive node's step already ran on the round, the index of that win among
    /// the walk's wins: the round then takes, without a step, only the late feeds the win
    /// overtook, until no slot can still be fed, and a feed it did not overtake, a loop's next pass
    /// among them, goes to a later round.
    pub(super) won: Option<usize>,
    /// The wins, by index, this round was pending at or descends from a step pending at.
    pub(super) overtaken_by: BTreeSet<usize>,
}

impl Round {
    /// Whether a first-to-arrive node's step already ran on the round.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn is_won(&self) -> bool {
        self.won.is_some()
    }

    /// Whether a feed overtaken by the wins `overtaken_by` may enter the round: a won round only
    /// one its win overtook, and any other only one no win of this node overtook, which
    /// `is_claimed` tells.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn admits(&self, overtaken_by: &BTreeSet<usize>, is_claimed: bool) -> bool {
        match self.won {
            Some(win) => overtaken_by.contains(&win),
            None => !is_claimed,
        }
    }

    /// The lowest slot whose feed carries items, `None` when no slot's does.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn first_slot_with_items(&self) -> Option<usize> {
        self.slots
            .iter()
            .position(|slot| matches!(slot, RoundSlot::Filled { count, .. } if *count > 0))
    }

    /// Whether every slot is filled and at least one holds items.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn is_full_with_items(&self) -> bool {
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
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) fn sources(&self) -> Vec<Option<WorkflowStepSource>> {
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
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) struct SlotOpenings {
    /// The rounds whose slot nothing has fed.
    pub(super) unfilled: BTreeSet<u64>,
    /// The rounds whose slot was settled empty, which a feed with items replaces.
    pub(super) empty: BTreeSet<u64>,
}

/// One node's rounds: the open ones by run index and the run index the next one takes.
#[derive(Default)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) struct NodeRounds {
    /// The open rounds by run index.
    pub(super) open: BTreeMap<u64, Round>,
    /// The run index the node's next round takes.
    pub(super) next_run_index: u64,
    /// Per slot, the open rounds a feed may enter.
    pub(super) openings: Vec<SlotOpenings>,
}
