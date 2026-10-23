//! A file read that a hung network folder can hold, run on a thread of its own and answered through
//! a channel within a wall-clock ceiling. A read the kernel holds (a hard NFS or SMB mount retries
//! for as long as the server is away) cannot be canceled, and one on tokio's blocking pool would
//! hold the runtime's stop until it returns, so a read past the ceiling is abandoned on its thread
//! and the caller answered at once.
//!
//! - The reads in flight, abandoned ones included, are capped at the runtime's default
//!   blocking-thread limit, so hung reads cannot start threads without end; a read waiting for
//!   room counts its wait against its ceiling.
//! - A path whose read was abandoned is kept until that read returns, and a read of it or of a path
//!   beneath it answers `TimedOut` at once with no thread, so one dead mount read again and again
//!   holds one thread, never the whole cap.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::sync::{Semaphore, oneshot};

/// How long a bounded read may take before its caller is answered without it.
pub(crate) const FILE_READ_CEILING: Duration = Duration::from_secs(10);

/// The most reads in flight at once, abandoned ones included: tokio's default blocking-thread
/// limit, the bound the reads had on its pool.
const READS_IN_FLIGHT_MAX: usize = 512;

static READS_IN_FLIGHT: Semaphore = Semaphore::const_new(READS_IN_FLIGHT_MAX);

// Each path whose read was abandoned and has not returned, once per such read.
static ABANDONED_PATHS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

// What became of one read, its last two flags changed only while `ABANDONED_PATHS` is held, so a
// read that returns as its caller gives up on it either is abandoned and removes its path, or is
// not abandoned.
#[derive(Default)]
struct ReadFate {
    has_started: AtomicBool,
    has_returned: AtomicBool,
    is_abandoned: AtomicBool,
}

/// Runs `read` of `path` on a thread of its own and returns its answer, or fails with `TimedOut`
/// once [`FILE_READ_CEILING`] passes without one, the read left to finish on its thread; a read of
/// a path at or beneath one whose read is still abandoned fails with `TimedOut` at once. Fails with
/// the read's own error, the thread's start failure, or `Other` when the read panics.
pub(crate) async fn read_within_ceiling<Output: Send + 'static>(
    path: &Path,
    read: impl FnOnce(&Path) -> io::Result<Output> + Send + 'static,
) -> io::Result<Output> {
    if lock_abandoned_paths()
        .iter()
        .any(|abandoned| path.starts_with(abandoned))
    {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "an earlier read of this place in the file system has not answered yet",
        ));
    }
    let ceiling = read_ceiling(path);
    let fate = Arc::new(ReadFate::default());
    let answered = {
        let path = path.to_path_buf();
        let fate = Arc::clone(&fate);
        async move {
            let room = READS_IN_FLIGHT
                .acquire()
                .await
                .expect("the read cap is never closed");
            fate.has_started.store(true, Ordering::Relaxed);
            run_on_own_thread("bounded file read", move || {
                // Held until the read returns, so an abandoned read still counts against the cap.
                let _room = room;
                #[cfg(test)]
                stalled_reads::wait_while_stalled(&path);
                let answer = read(&path);
                let mut abandoned = lock_abandoned_paths();
                fate.has_returned.store(true, Ordering::Relaxed);
                if fate.is_abandoned.load(Ordering::Relaxed)
                    && let Some(index) = abandoned.iter().position(|held| *held == path)
                {
                    abandoned.swap_remove(index);
                }
                answer
            })
            .await?
        }
    };
    let Some(ceiling) = ceiling else {
        return answered.await;
    };
    match tokio::time::timeout(ceiling, answered).await {
        Ok(answer) => answer,
        Err(_elapsed) => {
            // A read still waiting for room never started, so no thread holds its path.
            if fate.has_started.load(Ordering::Relaxed) {
                let mut abandoned = lock_abandoned_paths();
                if !fate.has_returned.load(Ordering::Relaxed) {
                    fate.is_abandoned.store(true, Ordering::Relaxed);
                    abandoned.push(path.to_path_buf());
                }
            }
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "the file system gave no answer within {} s",
                    FILE_READ_CEILING.as_secs()
                ),
            ))
        }
    }
}

/// Runs `work` on a thread of its own, never on tokio's blocking pool, whose stop waits for every
/// task on it, and answers with what `work` returns. Fails with the thread's start failure, or
/// `Other` when `work` panics.
pub(crate) async fn run_on_own_thread<Output: Send + 'static>(
    thread_name: &str,
    work: impl FnOnce() -> Output + Send + 'static,
) -> io::Result<Output> {
    let (answer, answer_received) = oneshot::channel();
    std::thread::Builder::new()
        .name(thread_name.to_owned())
        .spawn(move || {
            // A caller that stopped waiting no longer listens; its answer is dropped.
            drop(answer.send(work()));
        })?;
    answer_received.await.map_err(io::Error::other)
}

fn lock_abandoned_paths() -> MutexGuard<'static, Vec<PathBuf>> {
    ABANDONED_PATHS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

#[cfg(not(test))]
#[expect(
    clippy::unnecessary_wraps,
    reason = "a test's read of a path it does not hold runs with no ceiling"
)]
fn read_ceiling(_path: &Path) -> Option<Duration> {
    Some(FILE_READ_CEILING)
}

// A test's held read gives up in moments rather than after the whole ceiling; any other read in a
// test runs with no timer, so a paused clock's advance never abandons a read that is answering.
#[cfg(test)]
fn read_ceiling(path: &Path) -> Option<Duration> {
    stalled_reads::is_stalled(path).then_some(stalled_reads::STALLED_READ_CEILING)
}

#[cfg(test)]
pub(crate) use stalled_reads::stall_reads_of;

/// Reads a test holds, so a bounded read of a path never answers while the test runs.
#[cfg(test)]
mod stalled_reads {
    use std::path::{Path, PathBuf};
    use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
    use std::time::Duration;

    /// How long a held read is waited for, so a test of a read that never answers takes moments.
    pub(super) const STALLED_READ_CEILING: Duration = Duration::from_millis(200);

    // A path a test holds the reads of.
    struct Stall {
        path: PathBuf,
        // How many reads of it still pass before the stall.
        passed: usize,
        // How many held reads reached their thread.
        arrived: usize,
    }

    static STALLED: Mutex<Vec<Stall>> = Mutex::new(Vec::new());
    static RELEASED: Condvar = Condvar::new();

    /// Holds every bounded read of one path past its first `passed` reads until dropped, when the
    /// held reads run and answer no one.
    pub(crate) struct StalledReads {
        path: PathBuf,
    }

    /// Stalls the bounded reads of exactly `path` after the first `passed` of them, until the
    /// returned guard drops; each held read gives up after [`STALLED_READ_CEILING`].
    pub(crate) fn stall_reads_of(path: &Path, passed: usize) -> StalledReads {
        lock_stalled().push(Stall {
            path: path.to_path_buf(),
            passed,
            arrived: 0,
        });
        StalledReads {
            path: path.to_path_buf(),
        }
    }

    impl StalledReads {
        /// How many reads of the path reached a thread and were held there.
        pub(crate) fn arrived(&self) -> usize {
            lock_stalled()
                .iter()
                .find(|stall| stall.path == self.path)
                .map_or(0, |stall| stall.arrived)
        }
    }

    /// Whether a test stalls reads of `path`.
    pub(super) fn is_stalled(path: &Path) -> bool {
        lock_stalled().iter().any(|stall| stall.path == path)
    }

    /// Waits while a test stalls reads of `path`, after taking one of its passing reads if any is
    /// left.
    pub(super) fn wait_while_stalled(path: &Path) {
        let mut stalled = lock_stalled();
        let Some(stall) = stalled.iter_mut().find(|stall| stall.path == path) else {
            return;
        };
        if stall.passed > 0 {
            stall.passed -= 1;
            return;
        }
        stall.arrived += 1;
        while stalled.iter().any(|stall| stall.path == path) {
            stalled = RELEASED
                .wait(stalled)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn lock_stalled() -> MutexGuard<'static, Vec<Stall>> {
        STALLED.lock().unwrap_or_else(PoisonError::into_inner)
    }

    impl Drop for StalledReads {
        fn drop(&mut self) {
            lock_stalled().retain(|stall| stall.path != self.path);
            RELEASED.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::Path;
    use std::time::Duration;

    use tokio::time::Instant;

    use super::{read_within_ceiling, stall_reads_of, stalled_reads::STALLED_READ_CEILING};

    async fn list(path: &Path) -> io::Result<()> {
        read_within_ceiling(path, |path| fs::read_dir(path).map(drop)).await
    }

    // Catches a dead mount filling the cap on reads in flight: once a read of a path is abandoned,
    // a read of it or beneath it answers at once and starts no thread, and the path reads again
    // once the stuck read returns.
    #[tokio::test]
    async fn a_read_on_a_dead_mount_answers_at_once_with_no_thread_once_one_hangs() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let dead = scratch.path().join("dead");
        fs::create_dir_all(dead.join("inside")).expect("the folders are made");
        let held = stall_reads_of(&dead, 0);
        let first = list(&dead).await.expect_err("the held read gives up");
        assert_eq!(first.kind(), io::ErrorKind::TimedOut);

        let started_at = Instant::now();
        for again in [dead.clone(), dead.join("inside")] {
            let answer = list(&again)
                .await
                .expect_err("the read answers without its thread");
            assert_eq!(answer.kind(), io::ErrorKind::TimedOut);
        }
        assert!(started_at.elapsed() < STALLED_READ_CEILING);
        assert_eq!(held.arrived(), 1, "no later read reached a thread");

        drop(held);
        let deadline = Instant::now() + Duration::from_secs(5);
        while list(&dead).await.is_err() {
            assert!(Instant::now() < deadline, "the path never read again");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
