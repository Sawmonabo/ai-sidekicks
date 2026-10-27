//! The daemon's one read retry: a read that fails in a way another moment can clear is tried once
//! more after a fixed 100 ms, git's own lock-retry window, before anything is answered. A second
//! failure, or any other, reaches the caller with the system's own reason.

use std::io;
use std::time::Duration;

/// How long the one retry waits.
const READ_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Whether a filesystem read's failure is one another moment can clear: a busy or locked entry, an
/// interrupted call, or a process or system out of open files.
pub(crate) fn is_retryable_read_failure(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    ) || sidekicks_platforms::is_resource_busy(error)
        || sidekicks_platforms::is_out_of_open_files(error)
}

/// Runs `read`, and once more after [`READ_RETRY_DELAY`] when it fails in a way `is_retryable`
/// accepts; any other failure, and the retry's own, is returned as it came.
pub(crate) async fn read_with_one_retry<Output, Failure, Read>(
    mut read: impl FnMut() -> Read,
    is_retryable: impl Fn(&Failure) -> bool,
) -> Result<Output, Failure>
where
    Read: Future<Output = Result<Output, Failure>>,
{
    match read().await {
        Err(failure) if is_retryable(&failure) => {
            tokio::time::sleep(READ_RETRY_DELAY).await;
            read().await
        }
        Err(failure) => Err(failure),
        Ok(output) => Ok(output),
    }
}
