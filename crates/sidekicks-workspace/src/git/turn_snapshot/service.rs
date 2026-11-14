//! The turn-snapshot service: at each of an agent run's turn ends and at each of a workflow run's
//! points it commits the project state of the checkout the run works in under
//! `refs/sidekicks/runs/<run>/epoch-<E>/` then `turn-<N>`, `start`, `pause-<N>` or `end`, in its
//! owner's capture folder, never in the repository's own `.git`; it deletes one run's refs when the
//! run is deleted and lists an owner's snapshots. It also reads a workflow run's checkout the same
//! way with no ref, answering the tree, its commit and its base. Nothing prunes by age, and a
//! capture reads no database: the caller supplies the owner, the point with its epoch, the
//! checkout and the capture's instant.
//!
//! - A capture covers the whole checkout, never only a nested execution root, since `ls-files`
//!   lists only the folder it runs in; the supplied checkout is checked against the live tree
//!   first.
//! - A capture holds the checkout's lock, the one the run setup gate holds around a run's context
//!   write, so captures of one checkout run one at a time, whichever session's run asks, and never
//!   beside the gate's setup of it.
//! - A git that lacks a feature the capture calls captures nothing and writes nothing.
//! - A file over the size bound is left out of the tree and named in its trailer.
//! - Once captured, what the snapshot borrows from the repository is packed into the folder.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_platforms::{create_private_folder, remove_tree_awaited};
use sidekicks_std::error_description::describe_error;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::random_hex::random_hex;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::optional_text_column;

use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::turn_snapshot::capture::{
    CheckoutCaptureInput, EXCLUDE_PER_DIRECTORY_GITIGNORE, GitFloorReports, SparseListingPartition,
    TURN_SNAPSHOT_SUBJECT, WORKFLOW_RUN_SNAPSHOT_SUBJECT,
};
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, git_folder_argument};
use crate::git::turn_snapshot::capture_steps::{
    CaptureStepError, SnapshotCheckout, at, index_lock_path, joined,
};
use crate::git::turn_snapshot::diagnostics::{
    CaptureDiagnostic, CaptureStep, TurnSnapshotRetentionSkipReason,
};
use crate::git::turn_snapshot::held_checkout::{CaptureStartFailure, HeldCheckout, hold_checkout};
use crate::git::turn_snapshot::refs::{
    RunSnapshotPoint, build_run_snapshot_ref_prefix, build_snapshot_ref,
};
use crate::git::turn_snapshot::repack::{CapturePacking, CapturedCommit};
use crate::git::turn_snapshot::retention::{
    RunContextKey, RunContextRow, is_path_provably_absent, parse_snapshot_ref_listing,
};

/// The statements the prune's context read prepares on a read connection: the one row read.
pub const TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY: usize = 1;

const SELECT_RUN_CONTEXT_SQL: &str =
    "SELECT git_common_dir, released_at FROM run_execution_contexts WHERE run_id = @run_id";

/// The random bytes in a scratch index's name, enough that two captures never meet.
const SCRATCH_INDEX_NAME_BYTES: usize = 16;

/// The cause a capture refused for an old git answers; the floor itself is logged once per place
/// and feature.
const GIT_BELOW_FLOOR_CAUSE: &str = "the daemon's git is older than this capture needs";

/// What one snapshot records, every field resolved by the caller.
#[derive(Clone, Debug)]
pub struct TurnSnapshotCaptureInput {
    /// The checkout captured and its owner, as the run's execution context records them; its
    /// `captured_at` is a turn's end for a turn and the instant the caller names for a workflow
    /// run's point.
    pub checkout: CheckoutCaptureInput,
    /// The point the snapshot is taken at, with its run, which names its ref.
    pub point: RunSnapshotPoint,
}

/// What one capture did. It never fails its caller: a failure is reported, not retried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnSnapshotCaptureOutcome {
    /// This call wrote the snapshot's ref.
    Captured {
        /// The ref written.
        snapshot_ref: String,
        /// The snapshot commit the ref names.
        snapshot_commit: GitObjectId,
        /// The one base resolved at the start: both the tree's base and the recorded parent;
        /// `None` in a repository with no commit yet, where the snapshot has no parent.
        base_commit: Option<GitObjectId>,
        /// The embedded repositories not recorded as gitlinks, in listing order, read as UTF-8
        /// with any other byte replaced, for the caller to record.
        skipped_embedded_repositories: Vec<String>,
    },
    /// The ref was already written, by a retry or a duplicate of the same point; the first write
    /// wins.
    AlreadyCaptured {
        /// The ref.
        snapshot_ref: String,
        /// The id read back off the ref, not the commit this call built; with another writer
        /// that has repository access it need not be one this service recorded.
        snapshot_commit: GitObjectId,
    },
    /// The capture did not complete; the failure goes to the service log too.
    Failed {
        /// The ref the snapshot would have been written to.
        snapshot_ref: String,
        /// The step that failed.
        failed_step: CaptureStep,
        /// The failure in one line, its causes after it, for the caller to record.
        cause: String,
    },
}

/// What one read of a workflow run's checkout did. It never fails its caller: a failure is
/// reported, not retried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckoutTreeOutcome {
    /// The checkout was read; no ref names it.
    Captured {
        /// The checkout's tree, the same for the same project state.
        tree: GitObjectId,
        /// The commit naming the tree, whose trailers name the files left out of it.
        snapshot_commit: GitObjectId,
        /// The repository's commit the tree stands on and the commit's parent, which a sweep keeps
        /// the tree readable past; `None` in a repository with no commit yet.
        base_commit: Option<GitObjectId>,
    },
    /// The read did not complete; the failure goes to the service log too.
    Failed {
        /// The step that failed.
        failed_step: CaptureStep,
        /// The failure in one line, its causes after it, for the caller to record.
        cause: String,
    },
}

// A run's capture committed in its capture folder, before any ref names it.
struct CommittedCheckout {
    tree: GitObjectId,
    snapshot_commit: GitObjectId,
    // The one base resolved at the start: both the tree's base and the commit's parent.
    base_commit: Option<GitObjectId>,
    // The embedded repositories not recorded as gitlinks, in listing order, read as UTF-8 with any
    // other byte replaced.
    skipped_embedded_repositories: Vec<String>,
}

impl CommittedCheckout {
    // Logs the embedded repositories the capture left unrecorded, if any, with the ref it wrote.
    fn warn_skipped(&self, run_key: RunContextKey, snapshot_ref: Option<&str>) {
        if self.skipped_embedded_repositories.is_empty() {
            return;
        }
        CaptureDiagnostic::EmbeddedRepositoriesSkipped {
            run_key,
            snapshot_ref: snapshot_ref.map(str::to_owned),
            skipped_paths: self.skipped_embedded_repositories.clone(),
        }
        .warn();
    }
}

/// What one prune of a run's snapshot refs did.
#[derive(Debug)]
pub enum TurnSnapshotPruneOutcome {
    /// Every snapshot ref of the run was deleted, in one transaction; none when it had none.
    Pruned {
        /// The refs deleted.
        deleted_refs: Vec<String>,
    },
    /// Nothing was deleted, and why.
    Skipped {
        /// Why the prune stopped.
        reason: TurnSnapshotRetentionSkipReason,
        /// The failure behind it; `None` for a run not ended, with no context row or with no
        /// capture folder.
        cause: Option<TurnSnapshotPruneFailure>,
    },
}

/// The failure behind a skipped prune.
#[derive(Debug, thiserror::Error)]
pub enum TurnSnapshotPruneFailure {
    /// The run's context row could not be read.
    #[error(transparent)]
    ContextRead(Arc<RunContextReadError>),
    /// Whether the owner's capture folder exists could not be found out.
    #[error("the capture folder could not be reached")]
    CaptureFolder(#[source] std::io::Error),
    /// Listing or deleting the run's refs failed.
    #[error(transparent)]
    Git(GitError),
    /// The capture folder's reclaim mark could not be written.
    #[error("the capture folder's reclaim mark could not be written")]
    ReclaimMark(#[source] std::io::Error),
}

/// Why a run's context row could not be read.
#[derive(Debug, thiserror::Error)]
pub enum RunContextReadError {
    /// SQLite refused the read, or a stored value did not read as its type.
    #[error("the run's context row could not be read")]
    Read(#[from] rusqlite::Error),
    /// No read connection could be had.
    #[error(transparent)]
    ReadPool(#[from] DatabaseReadError),
}

/// Owns the `refs/sidekicks/runs/` namespace of every capture folder and every git call that
/// writes into it. Keeps nothing between calls; the old gits it meets go in the daemon run's shared
/// record.
pub struct TurnSnapshotService {
    git: GitRunner,
    /// Where the prune reads a run's context row.
    reads: Arc<DatabaseReadPool>,
    /// The run setup gate's lock, keyed by each checkout's canonical folder, so every spelling of
    /// one tree takes one lock.
    checkout_lock: Arc<KeyedLock<PathBuf>>,
    /// The packing every capture's borrowed objects go through.
    packing: Arc<CapturePacking>,
    /// The daemon run's record of the old gits already reported.
    floor_reports: Arc<GitFloorReports>,
}

impl TurnSnapshotService {
    /// A service running `git`, reading run contexts through `reads`, holding a checkout in
    /// `checkout_lock`, the run setup gate's, while it captures it, packing each snapshot through
    /// `packing` and reporting an old git once through `floor_reports`, the daemon run's.
    pub fn new(
        git: GitRunner,
        reads: Arc<DatabaseReadPool>,
        checkout_lock: Arc<KeyedLock<PathBuf>>,
        packing: Arc<CapturePacking>,
        floor_reports: Arc<GitFloorReports>,
    ) -> Self {
        Self {
            git,
            reads,
            checkout_lock,
            packing,
            floor_reports,
        }
    }

    /// Records the checkout's project state (tracked plus non-ignored untracked files, a file over
    /// the size bound left out) as a snapshot commit at the ref of the input's point, a turn's end
    /// or a workflow run's point, in the owner's capture folder, running git for the project at
    /// `place`, then packs what it borrows from the repository; a workflow run's point is answered
    /// once its ref is written, its pack following off the caller's path and, should it fail, left
    /// for the sweep to pack again. Never fails: every failure is logged and answered `Failed` with
    /// its step and cause, since a snapshot never holds up a run; a git lacking a feature is logged
    /// once per place and feature.
    pub async fn capture_turn_snapshot(
        &self,
        place: Option<&Place>,
        input: &TurnSnapshotCaptureInput,
    ) -> TurnSnapshotCaptureOutcome {
        let snapshot_ref = build_snapshot_ref(&input.point);
        let run_key = input.point.run_key();
        let subject = snapshot_subject(&input.point);
        let committed = self
            .hold_and_commit(
                place,
                run_key,
                Some(&snapshot_ref),
                subject,
                &input.checkout,
            )
            .await;
        let (held, committed) = match committed {
            Ok(held_and_committed) => held_and_committed,
            Err((failed_step, cause)) => {
                return TurnSnapshotCaptureOutcome::Failed {
                    snapshot_ref,
                    failed_step,
                    cause,
                };
            }
        };
        // Still under the hold, so no other capture of the checkout writes between.
        let written = held
            .checkout(&self.git, place)
            .write_create_only_ref(&snapshot_ref, &committed.snapshot_commit)
            .await;
        match written {
            Ok(None) => {
                committed.warn_skipped(run_key, Some(&snapshot_ref));
                let CommittedCheckout {
                    tree,
                    snapshot_commit,
                    base_commit,
                    skipped_embedded_repositories,
                    ..
                } = committed;
                let captured = release(held, snapshot_commit.clone(), tree, base_commit.clone());
                match input.point {
                    RunSnapshotPoint::Turn { .. } => self.packing.pack(place, &captured).await,
                    RunSnapshotPoint::WorkflowRun { .. } => {
                        let (packing, place) = (Arc::clone(&self.packing), place.cloned());
                        tokio::spawn(async move {
                            packing.pack(place.as_ref(), &captured).await;
                        });
                    }
                }
                TurnSnapshotCaptureOutcome::Captured {
                    snapshot_ref,
                    snapshot_commit,
                    base_commit,
                    skipped_embedded_repositories,
                }
            }
            Ok(Some(recorded)) => TurnSnapshotCaptureOutcome::AlreadyCaptured {
                snapshot_ref,
                snapshot_commit: recorded,
            },
            Err(failure) => {
                let (failed_step, cause) =
                    fail_capture(run_key, Some(&snapshot_ref), CaptureStep::WriteRef, failure);
                TurnSnapshotCaptureOutcome::Failed {
                    snapshot_ref,
                    failed_step,
                    cause,
                }
            }
        }
    }

    /// Reads the checkout of the workflow run `workflow_run_id` as a point would record it, the
    /// same tree for the same project state, into the owner's capture folder, running git for the
    /// project at `place`, and packs what it borrows from the repository as a point's capture is
    /// packed; it writes no ref, so nothing can repoint it. It answers the tree, the commit naming
    /// it, whose trailers name the files left out, and the base it stands on, which a sweep needs
    /// to keep the tree readable once the repository drops that base. Never fails: every failure
    /// is logged and answered `Failed` with its step and cause.
    pub async fn capture_checkout_tree(
        &self,
        place: Option<&Place>,
        workflow_run_id: WorkflowRunId,
        checkout: &CheckoutCaptureInput,
    ) -> CheckoutTreeOutcome {
        let run_key = RunContextKey::from(workflow_run_id);
        let committed = self
            .hold_and_commit(
                place,
                run_key,
                None,
                WORKFLOW_RUN_SNAPSHOT_SUBJECT,
                checkout,
            )
            .await;
        let (held, committed) = match committed {
            Ok(held_and_committed) => held_and_committed,
            Err((failed_step, cause)) => {
                return CheckoutTreeOutcome::Failed { failed_step, cause };
            }
        };
        committed.warn_skipped(run_key, None);
        let CommittedCheckout {
            tree,
            snapshot_commit,
            base_commit,
            ..
        } = committed;
        let captured = release(
            held,
            snapshot_commit.clone(),
            tree.clone(),
            base_commit.clone(),
        );
        self.packing.pack(place, &captured).await;
        CheckoutTreeOutcome::Captured {
            tree,
            snapshot_commit,
            base_commit,
        }
    }

    // The start every capture of a run shares and its steps through the commit, under the
    // checkout's hold, which the caller lets go; a failure is logged once and answered with its
    // step and cause.
    async fn hold_and_commit(
        &self,
        place: Option<&Place>,
        run_key: RunContextKey,
        snapshot_ref: Option<&str>,
        subject: &'static str,
        checkout: &CheckoutCaptureInput,
    ) -> Result<(HeldCheckout<'_>, CommittedCheckout), (CaptureStep, String)> {
        let held = match hold_checkout(
            &self.git,
            place,
            &self.checkout_lock,
            &self.packing,
            &self.floor_reports,
            checkout.roots(),
        )
        .await
        {
            Ok(held) => held,
            Err(CaptureStartFailure::BelowFloor) => {
                return Err((CaptureStep::GitFloor, GIT_BELOW_FLOOR_CAUSE.to_owned()));
            }
            Err(CaptureStartFailure::Failed(failed_step, failure)) => {
                return Err(fail_capture(run_key, snapshot_ref, failed_step, failure));
            }
        };
        match self
            .commit_checkout(&held, place, run_key, subject, checkout.captured_at)
            .await
        {
            Ok(committed) => Ok((held, committed)),
            Err((failed_step, failure)) => {
                Err(fail_capture(run_key, snapshot_ref, failed_step, failure))
            }
        }
    }

    // The capture's steps through its commit, each run at the top level of the verified checkout,
    // and the scratch index's removal after them whatever they did.
    async fn commit_checkout(
        &self,
        held: &HeldCheckout<'_>,
        place: Option<&Place>,
        run_key: RunContextKey,
        subject: &'static str,
        captured_at: Timestamp,
    ) -> Result<CommittedCheckout, (CaptureStep, CaptureStepError)> {
        let checkout = &held.checkout(&self.git, place);
        // A name that meets no other, removed in the same call; no row or event stores it. In the
        // capture folder, outside every worktree, so it never shows in `ls-files -o` or
        // `git status`.
        let scratch_index = random_hex(SCRATCH_INDEX_NAME_BYTES)
            .map(|name| checkout.capture_folder.scratch_index(&name))
            .map_err(CaptureStepError::ScratchIndexName)
            .map_err(at(CaptureStep::PrepareScratchIndex))?;
        let committed = self
            .run_capture_steps(
                checkout,
                held.is_sparse_root,
                subject,
                captured_at,
                &scratch_index,
            )
            .await;
        // Never outlives the capture, nor does the lock file a git ended mid-write leaves beside
        // it; a failed removal is logged, never put in place of the capture's own outcome.
        let lock_file = index_lock_path(&scratch_index);
        for removal_path in [scratch_index, lock_file] {
            let removed = remove_tree_awaited(&removal_path).await;
            if let Err(failure) = removed {
                CaptureDiagnostic::ScratchIndexCleanupFailed {
                    run_key,
                    scratch_index_path: removal_path,
                    detail: failure,
                }
                .warn();
            }
        }
        committed
    }

    // The steps of one capture through its commit, staged into `scratch_index`, the commit taking
    // `subject` and `captured_at`.
    async fn run_capture_steps(
        &self,
        checkout: &SnapshotCheckout<'_>,
        is_sparse_root: bool,
        subject: &'static str,
        captured_at: Timestamp,
        scratch_index: &Path,
    ) -> Result<CommittedCheckout, (CaptureStep, CaptureStepError)> {
        use CaptureStep as Step;

        let indexes = checkout.capture_folder.indexes_folder();
        joined(tokio::task::spawn_blocking(move || create_private_folder(&indexes)).await)
            .map_err(CaptureStepError::IndexFolder)
            .map_err(at(Step::PrepareScratchIndex))?;
        let base_commit = checkout
            .resolve_base_commit()
            .await
            .map_err(at(Step::ResolveBase))?;

        if is_sparse_root && base_commit.is_some() {
            // The live index, not `read-tree <base>`: a read-tree index lacks skip-worktree bits,
            // so staging would re-stat each out-of-cone path, find it absent and drop it. The live
            // index also carries legitimate differences from `HEAD` (`git add --sparse`). With no
            // commit yet nothing is skipped, and a fresh repository may have no live index.
            checkout
                .seed_scratch_index_from_live_index(scratch_index)
                .await
                .map_err(at(Step::SeedIndex))?;
        } else {
            checkout
                .seed_index_from_base(scratch_index, base_commit.as_ref())
                .await
                .map_err(at(Step::SeedIndex))?;
        }

        // `-c` lists the seeded base paths again so `--add --remove` re-stats each one; `-o` adds
        // untracked files under the tree's own `.gitignore` rules only.
        let arguments =
            checkout.on_index_copy(&["ls-files", "-co", EXCLUDE_PER_DIRECTORY_GITIGNORE, "-z"]);
        let call = GitCall::read(arguments).with_environment("GIT_INDEX_FILE", scratch_index);
        let full_listing = checkout
            .git
            .run(checkout.place, call)
            .await
            .map_err(at(Step::ListPaths))?
            .stdout;

        // Every entry is in the cone unless the root is sparse, where git's own matcher decides.
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
        let listing: &[u8] = &sizes.staged_listing;

        checkout
            .stage_listing(scratch_index, listing)
            .await
            .map_err(at(Step::StagePaths))?;

        let skipped_embedded_repositories = checkout
            .normalize_embedded_repositories(scratch_index, listing)
            .await
            .map_err(at(Step::NormalizeEmbeddedRepositories))?;

        let tree = checkout
            .write_snapshot_tree(scratch_index)
            .await
            .map_err(at(Step::WriteTree))?;

        // Read back from the tree just written: the out-of-cone entries the tree lacks. The live
        // index seed already carries the ordinary skip-worktree ones.
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

        let snapshot_commit = checkout
            .commit_snapshot_tree(
                &tree,
                base_commit.as_ref(),
                subject,
                &skipped_embedded_repositories,
                sparse_boundary_paths.as_deref(),
                &sizes.left_out_entries,
                captured_at,
            )
            .await
            .map_err(at(Step::CommitTree))?;

        Ok(CommittedCheckout {
            tree,
            snapshot_commit,
            base_commit,
            skipped_embedded_repositories: skipped_embedded_repositories
                .iter()
                .map(|path| String::from_utf8_lossy(path).into_owned())
                .collect(),
        })
    }

    /// Deletes the snapshot refs of the run `run_key` once it has ended, from the capture folder
    /// of the owner whose folder is `owner_folder` for the repository its context row records,
    /// running git for the project at `place`, marking the folder first so the next sweep reclaims
    /// the run's objects. Idempotent: a second call answers `Pruned` with none. Never fails; a run
    /// not ended, with no row, whose row cannot be read, whose folder cannot be marked, or whose
    /// refs git cannot list or delete answers `Skipped` with the reason.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "a run's deletion prunes its snapshot refs through it"
        )
    )]
    pub(crate) async fn prune_snapshots_for_run(
        &self,
        place: Option<&Place>,
        run_key: RunContextKey,
        owner_folder: &Path,
    ) -> TurnSnapshotPruneOutcome {
        let row = self
            .reads
            .read(ReadLength::Short, move |reader| {
                read_run_context(reader, run_key)
            })
            .await;
        let row = match row {
            Ok(Some(row)) => row,
            // No row means no recorded git folder; a skip, so "found nothing" stays distinct from
            // "could not look".
            Ok(None) => return skipped(TurnSnapshotRetentionSkipReason::RunContextAbsent, None),
            Err(failure) => {
                let failure = Arc::new(failure);
                CaptureDiagnostic::RunContextReadFailed {
                    run_key,
                    detail: Box::new(Arc::clone(&failure)),
                }
                .warn();
                return skipped(
                    TurnSnapshotRetentionSkipReason::RunContextUnreadable,
                    Some(TurnSnapshotPruneFailure::ContextRead(failure)),
                );
            }
        };
        // A run nobody stamps as ended stays unprunable.
        if row.released_at.is_none() {
            return skipped(TurnSnapshotRetentionSkipReason::RunNotEnded, None);
        }
        self.prune_run_refs(place, run_key, owner_folder, &row.git_common_dir)
            .await
    }

    /// Deletes the snapshot refs of the run `run_key` from the capture folder of the owner whose
    /// folder is `owner_folder` for the repository whose common git folder is `git_common_dir`,
    /// running git for the project at `place`; the repository itself is never written. Once a ref
    /// is listed, the folder is marked for the next sweep's reclaim before any is deleted, so no
    /// ref goes unmarked. The refs listed under the run's prefix go in one
    /// `update-ref --no-deref --stdin` transaction, all or none, so a refusal deletes none and the
    /// prune is retried. A dangling symref under the prefix, which the daemon never writes, is not
    /// listed and so not deleted. Never fails; answers `Skipped` with `GitDirAbsent`,
    /// `GitDirUnusable`, `ReclaimMarkFailed` or `RefDeleteFailed`.
    async fn prune_run_refs(
        &self,
        place: Option<&Place>,
        run_key: RunContextKey,
        owner_folder: &Path,
        git_common_dir: &Path,
    ) -> TurnSnapshotPruneOutcome {
        // Opened, never made: a folder no capture made holds no ref.
        let capture_folder = match CaptureFolder::open_existing(owner_folder, git_common_dir).await
        {
            Ok(Some(capture_folder)) => capture_folder,
            Ok(None) => return skipped(TurnSnapshotRetentionSkipReason::GitDirAbsent, None),
            Err(failure) => {
                return skipped(
                    TurnSnapshotRetentionSkipReason::GitDirUnusable,
                    Some(TurnSnapshotPruneFailure::CaptureFolder(failure)),
                );
            }
        };
        let ref_prefix = build_run_snapshot_ref_prefix(run_key);
        let git_dir_argument = git_folder_argument(capture_folder.folder());

        let listing_call = GitCall::read([
            git_dir_argument.clone(),
            "for-each-ref".into(),
            "--format=%(objectname) %(refname)".into(),
            ref_prefix.as_str().into(),
        ]);
        let listing = match self.git.run(place, listing_call).await {
            Ok(listing) => listing,
            // A folder removed since it was opened fails the same way as a fault (no permission, no
            // git); one stat on this failure path decides, never git's message.
            Err(failure) => {
                let reason = if is_path_provably_absent(capture_folder.folder()).await {
                    TurnSnapshotRetentionSkipReason::GitDirAbsent
                } else {
                    TurnSnapshotRetentionSkipReason::GitDirUnusable
                };
                return skipped(reason, Some(TurnSnapshotPruneFailure::Git(failure)));
            }
        };
        let entries = parse_snapshot_ref_listing(&listing.stdout, &ref_prefix);
        if entries.is_empty() {
            return TurnSnapshotPruneOutcome::Pruned {
                deleted_refs: Vec::new(),
            };
        }
        // Before the delete, so a stop between the two leaves a mark whose run still has refs,
        // which the sweep holds until they go, never refs deleted with no mark.
        if let Err(failure) = self
            .packing
            .mark_reclaim_due(owner_folder, git_common_dir, run_key)
            .await
        {
            return skipped(
                TurnSnapshotRetentionSkipReason::ReclaimMarkFailed,
                Some(TurnSnapshotPruneFailure::ReclaimMark(failure)),
            );
        }

        // `--no-deref` deletes a symref planted under the prefix itself, never the branch it
        // names: the listing names the symref and its target's id, and without the flag the delete
        // would reach `refs/heads/<branch>` and report a clean prune (git 2.50.1).
        let mut deletions = String::new();
        for entry in &entries {
            writeln!(
                deletions,
                "delete {} {}",
                entry.snapshot_ref,
                entry.object_id.as_str()
            )
            .expect("writing to a string cannot fail");
        }
        let delete_call = GitCall::private_ref_write([
            git_dir_argument,
            "update-ref".into(),
            "--no-deref".into(),
            "--stdin".into(),
        ])
        .with_input(deletions.into_bytes());
        match self.git.run(place, delete_call).await {
            Ok(_) => TurnSnapshotPruneOutcome::Pruned {
                deleted_refs: entries
                    .into_iter()
                    .map(|entry| entry.snapshot_ref)
                    .collect(),
            },
            Err(failure) => skipped(
                TurnSnapshotRetentionSkipReason::RefDeleteFailed,
                Some(TurnSnapshotPruneFailure::Git(failure)),
            ),
        }
    }
}

// One run's context row, `None` when it has none.
fn read_run_context(
    reader: &Connection,
    run_key: RunContextKey,
) -> Result<Option<RunContextRow>, RunContextReadError> {
    Ok(reader
        .prepare_cached(SELECT_RUN_CONTEXT_SQL)?
        .query_row(named_params! { "@run_id": run_key.to_string() }, |row| {
            Ok(RunContextRow {
                git_common_dir: PathBuf::from(row.get::<_, String>(0)?),
                released_at: optional_text_column(row, 1, WireInstant::try_from)?,
            })
        })
        .optional()?)
}

// Lets the checkout go, so the next capture of it does not wait, and answers the capture
// `snapshot_commit` of `tree` on `base_commit` for its pack.
fn release(
    held: HeldCheckout<'_>,
    snapshot_commit: GitObjectId,
    tree: GitObjectId,
    base_commit: Option<GitObjectId>,
) -> CapturedCommit {
    let HeldCheckout {
        capture_folder,
        hold,
        ..
    } = held;
    drop(hold);
    CapturedCommit::new(capture_folder, snapshot_commit, tree, base_commit)
}

// The commit subject of a snapshot at `point`: a turn's, or a workflow run's.
fn snapshot_subject(point: &RunSnapshotPoint) -> &'static str {
    match point {
        RunSnapshotPoint::Turn { .. } => TURN_SNAPSHOT_SUBJECT,
        RunSnapshotPoint::WorkflowRun { .. } => WORKFLOW_RUN_SNAPSHOT_SUBJECT,
    }
}

// The one place a run's capture failure is reported: the log, with the ref the capture would have
// written (`None` for a checkout read), then the step and its cause for the caller's outcome.
fn fail_capture(
    run_key: RunContextKey,
    snapshot_ref: Option<&str>,
    failed_step: CaptureStep,
    failure: CaptureStepError,
) -> (CaptureStep, String) {
    let cause = describe_error(&failure);
    CaptureDiagnostic::CaptureFailed {
        run_key,
        snapshot_ref: snapshot_ref.map(str::to_owned),
        failed_step,
        detail: Box::new(failure),
    }
    .warn();
    (failed_step, cause)
}

fn skipped(
    reason: TurnSnapshotRetentionSkipReason,
    cause: Option<TurnSnapshotPruneFailure>,
) -> TurnSnapshotPruneOutcome {
    TurnSnapshotPruneOutcome::Skipped { reason, cause }
}

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;
