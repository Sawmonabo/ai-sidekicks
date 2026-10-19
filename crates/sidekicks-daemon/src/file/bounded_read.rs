//! A file read that a hung network folder can hold, run on a thread of its own and answered through
//! a channel within a wall-clock ceiling. A read the kernel holds (a hard NFS or SMB mount retries
//! for as long as the server is away) cannot be canceled, and one on tokio's blocking pool would
//! hold the runtime's stop until it returns, so a read past the ceiling is abandoned on its thread
//! and the caller answered at once. The reads in flight, abandoned ones included, are capped at
//! the runtime's default blocking-thread limit, so hung reads cannot start threads without end; a
//! read waiting for room counts its wait against its ceiling.

use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::sync::{Semaphore, oneshot};

/// How long a bounded read may take before its caller is answered without it.
pub(crate) const FILE_READ_CEILING: Duration = Duration::from_secs(10);

/// The most reads in flight at once, abandoned ones included: tokio's default blocking-thread
/// limit, the bound the reads had on its pool.
const READS_IN_FLIGHT_MAX: usize = 512;

static READS_IN_FLIGHT: Semaphore = Semaphore::const_new(READS_IN_FLIGHT_MAX);

/// Runs `read` of `path` on a thread of its own and returns its answer, or fails with `TimedOut`
/// once [`FILE_READ_CEILING`] passes without one, the read left to finish on its thread. Fails with
/// the read's own error, the thread's start failure, or `Other` when the read panics.
pub(crate) async fn read_within_ceiling<Output: Send + 'static>(
    path: &Path,
    read: impl FnOnce(&Path) -> io::Result<Output> + Send + 'static,
) -> io::Result<Output> {
    let path = path.to_path_buf();
    let answered = async move {
        let room = READS_IN_FLIGHT
            .acquire()
            .await
            .expect("the read cap is never closed");
        let (answer, answer_received) = oneshot::channel();
        std::thread::Builder::new()
            .name("bounded file read".to_owned())
            .spawn(move || {
                // Held until the read returns, so an abandoned read still counts against the cap.
                let _room = room;
                #[cfg(test)]
                stalled_reads::wait_while_stalled(&path);
                // A caller past the ceiling no longer listens; its answer is dropped.
                drop(answer.send(read(&path)));
            })?;
        answer_received.await.map_err(io::Error::other)?
    };
    match tokio::time::timeout(FILE_READ_CEILING, answered).await {
        Ok(answer) => answer,
        Err(_elapsed) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "the file system gave no answer within {} s",
                FILE_READ_CEILING.as_secs()
            ),
        )),
    }
}

#[cfg(test)]
pub(crate) use stalled_reads::stall_reads_of;

/// Reads a test holds, so a bounded read of a path never answers while the test runs.
#[cfg(test)]
mod stalled_reads {
    use std::path::{Path, PathBuf};
    use std::sync::{Condvar, Mutex, PoisonError};

    // Each stalled path with how many reads of it still pass before the stall.
    static STALLED: Mutex<Vec<(PathBuf, usize)>> = Mutex::new(Vec::new());
    static RELEASED: Condvar = Condvar::new();

    /// Holds every bounded read of one path past its first `passed` reads until dropped, when the
    /// held reads run and answer no one.
    pub(crate) struct StalledReads {
        path: PathBuf,
    }

    /// Stalls the bounded reads of exactly `path` after the first `passed` of them, until the
    /// returned guard drops.
    pub(crate) fn stall_reads_of(path: &Path, passed: usize) -> StalledReads {
        STALLED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((path.to_path_buf(), passed));
        StalledReads {
            path: path.to_path_buf(),
        }
    }

    /// Waits while a test stalls reads of `path`, after taking one of its passing reads if any is
    /// left.
    pub(super) fn wait_while_stalled(path: &Path) {
        let mut stalled = STALLED.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((_, passed)) = stalled.iter_mut().find(|(held, _)| held == path)
            && *passed > 0
        {
            *passed -= 1;
            return;
        }
        while stalled.iter().any(|(held, _)| held == path) {
            stalled = RELEASED
                .wait(stalled)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    impl Drop for StalledReads {
        fn drop(&mut self) {
            STALLED
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|(held, _)| *held != self.path);
            RELEASED.notify_all();
        }
    }
}
