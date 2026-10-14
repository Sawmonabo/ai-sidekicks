//! The copies across volumes under way, one entry from a copy's start to its end, whether it
//! succeeded or failed, and the followers of them. Each change replaces the whole list, and every
//! follower reads the copies of its project from the newest list. A copy is sent when it starts, on
//! a tick four times a second while it runs, and once more when it ends. Each tick counts the files
//! the copy has finished and what has reached the destination of the one it is copying, so one
//! large file moves the figure too. A copy's ticks run one after another on a task of its own, so
//! two reads never overlap, and none runs once the copy ends.

use std::error::Error;
use std::future::Future;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::worktree::copy_progress::{WorktreeCopy, WorktreeCopyProgress};
use tokio::sync::watch;
use tokio::task::AbortHandle;

/// How often a running copy's figure is sent: four times a second reads as steady progress on the
/// row and costs the stream next to nothing.
const COPY_PROGRESS_TICK: Duration = Duration::from_millis(250);

/// The copies across volumes a removal or a put-back makes, while they run, and their followers.
/// Cloning it shares the same list.
#[derive(Clone)]
pub(crate) struct WorktreeCopiesUnderWay {
    state: Arc<CopiesState>,
}

struct CopiesState {
    entries: Mutex<CopyEntries>,
    // The whole list as last sent; a follower reads only the newest, so nothing queues.
    published: watch::Sender<Vec<WorktreeCopy>>,
}

#[derive(Default)]
struct CopyEntries {
    next_id: u64,
    // In the order the copies began.
    entries: Vec<CopyEntry>,
}

struct CopyEntry {
    id: u64,
    // The caller's copy, holding its total; its copied bytes are set each time it is sent.
    copy: WorktreeCopy,
    // The bytes of the files the copy has finished.
    finished_bytes: u64,
    // What the last tick read of the file the copy is on.
    bytes_in_flight: u64,
}

/// What a copy across volumes reports while it runs. Ending it, by [`WorktreeCopyReport::end`] or
/// by dropping it, takes the copy off the list, sends the list at once and stops its ticks.
pub(crate) struct WorktreeCopyReport {
    state: Arc<CopiesState>,
    entry_id: u64,
    ticking: AbortHandle,
}

/// One follower of the copies under way in a project, or in every project.
pub(crate) struct WorktreeCopyFollower {
    // `None` follows every project's copies.
    project_id: Option<ProjectId>,
    copies: watch::Receiver<Vec<WorktreeCopy>>,
    last_sent: Option<WorktreeCopyProgress>,
}

// No copy under way.
impl Default for WorktreeCopiesUnderWay {
    fn default() -> Self {
        Self {
            state: Arc::new(CopiesState {
                entries: Mutex::new(CopyEntries::default()),
                published: watch::channel(Vec::new()).0,
            }),
        }
    }
}

impl WorktreeCopiesUnderWay {
    /// Lists `copy`, its total in its `total_bytes` and its `copied_bytes` 0, and sends the list,
    /// then on each tick adds what `read_bytes_in_flight` answers for the file the copy is on; a
    /// failed read counts nothing and is logged once per copy. Called inside a tokio runtime, whose
    /// task runs the ticks.
    pub(crate) fn begin<Read, Reading>(
        &self,
        copy: WorktreeCopy,
        read_bytes_in_flight: Read,
    ) -> WorktreeCopyReport
    where
        Read: FnMut() -> Reading + Send + 'static,
        Reading: Future<Output = io::Result<u64>> + Send + 'static,
    {
        let entry_id = {
            let mut entries = self.state.lock_entries();
            let entry_id = entries.next_id;
            entries.next_id += 1;
            entries.entries.push(CopyEntry {
                id: entry_id,
                copy,
                finished_bytes: 0,
                bytes_in_flight: 0,
            });
            self.state.publish(&entries);
            entry_id
        };
        let ticking = tokio::spawn(tick_until_ended(
            Arc::clone(&self.state),
            entry_id,
            read_bytes_in_flight,
        ))
        .abort_handle();
        WorktreeCopyReport {
            state: Arc::clone(&self.state),
            entry_id,
            ticking,
        }
    }

    /// Follows the copies under way in `project_id`, or in every project when it is `None`: the
    /// follower's first read answers them at once, and each later read waits for them to change.
    pub(crate) fn follow(&self, project_id: Option<ProjectId>) -> WorktreeCopyFollower {
        WorktreeCopyFollower {
            project_id,
            copies: self.state.published.subscribe(),
            last_sent: None,
        }
    }
}

impl WorktreeCopyReport {
    /// Adds the bytes of a file the copy has finished; the next tick sends them.
    pub(crate) fn add_copied(&self, bytes: u64) {
        let mut entries = self.state.lock_entries();
        let entry = entries
            .find_mut(self.entry_id)
            .expect("a copy stays listed until its report ends");
        entry.finished_bytes += bytes;
        entry.bytes_in_flight = 0;
    }

    /// Ends the copy, whether it succeeded or failed, as dropping the report does.
    pub(crate) fn end(self) {
        drop(self);
    }
}

impl Drop for WorktreeCopyReport {
    fn drop(&mut self) {
        self.ticking.abort();
        let mut entries = self.state.lock_entries();
        entries.entries.retain(|entry| entry.id != self.entry_id);
        self.state.publish(&entries);
    }
}

impl WorktreeCopyFollower {
    /// The copies under way in the followed project: at once on the first call, then whenever they
    /// differ from the last answer. `None` once the list it follows is gone.
    pub(crate) async fn next(&mut self) -> Option<WorktreeCopyProgress> {
        loop {
            let progress = progress_in(self.project_id.as_ref(), &self.copies.borrow_and_update());
            // A change to another project's copy leaves this one's list as it was.
            if self.last_sent.as_ref() != Some(&progress) {
                self.last_sent = Some(progress.clone());
                return Some(progress);
            }
            self.copies.changed().await.ok()?;
        }
    }
}

impl CopiesState {
    fn lock_entries(&self) -> MutexGuard<'_, CopyEntries> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // Sent while the entries are held, so two changes reach the followers in the order made.
    fn publish(&self, entries: &CopyEntries) {
        self.published
            .send_replace(entries.entries.iter().map(CopyEntry::to_copy).collect());
    }
}

impl CopyEntries {
    fn find_mut(&mut self, entry_id: u64) -> Option<&mut CopyEntry> {
        self.entries.iter_mut().find(|entry| entry.id == entry_id)
    }
}

impl CopyEntry {
    fn to_copy(&self) -> WorktreeCopy {
        let mut copy = self.copy.clone();
        match &mut copy {
            WorktreeCopy::Removing {
                copied_bytes,
                total_bytes,
                ..
            }
            | WorktreeCopy::PuttingBack {
                copied_bytes,
                total_bytes,
                ..
            } => {
                // Never past the total, which also keeps the figure a safe integer.
                *copied_bytes = SafeInt::new(
                    self.finished_bytes
                        .saturating_add(self.bytes_in_flight)
                        .min(total_bytes.get()),
                )
                .expect("a figure no larger than a safe integer is one");
            }
        }
        copy
    }
}

fn project_id_of(copy: &WorktreeCopy) -> &ProjectId {
    match copy {
        WorktreeCopy::Removing { project_id, .. }
        | WorktreeCopy::PuttingBack { project_id, .. } => project_id,
    }
}

fn progress_in(project_id: Option<&ProjectId>, copies: &[WorktreeCopy]) -> WorktreeCopyProgress {
    WorktreeCopyProgress {
        copies: copies
            .iter()
            .filter(|copy| project_id.is_none_or(|project_id| project_id_of(copy) == project_id))
            .cloned()
            .collect(),
    }
}

// Ends when the copy's report ends: its abort stops the task at its next wait, and a tick whose
// read finished after the copy left the list sends nothing.
async fn tick_until_ended<Read, Reading>(
    state: Arc<CopiesState>,
    entry_id: u64,
    mut read_bytes_in_flight: Read,
) where
    Read: FnMut() -> Reading,
    Reading: Future<Output = io::Result<u64>>,
{
    let mut has_logged_read_failure = false;
    loop {
        tokio::time::sleep(COPY_PROGRESS_TICK).await;
        let Some(finished_before) = state
            .lock_entries()
            .find_mut(entry_id)
            .map(|entry| entry.finished_bytes)
        else {
            return;
        };
        let bytes_in_flight = match read_bytes_in_flight().await {
            Ok(bytes) => bytes,
            Err(error) => {
                // The figure only lags until that file is finished, so the copy goes on.
                if !has_logged_read_failure {
                    has_logged_read_failure = true;
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        "A copy's progress could not read how much of a file is copied, so the \
                         figure counts only finished files while the read fails"
                    );
                }
                0
            }
        };
        let mut entries = state.lock_entries();
        let Some(entry) = entries.find_mut(entry_id) else {
            return;
        };
        // A file finished during the read may be the one read, now counted whole.
        entry.bytes_in_flight = if entry.finished_bytes == finished_before {
            bytes_in_flight
        } else {
            0
        };
        state.publish(&entries);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
    use sidekicks_contracts::project::ProjectId;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_contracts::worktree::copy_progress::{WorktreeCopy, WorktreeCopyProgress};
    use sidekicks_contracts::worktree::lifecycle::WorktreeId;
    use tokio::sync::oneshot;
    use tokio::time::Instant;

    use super::{COPY_PROGRESS_TICK, WorktreeCopiesUnderWay};

    // How long the test's read of the file in flight takes.
    const READ_TIME: Duration = Duration::from_millis(100);
    const IN_FLIGHT_BYTES: u64 = 300;
    const TOTAL_BYTES: u64 = 1_000;

    fn removing(copied_bytes: u64) -> WorktreeCopy {
        WorktreeCopy::Removing {
            worktree_id: WorktreeId::new("0192f3a4-5b6c-7d8e-9f01-23456789abcd")
                .expect("the id is a UUID"),
            project_id: ProjectId::new("0192f3a4-5b6c-7d8e-9f01-23456789abce")
                .expect("the id is a UUID"),
            name: FreeFormText::<FILE_PATH_MAX_LEN>::new("feature".to_owned())
                .expect("the name is short text"),
            copied_bytes: SafeInt::new(copied_bytes).expect("the figure is small"),
            total_bytes: SafeInt::new(TOTAL_BYTES).expect("the figure is small"),
        }
    }

    fn progress_of(copies: Vec<WorktreeCopy>) -> WorktreeCopyProgress {
        WorktreeCopyProgress { copies }
    }

    #[tokio::test(start_paused = true)]
    async fn sends_each_tick_counts_a_file_finished_mid_read_once_and_stops_at_the_end() {
        let copies = WorktreeCopiesUnderWay::default();
        let mut follower = copies.follow(None);
        assert_eq!(follower.next().await, Some(progress_of(Vec::new())));

        let reads = Arc::new(AtomicUsize::new(0));
        let (stalled_sender, stalled) = oneshot::channel();
        let began = Instant::now();
        let report = copies.begin(removing(0), {
            let reads = Arc::clone(&reads);
            let mut stalled_sender = Some(stalled_sender);
            move || {
                // The third read stalls for good, as a read on a hung volume does.
                let stall = if reads.fetch_add(1, Ordering::SeqCst) == 2 {
                    stalled_sender.take()
                } else {
                    None
                };
                async move {
                    if let Some(stalled_sender) = stall {
                        stalled_sender
                            .send(())
                            .expect("the test waits for the stall");
                        std::future::pending().await
                    } else {
                        tokio::time::sleep(READ_TIME).await;
                        Ok::<_, std::io::Error>(IN_FLIGHT_BYTES)
                    }
                }
            }
        });
        assert_eq!(follower.next().await, Some(progress_of(vec![removing(0)])));

        // The first tick reads the file in flight and sends its bytes.
        assert_eq!(
            follower.next().await,
            Some(progress_of(vec![removing(IN_FLIGHT_BYTES)]))
        );

        // The file in flight finishes while the second tick reads it: counted whole, not twice.
        tokio::time::sleep_until(began + 2 * COPY_PROGRESS_TICK + READ_TIME + READ_TIME / 2).await;
        report.add_copied(400);
        assert_eq!(
            follower.next().await,
            Some(progress_of(vec![removing(400)]))
        );

        // The copy ends while the third read is stalled: the ticking task is released at once.
        stalled.await.expect("the third read stalls");
        report.end();
        assert_eq!(follower.next().await, Some(progress_of(Vec::new())));
        tokio::task::yield_now().await;
        assert_eq!(Arc::strong_count(&reads), 1);
        assert!(
            tokio::time::timeout(4 * COPY_PROGRESS_TICK, follower.next())
                .await
                .is_err(),
            "nothing is sent once the copy ends"
        );
    }
}
