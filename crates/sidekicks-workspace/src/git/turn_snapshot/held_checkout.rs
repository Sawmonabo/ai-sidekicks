//! The start every capture shares: the git checked against the features the capture needs, the
//! supplied checkout checked against the live tree, whether it is sparse, the checkout's lock taken
//! and its capture folder opened, so an old git or a wrong checkout writes nothing.

use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_platforms::{path_from_program_output, real_path};
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::version::GitFeature;
use crate::git::process::{
    GitCall, GitError, GitRunner, in_folder, read_git_common_folder, strip_line_end,
};
use crate::git::turn_snapshot::capture::GitFloorReports;
use crate::git::turn_snapshot::capture_folder::CaptureFolder;
use crate::git::turn_snapshot::capture_steps::{
    CaptureStepError, SnapshotCheckout, detect_sparse_root, joined,
};
use crate::git::turn_snapshot::diagnostics::CaptureStep;

/// The folders a capture names, each resolved by its caller.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CaptureRoots<'roots> {
    /// The folder of the capture's owner, whose capture folders hold its captures.
    pub(crate) owner_folder: &'roots Path,
    /// Where the run works: the worktree, or the bound folder of a bound root.
    pub(crate) execution_root: &'roots Path,
    /// The top level of the working tree holding `execution_root`, as its caller records it; a
    /// value the live tree disagrees with fails the start.
    pub(crate) checkout_root: &'roots Path,
}

/// A checkout held for one capture: its verified top level, its repository's common git folder,
/// its capture folder, whether it is sparse, and the hold on its lock, which releases the checkout
/// when it drops.
pub(crate) struct HeldCheckout<'lock> {
    /// The checkout's top level, symlinks resolved.
    pub(crate) root: PathBuf,
    /// The repository's common git folder, as git names it.
    pub(crate) common_folder: PathBuf,
    /// The owner's capture folder for the checkout's repository.
    pub(crate) capture_folder: CaptureFolder,
    /// Whether the checkout is sparse.
    pub(crate) is_sparse_root: bool,
    /// The hold on the checkout's lock.
    pub(crate) hold: KeyHold<'lock, PathBuf>,
}

impl HeldCheckout<'_> {
    /// Where the capture's git calls run: `git` for the project at `place`, in this checkout.
    pub(crate) fn checkout<'checkout>(
        &'checkout self,
        git: &'checkout GitRunner,
        place: Option<&'checkout Place>,
    ) -> SnapshotCheckout<'checkout> {
        SnapshotCheckout {
            git,
            place,
            root: &self.root,
            capture_folder: &self.capture_folder,
        }
    }
}

/// Why a capture's start did not hold the checkout.
#[derive(Debug)]
pub(crate) enum CaptureStartFailure {
    /// The git lacks a feature this capture needs, already reported once for its place.
    BelowFloor,
    /// A step of the start failed.
    Failed(CaptureStep, CaptureStepError),
}

/// Checks the git for the project at `place` against the features the capture needs, checks the
/// supplied checkout against the live tree, finds whether it is sparse, takes its lock in
/// `checkout_lock` and opens, or makes, its capture folder, in that order, so nothing is written
/// before every check passes. Fails with `BelowFloor` when the git lacks a feature, reporting it
/// once per place and feature through `floor_reports`, and with the failed step otherwise.
pub(crate) async fn hold_checkout<'lock>(
    git: &GitRunner,
    place: Option<&Place>,
    checkout_lock: &'lock KeyedLock<PathBuf>,
    floor_reports: &GitFloorReports,
    roots: CaptureRoots<'_>,
) -> Result<HeldCheckout<'lock>, CaptureStartFailure> {
    use CaptureStep as Step;

    check_git_feature(git, place, floor_reports, GitFeature::CoreFsync).await?;
    let (root, git_common_folder) = verify_checkout_root(git, place, roots)
        .await
        .map_err(|failure| CaptureStartFailure::Failed(Step::VerifyCheckoutRoot, failure))?;
    let is_sparse_root = detect_sparse_root(git, place, &root)
        .await
        .map_err(|failure| CaptureStartFailure::Failed(Step::DetectSparseRoot, failure))?;
    if is_sparse_root {
        check_git_feature(
            git,
            place,
            floor_reports,
            GitFeature::SparseCheckoutCheckRules,
        )
        .await?;
    }
    let checkout_key = canonical_folder_path(&root).await.map_err(|failure| {
        CaptureStartFailure::Failed(
            Step::VerifyCheckoutRoot,
            CaptureStepError::CheckoutUnresolved(failure),
        )
    })?;
    let hold = checkout_lock.acquire(checkout_key).await;
    let capture_folder =
        CaptureFolder::open_or_create(git, place, roots.owner_folder, &git_common_folder)
            .await
            .map_err(|failure| {
                CaptureStartFailure::Failed(Step::OpenCaptureFolder, failure.into())
            })?;
    Ok(HeldCheckout {
        root,
        common_folder: git_common_folder,
        capture_folder,
        is_sparse_root,
        hold,
    })
}

// Refuses a git at `place` that lacks `feature`, reporting it once; an unreadable version fails the
// floor step with its error.
async fn check_git_feature(
    git: &GitRunner,
    place: Option<&Place>,
    floor_reports: &GitFloorReports,
    feature: GitFeature,
) -> Result<(), CaptureStartFailure> {
    match git.version(place, feature).await {
        Ok(version) if version.has(feature) => Ok(()),
        Ok(version) => {
            floor_reports.report_once(place, version, feature);
            Err(CaptureStartFailure::BelowFloor)
        }
        Err(failure) => Err(CaptureStartFailure::Failed(
            CaptureStep::GitFloor,
            failure.into(),
        )),
    }
}

// The supplied checkout, symlinks resolved, once git names it as the top level of the working tree
// holding the execution root, and the repository's common git folder.
async fn verify_checkout_root(
    git: &GitRunner,
    place: Option<&Place>,
    roots: CaptureRoots<'_>,
) -> Result<(PathBuf, PathBuf), CaptureStepError> {
    let (supplied, live, git_common_folder) = tokio::try_join!(
        resolve_symlinks(roots.checkout_root.to_path_buf()),
        read_live_top_level(git, place, roots.execution_root),
        async {
            read_git_common_folder(git, place, roots.execution_root, None)
                .await
                .map_err(CaptureStepError::from)
        }
    )?;
    if supplied != live {
        return Err(CaptureStepError::CheckoutMismatch);
    }
    Ok((supplied, git_common_folder))
}

// The top level of the working tree holding `execution_root`, symlinks resolved.
async fn read_live_top_level(
    git: &GitRunner,
    place: Option<&Place>,
    execution_root: &Path,
) -> Result<PathBuf, CaptureStepError> {
    let call = GitCall::read(in_folder(execution_root, &["rev-parse", "--show-toplevel"]));
    let output = git.run(place, call).await?;
    let top_level =
        path_from_program_output(strip_line_end(output.stdout)).map_err(GitError::PathText)?;
    resolve_symlinks(top_level).await
}

// `path` with every symlink resolved, on the blocking pool.
async fn resolve_symlinks(path: PathBuf) -> Result<PathBuf, CaptureStepError> {
    joined(tokio::task::spawn_blocking(move || real_path(&path)).await)
        .map_err(CaptureStepError::CheckoutUnresolved)
}
