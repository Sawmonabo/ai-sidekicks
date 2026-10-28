//! The worktree lifecycle service: the `worktrees` table's reads, a tree's retirement, the record
//! of a put-back tree, and the sweep that cleans retired folders. A tree's making is its
//! creation's; this service holds no `workspaces` write, and its caller wraps these calls.
//!
//! - The main checkout is never changed: git runs only reads in it, and the one record removed
//!   from the repository's git folder is the removed tree's own.
//! - Each `UPDATE` carries its legal-predecessor set in its `WHERE`, so the transition table lives
//!   in the statements.
//! - A retirement touches nothing on disk; the sweep empties the folder later, and only a tree the
//!   person retired loses it: a tree retired because its project was detached keeps its folder.

pub(crate) mod cleanup;

use std::borrow::Cow;
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension, Row};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::{LifecycleActor, RepoMountId, RepoMountState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::worktree::lifecycle::{
    RemovedWorktreeId, RetiredWorktreeState, WorktreeId, WorktreeRetireConflictDetails,
    WorktreeRetireResponse, WorktreeState,
};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::log_service::EventAppendError;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventEmitError, SessionEventLinkage,
};

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::GitRunner;
use crate::git::worktree::errors::WorktreeRefusal;
use crate::git::worktree::event_emitter::{EmitWorktreeEventInput, WorktreeEventEmitter};
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::risks::{RemovalRiskReadError, read_removal_risk_reading};
use crate::git::worktree::rows::{
    AttachedMountRow, MARK_READY_SQL, NewWorktreeRow, UNRELEASED_RUN_IN_WORKTREE_SQL,
    UNRELEASED_RUNS_SQL, UnreleasedRunRow, WorktreeRow, WorktreeRowChange, WorktreeRowRefusal,
    insert_worktree_statement, transition_statement,
};
use crate::repo::errors::RepoRefusal;
use crate::trust_envelope::is_contained_within;

// The `worktrees` columns [`worktree_row_of`] reads, in its order, for a query naming the table
// `wt`.
const WORKTREE_ROW_COLUMNS: &str = "wt.id, wt.repo_mount_id, wt.created_by_session_id, \
     wt.branch_name, wt.base_ref, wt.fs_root, wt.state";

// A worktree's row and the place its mount's project is at.
static SELECT_WORKTREE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {WORKTREE_ROW_COLUMNS}, mount.place
  FROM worktrees AS wt JOIN repo_mounts AS mount ON mount.id = wt.repo_mount_id
 WHERE wt.id = ?"
    )
});

// Only an `attached` mount is a provisioning target; a detached one is `repoMount.notFound`.
static SELECT_ATTACHED_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, canonical_root, project_id, place FROM repo_mounts
 WHERE id = ? AND state = '{}'",
        <&'static str>::from(RepoMountState::Attached)
    )
});

const SELECT_ROW_AT_FOLDER_SQL: &str = "SELECT 1 FROM worktrees WHERE fs_root = ? LIMIT 1";

const SELECT_WORKTREE_STATE_SQL: &str = "SELECT state FROM worktrees WHERE id = ?";

// Which of a JSON list of worktree ids have their retirement recorded.
static SELECT_RETIRED_AMONG_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id FROM worktrees WHERE id IN (SELECT value FROM json_each(?)) AND state = '{}'",
        <&'static str>::from(WorktreeState::Retired)
    )
});

// The retirement's write checks, in order, that the row is not yet retired and that no agent runs
// in the tree, then retires it; every state but `retired` is a legal predecessor, `failed`
// included, the only route by which a failed creation becomes sweepable.
static SELECT_UNRETIRED_WORKTREE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id FROM worktrees WHERE id = @worktree_id AND state <> '{}'",
        <&'static str>::from(WorktreeState::Retired)
    )
});
static RETIRE_SQL: LazyLock<String> = LazyLock::new(|| {
    let retired = <&'static str>::from(WorktreeState::Retired);
    format!(
        "UPDATE worktrees
    SET state = '{retired}', retired_risk_digest = @retired_risk_digest, updated_at = @now
  WHERE id = @worktree_id AND state <> '{retired}'"
    )
});
// The positions of the retirement write's checks among its statements.
const UNRETIRED_CHECK_INDEX: usize = 0;
const RUNNING_SESSION_CHECK_INDEX: usize = 1;

// Guarded on `cleaned_at IS NULL`, so a concurrent pass that already stamped the row keeps its
// stamp. A discard stamps it in its retirement's write, since its folder is moved aside.
const STAMP_CLEANED_SQL: &str = "UPDATE worktrees
    SET cleaned_at = @now, updated_at = @now
  WHERE id = @worktree_id AND cleaned_at IS NULL";

/// What a retirement's write carries beyond the row's own transition.
#[derive(Clone, Debug, Default)]
pub(crate) struct RecordRetirementOptions {
    /// The person's or agent's id that acted; `None` when the daemon did.
    pub(crate) actor: Option<LifecycleActor>,
    /// The id that ties `worktree.retired` to the rest of its operation.
    pub(crate) correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The kept copy a discard made, carried on `worktree.retired`; the row is stamped cleaned.
    pub(crate) removed_worktree_id: Option<RemovedWorktreeId>,
    /// The folder stays on disk as it is, so the row is stamped cleaned in the same write and no
    /// sweep ever removes it: a retirement because the project was detached.
    pub(crate) is_folder_left_on_disk: bool,
    /// The digest of what the risk read showed at retirement, which the sweep compares against.
    pub(crate) retired_risk_digest: Option<String>,
    /// Statements committed in the same write, after the retirement's own checks.
    pub(crate) transactional_prelude: Vec<WriteStatement>,
}

/// A tree a put-back made from a kept copy, recorded as a new row.
#[derive(Clone, Debug)]
pub(crate) struct RestoredWorktree {
    /// The mount the tree is on.
    pub(crate) repo_mount_id: RepoMountId,
    /// The session the kept copy's tree was made by, which the new row names.
    pub(crate) session_id: SessionId,
    /// Its branch.
    pub(crate) branch_name: GitRefName,
    /// The base its branch was cut from.
    pub(crate) base_ref: GitRefName,
    /// The tree's folder.
    pub(crate) fs_root: FilesystemPath,
    /// The kept copy the tree came from, carried on `worktree.created`.
    pub(crate) restored_from: RemovedWorktreeId,
}

/// Why a worktree call failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorktreeServiceError {
    /// The call was refused: an unknown tree, or a retirement while an agent runs in the tree.
    #[error(transparent)]
    Refused(#[from] WorktreeRefusal),
    /// The mount is not attached (`repoMount.notFound`).
    #[error(transparent)]
    MountRefused(#[from] RepoRefusal),
    /// The retirement found the row already retired, so no second `worktree.retired` was
    /// appended.
    #[error(
        "worktree {worktree_id} was already retired when the retirement was written; nothing was \
         appended"
    )]
    AlreadyRetired {
        /// The worktree.
        worktree_id: WorktreeId,
    },
    /// The row disappeared before the retirement's write committed: no path deletes a row, so this
    /// is corruption, not a race.
    #[error("cannot retire worktree {worktree_id}: its row disappeared before the write committed")]
    RowVanished {
        /// The worktree.
        worktree_id: WorktreeId,
        /// The writer's refusal.
        #[source]
        write: WriteError,
    },
    /// The row left the state its write expected.
    #[error(transparent)]
    RowMoved(#[from] WorktreeRowRefusal),
    /// The read did not reach the database.
    #[error("the worktree rows did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The rows could not be read.
    #[error("the worktree rows could not be read")]
    Database(#[from] rusqlite::Error),
    /// A write without an event was not kept.
    #[error("the worktree row's write was not kept")]
    Write(#[from] WriteError),
    /// An event's write was not kept.
    #[error("the worktree event was not appended")]
    Emit(#[from] SessionEventEmitError),
    /// A folder could not be resolved, or whether it exists could not be read.
    #[error("a worktree's folder could not be read")]
    Folder(#[source] io::Error),
    /// What the tree holds could not be read.
    #[error(transparent)]
    RiskRead(#[from] RemovalRiskReadError),
    /// Reading what the tree holds failed, and retiring it failed too.
    #[error("reading what the worktree holds failed, and so did retiring it: {retirement}")]
    RiskReadAndRetirement {
        /// The read's failure.
        #[source]
        read: Box<WorktreeServiceError>,
        /// The retirement's failure.
        retirement: Box<WorktreeServiceError>,
    },
}

/// What the worktree service runs with.
pub struct WorktreeServiceDeps {
    /// The daemon's git entry point; git runs only reads in the main checkout.
    pub git: GitRunner,
    /// The daemon's read pool.
    pub reads: Arc<DatabaseReadPool>,
    /// The writer a row write without an event goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The one seam every worktree event is appended through.
    pub events: Arc<WorktreeEventEmitter>,
    /// The daemon's one occupancy reader, for the sessions standing in a tree.
    pub occupancy: MountOccupancyReader,
    /// The daemon's worktrees folder, the only place the sweep removes a folder from.
    pub worktrees_folder: PathBuf,
}

/// Why the worktree rows could not be read.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeRowsReadError {
    /// The read did not reach the database.
    #[error("the worktree rows did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The rows could not be read.
    #[error("the worktree rows could not be read")]
    Database(#[from] rusqlite::Error),
}

/// Owns every `worktrees` transition and worktree-scoped git call.
pub struct WorktreeService {
    deps: WorktreeServiceDeps,
}

impl WorktreeService {
    /// A service over `deps`.
    pub fn new(deps: WorktreeServiceDeps) -> Self {
        Self { deps }
    }

    /// The row of a worktree. Fails with `worktree.notFound` for an unknown id, or the read's
    /// failure.
    #[expect(
        dead_code,
        reason = "worktree removal and the workspace's execution-root prepare"
    )]
    pub(crate) async fn require_worktree(
        &self,
        worktree_id: &WorktreeId,
    ) -> Result<WorktreeRow, WorktreeServiceError> {
        Ok(self.require_worktree_at_place(worktree_id).await?.0)
    }

    /// The session whose agent runs in the tree, or `None` when none does: a run whose context
    /// names the tree, or whose root is the tree's folder or inside it, the folders compared
    /// resolved. Fails with `worktree.notFound` for an unknown id, or a read's failure.
    #[expect(
        dead_code,
        reason = "worktree removal and the workspace's execution-root prepare"
    )]
    pub(crate) async fn read_running_session(
        &self,
        worktree_id: &WorktreeId,
    ) -> Result<Option<SessionId>, WorktreeServiceError> {
        let (tree, _place) = self.require_worktree_at_place(worktree_id).await?;
        self.running_session_in(&tree).await
    }

    /// Whether a worktree row in any state names `folder`, compared as stored: a tree's folder can
    /// be named like a leftover copy, and a detached project's trees stay on disk once cleaned.
    /// Fails with the read's failure.
    #[expect(dead_code, reason = "the removed-worktrees store")]
    pub(crate) async fn is_worktree_folder(
        &self,
        folder: &Path,
    ) -> Result<bool, WorktreeServiceError> {
        let folder = folder.to_string_lossy().into_owned();
        self.deps
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_ROW_AT_FOLDER_SQL)?
                    .exists([folder])?)
            })
            .await
    }

    /// The attached mount, with its root and project. Fails with `repoMount.notFound` for a mount
    /// that is not attached, or the read's failure.
    #[expect(
        dead_code,
        reason = "worktree creation and the workspace's execution-root prepare"
    )]
    pub(crate) async fn require_attached_mount(
        &self,
        repo_mount_id: &RepoMountId,
    ) -> Result<AttachedMountRow, WorktreeServiceError> {
        let mount_id = repo_mount_id.to_string();
        let mount = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_ATTACHED_MOUNT_SQL.as_str())?
                    .query_row([mount_id], |row| {
                        Ok(AttachedMountRow {
                            id: text_column(row, 0, |text| RepoMountId::new(&text))?,
                            canonical_root: text_column(row, 1, FilesystemPath::new)?,
                            project_id: text_column(row, 2, |text| ProjectId::new(&text))?,
                            place: place_of(row, 3)?,
                        })
                    })
                    .optional()
                    .map_err(WorktreeServiceError::from)
            })
            .await?;
        mount.ok_or_else(|| {
            RepoRefusal::MountNotFound {
                repo_mount_id: *repo_mount_id,
            }
            .into()
        })
    }

    /// Records `-> retired` with `worktree.retired` in one write and touches nothing on disk. A run
    /// the write saw that has ended by the read after is tried once more. Fails with
    /// `worktree.retireConflict` (`rootBusy`) when an agent runs in the tree, decided inside the
    /// write; with [`WorktreeServiceError::AlreadyRetired`] when the row was already retired, so
    /// nothing is appended twice; and with the write's failure.
    pub(crate) async fn record_retirement(
        &self,
        row: &WorktreeRow,
        options: RecordRetirementOptions,
    ) -> Result<(), WorktreeServiceError> {
        let mut can_retry = true;
        loop {
            let Err(failure) = self.write_retirement(row, options.clone()).await else {
                return Ok(());
            };
            let SessionEventEmitError::Append(SessionEventAppendError::Append(
                EventAppendError::Write(write),
            )) = failure
            else {
                return Err(failure.into());
            };
            match write.refused_statement_index() {
                Some(UNRETIRED_CHECK_INDEX) => {
                    return Err(self.explain_unretired_refusal(&row.id, write).await);
                }
                Some(RUNNING_SESSION_CHECK_INDEX) => match self.running_session_in(row).await? {
                    Some(running_session_id) => {
                        return Err(WorktreeRefusal::RetireConflict {
                            details: WorktreeRetireConflictDetails::RootBusy {
                                worktree_id: row.id,
                                running_session_id,
                            },
                        }
                        .into());
                    }
                    // The run ended after the write saw it, so the retirement is legal again.
                    None if can_retry => can_retry = false,
                    None => return Err(retire_refusal(row.id, write).into()),
                },
                Some(_) | None => {
                    return Err(
                        match WorktreeRowRefusal::explain(write, row.id, WorktreeRowChange::Retire)
                        {
                            Ok(refusal) => refusal.into(),
                            Err(write) => write.into(),
                        },
                    );
                }
            }
        }
    }

    /// Retires a tree this daemon just made and could not hand over, for a caller undoing its own
    /// preparation, recording what the risk read shows in the tree, its setup's own output
    /// included; the sweep removes the folder while nothing beyond that has appeared. A failed
    /// read still retires the tree, recording nothing, so its branch is freed and the sweep keeps
    /// the folder aside, and the read's failure is then returned, beside the retirement's if that
    /// failed too.
    #[expect(
        dead_code,
        reason = "worktree creation and the workspace's execution-root prepare"
    )]
    pub(crate) async fn retire_unadopted(
        &self,
        worktree_id: &WorktreeId,
    ) -> Result<WorktreeRetireResponse, WorktreeServiceError> {
        let (row, place) = self.require_worktree_at_place(worktree_id).await?;
        let reading = self.read_risk_digest(&row, place.as_ref()).await;
        let retired_risk_digest = reading.as_ref().ok().cloned().flatten();
        let retirement = self
            .record_retirement(
                &row,
                RecordRetirementOptions {
                    retired_risk_digest,
                    ..RecordRetirementOptions::default()
                },
            )
            .await;
        match (reading, retirement) {
            (Ok(_), Ok(()) | Err(WorktreeServiceError::AlreadyRetired { .. })) => {
                Ok(WorktreeRetireResponse {
                    worktree_id: row.id,
                    state: RetiredWorktreeState::Value,
                    kept: None,
                })
            }
            (Err(read), Ok(()) | Err(WorktreeServiceError::AlreadyRetired { .. })) => Err(read),
            (Ok(_), Err(retirement)) => Err(retirement),
            (Err(read), Err(retirement)) => Err(WorktreeServiceError::RiskReadAndRetirement {
                read: Box::new(read),
                retirement: Box::new(retirement),
            }),
        }
    }

    /// Records a tree a put-back made in one write: the row with `worktree.created` carrying the
    /// kept copy it came from, its move to `ready` with `worktree.bound`, and the statements
    /// `prelude_for` makes for the new id, so a failure keeps none of them. Returns the new row's
    /// id; fails with the write's failure.
    #[expect(dead_code, reason = "the kept worktrees' put-back")]
    pub(crate) async fn record_restored_worktree(
        &self,
        restored: RestoredWorktree,
        prelude_for: impl FnOnce(&WorktreeId) -> Vec<WriteStatement>,
    ) -> Result<WorktreeId, WorktreeServiceError> {
        let worktree_id =
            WorktreeId::try_from(mint_uuid_v7()).expect("a minted UUID is a worktree id");
        let now = WireInstant::now();
        let mut statements = vec![
            insert_worktree_statement(&NewWorktreeRow {
                id: worktree_id,
                repo_mount_id: restored.repo_mount_id,
                created_by_session_id: restored.session_id,
                created_by_run_id: None,
                branch_name: restored.branch_name,
                base_ref: restored.base_ref,
                fs_root: restored.fs_root,
                now: now.clone(),
            }),
            transition_statement(MARK_READY_SQL.as_str(), &worktree_id, &now, Some(1)),
        ];
        statements.extend(prelude_for(&worktree_id));
        self.deps
            .events
            .emit_worktree_created_and_bound(
                EmitWorktreeEventInput {
                    session_id: restored.session_id,
                    worktree_id,
                    repo_mount_id: Some(restored.repo_mount_id),
                    workspace_id: None,
                    actor: None,
                },
                Some(restored.restored_from),
                SessionEventLinkage {
                    occurred_at: Some(now),
                    transactional_prelude: statements,
                    ..SessionEventLinkage::default()
                },
            )
            .await?;
        Ok(worktree_id)
    }

    /// Stamps a retired tree cleaned: its folder is gone from where the row points, or is left
    /// there for good. A row a concurrent pass already stamped keeps its stamp. Fails with the
    /// write's failure.
    pub(crate) async fn stamp_cleaned(
        &self,
        worktree_id: &WorktreeId,
    ) -> Result<(), WorktreeServiceError> {
        self.deps
            .writer
            .write(vec![transition_statement(
                STAMP_CLEANED_SQL,
                worktree_id,
                &WireInstant::now(),
                None,
            )])
            .await?;
        Ok(())
    }

    /// Lists a retired tree's kept copy with `finish_kept_copy` and stamps the row cleaned in one
    /// write. Fails, keeping neither, when the row was already stamped, so a copy is never listed
    /// for a tree another pass settled, and with the write's other failures.
    #[expect(
        dead_code,
        reason = "the kept worktrees' store keeps a retired tree aside"
    )]
    pub(crate) async fn record_kept_aside(
        &self,
        worktree_id: &WorktreeId,
        finish_kept_copy: WriteStatement,
    ) -> Result<(), WorktreeServiceError> {
        self.deps
            .writer
            .write(vec![
                finish_kept_copy,
                transition_statement(STAMP_CLEANED_SQL, worktree_id, &WireInstant::now(), Some(1)),
            ])
            .await?;
        Ok(())
    }

    /// Removes one tree's record from the repository's git folder, as
    /// [`read_linked_tree_record`](crate::git::worktree::reads::read_linked_tree_record) named
    /// it, so no other tree's record is touched; `None`, a tree with no record left, removes
    /// nothing. Fails with the removal's failure.
    pub(crate) async fn remove_worktree_record(
        &self,
        record_folder: Option<&Path>,
    ) -> io::Result<()> {
        match record_folder {
            Some(record_folder) => remove_folder(record_folder).await,
            None => Ok(()),
        }
    }

    /// Which of `worktree_ids` have their retirement recorded. Fails with the read's failure.
    pub async fn read_retired(
        &self,
        worktree_ids: &[WorktreeId],
    ) -> Result<HashSet<WorktreeId>, WorktreeRowsReadError> {
        let listed = serde_json::to_string(
            &worktree_ids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
        )
        .expect("a list of strings serializes");
        self.deps
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_RETIRED_AMONG_SQL.as_str())?
                    .query_map([listed], |row| {
                        text_column(row, 0, |text| WorktreeId::new(&text))
                    })?
                    .collect::<rusqlite::Result<_>>()?)
            })
            .await
    }

    /// The worktree's row and the place its mount's project is at. Fails with `worktree.notFound`
    /// for an unknown id, or the read's failure.
    pub(crate) async fn require_worktree_at_place(
        &self,
        worktree_id: &WorktreeId,
    ) -> Result<(WorktreeRow, Option<Place>), WorktreeServiceError> {
        let id = worktree_id.to_string();
        let found = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_WORKTREE_SQL.as_str())?
                    .query_row([id], |row| Ok((worktree_row_of(row)?, place_of(row, 7)?)))
                    .optional()
                    .map_err(WorktreeServiceError::from)
            })
            .await?;
        found.ok_or_else(|| {
            WorktreeRefusal::NotFound {
                worktree_id: *worktree_id,
            }
            .into()
        })
    }

    // The session whose agent runs in `tree`, compared as `read_running_session` says.
    async fn running_session_in(
        &self,
        tree: &WorktreeRow,
    ) -> Result<Option<SessionId>, WorktreeServiceError> {
        let runs = self
            .deps
            .reads
            .read(ReadLength::Short, read_unreleased_runs)
            .await?;
        let tree_key = canonical_folder_path(Path::new(tree.fs_root.as_str()))
            .await
            .map_err(WorktreeServiceError::Folder)?;
        for run in runs {
            if run.worktree_id == Some(tree.id) {
                return Ok(Some(run.session_id));
            }
            let root_key = canonical_folder_path(Path::new(run.execution_root.as_str()))
                .await
                .map_err(WorktreeServiceError::Folder)?;
            if is_contained_within(&root_key, &tree_key) {
                return Ok(Some(run.session_id));
            }
        }
        Ok(None)
    }

    // The digest of what the tree holds, `None` when its folder is gone.
    async fn read_risk_digest(
        &self,
        row: &WorktreeRow,
        place: Option<&Place>,
    ) -> Result<Option<String>, WorktreeServiceError> {
        let folder = Path::new(row.fs_root.as_str());
        if !tokio::fs::try_exists(folder)
            .await
            .map_err(WorktreeServiceError::Folder)?
        {
            return Ok(None);
        }
        Ok(Some(
            read_removal_risk_reading(&self.deps.git, place, folder)
                .await?
                .digest,
        ))
    }

    // The write found no unretired row: retired is terminal and no path deletes a row, so the row
    // is retired, or it vanished, which is corruption rather than a race.
    async fn explain_unretired_refusal(
        &self,
        worktree_id: &WorktreeId,
        write: WriteError,
    ) -> WorktreeServiceError {
        let id = worktree_id.to_string();
        let state = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_WORKTREE_STATE_SQL)?
                    .query_row([id], |row| {
                        text_column(row, 0, closed_word::<WorktreeState>)
                    })
                    .optional()
                    .map_err(WorktreeServiceError::from)
            })
            .await;
        match state {
            Ok(None) => WorktreeServiceError::RowVanished {
                worktree_id: *worktree_id,
                write,
            },
            Ok(Some(WorktreeState::Retired)) => WorktreeServiceError::AlreadyRetired {
                worktree_id: *worktree_id,
            },
            Ok(Some(
                WorktreeState::Creating
                | WorktreeState::Ready
                | WorktreeState::Dirty
                | WorktreeState::Merged
                | WorktreeState::Failed,
            )) => retire_refusal(*worktree_id, write).into(),
            Err(read) => read,
        }
    }

    // One retirement write.
    async fn write_retirement(
        &self,
        row: &WorktreeRow,
        options: RecordRetirementOptions,
    ) -> Result<(), SessionEventEmitError> {
        let now = WireInstant::now();
        let worktree_id = row.id.text();
        let mut prelude = vec![
            WriteStatement {
                sql: Cow::Borrowed(SELECT_UNRETIRED_WORKTREE_SQL.as_str()),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@worktree_id",
                    worktree_id.as_str(),
                )]),
                expected_row_count: Some(1),
            },
            WriteStatement {
                sql: Cow::Borrowed(UNRELEASED_RUN_IN_WORKTREE_SQL),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@worktree_id",
                    worktree_id.as_str(),
                )]),
                expected_row_count: Some(0),
            },
            WriteStatement {
                sql: Cow::Borrowed(RETIRE_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@worktree_id", worktree_id.as_str()),
                    text_binding("@now", now.as_str()),
                    nullable_text_binding(
                        "@retired_risk_digest",
                        options.retired_risk_digest.as_deref(),
                    ),
                ]),
                expected_row_count: Some(1),
            },
        ];
        if options.removed_worktree_id.is_some() || options.is_folder_left_on_disk {
            prelude.push(transition_statement(STAMP_CLEANED_SQL, &row.id, &now, None));
        }
        prelude.extend(options.transactional_prelude);
        self.deps
            .events
            .emit_worktree_retired(
                // The row's own session: the event belongs to its maker, and the sweep has no
                // caller.
                EmitWorktreeEventInput {
                    session_id: row.created_by_session_id,
                    worktree_id: row.id,
                    repo_mount_id: Some(row.repo_mount_id),
                    workspace_id: None,
                    actor: options.actor,
                },
                options.removed_worktree_id,
                SessionEventLinkage {
                    occurred_at: Some(now),
                    correlation_id: options.correlation_id,
                    transactional_prelude: prelude,
                    ..SessionEventLinkage::default()
                },
            )
            .await?;
        Ok(())
    }
}

// The refusal of a retirement whose row left the state its write expected.
fn retire_refusal(worktree_id: WorktreeId, write: WriteError) -> WorktreeRowRefusal {
    WorktreeRowRefusal {
        worktree_id,
        change: WorktreeRowChange::Retire,
        write,
    }
}

// The row [`WORKTREE_ROW_COLUMNS`] reads, from its first seven columns.
fn worktree_row_of(row: &Row<'_>) -> rusqlite::Result<WorktreeRow> {
    Ok(WorktreeRow {
        id: text_column(row, 0, |text| WorktreeId::new(&text))?,
        repo_mount_id: text_column(row, 1, |text| RepoMountId::new(&text))?,
        created_by_session_id: text_column(row, 2, |text| SessionId::new(&text))?,
        branch_name: text_column(row, 3, GitRefName::new)?,
        base_ref: text_column(row, 4, GitRefName::new)?,
        fs_root: text_column(row, 5, FilesystemPath::new)?,
        state: text_column(row, 6, closed_word)?,
    })
}

// A mount's `place` column at `index`, which holds the place's wire JSON.
fn place_of(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<Place>> {
    optional_text_column(row, index, |text| serde_json::from_str::<Place>(&text))
}

fn read_unreleased_runs(
    connection: &Connection,
) -> Result<Vec<UnreleasedRunRow>, WorktreeServiceError> {
    Ok(connection
        .prepare_cached(UNRELEASED_RUNS_SQL)?
        .query_map([], |row| {
            Ok(UnreleasedRunRow {
                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                worktree_id: optional_text_column(row, 1, |text| WorktreeId::new(&text))?,
                execution_root: text_column(row, 2, FilesystemPath::new)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Removes `folder` and everything under it off the async workers, as `rm -rf` does; a folder
/// already gone passes. Fails with the removal's failure.
pub(crate) async fn remove_folder(folder: &Path) -> io::Result<()> {
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || sidekicks_platforms::remove_tree(&folder))
        .await
        .map_err(io::Error::other)?
}
