//! The kept index: one per checkout in its capture folder, a copy of the checkout's own index that
//! a command's two captures stage into. It is seeded from the live index at first use and again
//! whenever HEAD has moved since, and reused as it stands in between; a checkout with no commit yet
//! seeds it empty, since it may have no live index to copy. A turn snapshot never stages into it:
//! it keeps a scratch index of its own.

use std::path::{Path, PathBuf};

use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_platforms::create_private_folder;
use sidekicks_std::missing_entry::MissingEntry as _;

use crate::git::process::GitCall;
use crate::git::turn_snapshot::capture_folder::real_path_name;
use crate::git::turn_snapshot::capture_steps::{
    CaptureStepError, SnapshotCheckout, index_lock_path, joined,
};

/// The extension of the file beside a kept index that records the HEAD it was seeded at.
const SEEDED_HEAD_EXTENSION: &str = "head";

/// A checkout's kept index, seeded at the checkout's current HEAD.
#[derive(Debug)]
pub(crate) struct KeptIndex {
    /// The index file in the capture folder.
    path: PathBuf,
    /// The HEAD resolved when the index was opened, `None` for a checkout with no commit yet.
    head: Option<GitObjectId>,
}

impl KeptIndex {
    /// The index file, for a git call's `GIT_INDEX_FILE`.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// The HEAD the index was opened at, read once: a capture's base and its commit's parent, so
    /// a branch moving mid-capture cannot pair them apart. `None` for a checkout with no commit.
    pub(crate) fn head(&self) -> Option<&GitObjectId> {
        self.head.as_ref()
    }
}

/// The kept index of `checkout`, at `indexes/<sha256 of the checkout's real path>` in its capture
/// folder: seeded from the checkout's live index, or empty when HEAD is unborn, and refreshed when
/// it is absent or HEAD differs from the one recorded beside it, else reused as it stands; a lock
/// file a git ended mid-write left beside it is removed first. The caller holds the checkout's
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
    // A git cut at its time bound, or a daemon crash, leaves this lock, which would fail every
    // later stage into the index; under the checkout's lock no live git holds it.
    tokio::fs::remove_file(index_lock_path(&path))
        .await
        .none_if_missing()
        .map_err(CaptureStepError::KeptIndex)?;
    let head = checkout.resolve_base_commit().await?;
    // An unborn HEAD is recorded as an empty file, which no id reads as.
    let head_record = head.as_ref().map_or("", GitObjectId::as_str);
    let recorded = tokio::fs::read_to_string(&seeded_head)
        .await
        .none_if_missing()
        .map_err(CaptureStepError::KeptIndex)?;
    let is_present = tokio::fs::try_exists(&path)
        .await
        .map_err(CaptureStepError::KeptIndex)?;
    if is_present && recorded.as_deref() == Some(head_record) {
        return Ok(KeptIndex { path, head });
    }

    let folder = indexes.clone();
    joined(tokio::task::spawn_blocking(move || create_private_folder(&folder)).await)
        .map_err(CaptureStepError::IndexFolder)?;
    // Gone before the seed starts, so a seed cut short is never taken for one at this HEAD.
    tokio::fs::remove_file(&seeded_head)
        .await
        .none_if_missing()
        .map_err(CaptureStepError::KeptIndex)?;
    if head.is_some() {
        checkout.seed_scratch_index_from_live_index(&path).await?;
        // The copy's stat data is the live index's; a refresh brings it to the checkout as it is
        // now.
        let refresh = GitCall::read(checkout.on_index_copy(&["update-index", "-q", "--refresh"]))
            .with_environment("GIT_INDEX_FILE", &path);
        checkout
            .git
            .run(checkout.place, checkout.writing_capture_objects(refresh))
            .await?;
    } else {
        // A fresh `git init` has no live index, and the person's is never written.
        checkout.seed_index_from_base(&path, None).await?;
    }
    tokio::fs::write(&seeded_head, head_record)
        .await
        .map_err(CaptureStepError::KeptIndex)?;
    Ok(KeptIndex { path, head })
}

#[cfg(test)]
mod tests;
