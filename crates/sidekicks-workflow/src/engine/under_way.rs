//! The runs under way: each run's id is held from its mint until the start returns with no run,
//! or else until the tick ends the run, and from a take-back until the tick ends the run, so the
//! leftover sweep of a session reloaded beside them leaves alone what a start or a turn still
//! holds: a workspace bound and a payload reserved ahead of the write that names them.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the engine's run start handlers and the daemon's restart"
    )
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_std::mutex_lock::lock;

/// The runs under way, which a start and the tick hold and the leftover sweep reads. A run can be
/// held twice at once, by its start and by the run it hands the tick, so each id keeps a count.
#[derive(Default)]
pub(crate) struct RunsUnderWay {
    runs: Mutex<HashMap<WorkflowRunId, usize>>,
}

impl RunsUnderWay {
    /// Holds `run_id` as under way until the hold is dropped.
    pub(crate) fn hold(self: &Arc<Self>, run_id: WorkflowRunId) -> RunUnderWay {
        *lock(&self.runs).entry(run_id).or_insert(0) += 1;
        RunUnderWay {
            runs: Arc::clone(self),
            run_id,
        }
    }

    /// Whether `run_id` is under way.
    pub(crate) fn is_under_way(&self, run_id: WorkflowRunId) -> bool {
        lock(&self.runs).contains_key(&run_id)
    }
}

/// A hold on a run's id as under way, let go when dropped.
pub(crate) struct RunUnderWay {
    runs: Arc<RunsUnderWay>,
    run_id: WorkflowRunId,
}

impl Drop for RunUnderWay {
    fn drop(&mut self) {
        let mut runs = lock(&self.runs.runs);
        let count = runs
            .get_mut(&self.run_id)
            .expect("a held run's id is counted until its last hold goes");
        *count -= 1;
        if *count == 0 {
            runs.remove(&self.run_id);
        }
    }
}
