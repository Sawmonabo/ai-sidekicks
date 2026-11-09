//! Whether one provider process's telemetry exports are arriving: each export marks them arriving,
//! and a turn that made a model request with no export from its start to two export intervals
//! after its settle marks them stopped. One tracker per process, dropped with it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{JobCondition, ScheduleError, ScheduledJobHandle, Scheduler};
use tokio::sync::watch;
use tokio::time::Instant;

/// How many export intervals pass after a turn's settle before every export of that turn has
/// arrived: a request turn's check waits that long, and so does a response the stream may yet
/// state.
pub(crate) const INTERVALS_WAITED: u32 = 2;

/// What a process's exports read as, once one arrived or a request turn waited for one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExportStatus {
    /// An export arrived, and no request turn since has gone without one.
    Arriving,
    /// A turn that made a request saw no export from its start to two intervals after its settle.
    Stopped,
}

/// One provider process's export status, fed by its driver's telemetry: an export arriving, and a
/// turn settling. Holds at most one scheduled check, canceled by an export or by the drop.
pub(crate) struct ExportStatusTracker {
    scheduler: Arc<Scheduler>,
    export_interval: Duration,
    state: Arc<Mutex<TrackerState>>,
    status: watch::Receiver<Option<ExportStatus>>,
}

// What the tracker and its scheduled check share.
struct TrackerState {
    last_export_at: Option<Instant>,
    check: Option<PendingCheck>,
    next_check_id: u64,
    status: watch::Sender<Option<ExportStatus>>,
}

// The check armed for a request turn that settled unexported, its id telling a run of a check an
// export already canceled from the one still armed.
struct PendingCheck {
    id: u64,
    job: ScheduledJobHandle,
}

impl ExportStatusTracker {
    /// A tracker for a process exporting every `export_interval`, its checks run on `scheduler`;
    /// its status reads `None` until an export arrives or a check finds none.
    pub(crate) fn new(scheduler: Arc<Scheduler>, export_interval: Duration) -> Self {
        let (sender, status) = watch::channel(None);
        Self {
            scheduler,
            export_interval,
            state: Arc::new(Mutex::new(TrackerState {
                last_export_at: None,
                check: None,
                next_check_id: 0,
                status: sender,
            })),
            status,
        }
    }

    /// An export from the process arrived: the armed check is canceled and the status reads
    /// `Arriving`.
    pub(crate) fn export_arrived(&self) {
        let mut state = lock(&self.state);
        state.last_export_at = Some(Instant::now());
        if let Some(check) = state.check.take() {
            check.job.cancel();
        }
        state.status.send_if_modified(|status| {
            let was_arriving = *status == Some(ExportStatus::Arriving);
            *status = Some(ExportStatus::Arriving);
            !was_arriving
        });
    }

    /// A turn that began at `started_at` settled. One that made a model request and saw no export
    /// since its start arms a check two intervals out, unless one is already armed, whose earlier
    /// deadline decides first; a turn with no request changes nothing. Fails only once the
    /// scheduler has stopped.
    pub(crate) fn turn_settled(
        &self,
        made_request: bool,
        started_at: Instant,
    ) -> Result<(), ScheduleError> {
        if !made_request {
            return Ok(());
        }
        let mut state = lock(&self.state);
        let was_exported = state
            .last_export_at
            .is_some_and(|exported_at| exported_at >= started_at);
        if was_exported || state.check.is_some() {
            return Ok(());
        }
        let id = state.next_check_id;
        state.next_check_id += 1;
        let shared = Arc::downgrade(&self.state);
        let job = self.scheduler.schedule(
            "telemetry export check",
            JobCondition::Always,
            self.export_interval * INTERVALS_WAITED,
            move |_| {
                let shared = shared.clone();
                async move {
                    if let Some(shared) = shared.upgrade() {
                        let mut state = lock(&shared);
                        if state.check.as_ref().is_some_and(|check| check.id == id) {
                            state.check = None;
                            state.status.send_if_modified(|status| {
                                let was_stopped = *status == Some(ExportStatus::Stopped);
                                *status = Some(ExportStatus::Stopped);
                                !was_stopped
                            });
                        }
                    }
                    Ok(())
                }
                .boxed()
            },
        )?;
        state.check = Some(PendingCheck { id, job });
        Ok(())
    }

    /// The process's export status, `None` until an export arrives or a check finds none.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the export status line and the usage-file fallback read it"
        )
    )]
    pub(crate) fn status(&self) -> watch::Receiver<Option<ExportStatus>> {
        self.status.clone()
    }
}

impl Drop for ExportStatusTracker {
    // The process is gone, so its armed check would decide nothing.
    fn drop(&mut self) {
        if let Some(check) = lock(&self.state).check.take() {
            check.job.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use sidekicks_std::scheduler::Scheduler;
    use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
    use tokio::sync::watch;
    use tokio::time::{Instant, sleep};

    use super::{ExportStatus, ExportStatusTracker};

    const INTERVAL: Duration = Duration::from_secs(1);

    fn tracker() -> ExportStatusTracker {
        let scheduler = Scheduler::start(
            Arc::new(TestWallClock::default()),
            None,
            watch::channel(0).1,
        );
        ExportStatusTracker::new(Arc::new(scheduler), INTERVAL)
    }

    // A request turn with no export reads stopped only two intervals after its settle, the next
    // export reads arriving again, and a turn with no request leaves that as it was. Killed by
    // deciding at the settle, by stopping on a turn with no request, and by an export that leaves
    // the stop standing.
    #[tokio::test(start_paused = true)]
    async fn an_unexported_request_turn_reads_stopped_until_the_next_export() {
        let tracker = tracker();
        let mut status = tracker.status();

        let settled_at = Instant::now();
        tracker
            .turn_settled(true, settled_at)
            .expect("the scheduler runs");
        sleep((INTERVAL * 2).saturating_sub(Duration::from_millis(1))).await;
        assert_eq!(*status.borrow(), None);
        status.changed().await.expect("the tracker is held");
        assert_eq!(*status.borrow_and_update(), Some(ExportStatus::Stopped));
        assert!(settled_at.elapsed() >= INTERVAL * 2);

        tracker.export_arrived();
        assert_eq!(*status.borrow_and_update(), Some(ExportStatus::Arriving));

        tracker
            .turn_settled(false, Instant::now())
            .expect("the scheduler runs");
        sleep(INTERVAL * 3).await;
        assert_eq!(*status.borrow(), Some(ExportStatus::Arriving));
    }

    // An export the turn's last record left before the turn settled counts for that turn. Killed by
    // a window that opens at the settle.
    #[tokio::test(start_paused = true)]
    async fn an_export_between_a_turns_start_and_its_settle_keeps_arriving() {
        let tracker = tracker();
        let status = tracker.status();

        let started_at = Instant::now();
        sleep(INTERVAL / 2).await;
        tracker.export_arrived();
        sleep(INTERVAL / 2).await;
        tracker
            .turn_settled(true, started_at)
            .expect("the scheduler runs");
        sleep(INTERVAL * 3).await;

        assert_eq!(*status.borrow(), Some(ExportStatus::Arriving));
    }
}
