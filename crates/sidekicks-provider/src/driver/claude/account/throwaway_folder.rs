//! A configuration folder made for one Claude Code process on an account's credential store and
//! removed after it, so the process keeps nothing: the token status read's and the smallest
//! turn's.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::remove_tree;

use crate::driver::contract::error::DriverError;

/// Runs `run` on a folder made for it under `data_folder`'s `kind` folder, then removes the
/// folder; the answer stands whether or not the folder goes, a failed removal logged. Fails as
/// the folder cannot be made, and as `run` fails.
pub(super) async fn run_in_throwaway_folder<Answer>(
    data_folder: &Path,
    kind: [&str; 2],
    run: impl AsyncFnOnce(PathBuf) -> Result<Answer, DriverError>,
) -> Result<Answer, DriverError> {
    let folder = kind
        .iter()
        .fold(data_folder.to_path_buf(), |folder, name| folder.join(name))
        .join(mint_uuid_v7().to_string());
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let answer = run(folder.clone()).await;
    let removed_folder = folder.clone();
    let removed = tokio::task::spawn_blocking(move || remove_tree(&removed_folder))
        .await
        .map_err(io::Error::other)
        .and_then(|removed| removed);
    if let Err(error) = removed {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            folder = %folder.display(),
            "a Claude Code process's throwaway folder could not be removed"
        );
    }
    answer
}
