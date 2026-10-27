//! What the snapshot service reports to the service log: the capture steps a failure names, why a
//! prune was skipped, and the diagnostic that logs itself.

use std::error::Error;
use std::io;
use std::path::PathBuf;

use sidekicks_contracts::run::id::RunId;
use strum::IntoStaticStr;

use crate::git::turn_snapshot::retention::RunContextKey;

/// The capture steps in order, named on a failed capture. `detectSparseRoot` and
/// `checkSparseRules` (the matcher failed, or git is older than 2.41) fail closed, never as a
/// checkout that is not sparse.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum TurnSnapshotCaptureStep {
    /// The supplied checkout is not the top level of the working tree holding the execution root.
    VerifyCheckoutRoot,
    /// Making the scratch index the capture stages into.
    PrepareScratchIndex,
    /// Resolving the base commit the snapshot's tree starts from.
    ResolveBase,
    /// Finding whether the checkout is sparse.
    DetectSparseRoot,
    /// Seeding the scratch index from the base.
    SeedIndex,
    /// Listing the checkout's tracked and untracked paths.
    ListPaths,
    /// Splitting the listing by the live sparse rules.
    CheckSparseRules,
    /// Staging the listed paths into the scratch index.
    StagePaths,
    /// Recording each untracked embedded repository as a gitlink.
    NormalizeEmbeddedRepositories,
    /// Writing the scratch index's tree.
    WriteTree,
    /// Committing the tree as the snapshot.
    CommitTree,
    /// Writing the snapshot's ref, create-only.
    WriteRef,
}

/// Why one run's snapshot refs were not pruned.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum TurnSnapshotRetentionSkipReason {
    /// The run has not ended (its context row carries no release time), so its refs stay.
    RunNotEnded,
    /// The run has no context row, so no git folder was recorded for it.
    RunContextAbsent,
    /// The row read failed (a closed handle, a schema fault); unlike absent, retry the prune.
    RunContextUnreadable,
    /// The recorded `git_common_dir` is gone (the repository was removed).
    GitDirAbsent,
    /// The recorded folder exists but listing its refs failed: permissions, a bad object store, no
    /// `git`, or a hook folder failure.
    GitDirUnusable,
    /// The listing succeeded but an `update-ref -d` did not; refs already deleted still count.
    RefDeleteFailed,
}

/// What the snapshot service reports to the service log. Paths appear on purpose: a diagnostic is
/// the daemon's own, unlike the typed errors that reach the wire.
#[derive(Debug)]
pub(crate) enum TurnSnapshotDiagnostic {
    /// A turn's snapshot was not captured; the turn ends anyway.
    CaptureFailed {
        /// The run whose turn ended.
        run_id: RunId,
        /// The run's execution epoch.
        epoch: u64,
        /// The turn's ordinal within the epoch.
        turn_ordinal: u64,
        /// The ref the snapshot would have been written to.
        snapshot_ref: String,
        /// The step that failed.
        failed_step: TurnSnapshotCaptureStep,
        /// The failure of whichever step failed.
        detail: Box<dyn Error + Send + Sync>,
    },
    /// Untracked embedded repositories were not recorded as gitlinks: an unborn `HEAD` has no
    /// object id, or the object format differs from the superproject's (git 2.50.1).
    EmbeddedRepositoriesSkipped {
        /// The run whose turn ended.
        run_id: RunId,
        /// The run's execution epoch.
        epoch: u64,
        /// The turn's ordinal within the epoch.
        turn_ordinal: u64,
        /// The ref the snapshot was written to.
        snapshot_ref: String,
        /// Each skipped repository's path within the checkout.
        skipped_paths: Vec<String>,
    },
    /// The scratch index could not be removed after a capture, so a surviving file is noticed.
    ScratchIndexCleanupFailed {
        /// The run whose turn ended.
        run_id: RunId,
        /// The run's execution epoch.
        epoch: u64,
        /// The turn's ordinal within the epoch.
        turn_ordinal: u64,
        /// The scratch index, or the lock file beside it, left behind.
        scratch_index_path: PathBuf,
        /// The removal's failure.
        detail: io::Error,
    },
    /// One run's context row could not be read, so its refs were not pruned.
    RunContextReadFailed {
        /// The run, of either kind, whose refs were to be pruned.
        run_key: RunContextKey,
        /// The row read's failure.
        detail: Box<dyn Error + Send + Sync>,
    },
}

impl TurnSnapshotDiagnostic {
    /// Logs the diagnostic as one warning on the service log, its failure with every cause.
    pub(crate) fn warn(&self) {
        match self {
            Self::CaptureFailed {
                run_id,
                epoch,
                turn_ordinal,
                snapshot_ref,
                failed_step,
                detail,
            } => tracing::warn!(
                run_id = %run_id,
                epoch,
                turn_ordinal,
                snapshot_ref = snapshot_ref.as_str(),
                failed_step = <&str>::from(*failed_step),
                error = &**detail as &(dyn Error + 'static),
                "A turn snapshot was not captured"
            ),
            Self::EmbeddedRepositoriesSkipped {
                run_id,
                epoch,
                turn_ordinal,
                snapshot_ref,
                skipped_paths,
            } => tracing::warn!(
                run_id = %run_id,
                epoch,
                turn_ordinal,
                snapshot_ref = snapshot_ref.as_str(),
                skipped_paths = ?skipped_paths,
                "A turn snapshot left embedded repositories unrecorded"
            ),
            Self::ScratchIndexCleanupFailed {
                run_id,
                epoch,
                turn_ordinal,
                scratch_index_path,
                detail,
            } => tracing::warn!(
                run_id = %run_id,
                epoch,
                turn_ordinal,
                scratch_index_path = %scratch_index_path.display(),
                error = detail as &(dyn Error + 'static),
                "A turn snapshot's scratch index could not be removed"
            ),
            Self::RunContextReadFailed { run_key, detail } => tracing::warn!(
                run_id = %run_key,
                error = &**detail as &(dyn Error + 'static),
                "A run's context row could not be read, so its snapshots were not pruned"
            ),
        }
    }
}
