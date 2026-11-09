//! The tasks timers hand their owners' work to, which the scheduler's stop waits for as it waits
//! for a job, aborting those still running at its deadline and answering a panic among them.

use std::future::Future;

use tokio::task::{JoinError, JoinSet};
use tokio::time::Instant;

use crate::scheduler::SchedulerStopError;

/// The owner tasks still running, the first that panicked among those already ended, and whether
/// the stop has taken them, after which no task starts.
#[derive(Default)]
pub(super) struct OwnerTasks {
    running: JoinSet<()>,
    first_panic: Option<JoinError>,
    is_closed: bool,
}

impl OwnerTasks {
    /// Runs `work` on a task of its own, joining first the tasks that have ended; once the stop
    /// took the set, `work` is dropped unrun, since nothing would wait for it.
    pub(super) fn spawn(&mut self, work: impl Future<Output = ()> + Send + 'static) {
        if self.is_closed {
            return;
        }
        while let Some(ended) = self.running.try_join_next() {
            self.keep_panic(ended);
        }
        self.running.spawn(work);
    }

    /// Takes the tasks for the stop to wait on, leaving a closed set that starts none.
    pub(super) fn close(&mut self) -> Self {
        self.is_closed = true;
        Self {
            running: std::mem::take(&mut self.running),
            first_panic: self.first_panic.take(),
            is_closed: true,
        }
    }

    /// Waits up to `deadline` for every task, aborts those still running then and waits for
    /// their end. Fails with the first panic, or with an overrun when one was aborted.
    pub(super) async fn stop(mut self, deadline: Instant) -> Result<(), SchedulerStopError> {
        let mut has_overrun = false;
        loop {
            match tokio::time::timeout_at(deadline, self.running.join_next()).await {
                Ok(Some(ended)) => self.keep_panic(ended),
                Ok(None) => break,
                Err(_elapsed) => {
                    has_overrun = true;
                    self.running.abort_all();
                    while let Some(ended) = self.running.join_next().await {
                        self.keep_panic(ended);
                    }
                    break;
                }
            }
        }
        match self.first_panic {
            Some(error) => Err(SchedulerStopError::Panicked(error)),
            None if has_overrun => Err(SchedulerStopError::Overran),
            None => Ok(()),
        }
    }

    fn keep_panic(&mut self, ended: Result<(), JoinError>) {
        if let Err(error) = ended
            && error.is_panic()
        {
            self.first_panic.get_or_insert(error);
        }
    }
}
