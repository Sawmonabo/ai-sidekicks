//! Gives a whole file its real name without replacing a file that already has it. The file, written
//! under a temporary name beside the target, is hard-linked to the target's name, which refuses a
//! name already taken in the same step, and the temporary name is then removed. A volume with no
//! hard links (`exFAT` on macOS, FAT and `exFAT` on Linux, `exFAT` and FAT32 on Windows, each of
//! which refuses the link) takes a check that the name is free and a rename instead: a file made
//! under the name between the two is the one case replaced.

use std::io;
use std::path::Path;

use crate::cleanup_failures::CleanupFailures;
use crate::missing_entry::MissingEntry;

/// How a publish ended: the file has the target's name, or another file had it already.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PublishOutcome {
    /// The file now has the target's name.
    Published,
    /// Another file had the name, which was left as it was.
    TargetExists,
}

/// Names the whole file at `temporary_path` `target_path` and removes `temporary_path` either way.
/// A file already at `target_path` is never replaced, but for one made there, on a volume with no
/// hard links, between the name check and the rename. A failure is returned once `temporary_path`
/// is removed, with the removal's own failure beside it when that fails too.
pub(crate) async fn publish_without_replacing(
    temporary_path: &Path,
    target_path: &Path,
) -> Result<PublishOutcome, CleanupFailures<io::Error>> {
    match tokio::fs::hard_link(temporary_path, target_path).await {
        Ok(()) => {
            remove_temporary(temporary_path).await?;
            Ok(PublishOutcome::Published)
        }
        Err(link_failure) if link_failure.kind() == io::ErrorKind::AlreadyExists => {
            remove_temporary(temporary_path).await?;
            Ok(PublishOutcome::TargetExists)
        }
        Err(link_failure) if sidekicks_platforms::is_hard_link_unsupported(&link_failure) => {
            rename_into_free_name(temporary_path, target_path).await
        }
        Err(link_failure) => Err(remove_temporary_after(link_failure, temporary_path).await),
    }
}

// The publish on a volume with no hard links: a rename once the name is checked free.
async fn rename_into_free_name(
    temporary_path: &Path,
    target_path: &Path,
) -> Result<PublishOutcome, CleanupFailures<io::Error>> {
    let renamed = async {
        if is_name_taken(target_path).await? {
            return Ok(false);
        }
        tokio::fs::rename(temporary_path, target_path).await?;
        Ok(true)
    };
    match renamed.await {
        Ok(true) => Ok(PublishOutcome::Published),
        Ok(false) => {
            remove_temporary(temporary_path).await?;
            Ok(PublishOutcome::TargetExists)
        }
        Err(failure) => Err(remove_temporary_after(failure, temporary_path).await),
    }
}

// Anything under the name takes it, a link included; only its absence leaves it free.
async fn is_name_taken(path: &Path) -> io::Result<bool> {
    Ok(tokio::fs::symlink_metadata(path)
        .await
        .none_if_missing()?
        .is_some())
}

async fn remove_temporary(temporary_path: &Path) -> Result<(), CleanupFailures<io::Error>> {
    tokio::fs::remove_file(temporary_path)
        .await
        .map_err(|removal_failure| CleanupFailures::new(removal_failure, Vec::new(), PUBLISHING))
}

// Removes the temporary file after `failure`, keeping the removal's own failure beside it.
async fn remove_temporary_after(
    failure: io::Error,
    temporary_path: &Path,
) -> CleanupFailures<io::Error> {
    let removal_failures = match tokio::fs::remove_file(temporary_path).await {
        Ok(()) => Vec::new(),
        Err(removal_failure) => vec![removal_failure],
    };
    CleanupFailures::new(failure, removal_failures, PUBLISHING)
}

// What a publish's failure names as its operation.
const PUBLISHING: &str = "publishing the file";
