//! The folder an account read of Claude Code runs on: made under the daemon's data folder for the
//! one read, as the throwaway configuration home over the account's own credential store, and
//! removed once the read has answered.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::remove_tree;

use crate::driver::contract::error::DriverError;

/// Runs `read` on a folder of its own under `reads_folder` in `data_folder`, then removes the
/// folder; the read's answer stands whether or not the folder goes, and a failed removal is
/// logged. Fails as the folder cannot be made, or as `read` fails.
pub(super) async fn run_in_read_folder<Answer>(
    data_folder: &Path,
    reads_folder: &[&str],
    read: impl AsyncFnOnce(&Path) -> Result<Answer, DriverError>,
) -> Result<Answer, DriverError> {
    let folder = compose_reads_folder(data_folder, reads_folder).join(mint_uuid_v7().to_string());
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let answer = read(&folder).await;
    let removed_folder = folder.clone();
    let removed = tokio::task::spawn_blocking(move || remove_tree(&removed_folder))
        .await
        .map_err(io::Error::other)
        .and_then(|removed| removed);
    if let Err(error) = removed {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            folder = %folder.display(),
            "a Claude Code account read's folder could not be removed"
        );
    }
    answer
}

/// The folder in `data_folder` that holds each read's own folder under `reads_folder`.
pub(super) fn compose_reads_folder(data_folder: &Path, reads_folder: &[&str]) -> PathBuf {
    reads_folder
        .iter()
        .fold(data_folder.to_path_buf(), |folder, name| folder.join(name))
}
