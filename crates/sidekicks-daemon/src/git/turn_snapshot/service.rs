//! The turn-snapshot service: at each turn's end it commits the project state of the checkout a run
//! works in under `refs/sidekicks/runs/<run>/epoch-<E>/turn-<N>`, and it deletes one run's refs
//! when the run is deleted. Nothing prunes by age, and a capture reads no database: the caller
//! supplies the epoch, the checkout and the turn's end.
//!
//! - A capture covers the whole checkout, never only a nested execution root, since `ls-files`
//!   lists only the folder it runs in; the supplied checkout is checked against the live tree
//!   first.
//! - Captures of one checkout run one at a time, whichever session's run asks.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{path_from_program_output, real_path, remove_tree};

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::stored_column::optional_text_column;
use crate::git::process::{GitCall, GitError, GitRunner, in_folder, strip_line_end};
use crate::git::turn_snapshot::capture::{
    EXCLUDE_PER_DIRECTORY_GITIGNORE, SNAPSHOT_INDEX_SEGMENT, SparseListingPartition,
};
use crate::git::turn_snapshot::capture_steps::{
    CaptureStepError, SnapshotCheckout, joined, require_object_id,
};
use crate::git::turn_snapshot::diagnostics::{
    TurnSnapshotCaptureStep, TurnSnapshotDiagnostic, TurnSnapshotRetentionSkipReason,
};
use crate::git::turn_snapshot::refs::{
    USE_REPLACE_REFS_PIN, build_run_snapshot_ref_prefix, build_turn_snapshot_ref,
};
use crate::git::turn_snapshot::retention::{
    RunContextKey, RunContextRow, is_path_provably_absent, parse_snapshot_ref_listing,
};
use crate::keyed_lock::KeyedLock;
use crate::random_hex::random_hex;

/// The statements the prune's context read prepares on a read connection: the one row read.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start sizes the read connections' statement caches with it"
    )
)]
pub(crate) const TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY: usize = 1;

const SELECT_RUN_CONTEXT_SQL: &str =
    "SELECT git_common_dir, released_at FROM run_execution_contexts WHERE run_id = @run_id";

/// The random bytes in a scratch index's name, enough that two captures never meet.
const SCRATCH_INDEX_NAME_BYTES: usize = 16;

/// What one capture records, every field resolved by the caller.
#[derive(Clone, Debug)]
pub(crate) struct TurnSnapshotCaptureInput {
    /// Where the run works: the worktree, or the bound folder of a bound root.
    pub(crate) execution_root: PathBuf,
    /// The top level of the working tree holding `execution_root`, as the run's execution context
    /// records it; a value the live tree disagrees with fails the capture.
    pub(crate) checkout_root: PathBuf,
    /// The run whose turn ended.
    pub(crate) run_id: RunId,
    /// 0 before any rollback, advanced by each accepted rollback.
    pub(crate) epoch: u64,
    /// The turn's ordinal within the epoch.
    pub(crate) turn_ordinal: u64,
    /// When the turn ended; both of the snapshot's dates, so its id never depends on the host's
    /// time zone or on when the capture ran.
    pub(crate) turn_ended_at: Timestamp,
}

/// What one capture did. It never fails the turn: a failure is reported, not retried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TurnSnapshotCaptureOutcome {
    /// This call wrote the snapshot's ref.
    Captured {
        /// The ref written.
        snapshot_ref: String,
        /// The snapshot commit the ref names.
        snapshot_commit: GitObjectId,
        /// The one base resolved at the start: both the tree's base and the recorded parent.
        base_commit: GitObjectId,
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
        failed_step: TurnSnapshotCaptureStep,
    },
}

/// What one prune of a run's snapshot refs did.
#[derive(Debug)]
#[expect(
    dead_code,
    reason = "a run's deletion reads what the prune of its refs did"
)]
pub(crate) enum TurnSnapshotPruneOutcome {
    /// Every snapshot ref of the run was deleted, in one transaction; none when it had none.
    Pruned {
        /// The refs deleted.
        deleted_refs: Vec<String>,
    },
    /// Nothing was deleted, and why.
    Skipped {
        /// Why the prune stopped.
        reason: TurnSnapshotRetentionSkipReason,
        /// The failure behind it; `None` for a run not ended or with no context row.
        cause: Option<TurnSnapshotPruneFailure>,
    },
}

/// The failure behind a skipped prune.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TurnSnapshotPruneFailure {
    /// The run's context row could not be read.
    #[error(transparent)]
    ContextRead(Arc<RunContextReadError>),
    /// Listing or deleting the run's refs failed.
    #[error(transparent)]
    Git(GitError),
}

/// Why a run's context row could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunContextReadError {
    /// SQLite refused the read, or a stored value did not read as its type.
    #[error("the run's context row could not be read")]
    Read(#[from] rusqlite::Error),
    /// No read connection could be had.
    #[error(transparent)]
    ReadPool(#[from] DatabaseReadError),
}

/// Owns the `refs/sidekicks/runs/` namespace and every git call that writes into it. Keeps nothing
/// between calls but the lock that runs one capture of a checkout at a time.
pub(crate) struct TurnSnapshotService {
    git: GitRunner,
    /// Where the prune reads a run's context row.
    reads: Arc<DatabaseReadPool>,
    /// Holds each capture's scratch index, outside every worktree.
    snapshot_index_folder: PathBuf,
    /// Keyed by the checkout with its symlinks resolved, so every spelling of one tree takes one
    /// lock.
    checkout_lock: KeyedLock<PathBuf>,
}

impl TurnSnapshotService {
    /// A service running `git`, reading run contexts through `reads`, and keeping scratch indexes
    /// under `execution_roots_folder`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start makes the turn snapshot service through it"
        )
    )]
    pub(crate) fn new(
        git: GitRunner,
        reads: Arc<DatabaseReadPool>,
        execution_roots_folder: &Path,
    ) -> Self {
        Self {
            git,
            reads,
            snapshot_index_folder: execution_roots_folder.join(SNAPSHOT_INDEX_SEGMENT),
            checkout_lock: KeyedLock::new(),
        }
    }

    /// Records the checkout's project state (tracked plus non-ignored untracked files) as a
    /// snapshot commit at the turn's ref, running git for the project at `place`. Never fails:
    /// every failure is logged and answered `Failed` with its step, since a snapshot never holds
    /// up a turn.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the run engine's turn end captures the checkout through it"
        )
    )]
    pub(crate) async fn capture_turn_snapshot(
        &self,
        place: Option<&Place>,
        input: &TurnSnapshotCaptureInput,
    ) -> TurnSnapshotCaptureOutcome {
        let snapshot_ref = build_turn_snapshot_ref(&input.run_id, input.epoch, input.turn_ordinal);
        let checkout_root = match self.verify_checkout_root(place, input).await {
            Ok(checkout_root) => checkout_root,
            Err(failure) => {
                return fail_capture(
                    input,
                    snapshot_ref,
                    TurnSnapshotCaptureStep::VerifyCheckoutRoot,
                    failure,
                );
            }
        };
        let _checkout_hold = self.checkout_lock.acquire(checkout_root.clone()).await;
        let checkout = SnapshotCheckout {
            git: &self.git,
            place,
            root: &checkout_root,
        };
        self.capture_checkout(&checkout, input, snapshot_ref).await
    }

    // The supplied checkout, symlinks resolved, once git names it as the top level of the working
    // tree holding the execution root.
    async fn verify_checkout_root(
        &self,
        place: Option<&Place>,
        input: &TurnSnapshotCaptureInput,
    ) -> Result<PathBuf, CaptureStepError> {
        let (supplied, live) = tokio::try_join!(
            resolve_symlinks(input.checkout_root.clone()),
            self.read_live_top_level(place, &input.execution_root)
        )?;
        if supplied != live {
            return Err(CaptureStepError::CheckoutMismatch);
        }
        Ok(supplied)
    }

    // The top level of the working tree holding `execution_root`, symlinks resolved.
    async fn read_live_top_level(
        &self,
        place: Option<&Place>,
        execution_root: &Path,
    ) -> Result<PathBuf, CaptureStepError> {
        let call = GitCall::read(in_folder(execution_root, &["rev-parse", "--show-toplevel"]));
        let output = self.git.run(place, call).await?;
        let top_level =
            path_from_program_output(strip_line_end(output.stdout)).map_err(GitError::PathText)?;
        resolve_symlinks(top_level).await
    }

    // The capture's steps, each run at the top level of the verified checkout, and the scratch
    // index's removal after them whatever they did.
    async fn capture_checkout(
        &self,
        checkout: &SnapshotCheckout<'_>,
        input: &TurnSnapshotCaptureInput,
        snapshot_ref: String,
    ) -> TurnSnapshotCaptureOutcome {
        // A name that meets no other, removed in the same call; no row or event stores it.
        let scratch_index = match random_hex(SCRATCH_INDEX_NAME_BYTES) {
            Ok(name) => self.snapshot_index_folder.join(format!("{name}.index")),
            Err(failure) => {
                return fail_capture(
                    input,
                    snapshot_ref,
                    TurnSnapshotCaptureStep::PrepareScratchIndex,
                    CaptureStepError::ScratchIndexName(failure),
                );
            }
        };
        let captured = self
            .run_capture_steps(checkout, input, &snapshot_ref, &scratch_index)
            .await;
        // Never outlives the capture, nor does the lock file a git ended mid-write leaves beside
        // it; a failed removal is logged, never put in place of the capture's own outcome.
        let mut lock_file = scratch_index.clone().into_os_string();
        lock_file.push(".lock");
        for removal_path in [scratch_index, PathBuf::from(lock_file)] {
            let removing = removal_path.clone();
            let removed = joined(tokio::task::spawn_blocking(move || remove_tree(&removing)).await);
            if let Err(failure) = removed {
                TurnSnapshotDiagnostic::ScratchIndexCleanupFailed {
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
        input: &TurnSnapshotCaptureInput,
        snapshot_ref: &str,
        scratch_index: &Path,
    ) -> Result<TurnSnapshotCaptureOutcome, (TurnSnapshotCaptureStep, CaptureStepError)> {
        use TurnSnapshotCaptureStep as Step;

        tokio::fs::create_dir_all(&self.snapshot_index_folder)
            .await
            .map_err(CaptureStepError::ScratchIndexFolder)
            .map_err(at(Step::PrepareScratchIndex))?;
        let base_commit = checkout
            .resolve_base_commit()
            .await
            .map_err(at(Step::ResolveBase))?;
        let is_sparse_root = checkout
            .detect_sparse_root()
            .await
            .map_err(at(Step::DetectSparseRoot))?;

        if is_sparse_root {
            // The live index, not `read-tree <base>`: a read-tree index lacks skip-worktree bits,
            // so staging would re-stat each out-of-cone path, find it absent and drop it. The live
            // index also carries legitimate differences from `HEAD` (`git add --sparse`).
            checkout
                .seed_scratch_index_from_live_index(scratch_index)
                .await
                .map_err(at(Step::SeedIndex))?;
        } else {
            // Pinned: a replace ref on the base would seed from the replacement's tree and drop a
            // path that is both tracked in the index and ignored (measured against `add -A`).
            let [pin_flag, pin_setting] = USE_REPLACE_REFS_PIN;
            let arguments =
                checkout.in_checkout(&[pin_flag, pin_setting, "read-tree", base_commit.as_str()]);
            let call = GitCall::read(arguments).with_environment("GIT_INDEX_FILE", scratch_index);
            checkout
                .git
                .run(checkout.place, call)
                .await
                .map_err(at(Step::SeedIndex))?;
        }

        // `-c` lists the seeded base paths again so `--add --remove` re-stats each one; `-o` adds
        // untracked files under the tree's own `.gitignore` rules only.
        let arguments =
            checkout.in_checkout(&["ls-files", "-co", EXCLUDE_PER_DIRECTORY_GITIGNORE, "-z"]);
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
        let listing: &[u8] = &partition.in_cone_listing;

        // Pins for the one step that hashes worktree bytes: a host `core.autocrlf` changes blob
        // ids, a host `core.safecrlf=true` fails staging on CRLF bytes under `*.txt text` (git
        // 2.50.1), and the person's and the system's attribute files must not steer conversion
        // (the tree's own `.gitattributes` stays honored). `core.fileMode` is not pinned: true
        // would replace each tracked file's recorded mode with the stat mode, since the scratch
        // index carries no stat data.
        let arguments = checkout.in_checkout(&[
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.safecrlf=false",
            "-c",
            "core.attributesFile=/dev/null",
            "update-index",
            "--add",
            "--remove",
            "-z",
            "--stdin",
        ]);
        let call = GitCall::read(arguments)
            .with_environment("GIT_INDEX_FILE", scratch_index)
            .with_environment("GIT_ATTR_NOSYSTEM", "1")
            .with_input(listing.to_vec());
        checkout
            .git
            .run(checkout.place, call)
            .await
            .map_err(at(Step::StagePaths))?;

        let skipped_embedded_repositories = checkout
            .normalize_embedded_repositories(scratch_index, listing)
            .await
            .map_err(at(Step::NormalizeEmbeddedRepositories))?;

        let call = GitCall::read(checkout.in_checkout(&["write-tree"]))
            .with_environment("GIT_INDEX_FILE", scratch_index);
        let tree = checkout
            .git
            .run(checkout.place, call)
            .await
            .map_err(CaptureStepError::from)
            .and_then(|output| require_object_id(&output.stdout))
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
                &base_commit,
                &skipped_embedded_repositories,
                sparse_boundary_paths.as_deref(),
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
            TurnSnapshotDiagnostic::EmbeddedRepositoriesSkipped {
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

    /// Deletes the snapshot refs of the run `run_key` once it has ended, from the git folder its
    /// context row records, running git for the project at `place`. Idempotent: a second call
    /// answers `Pruned` with none. Never fails; a run not ended, with no row, whose row cannot be
    /// read, or whose refs git cannot list or delete answers `Skipped` with the reason.
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
                TurnSnapshotDiagnostic::RunContextReadFailed {
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
        self.prune_run_refs(place, run_key, &row.git_common_dir)
            .await
    }

    /// Deletes the snapshot refs of the run `run_key` from `git_common_dir`, for a run whose rows
    /// are already deleted, running git for the project at `place`. The refs listed under the
    /// run's prefix go in one `update-ref --no-deref --stdin` transaction, all or none, so a
    /// refusal deletes none and the prune is retried. A dangling symref under the prefix, which
    /// the daemon never writes, is not listed and so not deleted. Never fails; answers `Skipped`
    /// with `GitDirAbsent`, `GitDirUnusable` or `RefDeleteFailed`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "a run's deletion prunes its snapshot refs through it"
        )
    )]
    pub(crate) async fn prune_run_refs(
        &self,
        place: Option<&Place>,
        run_key: RunContextKey,
        git_common_dir: &Path,
    ) -> TurnSnapshotPruneOutcome {
        let ref_prefix = build_run_snapshot_ref_prefix(run_key);
        // The common git folder, not the execution root, which may be gone while its refs remain.
        let mut git_dir_argument = OsString::from("--git-dir=");
        git_dir_argument.push(git_common_dir);

        let listing_call = GitCall::read([
            git_dir_argument.clone(),
            "for-each-ref".into(),
            "--format=%(objectname) %(refname)".into(),
            ref_prefix.as_str().into(),
        ]);
        let listing = match self.git.run(place, listing_call).await {
            Ok(listing) => listing,
            // A removed repository fails the same way as a fault (no permission, no git); one stat
            // on this failure path decides, never git's message.
            Err(failure) => {
                let reason = if is_path_provably_absent(git_common_dir).await {
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
        let delete_call = GitCall::write([
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

// `path` with every symlink resolved, on the blocking pool.
async fn resolve_symlinks(path: PathBuf) -> Result<PathBuf, CaptureStepError> {
    joined(tokio::task::spawn_blocking(move || real_path(&path)).await)
        .map_err(CaptureStepError::CheckoutUnresolved)
}

// Tags a step's failure with the step.
fn at<Failure: Into<CaptureStepError>>(
    step: TurnSnapshotCaptureStep,
) -> impl FnOnce(Failure) -> (TurnSnapshotCaptureStep, CaptureStepError) {
    move |failure| (step, failure.into())
}

// The one place a capture failure is reported: the log, then the outcome.
fn fail_capture(
    input: &TurnSnapshotCaptureInput,
    snapshot_ref: String,
    failed_step: TurnSnapshotCaptureStep,
    failure: CaptureStepError,
) -> TurnSnapshotCaptureOutcome {
    TurnSnapshotDiagnostic::CaptureFailed {
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
mod tests;
