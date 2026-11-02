//! The kept index: one per checkout in its capture folder, a copy of the checkout's own index that
//! the later captures of a command or an edit stage into. It is seeded from the live index at first
//! use and again whenever HEAD has moved since, and reused as it stands in between. A turn
//! snapshot never stages into it: it keeps a scratch index of its own.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the command and edit captures stage into the kept index"
    )
)]

use std::path::{Path, PathBuf};

use sidekicks_platforms::create_private_folder;
use sidekicks_std::missing_entry::MissingEntry as _;

use crate::git::process::GitCall;
use crate::git::turn_snapshot::capture_folder::real_path_name;
use crate::git::turn_snapshot::capture_steps::{CaptureStepError, SnapshotCheckout, joined};

/// The extension of the file beside a kept index that records the HEAD it was seeded at.
const SEEDED_HEAD_EXTENSION: &str = "head";

/// A checkout's kept index, seeded at the checkout's current HEAD.
#[derive(Debug)]
pub(crate) struct KeptIndex {
    /// The index file in the capture folder.
    path: PathBuf,
}

impl KeptIndex {
    /// The index file, for a git call's `GIT_INDEX_FILE`.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

/// The kept index of `checkout`, at `indexes/<sha256 of the checkout's real path>` in its capture
/// folder: seeded from the checkout's live index and refreshed when it is absent or HEAD differs
/// from the one recorded beside it, else reused as it stands. The caller holds the checkout's
/// lock. Fails as resolving the checkout, its HEAD, the seed, git or the file system do.
pub(crate) async fn open_kept_index(
    checkout: &SnapshotCheckout<'_>,
) -> Result<KeptIndex, CaptureStepError> {
    let name = real_path_name(checkout.root)
        .await
        .map_err(CaptureStepError::CheckoutUnresolved)?;
    let indexes = checkout.capture_folder.indexes_folder();
    let path = indexes.join(&name);
    let seeded_head = indexes.join(format!("{name}.{SEEDED_HEAD_EXTENSION}"));
    let head = checkout.resolve_base_commit().await?;
    let recorded = tokio::fs::read_to_string(&seeded_head)
        .await
        .none_if_missing()
        .map_err(CaptureStepError::KeptIndex)?;
    let is_present = tokio::fs::try_exists(&path)
        .await
        .map_err(CaptureStepError::KeptIndex)?;
    if is_present && recorded.as_deref() == Some(head.as_str()) {
        return Ok(KeptIndex { path });
    }

    let folder = indexes.clone();
    joined(tokio::task::spawn_blocking(move || create_private_folder(&folder)).await)
        .map_err(CaptureStepError::IndexFolder)?;
    // Gone before the seed starts, so a seed cut short is never taken for one at this HEAD.
    tokio::fs::remove_file(&seeded_head)
        .await
        .none_if_missing()
        .map_err(CaptureStepError::KeptIndex)?;
    checkout.seed_scratch_index_from_live_index(&path).await?;
    // The copy's stat data is the live index's; a refresh brings it to the checkout as it is now.
    let refresh = GitCall::read(checkout.on_index_copy(&["update-index", "-q", "--refresh"]))
        .with_environment("GIT_INDEX_FILE", &path);
    checkout
        .git
        .run(checkout.place, checkout.writing_capture_objects(refresh))
        .await?;
    tokio::fs::write(&seeded_head, head.as_str())
        .await
        .map_err(CaptureStepError::KeptIndex)?;
    Ok(KeptIndex { path })
}

#[cfg(test)]
mod tests;
