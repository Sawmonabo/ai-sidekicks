//! The watch that stops a recovery whose shells have both stopped working: once no byte has passed
//! between them for a whole window it reads each running shell's processor time, and once a further
//! window passes in which no byte passed, no shell exited and none used the processor, it reads as
//! stalled. A shell that works, however slowly, uses some processor time in every window, while one
//! blocked for good uses none, so a recovery that is only slow, on a busy machine or a large file,
//! goes on however long it takes.

use std::collections::HashMap;
use std::error::Error;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio::time::{Instant, Sleep};
use tracing::warn;

use crate::mutex_lock::lock;

/// How long the recovery may pass no byte before the shells' processor time is read.
pub(crate) const RECOVERY_STALL_WINDOW: Duration = Duration::from_secs(60);

/// Each running shell's processor time, all its cores together, by process id.
pub(crate) type ShellProcessorTimes = HashMap<u32, Duration>;

/// Watches a recovery's shells for a stall, reading their processor time through
/// `read_processor_times`, which answers `None` when a shell ended between the listing and the
/// reading. All its state is its own, so [`RecoveryStallWatch::stalled`] may be dropped and called
/// again, as a `select!` branch is.
pub(crate) struct RecoveryStallWatch<Read> {
    read_processor_times: Read,
    window: Duration,
    deadline: Pin<Box<Sleep>>,
    // Each running shell's processor time at the last reading since a byte last passed.
    last_reading: Option<ShellProcessorTimes>,
}

impl<Read, Reading, ReadError> RecoveryStallWatch<Read>
where
    Read: FnMut() -> Reading,
    Reading: Future<Output = Result<Option<ShellProcessorTimes>, ReadError>>,
    ReadError: Error + 'static,
{
    /// A watch whose first window starts now and lasts `window`.
    pub(crate) fn new(window: Duration, read_processor_times: Read) -> Self {
        Self {
            read_processor_times,
            window,
            deadline: Box::pin(tokio::time::sleep(window)),
            last_reading: None,
        }
    }

    /// Starts the window again: bytes passed between the shells.
    pub(crate) fn note_passed_bytes(&mut self) {
        self.last_reading = None;
        self.deadline.as_mut().reset(Instant::now() + self.window);
    }

    /// Resolves once the shells have stalled: a window passed with no byte, then a reading, then a
    /// further window with no byte in which the same shells still run and none used the processor.
    /// A reading that fails never counts: the log says why, and the next window reads again.
    pub(crate) async fn stalled(&mut self) {
        loop {
            self.deadline.as_mut().await;
            let reading = (self.read_processor_times)().await.unwrap_or_else(|error| {
                warn!(
                    error = &error as &(dyn Error + 'static),
                    "the recovery's processor time could not be read, so its progress is read \
                         again after the next window"
                );
                None
            });
            if let (Some(before), Some(after)) = (&self.last_reading, &reading)
                && is_still(before, after)
            {
                return;
            }
            self.last_reading = reading;
            self.deadline.as_mut().reset(Instant::now() + self.window);
        }
    }
}

/// Why the shells' processor time could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ShellProcessorTimeError {
    /// The blocking task that reads the process table ended before it gave a reading.
    #[error("the shells' processor time reading ended before it finished")]
    Interrupted(#[source] tokio::task::JoinError),
}

/// Reads the shells' processor time through one process table it keeps between readings.
#[derive(Clone)]
pub(crate) struct ShellProcessorTimeReader {
    system: Arc<Mutex<System>>,
}

impl ShellProcessorTimeReader {
    /// A reader with an empty process table, which keeps no process file open between readings.
    pub(crate) fn new() -> Self {
        // On Linux the process table would otherwise keep each process's `stat` file open.
        sysinfo::set_open_files_limit(0);
        Self {
            system: Arc::new(Mutex::new(System::new())),
        }
    }

    /// Each of `shell_pids`' processor time, read on a blocking thread; `None` when one has ended.
    /// Fails when that thread ends early.
    pub(crate) async fn read(
        &self,
        shell_pids: Vec<u32>,
    ) -> Result<Option<ShellProcessorTimes>, ShellProcessorTimeError> {
        let system = Arc::clone(&self.system);
        tokio::task::spawn_blocking(move || {
            let mut system = lock(&system);
            let pids: Vec<Pid> = shell_pids.iter().copied().map(Pid::from_u32).collect();
            // An ended shell's entry is dropped, so it reads as missing.
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                true,
                ProcessRefreshKind::nothing().with_cpu(),
            );
            shell_pids
                .iter()
                .map(|pid| {
                    let process = system.process(Pid::from_u32(*pid))?;
                    Some((*pid, Duration::from_millis(process.accumulated_cpu_time())))
                })
                .collect::<Option<ShellProcessorTimes>>()
        })
        .await
        .map_err(ShellProcessorTimeError::Interrupted)
    }
}

// Whether the same shells still run and none has used the processor since `before`.
fn is_still(before: &ShellProcessorTimes, after: &ShellProcessorTimes) -> bool {
    !after.is_empty()
        && before.len() == after.len()
        && after.iter().all(|(pid, processor_time)| {
            before
                .get(pid)
                .is_some_and(|earlier| processor_time <= earlier)
        })
}

#[cfg(test)]
mod tests {
    use std::future::ready;
    use std::io;
    use std::time::Duration;

    use tokio::time::{Instant, timeout};

    use super::{RecoveryStallWatch, ShellProcessorTimes};

    const WINDOW: Duration = Duration::from_secs(1);

    fn processor_times(readings: [(u32, u64); 2]) -> ShellProcessorTimes {
        readings
            .into_iter()
            .map(|(pid, milliseconds)| (pid, Duration::from_millis(milliseconds)))
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn stalls_a_window_after_a_still_reading_and_a_passed_byte_starts_it_again() {
        let started = Instant::now();
        let mut watch = RecoveryStallWatch::new(WINDOW, || {
            ready(Ok::<_, io::Error>(Some(processor_times([
                (1, 120),
                (2, 40),
            ]))))
        });

        // The first reading comes after one window; a byte passes halfway into the next.
        assert!(timeout(WINDOW * 3 / 2, watch.stalled()).await.is_err());
        watch.note_passed_bytes();
        watch.stalled().await;

        // A window to the reading after the byte, then a still window.
        assert_eq!(started.elapsed(), WINDOW * 3 / 2 + WINDOW * 2);
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_a_shell_that_uses_the_processor_while_it_passes_no_byte() {
        let mut processor_milliseconds = 0;
        let mut watch = RecoveryStallWatch::new(WINDOW, || {
            processor_milliseconds += 5;
            ready(Ok::<_, io::Error>(Some(processor_times([
                (1, processor_milliseconds),
                (2, 40),
            ]))))
        });

        assert!(timeout(WINDOW * 10, watch.stalled()).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn reads_again_after_a_failed_reading_which_never_counts() {
        let started = Instant::now();
        let mut reading_count = 0;
        let mut watch = RecoveryStallWatch::new(WINDOW, || {
            reading_count += 1;
            ready(if reading_count == 1 {
                Err(io::Error::other("the process table could not be read"))
            } else {
                Ok(Some(processor_times([(1, 120), (2, 40)])))
            })
        });

        watch.stalled().await;

        // The failed reading, then the first that counts, then a still window.
        assert_eq!(started.elapsed(), WINDOW * 3);
    }
}
