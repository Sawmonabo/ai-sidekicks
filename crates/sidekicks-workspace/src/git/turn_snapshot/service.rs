//! The turn-snapshot service: at each turn's end it commits the project state of the checkout a run
//! works in under `refs/sidekicks/runs/<run>/epoch-<E>/turn-<N>` in its owner's capture folder,
//! never in the repository's own `.git`; it deletes one run's refs when the run is deleted and
//! lists an owner's snapshots. Nothing prunes by age, and a capture reads no database: the caller
//! supplies the owner, the epoch, the checkout and the turn's end.
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
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::create_private_folder;
use sidekicks_std::file::remove_tree_awaited;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::random_hex::random_hex;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::optional_text_column;

use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::turn_snapshot::capture::{
    EXCLUDE_PER_DIRECTORY_GITIGNORE, GitFloorReports, SparseListingPartition, TURN_SNAPSHOT_SUBJECT,
};
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, git_folder_argument};
use crate::git::turn_snapshot::capture_steps::{CaptureStepError, SnapshotCheckout, at, joined};
use crate::git::turn_snapshot::diagnostics::{
    CaptureDiagnostic, CaptureStep, TurnSnapshotRetentionSkipReason,
};
use crate::git::turn_snapshot::held_checkout::{
    CaptureRoots, CaptureStartFailure, HeldCheckout, hold_checkout,
};
use crate::git::turn_snapshot::refs::{build_run_snapshot_ref_prefix, build_turn_snapshot_ref};
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

/// What one capture records, every field resolved by the caller.
#[derive(Clone, Debug)]
pub struct TurnSnapshotCaptureInput {
    /// The folder of the snapshot's owner, whose capture folders hold its snapshots: a session's
    /// storage folder, or the folder a workflow run's caller names.
    pub owner_folder: PathBuf,
    /// Where the run works: the worktree, or the bound folder of a bound root.
    pub execution_root: PathBuf,
    /// The top level of the working tree holding `execution_root`, as the run's execution context
    /// records it; a value the live tree disagrees with fails the capture.
    pub checkout_root: PathBuf,
    /// The run whose turn ended.
    pub run_id: RunId,
    /// 0 before any rollback, advanced by each accepted rollback.
    pub epoch: u64,
    /// The turn's ordinal within the epoch.
    pub turn_ordinal: u64,
    /// When the turn ended; both of the snapshot's dates, so its id never depends on the host's
    /// time zone or on when the capture ran.
    pub turn_ended_at: Timestamp,
}

/// What one capture did. It never fails the turn: a failure is reported, not retried.
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
    /// The ref was already written, by a retry or a duplicate of the same turn; the first write
    /// wins.
    AlreadyCaptured {
        /// The ref.
        snapshot_ref: String,
        /// The id read back off the ref, not the commit this call built; with another writer
        /// that has repository access it need not be one this service recorded.
        snapshot_commit: GitObjectId,
    },
    /// The capture did not complete; the failure itself goes to the service log.
    Failed {
        /// The ref the snapshot would have been written to.
        snapshot_ref: String,
        /// The step that failed.
        failed_step: CaptureStep,
    },
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
/// writes into it. Keeps nothing between calls but the places and features whose old git it already
/// reported.
pub struct TurnSnapshotService {
    git: GitRunner,
    /// Where the prune reads a run's context row.
    reads: Arc<DatabaseReadPool>,
    /// The run setup gate's lock, keyed by each checkout's canonical folder, so every spelling of
    /// one tree takes one lock.
    checkout_lock: Arc<KeyedLock<PathBuf>>,
    /// The packing every capture's borrowed objects go through.
    packing: Arc<CapturePacking>,
    /// The places and features whose git was reported too old in this daemon run.
    floor_reports: GitFloorReports,
}

impl TurnSnapshotService {
    /// A service running `git`, reading run contexts through `reads`, holding a checkout in
    /// `checkout_lock`, the run setup gate's, while it captures it, and packing each snapshot
    /// through `packing`.
    pub fn new(
        git: GitRunner,
        reads: Arc<DatabaseReadPool>,
        checkout_lock: Arc<KeyedLock<PathBuf>>,
        packing: Arc<CapturePacking>,
    ) -> Self {
        Self {
            git,
            reads,
            checkout_lock,
            packing,
            floor_reports: GitFloorReports::new(),
        }
    }

    /// Records the checkout's project state (tracked plus non-ignored untracked files, a file over
    /// the size bound left out) as a snapshot commit at the turn's ref in the owner's capture
    /// folder, running git for the project at `place`, then packs what it borrows from the
    /// repository. Never fails: every failure is logged and answered `Failed` with its step, since
    /// a snapshot never holds up a turn; a git lacking a feature is logged once per place and
    /// feature.
    pub async fn capture_turn_snapshot(
        &self,
        place: Option<&Place>,
        input: &TurnSnapshotCaptureInput,
    ) -> TurnSnapshotCaptureOutcome {
        let snapshot_ref = build_turn_snapshot_ref(&input.run_id, input.epoch, input.turn_ordinal);
        let roots = CaptureRoots {
            owner_folder: &input.owner_folder,
            execution_root: &input.execution_root,
            checkout_root: &input.checkout_root,
        };
        let held = match hold_checkout(
            &self.git,
            place,
            &self.checkout_lock,
            &self.floor_reports,
            roots,
        )
        .await
        {
            Ok(held) => held,
            Err(CaptureStartFailure::BelowFloor) => {
                return TurnSnapshotCaptureOutcome::Failed {
                    snapshot_ref,
                    failed_step: CaptureStep::GitFloor,
                };
            }
            Err(CaptureStartFailure::Failed(failed_step, failure)) => {
                return fail_capture(input, snapshot_ref, failed_step, failure);
            }
        };
        let outcome = self
            .capture_checkout(&held, place, input, snapshot_ref)
            .await;
        let HeldCheckout {
            capture_folder,
            hold,
            ..
        } = held;
        // Packed after the checkout is let go, so the next capture of it does not wait.
        drop(hold);
        if let TurnSnapshotCaptureOutcome::Captured {
            snapshot_commit,
            base_commit,
            ..
        } = &outcome
        {
            let captured =
                CapturedCommit::new(capture_folder, snapshot_commit.clone(), base_commit.clone());
            self.packing.pack(place, &captured).await;
        }
        outcome
    }

    // The capture's steps, each run at the top level of the verified checkout, and the scratch
    // index's removal after them whatever they did.
    async fn capture_checkout(
        &self,
        held: &HeldCheckout<'_>,
        place: Option<&Place>,
        input: &TurnSnapshotCaptureInput,
        snapshot_ref: String,
    ) -> TurnSnapshotCaptureOutcome {
        let checkout = &held.checkout(&self.git, place);
        // A name that meets no other, removed in the same call; no row or event stores it. In the
        // capture folder, outside every worktree, so it never shows in `ls-files -o` or
        // `git status`.
        let scratch_index = match random_hex(SCRATCH_INDEX_NAME_BYTES) {
            Ok(name) => checkout
                .capture_folder
                .indexes_folder()
                .join(format!("scratch-{name}.index")),
            Err(failure) => {
                return fail_capture(
                    input,
                    snapshot_ref,
                    CaptureStep::PrepareScratchIndex,
                    CaptureStepError::ScratchIndexName(failure),
                );
            }
        };
        let captured = self
            .run_capture_steps(
                checkout,
                held.is_sparse_root,
                input,
                &snapshot_ref,
                &scratch_index,
            )
            .await;
        // Never outlives the capture, nor does the lock file a git ended mid-write leaves beside
        // it; a failed removal is logged, never put in place of the capture's own outcome.
        let mut lock_file = scratch_index.clone().into_os_string();
        lock_file.push(".lock");
        for removal_path in [scratch_index, PathBuf::from(lock_file)] {
            let removed = remove_tree_awaited(&removal_path).await;
            if let Err(failure) = removed {
                CaptureDiagnostic::ScratchIndexCleanupFailed {
                    run_id: input.run_id,
                    epoch: input.epoch,
                    turn_ordinal: input.turn_ordinal,
                    scratch_index_path: removal_path,
                    detail: failure,
                }
                .warn();
            }
        }
        match captured {
            Ok(outcome) => outcome,
            Err((failed_step, failure)) => fail_capture(input, snapshot_ref, failed_step, failure),
        }
    }

    async fn run_capture_steps(
        &self,
        checkout: &SnapshotCheckout<'_>,
        is_sparse_root: bool,
        input: &TurnSnapshotCaptureInput,
        snapshot_ref: &str,
        scratch_index: &Path,
    ) -> Result<TurnSnapshotCaptureOutcome, (CaptureStep, CaptureStepError)> {
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
                TURN_SNAPSHOT_SUBJECT,
                &skipped_embedded_repositories,
                sparse_boundary_paths.as_deref(),
                &sizes.left_out_entries,
                input.turn_ended_at,
            )
            .await
            .map_err(at(Step::CommitTree))?;

        if let Some(recorded) = checkout
            .write_create_only_ref(snapshot_ref, &snapshot_commit)
            .await
            .map_err(at(Step::WriteRef))?
        {
            return Ok(TurnSnapshotCaptureOutcome::AlreadyCaptured {
                snapshot_ref: snapshot_ref.to_owned(),
                snapshot_commit: recorded,
            });
        }

        let skipped: Vec<String> = skipped_embedded_repositories
            .iter()
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect();
        if !skipped.is_empty() {
            CaptureDiagnostic::EmbeddedRepositoriesSkipped {
                run_id: input.run_id,
                epoch: input.epoch,
                turn_ordinal: input.turn_ordinal,
                snapshot_ref: snapshot_ref.to_owned(),
                skipped_paths: skipped.clone(),
            }
            .warn();
        }
        Ok(TurnSnapshotCaptureOutcome::Captured {
            snapshot_ref: snapshot_ref.to_owned(),
            snapshot_commit,
            base_commit,
            skipped_embedded_repositories: skipped,
        })
    }

    /// Deletes the snapshot refs of the run `run_key` once it has ended, from the capture folder
    /// of the owner whose folder is `owner_folder` for the repository its context row records,
    /// running git for the project at `place`. Idempotent: a second call answers `Pruned` with
    /// none. Never fails; a run not ended, with no row, whose row cannot be read, or whose refs
    /// git cannot list or delete answers `Skipped` with the reason.
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
    /// running git for the project at `place`; the repository itself is never written. The refs
    /// listed under the run's prefix go in one `update-ref --no-deref --stdin` transaction, all or
    /// none, so a refusal deletes none and the prune is retried. A dangling symref under the
    /// prefix, which the daemon never writes, is not listed and so not deleted. Never fails;
    /// answers `Skipped` with `GitDirAbsent`, `GitDirUnusable` or `RefDeleteFailed`.
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

// The one place a capture failure is reported: the log, then the outcome.
fn fail_capture(
    input: &TurnSnapshotCaptureInput,
    snapshot_ref: String,
    failed_step: CaptureStep,
    failure: CaptureStepError,
) -> TurnSnapshotCaptureOutcome {
    CaptureDiagnostic::CaptureFailed {
        run_id: input.run_id,
        epoch: input.epoch,
        turn_ordinal: input.turn_ordinal,
        snapshot_ref: snapshot_ref.clone(),
        failed_step,
        detail: Box::new(failure),
    }
    .warn();
    TurnSnapshotCaptureOutcome::Failed {
        snapshot_ref,
        failed_step,
    }
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
