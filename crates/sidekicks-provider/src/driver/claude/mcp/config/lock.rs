//! Claude Code's lock on the person's config, taken as Claude Code takes it: a folder beside the
//! config, made with `mkdir`, taken over once it is more than 10 seconds old, and tried again on
//! Claude Code's own schedule until the caller's deadline. The lock is never refreshed, so its
//! holder keeps it well under the stale age.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sidekicks_std::retry::jitter::{draw_jitter_sample, scale_to_unit};
use tokio::runtime::Handle;
use tokio::time::Instant;

/// Claude Code's age past which a lock folder is stale: removed and taken by the next writer.
pub(crate) const CLAUDE_CONFIG_LOCK_STALE_AGE: Duration = Duration::from_secs(10);

/// Claude Code's waits between tries of a held lock, each spread by one plus a random fraction;
/// the last repeats until the deadline.
pub(crate) const CLAUDE_CONFIG_LOCK_WAITS: [Duration; 6] = [
    Duration::from_millis(200),
    Duration::from_millis(400),
    Duration::from_millis(800),
    Duration::from_millis(1600),
    Duration::from_millis(3200),
    Duration::from_millis(4000),
];

/// Claude Code's lock on its config, held until `release`; one dropped unreleased removes its
/// folder on a blocking thread.
#[derive(Debug)]
pub(crate) struct ClaudeConfigLock {
    folder: Option<PathBuf>,
}

/// Why Claude Code's config lock was not taken.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeConfigLockError {
    /// Another writer held the lock past the deadline.
    #[error("Claude Code's config is locked by another writer")]
    Held,
    /// The lock's folder could not be made, read or removed.
    #[error("Claude Code's config lock could not be taken")]
    Folder(#[source] io::Error),
}

impl ClaudeConfigLock {
    /// Takes the lock on `config_path`, its folder the path as given with `.lock` appended, trying
    /// on Claude Code's schedule. Fails `Held` when the next wait would pass `deadline`, and
    /// `Folder` when a file call fails.
    pub(crate) async fn take(
        config_path: &Path,
        deadline: Instant,
    ) -> Result<Self, ClaudeConfigLockError> {
        let folder = compose_lock_folder(config_path);
        let mut tries = 0_usize;
        loop {
            if try_take(&folder)
                .await
                .map_err(ClaudeConfigLockError::Folder)?
            {
                return Ok(Self {
                    folder: Some(folder),
                });
            }
            let base = CLAUDE_CONFIG_LOCK_WAITS[tries.min(CLAUDE_CONFIG_LOCK_WAITS.len() - 1)];
            let wait = base.mul_f64(1.0 + scale_to_unit(draw_jitter_sample()));
            if Instant::now() + wait > deadline {
                return Err(ClaudeConfigLockError::Held);
            }
            tokio::time::sleep(wait).await;
            tries = tries.saturating_add(1);
        }
    }

    /// Releases the lock by removing its folder, blocking the calling thread on the removal. Fails
    /// as the removal fails.
    pub(crate) fn release(mut self) -> io::Result<()> {
        let folder = self
            .folder
            .take()
            .expect("a lock keeps its folder until it is released or dropped");
        std::fs::remove_dir(folder)
    }
}

impl Drop for ClaudeConfigLock {
    fn drop(&mut self) {
        let Some(folder) = self.folder.take() else {
            return;
        };
        let remove = move || log_unremoved(std::fs::remove_dir(&folder));
        match Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(remove)),
            // Dropped off the runtime, where a blocking removal holds no task up.
            Err(_outside_runtime) => remove(),
        }
    }
}

fn compose_lock_folder(config_path: &Path) -> PathBuf {
    let mut folder = config_path.as_os_str().to_owned();
    folder.push(".lock");
    PathBuf::from(folder)
}

// One try, as Claude Code makes it: the folder made, or a stale one removed and made again, with
// no second stale check. Answers whether the lock was taken.
async fn try_take(folder: &Path) -> io::Result<bool> {
    if make_folder(folder).await? {
        return Ok(true);
    }
    let modified = match tokio::fs::metadata(folder).await {
        Ok(metadata) => metadata.modified()?,
        // Removed since the make: one more make.
        Err(error) if error.kind() == io::ErrorKind::NotFound => return make_folder(folder).await,
        Err(error) => return Err(error),
    };
    if !is_stale(modified) {
        return Ok(false);
    }
    if let Err(error) = tokio::fs::remove_dir(folder).await
        && error.kind() != io::ErrorKind::NotFound
    {
        return Err(error);
    }
    make_folder(folder).await
}

// Answers false when the folder already exists.
async fn make_folder(folder: &Path) -> io::Result<bool> {
    match tokio::fs::create_dir(folder).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

// Read on the wall clock, as Claude Code reads it; a time ahead of now is fresh, since Claude
// Code's precision probe sets its folder's time up to a second ahead.
fn is_stale(modified: SystemTime) -> bool {
    SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age > CLAUDE_CONFIG_LOCK_STALE_AGE)
}

/// Logs a lock folder's removal that failed; the folder's path stays out of the log, since it names
/// the person's home.
pub(super) fn log_unremoved(removed: io::Result<()>) {
    if let Err(error) = removed {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "Claude Code's config lock could not be removed"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, FileTimes};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use rstest::rstest;
    use tokio::sync::Notify;
    use tokio::time::Instant;

    use super::{ClaudeConfigLock, ClaudeConfigLockError};

    // The real time a take may run before it counts as never answering. The paused tokio clock
    // stands still while a file call is in flight, so only the wall clock bounds a take that tries
    // again without waiting.
    const WALL_CLOCK_BOUND: Duration = Duration::from_secs(5);

    // `ClaudeConfigLock::take`, or `None` once the wall clock passes `WALL_CLOCK_BOUND`.
    async fn take_within_wall_clock_bound(
        config: &Path,
        deadline: Instant,
    ) -> Option<Result<ClaudeConfigLock, ClaudeConfigLockError>> {
        let expired = Arc::new(Notify::new());
        let notifier = Arc::clone(&expired);
        std::thread::spawn(move || {
            std::thread::sleep(WALL_CLOCK_BOUND);
            notifier.notify_one();
        });
        tokio::select! {
            taken = ClaudeConfigLock::take(config, deadline) => Some(taken),
            () = expired.notified() => None,
        }
    }

    // Sets the folder's time on the wall clock, which the paused tokio clock does not move, and
    // answers the time as the file system keeps it.
    fn time_folder(folder: &Path, modified: SystemTime) -> SystemTime {
        fs::set_times(folder, FileTimes::new().set_modified(modified)).unwrap();
        fs::metadata(folder).unwrap().modified().unwrap()
    }

    // Kills: no lock (a fresh folder taken); a busy loop with no wait; the deadline ignored; a
    // time ahead of now read as stale (an absolute difference past 10 s) or as an error.
    #[rstest]
    #[case::timed_now(Duration::ZERO)]
    #[case::one_second_ahead(Duration::from_secs(1))]
    #[case::past_the_stale_age_ahead(Duration::from_secs(11))]
    #[tokio::test(start_paused = true)]
    async fn a_fresh_or_ahead_lock_folder_holds_until_the_deadline(#[case] ahead: Duration) {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".claude.json");
        let folder = home.path().join(".claude.json.lock");
        fs::create_dir(&folder).unwrap();
        let timed = time_folder(&folder, SystemTime::now() + ahead);
        let started = Instant::now();
        let deadline = started + Duration::from_secs(10);

        let taken = take_within_wall_clock_bound(&config, deadline)
            .await
            .expect("the take answers by its deadline");

        assert!(matches!(taken, Err(ClaudeConfigLockError::Held)));
        assert_eq!(fs::metadata(&folder).unwrap().modified().unwrap(), timed);
        assert!(Instant::now() - started >= Duration::from_millis(200));
        assert!(Instant::now() <= deadline);
    }

    // Kills: no stale take; a stale take that waits first; a release that leaves the folder,
    // whether it answers success (a folder holding a file outlives the drop's removal too) or
    // failure.
    #[tokio::test(start_paused = true)]
    async fn a_stale_lock_folder_is_taken_at_once_and_released() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".claude.json");
        let folder = home.path().join(".claude.json.lock");
        fs::create_dir(&folder).unwrap();
        time_folder(&folder, SystemTime::now() - Duration::from_secs(11));
        let started = Instant::now();

        let lock = ClaudeConfigLock::take(&config, started + Duration::from_secs(10))
            .await
            .unwrap();

        assert_eq!(Instant::now(), started);
        assert!(folder.is_dir());
        lock.release().unwrap();
        assert!(!folder.exists());

        let lock = ClaudeConfigLock::take(&config, started + Duration::from_secs(10))
            .await
            .unwrap();
        fs::write(folder.join("held"), b"").unwrap();

        assert!(lock.release().is_err());
        assert!(folder.is_dir());
    }
}
