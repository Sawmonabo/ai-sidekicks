//! What the captures and their packing report to the service log: the capture steps a failure
//! names, why a prune was skipped, and the diagnostic that logs itself.

use std::error::Error;
use std::io;
use std::path::PathBuf;

use sidekicks_contracts::place::Place;
use sidekicks_contracts::run::id::RunId;
use strum::IntoStaticStr;

use sidekicks_contracts::repo::git_reads::GitObjectId;

use crate::git::process::version::{GitFeature, GitVersion};
use crate::git::turn_snapshot::retention::RunContextKey;

/// The steps of a turn snapshot or a command capture, named on a failed capture. `detectSparseRoot`
/// and `checkSparseRules` (the matcher failed) fail closed, never as a checkout that is not sparse.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub enum CaptureStep {
    /// The daemon's git lacks a feature this capture needs, or its version could not be read;
    /// nothing was written.
    GitFloor,
    /// The supplied checkout is not the top level of the working tree holding the execution root.
    VerifyCheckoutRoot,
    /// Opening, or making, the owner's capture folder for the repository.
    OpenCaptureFolder,
    /// Making the scratch index the capture stages into.
    PrepareScratchIndex,
    /// Opening, or seeding, the checkout's kept index a command capture stages into.
    OpenKeptIndex,
    /// Resolving the base commit the snapshot's tree starts from.
    ResolveBase,
    /// Finding whether the checkout is sparse.
    DetectSparseRoot,
    /// Seeding the scratch index from the base.
    SeedIndex,
    /// Listing the checkout's tracked and untracked paths.
    ListPaths,
    /// Listing the checkout's ignored files and folders.
    ListIgnoredPaths,
    /// Splitting the listing by the live sparse rules.
    CheckSparseRules,
    /// Reading the size of each listed path, so a file over the size bound is left out.
    ReadPathSizes,
    /// Staging the listed paths into the scratch index.
    StagePaths,
    /// Recording each untracked embedded repository as a gitlink.
    NormalizeEmbeddedRepositories,
    /// Removing the paths over the size bound from the kept index at a command's after-capture.
    RemoveLargePaths,
    /// Writing the scratch index's tree.
    WriteTree,
    /// Committing the tree as the snapshot.
    CommitTree,
    /// Writing the snapshot's ref, create-only.
    WriteRef,
    /// Reading what a command changed between its two captures' trees.
    DiffTrees,
}

/// Which of a command's two captures ran: the one before the command or the one after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub enum CommandCapturePhase {
    /// The capture taken before the command runs.
    Before,
    /// The capture taken once the command ended.
    After,
}

/// Why one run's snapshot refs were not pruned.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub enum TurnSnapshotRetentionSkipReason {
    /// The run has not ended (its context row carries no release time), so its refs stay.
    RunNotEnded,
    /// The run has no context row, so no git folder was recorded for it.
    RunContextAbsent,
    /// The row read failed (a closed handle, a schema fault); unlike absent, retry the prune.
    RunContextUnreadable,
    /// The owner has no capture folder for the recorded repository: none was made, or it went
    /// with its owner.
    GitDirAbsent,
    /// The capture folder could not be reached, or it exists but listing its refs failed:
    /// permissions, a bad object store, no `git`, or a hook folder failure.
    GitDirUnusable,
    /// The listing succeeded but an `update-ref -d` did not; refs already deleted still count.
    RefDeleteFailed,
}

/// What the captures and their packing report to the service log: a diagnostic is the daemon's
/// own, unlike the typed errors that reach the wire.
#[derive(Debug)]
pub(crate) enum CaptureDiagnostic {
    /// The daemon's git lacks a feature a capture or the packing needs, so that work is refused or
    /// skipped; logged once per place and feature for the daemon's run.
    GitBelowFloor {
        /// The project's place, `None` for the daemon's own system.
        place: Option<Place>,
        /// The release git named.
        git_version: GitVersion,
        /// The feature it lacks, whose first release is the floor.
        feature: GitFeature,
    },
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
        failed_step: CaptureStep,
        /// The failure of whichever step failed.
        detail: Box<dyn Error + Send + Sync>,
    },
    /// One of a command's two captures did not complete; the command runs anyway.
    CommandCaptureFailed {
        /// The checkout the command runs in.
        checkout_root: PathBuf,
        /// Which of the two captures failed.
        phase: CommandCapturePhase,
        /// The step that failed.
        failed_step: CaptureStep,
        /// The failure of whichever step failed.
        detail: Box<dyn Error + Send + Sync>,
    },
    /// What a capture borrows from the repository was not packed into its capture folder, so a gc
    /// in the repository may take it until a later pack or the sweep copies it.
    PackFailed {
        /// The capture folder.
        capture_folder: PathBuf,
        /// The failure.
        detail: Box<dyn Error + Send + Sync>,
    },
    /// A capture folder's packs were not folded; they stay readable, only more of them.
    FoldFailed {
        /// The capture folder.
        capture_folder: PathBuf,
        /// The failure.
        detail: Box<dyn Error + Send + Sync>,
    },
    /// A base the captures of a capture folder stand on is gone from the repository or names no
    /// commit, so the sweep packs nothing for their trees.
    BaseLost {
        /// The capture folder.
        capture_folder: PathBuf,
        /// The base.
        base: GitObjectId,
        /// The kind of object the base names, `None` when the repository lacks it.
        found_type: Option<String>,
    },
    /// A ref under the captures' namespace does not read as one capture over at most one base, so
    /// the sweep leaves it out.
    UnreadableRef {
        /// The capture folder.
        capture_folder: PathBuf,
        /// The listing's line for the ref, read as UTF-8 with any other byte replaced.
        line: String,
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
    /// The scratch index, in the capture folder, could not be removed after a capture, so a
    /// surviving file is noticed.
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

impl CaptureDiagnostic {
    /// Logs the diagnostic as one warning on the service log, its failure with every cause.
    pub(crate) fn warn(&self) {
        match self {
            Self::GitBelowFloor {
                place,
                git_version,
                feature,
            } => tracing::warn!(
                place = ?place,
                git_version = %git_version,
                git_floor = %feature.floor(),
                refused = refused_work(*feature),
                "The daemon's git is older than this work needs, so it is not done"
            ),
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
            Self::CommandCaptureFailed {
                checkout_root,
                phase,
                failed_step,
                detail,
            } => tracing::warn!(
                checkout_root = %checkout_root.display(),
                phase = <&str>::from(*phase),
                failed_step = <&str>::from(*failed_step),
                error = &**detail as &(dyn Error + 'static),
                "A command's capture was not taken"
            ),
            Self::PackFailed {
                capture_folder,
                detail,
            } => tracing::warn!(
                capture_folder = %capture_folder.display(),
                error = &**detail as &(dyn Error + 'static),
                "What a capture borrows from the repository was not packed"
            ),
            Self::FoldFailed {
                capture_folder,
                detail,
            } => tracing::warn!(
                capture_folder = %capture_folder.display(),
                error = &**detail as &(dyn Error + 'static),
                "A capture folder's packs were not folded"
            ),
            Self::BaseLost {
                capture_folder,
                base,
                found_type,
            } => tracing::warn!(
                capture_folder = %capture_folder.display(),
                base = base.as_str(),
                found_type = found_type.as_deref(),
                "A capture base is gone or names no commit, so its captures' trees are not packed"
            ),
            Self::UnreadableRef {
                capture_folder,
                line,
            } => tracing::warn!(
                capture_folder = %capture_folder.display(),
                line = line.as_str(),
                "A capture ref does not read as one capture, so the sweep leaves it out"
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

// What a git lacking `feature` leaves undone, in the log's words.
fn refused_work(feature: GitFeature) -> &'static str {
    match feature {
        GitFeature::CoreFsync => "every capture is refused",
        GitFeature::SparseCheckoutCheckRules => "a capture in a sparse checkout is refused",
        GitFeature::RepackGeometric => "the capture folders' packs are not folded",
    }
}
