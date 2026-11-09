//! The run limits a test sets: `Ask me after one start leads to` fixed at construction, and
//! `Stop a run after` read as the test last set it.

use std::sync::Mutex;

use sidekicks_contracts::daemon::config::{RunTimeLimitMinutes, WorkflowChainAskAfterRuns};

use crate::engine::ports::WorkflowRunLimits;

/// Run limits a test sets, both `None` unless it sets them.
#[derive(Default)]
pub(crate) struct ScriptedRunLimits {
    /// `Ask me after one start leads to`.
    chain_ask_after_runs: Option<WorkflowChainAskAfterRuns>,
    /// `Stop a run after`.
    run_time_limit: Mutex<Option<RunTimeLimitMinutes>>,
}

impl ScriptedRunLimits {
    /// Limits reading `chain_ask_after_runs` and no run time limit.
    pub(crate) fn with_chain_ask_after(
        chain_ask_after_runs: Option<WorkflowChainAskAfterRuns>,
    ) -> Self {
        Self {
            chain_ask_after_runs,
            run_time_limit: Mutex::new(None),
        }
    }

    /// Sets `Stop a run after` for every later read.
    pub(crate) fn set_run_time_limit(&self, limit: Option<RunTimeLimitMinutes>) {
        *sidekicks_std::mutex_lock::lock(&self.run_time_limit) = limit;
    }
}

impl WorkflowRunLimits for ScriptedRunLimits {
    fn chain_ask_after_runs(&self) -> Option<WorkflowChainAskAfterRuns> {
        self.chain_ask_after_runs
    }

    fn run_time_limit(&self) -> Option<RunTimeLimitMinutes> {
        *sidekicks_std::mutex_lock::lock(&self.run_time_limit)
    }
}
