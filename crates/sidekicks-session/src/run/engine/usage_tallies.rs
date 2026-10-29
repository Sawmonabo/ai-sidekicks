//! Each live run's usage tally, held from the run's first usage report until its end, so the usage
//! record adds each row to a kept count instead of reading the run's rows again at every report,
//! and each live helper's own run, so a helper's reports never look it up in the log again.

use std::sync::Arc;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_std::mutex_lock::lock;

use crate::run::engine::RunEngine;

/// Where a run's stop at its token limit stands, so a report asks for it only while none is asked
/// or under way.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum TokenLimitStop {
    /// Not asked, or asked and failed, so the next report past the limit asks again.
    #[default]
    Unasked,
    /// Asked on its own task, not answered yet.
    InFlight,
    /// Gone through.
    Stopped,
}

/// One run's usage as the usage record holds it to the run's token limit: the limit admitted with
/// the run, the count of its rows' input and output, where its stop at the limit stands, and the
/// turn the provider last attributed a row to with where that turn opened.
#[derive(Debug)]
pub(crate) struct RunUsageTally {
    /// The token limit admitted with the run, `None` for an unlimited one.
    pub(crate) token_limit: Option<TokensPerRun>,
    /// The input and output of the run's rows so far.
    pub(crate) token_count: u64,
    /// Where the run's stop at its token limit stands.
    pub(crate) limit_stop: TokenLimitStop,
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

    /// Drops `slot` as `run_id`'s tally, while it still is, and the helper kept on the run: a run
    /// already ended keeps neither.
    pub(crate) fn forget_run_usage_tally(&self, run_id: RunId, slot: &RunUsageTallySlot) {
        let mut live = lock(&self.live);
        if live
            .usage_tallies
            .get(&run_id)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
        {
            live.usage_tallies.remove(&run_id);
        }
        live.helper_runs
            .retain(|_, helper_run_id| *helper_run_id != run_id);
    }

    /// The own run of the helper `subagent_id` whose readings come on `binding_id`, once a report
    /// read it.
    pub(crate) fn helper_run(
        &self,
        binding_id: &RuntimeBindingId,
        subagent_id: &SubagentId,
    ) -> Option<RunId> {
        lock(&self.live)
            .helper_runs
            .get(&(binding_id.clone(), subagent_id.clone()))
            .copied()
    }

    /// Keeps `run_id` as the own run of the helper `subagent_id` whose readings come on
    /// `binding_id`, until the run ends.
    pub(crate) fn keep_helper_run(
        &self,
        binding_id: RuntimeBindingId,
        subagent_id: SubagentId,
        run_id: RunId,
    ) {
        lock(&self.live)
            .helper_runs
            .insert((binding_id, subagent_id), run_id);
    }
}
