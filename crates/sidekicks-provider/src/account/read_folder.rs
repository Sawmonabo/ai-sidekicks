//! The folder an account read of a provider runs on: made under the daemon's data folder for the
//! one read and removed once the read has answered or been dropped.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::remove_tree;
use sidekicks_std::file::remove_tree_awaited;

use crate::driver::contract::error::DriverError;

/// Runs `read` on a folder of its own under `reads_folder` in `data_folder`, then removes the
/// folder, also when the read is dropped before it answers; the read's answer stands whether or
/// not the folder goes, and a failed removal is logged. Fails as the folder cannot be made, or as
/// `read` fails.
pub(crate) async fn run_in_read_folder<Answer>(
    data_folder: &Path,
    reads_folder: &[&str],
    read: impl AsyncFnOnce(&Path) -> Result<Answer, DriverError>,
) -> Result<Answer, DriverError> {
    let folder = compose_reads_folder(data_folder, reads_folder).join(mint_uuid_v7().to_string());
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let mut held = ReadFolder(Some(folder.clone()));
    let answer = read(&folder).await;
    held.0 = None;
    log_unremoved(remove_tree_awaited(&folder).await);
    answer
}

/// The folder in `data_folder` that holds each read's own folder under `reads_folder`.
pub(crate) fn compose_reads_folder(data_folder: &Path, reads_folder: &[&str]) -> PathBuf {
    reads_folder
        .iter()
        .fold(data_folder.to_path_buf(), |folder, name| folder.join(name))
}

// A read's own folder while the read runs: a read dropped before it answers, as a bound on the
// read drops it, removes the folder on a blocking thread.
struct ReadFolder(Option<PathBuf>);

impl Drop for ReadFolder {
    fn drop(&mut self) {
        let Some(folder) = self.0.take() else {
            return;
        };
        let remove = move || log_unremoved(remove_tree(&folder));
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(remove)),
            // Dropped off the runtime, where a blocking removal holds no task up.
            Err(_outside_runtime) => remove(),
        }
    }
}

// Logs a removal that failed; the folder's path stays out of the log, since it names the
// person's home.
fn log_unremoved(removed: io::Result<()>) {
    if let Err(error) = removed {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "an account read's folder could not be removed"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{compose_reads_folder, run_in_read_folder};

    // A read the bound drops mid-read leaves no folder behind. Killed by the drop's removal taken
    // away, which leaves the folder and the file the read wrote in it.
    #[tokio::test]
    async fn a_dropped_read_leaves_no_folder() {
        let data_folder = tempfile::tempdir().expect("a data folder");
        let reads_folder = ["claude", "window-start"];

        let dropped = tokio::time::timeout(
            Duration::from_millis(100),
            run_in_read_folder(data_folder.path(), &reads_folder, async |folder| {
                tokio::fs::write(folder.join("session.jsonl"), b"{}")
                    .await
                    .expect("the read writes into its folder");
                std::future::pending::<Result<(), _>>().await
            }),
        )
        .await;
        assert!(dropped.is_err(), "the read never answers");

        let reads = compose_reads_folder(data_folder.path(), &reads_folder);
        let mut left = 1;
        for _ in 0..500 {
            left = std::fs::read_dir(&reads)
                .expect("the reads' folder stays")
                .count();
            if left == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(left, 0, "the dropped read's folder is removed");
    }
}
