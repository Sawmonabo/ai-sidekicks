//! Each live run's usage tally, held from the run's first usage report until its end, so the usage
//! record adds each row to a kept count instead of reading the run's rows again at every report.

use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_std::mutex_lock::lock;

use crate::run::engine::RunEngine;

/// One run's usage as the usage record holds it to the run's token limit: the limit admitted with
/// the run, the count of its rows' input and output, whether the run was stopped at the limit, and
/// the turn the provider last attributed a row to with where that turn opened.
#[derive(Debug)]
pub(crate) struct RunUsageTally {
    /// The token limit admitted with the run, `None` for an unlimited one.
    pub(crate) token_limit: Option<TokensPerRun>,
    /// The input and output of the run's rows so far.
    pub(crate) token_count: u64,
    /// Whether the run's stop at its token limit went through, so no later report asks again.
    pub(crate) is_stopped: bool,
    /// The provider's turn id the last row named, and the epoch and turn it opened in.
    pub(crate) turn_opening: Option<(String, Option<EpochPosition>)>,
}

/// A run's tally behind the lock its reports take one at a time; `None` until the first report
/// seeds it from the log.
pub(crate) type RunUsageTallySlot = Arc<tokio::sync::Mutex<Option<RunUsageTally>>>;

impl RunEngine {
    /// The slot of `run_id`'s tally, made empty on the run's first report; the run's end drops it.
    pub(crate) fn run_usage_tally(&self, run_id: RunId) -> RunUsageTallySlot {
        Arc::clone(lock(&self.live).usage_tallies.entry(run_id).or_default())
    }

    /// Drops `slot` as `run_id`'s tally, while it still is: a run already ended keeps none.
    pub(crate) fn forget_run_usage_tally(&self, run_id: RunId, slot: &RunUsageTallySlot) {
        let mut live = lock(&self.live);
        if live
            .usage_tallies
            .get(&run_id)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
        {
            live.usage_tallies.remove(&run_id);
        }
    }
}
