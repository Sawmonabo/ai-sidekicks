//! A command's two captures: one before the command runs and one after it ends, each staged into
//! the checkout's kept index and committed into the owner's capture folder, the after-capture
//! answering what changed between the two trees and the before-capture's blobs read back as the
//! changed files' before-images.
//!
//! - Each capture lists the tracked and untracked files under the tree's own `.gitignore` rules,
//!   plus the ignored files outside an ignored folder; an ignored folder is named, never staged.
//! - A file over the size bound is never hashed. At the after-capture it is also removed from the
//!   kept index, so a tracked file that grew past the bound reads as deleted, not as unchanged.
//! - `--no-empty-directory` (it drops a folder holding only ignored files from the ignored listing)
//!   and `--exclude-standard` (the person's own excludes are no project declaration) are never
//!   passed to the listings.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_platforms::path_from_program_output;
use sidekicks_std::keyed_lock::KeyedLock;

use crate::git::process::{GitCall, GitError, GitRunner, in_folder};
use crate::git::turn_snapshot::capture::{
    COMMAND_CAPTURE_SUBJECT, CheckoutCaptureInput, EXCLUDE_PER_DIRECTORY_GITIGNORE,
    GitFloorReports, LargeFile, SparseListingPartition, UnreadPath, join_nul_terminated_listing,
    split_nul_terminated_listing_bytes,
};
use crate::git::turn_snapshot::capture_folder::CaptureFolder;
use crate::git::turn_snapshot::capture_steps::{
    CaptureStepError, DiffTreeReadError, SnapshotCheckout, at,
};
use crate::git::turn_snapshot::diagnostics::{CaptureDiagnostic, CaptureStep, CommandCapturePhase};
use crate::git::turn_snapshot::held_checkout::{CaptureStartFailure, hold_checkout};
use crate::git::turn_snapshot::kept_index::{KeptIndex, open_kept_index};
use crate::git::turn_snapshot::refs::USE_REPLACE_REFS_PIN;
use crate::git::turn_snapshot::repack::{CapturePacking, CapturedCommit};

pub mod before_images;

/// One capture of a command's checkout, committed into the owner's capture folder.
#[derive(Debug)]
pub struct CommandCapture {
    /// The tree of the checkout's project state.
    pub tree: GitObjectId,
    /// The repository's HEAD the capture stood on, both its kept index's base and its commit's
    /// parent; `None` in a repository with no commit yet.
    pub head: Option<GitObjectId>,
    /// The listed files over the size bound, left out of the tree.
    pub large_files: Vec<LargeFile>,
    /// The listed paths whose size could not be read, left out of the tree.
    pub unread_paths: Vec<UnreadPath>,
    /// The ignored folders, each as git listed it with its trailing slash, named and not staged.
    pub ignored_folders: Vec<PathBuf>,
    /// The untracked embedded repositories not recorded as gitlinks, read as UTF-8 with any other
    /// byte replaced.
    pub skipped_embedded_repositories: Vec<String>,
    /// The capture's commit and its base, for packing what the capture borrows.
    pub objects: CapturedCommit,
    /// The checkout's top level, its links resolved.
    pub checkout_real_path: PathBuf,
    /// The repository's common git folder, which its capture folder is named for, as git names it.
    pub common_folder: PathBuf,
}

/// The capture taken after a command, with what changed since the one taken before it.
#[derive(Debug)]
pub struct CommandCaptureAfter {
    /// The after-capture.
    pub capture: CommandCapture,
    /// Each path whose entry differs between the before tree and this capture's tree, in git's
    /// path order; empty when the trees are one.
    pub changes: Vec<TreeChange>,
}

/// One side of a changed path: its entry in a tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    /// The entry's git mode, the number its six octal digits write (`0o100644` for a file).
    pub mode: u32,
    /// The entry's object.
    pub object: GitObjectId,
}

/// How one path differs between a command's two capture trees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TreeChange {
    /// The path is only in the after tree.
    Added {
        /// The path within the checkout.
        path: PathBuf,
        /// Its entry after the command.
        after: TreeEntry,
    },
    /// The path is only in the before tree.
    Deleted {
        /// The path within the checkout.
        path: PathBuf,
        /// Its entry before the command.
        before: TreeEntry,
    },
    /// The path's content or mode changed, its kind did not.
    Modified {
        /// The path within the checkout.
        path: PathBuf,
        /// Its entry before the command.
        before: TreeEntry,
        /// Its entry after the command.
        after: TreeEntry,
    },
    /// The path's kind changed: a file, a link or a gitlink became another.
    TypeChanged {
        /// The path within the checkout.
        path: PathBuf,
        /// Its entry before the command.
        before: TreeEntry,
        /// Its entry after the command.
        after: TreeEntry,
    },
}

/// Takes a command's two captures. Keeps nothing between calls; the old gits it meets go in the
/// daemon run's shared record.
pub struct CommandCaptureService {
    /// The daemon's git.
    git: GitRunner,
    /// The run setup gate's lock, keyed by each checkout's canonical folder, held while a capture
    /// stages into the checkout's kept index.
    checkout_lock: Arc<KeyedLock<PathBuf>>,
    /// The capture folders' packing, through which each capture folder opens.
    packing: Arc<CapturePacking>,
    /// The daemon run's record of the old gits already reported.
    floor_reports: Arc<GitFloorReports>,
}

impl CommandCaptureService {
    /// A service running `git`, holding a checkout in `checkout_lock`, the run setup gate's, while
    /// it captures it, opening its capture folder through `packing`, and reporting an old git once
    /// through `floor_reports`, the daemon run's.
    pub fn new(
        git: GitRunner,
        checkout_lock: Arc<KeyedLock<PathBuf>>,
        packing: Arc<CapturePacking>,
        floor_reports: Arc<GitFloorReports>,
    ) -> Self {
        Self {
            git,
            checkout_lock,
            packing,
            floor_reports,
        }
    }

    /// Captures the checkout before a command runs, running git for the project at `place`. Fails
    /// with the step that failed, the failure logged; a git too old fails with `GitFloor`, reported
    /// once per place and feature.
    pub async fn capture_before(
        &self,
        place: Option<&Place>,
        input: &CheckoutCaptureInput,
    ) -> Result<CommandCapture, CaptureStep> {
        let (capture, _) = self.capture(place, input, None).await?;
        Ok(capture)
    }

    /// Captures the checkout after a command ended and reads what changed since `before_tree`, the
    /// before-capture's tree, running git for the project at `place`. Fails as
    /// [`capture_before`](Self::capture_before) does, or with `DiffTrees` when the change listing
    /// fails or does not read.
    pub async fn capture_after(
        &self,
        place: Option<&Place>,
        input: &CheckoutCaptureInput,
        before_tree: &GitObjectId,
    ) -> Result<CommandCaptureAfter, CaptureStep> {
        let (capture, changes) = self.capture(place, input, Some(before_tree)).await?;
        Ok(CommandCaptureAfter { capture, changes })
    }

    // One capture and, at the after-capture (`before_tree` given), the changes since the before
    // tree, read once the checkout is released; each failure logged once with its phase.
    async fn capture(
        &self,
        place: Option<&Place>,
        input: &CheckoutCaptureInput,
        before_tree: Option<&GitObjectId>,
    ) -> Result<(CommandCapture, Vec<TreeChange>), CaptureStep> {
        let phase = if before_tree.is_some() {
            CommandCapturePhase::After
        } else {
            CommandCapturePhase::Before
        };
        let started = hold_checkout(
            &self.git,
            place,
            &self.checkout_lock,
            &self.packing,
            &self.floor_reports,
            input.roots(),
        )
        .await;
        let held = match started {
            Ok(held) => held,
            Err(CaptureStartFailure::BelowFloor) => return Err(CaptureStep::GitFloor),
            Err(CaptureStartFailure::Failed(step, failure)) => {
                return Err(report_failure(phase, step, failure));
            }
        };
        let checkout = held.checkout(&self.git, place);
        let captured =
            capture_checkout(&checkout, held.is_sparse_root, input.captured_at, phase).await;
        drop(held.hold);
        let captured = captured.map_err(|(step, failure)| report_failure(phase, step, failure))?;

        let changes = match before_tree {
            Some(before_tree) if *before_tree != captured.tree => read_tree_changes(
                &self.git,
                place,
                &held.root,
                &held.capture_folder,
                before_tree,
                &captured.tree,
            )
            .await
            .map_err(|failure| report_failure(phase, CaptureStep::DiffTrees, failure))?,
            Some(_) | None => Vec::new(),
        };
        let objects = CapturedCommit::new(
            held.capture_folder,
            captured.commit,
            captured.tree.clone(),
            captured.head.clone(),
        );
        let capture = CommandCapture {
            tree: captured.tree,
            head: captured.head,
            large_files: captured.large_files,
            unread_paths: captured.unread_paths,
            ignored_folders: captured.ignored_folders,
            skipped_embedded_repositories: captured.skipped_embedded_repositories,
            objects,
            checkout_real_path: held.root,
            common_folder: held.common_folder,
        };
        Ok((capture, changes))
    }
}

/// A failed step and why.
type StepFailure = (CaptureStep, CaptureStepError);

/// What one capture's steps produced, before its commit is handed over for packing.
struct CheckoutCapture {
    /// The capture's tree.
    tree: GitObjectId,
    /// The HEAD the kept index was opened at.
    head: Option<GitObjectId>,
    /// The capture's commit.
    commit: GitObjectId,
    /// The listed files over the size bound.
    large_files: Vec<LargeFile>,
    /// The listed paths whose size could not be read.
    unread_paths: Vec<UnreadPath>,
    /// The ignored folders, as git listed them.
    ignored_folders: Vec<PathBuf>,
    /// The embedded repositories not recorded.
    skipped_embedded_repositories: Vec<String>,
}

/// The ignored listing read: the ignored files staged with the first listing, and the folders git
/// listed whole.
#[derive(Debug, PartialEq, Eq)]
struct IgnoredListing<'listing> {
    /// The ignored files outside every ignored folder, which the capture stages.
    staged_entries: Vec<&'listing [u8]>,
    /// The ignored folders, each with its trailing slash, which the capture names and never
    /// stages.
    folders: Vec<&'listing [u8]>,
}

// The capture's steps on the held `checkout`, from opening its kept index to committing its tree;
// the large paths are removed from the kept index at the after-capture only.
async fn capture_checkout(
    checkout: &SnapshotCheckout<'_>,
    is_sparse_root: bool,
    captured_at: Timestamp,
    phase: CommandCapturePhase,
) -> Result<CheckoutCapture, StepFailure> {
    use CaptureStep as Step;

    let kept = open_kept_index(checkout)
        .await
        .map_err(at(Step::OpenKeptIndex))?;
    // `-c` lists the kept paths again so `--add --remove` re-stats each one; `-o` adds untracked
    // files under the tree's own `.gitignore` rules only, and the second listing the ignored ones.
    let (listing, ignored_listing) = tokio::try_join!(
        list_on_kept_index(
            checkout,
            &kept,
            &["ls-files", "-co", EXCLUDE_PER_DIRECTORY_GITIGNORE, "-z"],
            Step::ListPaths,
        ),
        list_on_kept_index(
            checkout,
            &kept,
            &[
                "ls-files",
                "-o",
                "-i",
                "--directory",
                EXCLUDE_PER_DIRECTORY_GITIGNORE,
                "-z"
            ],
            Step::ListIgnoredPaths,
        ),
    )?;
    let ignored = read_ignored_listing(&ignored_listing);
    let ignored_folders = ignored
        .folders
        .iter()
        .map(|folder| path_from_program_output(folder.to_vec()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|failure| CaptureStepError::from(GitError::PathText(failure)))
        .map_err(at(Step::ListIgnoredPaths))?;
    let full_listing = join_nul_terminated_listing(
        split_nul_terminated_listing_bytes(&listing).chain(ignored.staged_entries),
    );

    // Every entry is in the cone unless the root is sparse, where git's own matcher decides; an
    // out-of-cone entry keeps its kept-index entry, and the tree is checked for it after.
    let partition = if is_sparse_root {
        checkout
            .partition_listing_by_cone(&full_listing)
            .await
            .map_err(at(Step::CheckSparseRules))?
    } else {
        SparseListingPartition {
            in_cone_listing: full_listing.as_slice().into(),
            out_of_cone_entries: Vec::new(),
        }
    };
    let sizes = checkout
        .partition_listing_by_size(&partition.in_cone_listing)
        .await
        .map_err(at(Step::ReadPathSizes))?;
    checkout
        .stage_listing(kept.path(), &sizes.staged_listing)
        .await
        .map_err(at(Step::StagePaths))?;
    let skipped = checkout
        .normalize_embedded_repositories(kept.path(), &sizes.staged_listing)
        .await
        .map_err(at(Step::NormalizeEmbeddedRepositories))?;
    if phase == CommandCapturePhase::After && !sizes.large_entries.is_empty() {
        remove_large_paths(checkout, &kept, &sizes.large_entries)
            .await
            .map_err(at(Step::RemoveLargePaths))?;
    }
    let tree = checkout
        .write_snapshot_tree(kept.path())
        .await
        .map_err(at(Step::WriteTree))?;
    let sparse_boundary_paths = if is_sparse_root {
        Some(
            checkout
                .derive_sparse_boundary_paths(&tree, &partition.out_of_cone_entries)
                .await
                .map_err(at(Step::WriteTree))?,
        )
    } else {
        None
    };
    let commit = checkout
        .commit_snapshot_tree(
            &tree,
            kept.head(),
            COMMAND_CAPTURE_SUBJECT,
            &skipped,
            sparse_boundary_paths.as_deref(),
            &sizes.left_out_entries,
            captured_at,
        )
        .await
        .map_err(at(Step::CommitTree))?;
    let skipped_embedded_repositories = skipped
        .iter()
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect();
    Ok(CheckoutCapture {
        tree,
        head: kept.head().cloned(),
        commit,
        large_files: sizes.large_files,
        unread_paths: sizes.unread_paths,
        ignored_folders,
        skipped_embedded_repositories,
    })
}

// The `-z` listing `arguments` print on the kept index, failing as `step`.
async fn list_on_kept_index(
    checkout: &SnapshotCheckout<'_>,
    kept: &KeptIndex,
    arguments: &[&str],
    step: CaptureStep,
) -> Result<Vec<u8>, StepFailure> {
    let call = GitCall::read(checkout.on_index_copy(arguments))
        .with_environment("GIT_INDEX_FILE", kept.path());
    let output = checkout
        .git
        .run(checkout.place, call)
        .await
        .map_err(at(step))?;
    Ok(output.stdout)
}

// Removes the large entries from the kept index, so a tracked file now past the bound leaves the
// tree; an entry the index does not hold is no failure.
async fn remove_large_paths(
    checkout: &SnapshotCheckout<'_>,
    kept: &KeptIndex,
    large_entries: &[Vec<u8>],
) -> Result<(), CaptureStepError> {
    let arguments = checkout.on_index_copy(&["update-index", "--force-remove", "-z", "--stdin"]);
    let call = checkout
        .writing_capture_objects(GitCall::read(arguments))
        .with_environment("GIT_INDEX_FILE", kept.path())
        .with_input(join_nul_terminated_listing(large_entries));
    checkout.git.run(checkout.place, call).await?;
    Ok(())
}

// What changed from `before_tree` to `after_tree`, read in the checkout at `root` with the capture
// folder attached, renames off so each path reads on its own.
async fn read_tree_changes(
    git: &GitRunner,
    place: Option<&Place>,
    root: &Path,
    capture_folder: &CaptureFolder,
    before_tree: &GitObjectId,
    after_tree: &GitObjectId,
) -> Result<Vec<TreeChange>, CaptureStepError> {
    // Replace refs pinned off, so a replaced tree never stands in for a capture's.
    let [pin_flag, pin_setting] = USE_REPLACE_REFS_PIN;
    let arguments = in_folder(
        root,
        &[
            pin_flag,
            pin_setting,
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            before_tree.as_str(),
            after_tree.as_str(),
        ],
    );
    let mut call = GitCall::read(arguments);
    for (name, value) in capture_folder.read_environment() {
        call = call.with_environment(name, value);
    }
    let output = git.run(place, call).await?;
    Ok(read_diff_tree_records(&output.stdout)?)
}

// Splits git's ignored listing: an entry ending in `/` is an ignored folder only when no other
// entry sits under it (a folder holding only ignored files is listed beside them and dropped),
// and every other entry is staged. Sorted first, so the listing's order does not matter.
fn read_ignored_listing(listing: &[u8]) -> IgnoredListing<'_> {
    let mut entries: Vec<&[u8]> = split_nul_terminated_listing_bytes(listing).collect();
    entries.sort_unstable();
    entries.dedup();
    let mut read = IgnoredListing {
        staged_entries: Vec::new(),
        folders: Vec::new(),
    };
    for (position, &entry) in entries.iter().enumerate() {
        if !entry.ends_with(b"/") {
            read.staged_entries.push(entry);
            continue;
        }
        // In byte order every entry under a folder follows it directly, so the next one decides.
        let has_entry_under = entries
            .get(position + 1)
            .is_some_and(|next| next.starts_with(entry));
        if !has_entry_under {
            read.folders.push(entry);
        }
    }
    read
}

// `diff-tree -r -z` raw output read as changes: each record `:<mode> <mode> <id> <id> <letter>`,
// a NUL, the path and a NUL. Fails on anything else, so a record never reads as another change.
fn read_diff_tree_records(output: &[u8]) -> Result<Vec<TreeChange>, DiffTreeReadError> {
    let mut changes = Vec::new();
    let mut rest = output;
    while !rest.is_empty() {
        let (header, after_header) =
            split_at_nul(rest).ok_or(DiffTreeReadError::UnterminatedHeader)?;
        let (path, after_path) =
            split_at_nul(after_header).ok_or(DiffTreeReadError::MissingPath)?;
        if path.is_empty() {
            return Err(DiffTreeReadError::MissingPath);
        }
        changes.push(read_diff_tree_record(header, path)?);
        rest = after_path;
    }
    Ok(changes)
}

// The bytes before the first NUL and those after it, or `None` when there is no NUL.
fn split_at_nul(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    let end = bytes.iter().position(|&byte| byte == 0)?;
    Some((&bytes[..end], &bytes[end + 1..]))
}

// One record's change from its header and its path.
fn read_diff_tree_record(header: &[u8], path: &[u8]) -> Result<TreeChange, DiffTreeReadError> {
    let fields: Vec<&[u8]> = header
        .strip_prefix(b":")
        .ok_or(DiffTreeReadError::MalformedHeader)?
        .split(|&byte| byte == b' ')
        .collect();
    let [before_mode, after_mode, before_object, after_object, letter] = fields.as_slice() else {
        return Err(DiffTreeReadError::MalformedHeader);
    };
    if before_object.len() != after_object.len() {
        return Err(DiffTreeReadError::MixedObjectIdLengths);
    }
    let before = read_diff_tree_side(before_mode, before_object)?;
    let after = read_diff_tree_side(after_mode, after_object)?;
    let path = path_from_program_output(path.to_vec()).map_err(DiffTreeReadError::PathText)?;
    match (*letter, before, after) {
        (b"A", None, Some(after)) => Ok(TreeChange::Added { path, after }),
        (b"D", Some(before), None) => Ok(TreeChange::Deleted { path, before }),
        (b"M", Some(before), Some(after)) => Ok(TreeChange::Modified {
            path,
            before,
            after,
        }),
        (b"T", Some(before), Some(after)) => Ok(TreeChange::TypeChanged {
            path,
            before,
            after,
        }),
        (b"A" | b"D" | b"M" | b"T", _, _) => Err(DiffTreeReadError::SidesDisagree {
            letter: String::from_utf8_lossy(letter).into_owned(),
        }),
        (unread, _, _) => Err(DiffTreeReadError::UnreadLetter(
            String::from_utf8_lossy(unread).into_owned(),
        )),
    }
}

// One side of a record: `None` for the absent side (mode `000000` and the zero id), never an entry
// on the zero id.
fn read_diff_tree_side(mode: &[u8], object: &[u8]) -> Result<Option<TreeEntry>, DiffTreeReadError> {
    if mode.len() != 6 || !mode.iter().all(|digit| (b'0'..=b'7').contains(digit)) {
        return Err(DiffTreeReadError::MalformedMode);
    }
    let mode = mode
        .iter()
        .fold(0, |value, digit| value * 8 + u32::from(digit - b'0'));
    let object = std::str::from_utf8(object)
        .ok()
        .and_then(|text| GitObjectId::new(text.to_owned()))
        .ok_or(DiffTreeReadError::MalformedObjectId)?;
    let is_zero_object = object.as_str().bytes().all(|digit| digit == b'0');
    match (mode, is_zero_object) {
        (0, true) => Ok(None),
        (0, false) | (_, true) => Err(DiffTreeReadError::HalfSide),
        (_, false) => Ok(Some(TreeEntry { mode, object })),
    }
}

// Logs the capture's failure at `failed_step` once, with its phase, and answers the step; the
// person's checkout path stays out of the log.
fn report_failure(
    phase: CommandCapturePhase,
    failed_step: CaptureStep,
    failure: CaptureStepError,
) -> CaptureStep {
    CaptureDiagnostic::CommandCaptureFailed {
        phase,
        failed_step,
        detail: Box::new(failure),
    }
    .warn();
    failed_step
}

#[cfg(test)]
mod tests;
