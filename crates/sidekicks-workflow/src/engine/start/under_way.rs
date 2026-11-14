//! The starts under way: each holds its run's id from the id's mint until the start returns, so
//! the leftover sweep of a session taken back leaves alone what a start still between its first
//! stored payload and its run's write holds.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the engine's run start handlers and the daemon's restart"
    )
)]

use std::collections::HashSet;
use std::sync::Mutex;

use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_std::mutex_lock::lock;

/// The runs whose start is under way, which the run start holds and the leftover sweep reads.
#[derive(Default)]
pub(crate) struct StartsUnderWay {
    runs: Mutex<HashSet<WorkflowRunId>>,
}

impl StartsUnderWay {
    /// Holds `run_id` as under way until the hold is dropped.
    pub(crate) fn hold(&self, run_id: WorkflowRunId) -> StartUnderWay<'_> {
        lock(&self.runs).insert(run_id);
        StartUnderWay {
            starts: self,
            run_id,
        }
    }

    /// Whether the start of `run_id` is under way.
    pub(crate) fn is_under_way(&self, run_id: WorkflowRunId) -> bool {
        lock(&self.runs).contains(&run_id)
    }
}

/// A start's hold on its run's id, let go when dropped.
pub(crate) struct StartUnderWay<'starts> {
    starts: &'starts StartsUnderWay,
    run_id: WorkflowRunId,
}

impl Drop for StartUnderWay<'_> {
    fn drop(&mut self) {
        lock(&self.starts.runs).remove(&self.run_id);
    }
}
