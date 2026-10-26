//! The wait for a run to read `running` again, which a question asked while its run waits on
//! another question, on an approval or in a pause takes before it is answerable: woken where a
//! write moves the run to `running`, where its end lands and where a question waiting for it
//! settles, with no timer.

use std::pin::pin;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use tokio::sync::Notify;

use crate::mutex_lock::lock;

use crate::session::run::engine::live::LiveRuns;
use crate::session::run::engine::{RunEngine, RunEngineError};

impl RunEngine {
    /// Waits until `run_id` reads `running` or has ended, or until its waiters are woken for a
    /// question waiting for it that settled; the caller reads again what it waits on. Fails with
    /// [`crate::session::run::refusals::RunRefusal::NotFound`] for a run with no row, and as the
    /// read fails.
    pub(crate) async fn wait_for_running_wake(&self, run_id: RunId) -> Result<(), RunEngineError> {
        let waiter = RunningWaiter::enter(&self.live, run_id);
        // Enabled before the read, so a write that lands between the read and the wait wakes it.
        let mut woken = pin!(waiter.wake.notified());
        woken.as_mut().enable();
        let run = self.require_run(run_id).await?;
        if run.state != RunState::Running && !run.state.is_terminal() {
            woken.await;
        }
        Ok(())
    }

    /// Wakes whoever waits for `run_id` to read `running` again, once a write moved it to
    /// `running` or ended it, or a question waiting for it settled.
    pub(crate) fn wake_running_waiters(&self, run_id: &RunId) {
        if let Some(wake) = lock(&self.live).running_waits.get(run_id) {
            wake.notify_waiters();
        }
    }
}

// One waiter's share of its run's wake; the last to leave takes the run's entry out of the map.
struct RunningWaiter<'engine> {
    live: &'engine Mutex<LiveRuns>,
    run_id: RunId,
    wake: Arc<Notify>,
}

impl<'engine> RunningWaiter<'engine> {
    fn enter(live: &'engine Mutex<LiveRuns>, run_id: RunId) -> Self {
        let wake = Arc::clone(lock(live).running_waits.entry(run_id).or_default());
        Self { live, run_id, wake }
    }
}

impl Drop for RunningWaiter<'_> {
    fn drop(&mut self) {
        let mut live = lock(self.live);
        // The map's own share and this waiter's are the last; every share is taken under the lock.
        if Arc::strong_count(&self.wake) == 2 {
            live.running_waits.remove(&self.run_id);
        }
    }
}
