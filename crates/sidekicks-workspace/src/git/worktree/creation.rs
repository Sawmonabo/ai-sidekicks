//! Making a worktree: the base its branch is cut from, its branch and folder through the name
//! plan, git's judgment of the name, the tree itself, the uncommitted work it carries, its row and
//! events, and its setup card, opened before git runs and finished once the tree is ready; and, at
//! the daemon's start, the settling of the trees a stop cut off before they were ready.
//!
//! - Git decides a name: its branch-name rule, then `worktree add -b` against the branches that
//!   exist. A refusal of the name carries the line refusing it and writes nothing.
//! - The main checkout is never changed: in it git runs only reads, `worktree add -b` and, to undo
//!   a tree this call made, `worktree remove` and `branch -D`; a failed tree's own record is the
//!   one record removed from the repository's git folder.
//! - Carried work is stashed and its stash handed back to the caller, who drops it only once the
//!   tree is adopted, so every failure before that keeps the stash and names the command that
//!   recovers it.

mod free_name;
pub mod interrupted;

use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use notify::{RecommendedWatcher, Watcher};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::{LifecycleActor, RepoMountId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_contracts::worktree::lifecycle::{NewWorktreeSuggestion, WorktreeId, WorktreeState};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::log_service::EventAppendError;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventEmitError, SessionEventLinkage,
};

use self::free_name::NameWalk;
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{GitCall, GitRunner, in_folder, read_git_common_folder};
use crate::git::worktree::carry::{
    CarriedStash, KeptStash, carry_uncommitted_work, drop_carried_stash, kept_stash_failure,
    require_carry_onto_current_branch,
};
use crate::git::worktree::errors::{WorktreeCreateFailureReason, WorktreeRefusal};
use crate::git::worktree::event_emitter::{EmitWorktreeEventInput, WorktreeEventEmitter};
use crate::git::worktree::naming::{
    WorktreeName, WorktreeNamePlan, WorktreeNaming, WorktreeNamingError,
};
use crate::git::worktree::reads::{has_branch, read_current_branch, read_linked_tree_record};
use crate::git::worktree::rows::{
    AttachedMountRow, MARK_READY_SQL, NewWorktreeRow, WorktreeRowChange, WorktreeRowRefusal,
    insert_worktree_statement, transition_statement,
};
use crate::git::worktree::service::{WorktreeService, WorktreeServiceError, remove_folder};
use crate::git::worktree::setup::{MadeWorktree, WorktreeSetupError, WorktreeSetupRunner};
use crate::git::worktree::status::NewWorktreeSuggestionSource;
use crate::git::worktree::tree_records::{has_record_naming, remove_records_naming};
use crate::trust_envelope::is_contained_within;

// `creating -> failed`, for a recorded tree that could not reach `ready`. It appends no event: the
// caller's failed preparation records the failure on the workspace.
static MARK_FAILED_SQL: LazyLock<String> = LazyLock::new(|| {
    let failed = <&'static str>::from(WorktreeState::Failed);
    let creating = <&'static str>::from(WorktreeState::Creating);
    format!(
        "UPDATE worktrees
    SET state = '{failed}', updated_at = @now
  WHERE id = @worktree_id AND state = '{creating}'"
    )
});

/// A run of another session live in a folder: the session, the agent the run is for, and the
/// folder as recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRunFolder {
    /// The session the run belongs to.
    pub session_id: SessionId,
    /// The agent the run is for.
    pub agent_id: AgentId,
    /// The folder the run is live in, as its row records it.
    pub folder: PathBuf,
}

/// Why the live runs' folders could not be read; the implementation's own failure is the cause.
#[derive(Debug, thiserror::Error)]
#[error("the folders other sessions' runs are live in could not be read")]
pub struct LiveRunFolderReadError(#[source] pub Box<dyn Error + Send + Sync>);

/// Where creation reads the folders other sessions' runs are live in, so a carry never stashes
/// work from under one: a run whose execution context is unreleased, and a run still queued or
/// starting, at the checkout its session's workspace is in.
pub trait LiveRunFolderReader: Send + Sync {
    /// Every live run of a session other than `session_id`, with its folder and its agent, read
    /// together. Fails when the read fails or a run's agent cannot be read.
    fn read_other_sessions_live_runs<'a>(
        &'a self,
        session_id: &'a SessionId,
    ) -> BoxFuture<'a, Result<Vec<LiveRunFolder>, LiveRunFolderReadError>>;
}

/// How a new tree is named: a whole branch name the caller supplied, or a tail the branch-name
/// pattern fills in.
#[derive(Clone, Debug)]
pub enum WorktreeNameRequest {
    /// A whole branch name, kept as spelled when the pattern did not make it.
    BranchName(String),
    /// A tail the pattern fills in.
    Tail(String),
}

/// What a taken name does: a supplied one is refused, a derived one takes the first ordinal git
/// and the index both accept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameCollision {
    /// Refused with `worktree.branchCollision`, `worktreeFolderTaken` or git's taken line.
    Refuse,
    /// `-2`, `-3` and on, on the branch and the folder together.
    Suffix,
}

/// What [`WorktreeCreator::create`] makes.
#[derive(Clone, Debug)]
pub struct CreateWorktreeInput {
    /// The mount to check out from; it must be attached.
    pub repo_mount_id: RepoMountId,
    /// The session making the tree, recorded on its row and in its folder's short id.
    pub session_id: SessionId,
    /// The run making it; `None` for a prepare before any run.
    pub run_id: Option<RunId>,
    /// Its name.
    pub name: WorktreeNameRequest,
    /// What a taken name does.
    pub on_collision: NameCollision,
    /// The base its branch is cut from; `None` takes the mount's HEAD branch. A leading `-` is
    /// refused.
    pub base_ref: Option<GitRefName>,
    /// The folder whose uncommitted work, untracked files included, the tree takes; refused unless
    /// the base is the branch that folder is on, and while another session's run is live there.
    pub carry_uncommitted_from: Option<PathBuf>,
    /// The person's or agent's id that acted; `None` when the daemon did.
    pub actor: Option<LifecycleActor>,
    /// The id that ties the tree's events to the operation that caused them.
    pub correlation_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
}

/// A tree made and recorded `ready`.
#[derive(Clone, Debug)]
pub struct CreatedWorktree {
    /// The tree.
    pub worktree_id: WorktreeId,
    /// Its branch as made, any suffix included.
    pub branch_name: GitRefName,
    /// Its folder.
    pub fs_root: PathBuf,
    /// The base its branch was cut from, as given or resolved.
    pub base_ref: GitRefName,
    /// The stash still holding the carried work, `None` when nothing was carried; the caller
    /// drops it with [`WorktreeCreator::drop_carried_stash`] once it has adopted the tree.
    pub carried_stash: Option<CarriedStash>,
}

/// What the creator runs with; `W` is the setup card's file watch.
pub struct WorktreeCreatorDeps<W = RecommendedWatcher> {
    /// The daemon's git.
    pub git: GitRunner,
    /// The daemon's read pool.
    pub reads: Arc<DatabaseReadPool>,
    /// The writer a failed tree's `failed` mark goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The seam the tree's events are appended through.
    pub events: Arc<WorktreeEventEmitter>,
    /// The name plans.
    pub naming: WorktreeNaming,
    /// The attached mount a tree is cut from, and a failed tree's record removal.
    pub worktrees: Arc<WorktreeService>,
    /// The setup card each tree is followed on.
    pub setup: Arc<WorktreeSetupRunner<W>>,
    /// The folders other sessions' runs are live in.
    pub live_run_folders: Arc<dyn LiveRunFolderReader>,
    /// Held per checkout, keyed by its canonical folder, from a carry's last check for another
    /// session's run through its stash; the carry is the one holder.
    pub checkout_lock: Arc<KeyedLock<PathBuf>>,
}

/// Why a tree was not made. A refusal keeps its wire code; every other failure keeps its cause,
/// and the failures of undoing what was made ride beside it.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeCreationError {
    /// A refusal the wire carries: `worktree.createFailed` or `worktree.branchCollision`.
    #[error(transparent)]
    Refused(#[from] WorktreeRefusal),
    /// The mount is not attached (`repoMount.notFound`), or could not be read.
    #[error(transparent)]
    Mount(WorktreeServiceError),
    /// The name plan's facts could not be read.
    #[error(transparent)]
    Naming(#[from] WorktreeNamingError),
    /// The live runs' folders could not be read.
    #[error(transparent)]
    LiveRunFolders(#[from] LiveRunFolderReadError),
    /// The read did not reach the database.
    #[error("the worktree rows did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The rows could not be read.
    #[error("the worktree rows could not be read")]
    Database(#[from] rusqlite::Error),
    /// A folder to compare with a live run's could not be resolved.
    #[error("a folder could not be resolved to compare it with a live run's")]
    Folder(#[source] io::Error),
    /// Whether the new tree's folder exists could not be read.
    #[error("whether the new worktree's folder exists could not be read")]
    TreeFolder(#[source] io::Error),
    /// The new tree's folder is no path its row can hold.
    #[error("the new worktree's folder cannot be recorded")]
    FolderText(#[source] TextError),
    /// The row and `worktree.created` were not written.
    #[error("the new worktree's record was not written")]
    Record(#[source] SessionEventEmitError),
    /// The row left `creating` before its move to `ready` committed.
    #[error(transparent)]
    RowMoved(#[from] WorktreeRowRefusal),
    /// The move to `ready` and `worktree.bound` were not written.
    #[error("the new worktree's move to ready was not written")]
    Ready(#[source] SessionEventEmitError),
    /// The setup card could not run on the made tree.
    #[error(transparent)]
    Setup(#[from] WorktreeSetupError),
    /// The suggestion's folder is no path the wire takes.
    #[error("the suggested worktree's folder cannot be sent")]
    SuggestionText(#[source] TextError),
    /// The failure, beside the failures of undoing what was made before it.
    #[error(transparent)]
    Undone(Box<CleanupFailures<WorktreeCreationError, Box<dyn Error + Send + Sync>>>),
}

/// A tree git made, at its name, with what its checkout hook printed when it failed.
#[derive(Debug)]
struct MadeTree {
    name: WorktreeName,
    hook_output: Option<String>,
}

/// The statements the worktree creator prepares on a read connection: the live tree on a branch
/// and the trees a stop left being made.
pub const WORKTREE_CREATOR_STATEMENT_CAPACITY: usize = 2;

/// Makes worktrees and answers the create form's suggestion, through one name plan. Each `UPDATE`
/// carries its legal predecessor in its `WHERE`, so the transition table lives in the statements.
pub struct WorktreeCreator<W = RecommendedWatcher> {
    deps: WorktreeCreatorDeps<W>,
}

impl<W: Watcher + Send + 'static> WorktreeCreator<W> {
    /// A creator over `deps`.
    pub fn new(deps: WorktreeCreatorDeps<W>) -> Self {
        Self { deps }
    }

    /// Makes a worktree: resolves the base, names the branch and folder through the name plan,
    /// lets git judge the name and make the tree, carries uncommitted work when asked, records the
    /// row with `worktree.created` and `ready` with `worktree.bound`, and runs the setup card,
    /// answering once it ends, a failed step included. A refusal of the name writes nothing; a
    /// failure after the row exists marks it `failed` and stands on the card. Fails as
    /// [`WorktreeCreationError`] says; a carry's stash is kept and answered, never dropped here.
    pub async fn create(
        &self,
        input: CreateWorktreeInput,
    ) -> Result<CreatedWorktree, WorktreeCreationError> {
        let mount = self
            .deps
            .worktrees
            .require_attached_mount(&input.repo_mount_id)
            .await
            .map_err(WorktreeCreationError::Mount)?;
        let base_ref = self
            .resolve_base_ref(&mount, input.base_ref.as_ref())
            .await?;
        if let Some(carry_from) = &input.carry_uncommitted_from {
            require_carry_onto_current_branch(
                &self.deps.git,
                mount.place.as_ref(),
                carry_from,
                base_ref.as_str(),
            )
            .await?;
            self.refuse_carry_while_another_runs(carry_from, &input.session_id)
                .await?;
        }

        // Minted before git runs, so the card the tree's `worktree.created` names is already open.
        let worktree_id =
            WorktreeId::try_from(mint_uuid_v7()).expect("a minted UUID is a worktree id");
        self.deps.setup.begin(worktree_id);
        // A tree no row records was never named to anyone, so its card goes.
        let tree = match self.make_tree(&input, &mount, &base_ref).await {
            Ok(tree) => tree,
            Err(failure) => {
                self.deps.setup.forget(&worktree_id);
                return Err(failure);
            }
        };
        let carried = match &input.carry_uncommitted_from {
            None => None,
            Some(carry_from) => {
                match self
                    .carry_under_checkout_lock(carry_from, &input, &mount, &tree, &worktree_id)
                    .await
                {
                    Ok(carried) => carried,
                    Err(failure) => {
                        let undo_failures =
                            undo_unrecorded_tree(&self.deps.git, &mount, &tree.name, true).await;
                        self.deps.setup.forget(&worktree_id);
                        return Err(with_undo_failures(failure, undo_failures));
                    }
                }
            }
        };
        if let Err(failure) = self
            .record_created_row(&input, &mount, &tree, &base_ref, worktree_id)
            .await
        {
            self.deps.setup.forget(&worktree_id);
            return Err(keep_stash_named(carried.as_ref(), failure));
        }
        if let Err(failure) = self.mark_ready(&input, &mount, &tree, worktree_id).await {
            // The tree that took the work is undone, so the stash is the only copy left.
            let failure = keep_stash_named(carried.as_ref(), failure);
            // A recorded tree's failure stands on its card.
            if let Err(card_failure) = self
                .deps
                .setup
                .tree_failed(worktree_id, &describe_error(&failure))
            {
                tracing::warn!(
                    error = &card_failure as &(dyn Error + 'static),
                    "A failed worktree's setup card could not show its failure"
                );
            }
            return Err(failure);
        }
        // A failed step stands on the card for its retry; a setup that could not run fails.
        self.deps
            .setup
            .tree_made(MadeWorktree {
                worktree_id,
                tree_path: tree.name.folder_path.clone(),
                repository_root: PathBuf::from(mount.canonical_root.as_str()),
                repo_mount_id: input.repo_mount_id,
                place: mount.place.clone(),
                hook_output: tree.hook_output,
            })
            .await
            .map_err(|failure| keep_stash_named(carried.as_ref(), failure.into()))?;
        Ok(CreatedWorktree {
            worktree_id,
            branch_name: branch_ref_name(&tree.name),
            fs_root: tree.name.folder_path,
            base_ref,
            carried_stash: carried,
        })
    }

    /// Drops a carry's stash once the caller has adopted `worktree_id`'s tree, its repository at
    /// `place`. The work then stands in the tree, so a stash that cannot be dropped only repeats
    /// it: the failure is logged, where the person can find the leftover, and never fails the tree.
    pub async fn drop_carried_stash(
        &self,
        carried: &CarriedStash,
        worktree_id: &WorktreeId,
        place: Option<&Place>,
    ) {
        if let Err(failure) = drop_carried_stash(&self.deps.git, place, carried).await {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                %worktree_id,
                stash_commit = %carried.commit,
                "The carried work is in the new worktree, but its stash could not be dropped"
            );
        }
    }

    // The supplied base, else the mount's HEAD branch, else a refusal, never a guess. A leading
    // `-` is refused before any git call, since git would read it as an option.
    async fn resolve_base_ref(
        &self,
        mount: &AttachedMountRow,
        supplied: Option<&GitRefName>,
    ) -> Result<GitRefName, WorktreeCreationError> {
        if let Some(supplied) = supplied {
            if supplied.as_str().starts_with('-') {
                return Err(refused(WorktreeCreateFailureReason::BaseRefOptionLike));
            }
            return Ok(supplied.clone());
        }
        let repository = Path::new(mount.canonical_root.as_str());
        match read_current_branch(&self.deps.git, mount.place.as_ref(), repository).await {
            Ok(Some(branch)) => {
                Ok(GitRefName::new(branch).expect("a branch git has checked out is text"))
            }
            Ok(None) => Err(refused(WorktreeCreateFailureReason::BaseRefUnresolved)),
            Err(failure) => Err(create_failed(
                WorktreeCreateFailureReason::BaseRefUnresolved,
                failure,
            )),
        }
    }

    // Stashing takes the checkout's uncommitted work from under any run working there, so a carry
    // is refused while another session's run is live in that checkout, inside it or around it,
    // naming that run's session and agent.
    async fn refuse_carry_while_another_runs(
        &self,
        folder: &Path,
        session_id: &SessionId,
    ) -> Result<(), WorktreeCreationError> {
        let folder_key = canonical_folder_path(folder)
            .await
            .map_err(WorktreeCreationError::Folder)?;
        let live_runs = self
            .deps
            .live_run_folders
            .read_other_sessions_live_runs(session_id)
            .await?;
        for live_run in live_runs {
            let run_key = canonical_folder_path(&live_run.folder)
                .await
                .map_err(WorktreeCreationError::Folder)?;
            if is_contained_within(&run_key, &folder_key)
                || is_contained_within(&folder_key, &run_key)
            {
                return Err(refused(WorktreeCreateFailureReason::CarryCheckoutRunning {
                    running_session_id: live_run.session_id,
                    running_agent_id: live_run.agent_id,
                }));
            }
        }
        Ok(())
    }

    // The tree at the first free name of the plan the input asks for.
    async fn make_tree(
        &self,
        input: &CreateWorktreeInput,
        mount: &AttachedMountRow,
        base_ref: &GitRefName,
    ) -> Result<MadeTree, WorktreeCreationError> {
        let base = self
            .deps
            .naming
            .base_for(&input.repo_mount_id, &input.session_id)
            .await?;
        let plan = match &input.name {
            WorktreeNameRequest::Tail(tail) => WorktreeNamePlan::for_tail(base, tail.clone()),
            WorktreeNameRequest::BranchName(branch_name) => {
                WorktreeNamePlan::for_branch_name(base, branch_name)
            }
        };
        self.name_walk(mount)
            .make_tree_at_first_free_name(&plan, input.on_collision, base_ref)
            .await
    }

    // Checks again right before the stash for a run another session started while git made the
    // tree. The checkout's lock keeps a run from being bound there between that check and the
    // stash; the caller holds the workspace's preparation lock, taken first.
    async fn carry_under_checkout_lock(
        &self,
        carry_from: &Path,
        input: &CreateWorktreeInput,
        mount: &AttachedMountRow,
        tree: &MadeTree,
        worktree_id: &WorktreeId,
    ) -> Result<Option<CarriedStash>, WorktreeCreationError> {
        let checkout_key = canonical_folder_path(carry_from)
            .await
            .map_err(WorktreeCreationError::Folder)?;
        let _checkout_hold = self.deps.checkout_lock.acquire(checkout_key).await;
        self.refuse_carry_while_another_runs(carry_from, &input.session_id)
            .await?;
        Ok(carry_uncommitted_work(
            &self.deps.git,
            mount.place.as_ref(),
            carry_from,
            &tree.name.folder_path,
            worktree_id,
        )
        .await?)
    }

    // Writes the `creating` row and `worktree.created` in one write; undoes the tree on failure. A
    // row the active-branch index refuses is the typed collision; any other refusal, a CHECK's
    // among them, stays the write's failure.
    async fn record_created_row(
        &self,
        input: &CreateWorktreeInput,
        mount: &AttachedMountRow,
        tree: &MadeTree,
        base_ref: &GitRefName,
        worktree_id: WorktreeId,
    ) -> Result<(), WorktreeCreationError> {
        let fs_root =
            match FilesystemPath::new(tree.name.folder_path.to_string_lossy().into_owned()) {
                Ok(fs_root) => fs_root,
                Err(refusal) => {
                    let undo_failures =
                        undo_unrecorded_tree(&self.deps.git, mount, &tree.name, true).await;
                    return Err(with_undo_failures(
                        WorktreeCreationError::FolderText(refusal),
                        undo_failures,
                    ));
                }
            };
        let now = WireInstant::now();
        let row = NewWorktreeRow {
            id: worktree_id,
            repo_mount_id: input.repo_mount_id,
            created_by_session_id: input.session_id,
            created_by_run_id: input.run_id,
            branch_name: branch_ref_name(&tree.name),
            base_ref: base_ref.clone(),
            fs_root,
            now: now.clone(),
        };
        let recorded = self
            .deps
            .events
            .emit_worktree_created(
                event_input(input, worktree_id),
                None,
                SessionEventLinkage {
                    occurred_at: Some(now),
                    correlation_id: input.correlation_id.clone(),
                    transactional_prelude: vec![insert_worktree_statement(&row)],
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        let Err(failure) = recorded else {
            return Ok(());
        };
        let original = if is_active_branch_refusal(&failure) {
            WorktreeRefusal::BranchCollision {
                repo_mount_id: input.repo_mount_id,
                branch_name: row.branch_name,
            }
            .into()
        } else {
            WorktreeCreationError::Record(failure)
        };
        let undo_failures = undo_unrecorded_tree(&self.deps.git, mount, &tree.name, true).await;
        Err(with_undo_failures(original, undo_failures))
    }

    // Records `creating -> ready` with `worktree.bound`. A failure marks the row `failed` and
    // removes the tree: a `creating` row holds its branch under the unique index and no sweep
    // reaches it, so a bare failure would wedge the branch on the mount.
    async fn mark_ready(
        &self,
        input: &CreateWorktreeInput,
        mount: &AttachedMountRow,
        tree: &MadeTree,
        worktree_id: WorktreeId,
    ) -> Result<(), WorktreeCreationError> {
        let now = WireInstant::now();
        let emitted = self
            .deps
            .events
            .emit_worktree_bound(
                event_input(input, worktree_id),
                SessionEventLinkage {
                    occurred_at: Some(now.clone()),
                    correlation_id: input.correlation_id.clone(),
                    transactional_prelude: vec![transition_statement(
                        MARK_READY_SQL.as_str(),
                        &worktree_id,
                        &now,
                        Some(1),
                    )],
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        let Err(failure) = emitted else {
            return Ok(());
        };
        let original = explain_ready_failure(failure, worktree_id);
        let undo_failures = self
            .record_create_failure(
                mount,
                &tree.name.folder_path,
                &tree.name.branch_name,
                &worktree_id,
            )
            .await;
        Err(with_undo_failures(original, undo_failures))
    }

    // Marks the `creating` row `failed`, removes the tree's folder and its own record, then the
    // branch its creation made, answering each step's failure for the caller to carry. No row count
    // is required of the mark: the creation's failure is the one to report.
    async fn record_create_failure(
        &self,
        mount: &AttachedMountRow,
        folder: &Path,
        branch_name: &str,
        worktree_id: &WorktreeId,
    ) -> Vec<Box<dyn Error + Send + Sync>> {
        let mut failures: Vec<Box<dyn Error + Send + Sync>> = Vec::new();
        let place = mount.place.as_ref();
        let mark = transition_statement(
            MARK_FAILED_SQL.as_str(),
            worktree_id,
            &WireInstant::now(),
            None,
        );
        if let Err(mark_failure) = self.deps.writer.write(vec![mark]).await {
            failures.push(mark_failure.into());
        }
        // Read while the folder exists: git names the record only from inside the tree.
        match read_linked_tree_record(&self.deps.git, place, folder).await {
            Ok(record_folder) => match remove_folder(folder).await {
                Ok(()) => {
                    if let Err(record_failure) = self
                        .deps
                        .worktrees
                        .remove_worktree_record(record_folder.as_deref())
                        .await
                    {
                        failures.push(record_failure.into());
                    }
                }
                // A `failed` row is reached by no sweep, so the folder stays until a removal of the
                // row retires it.
                Err(folder_failure) => failures.push(folder_failure.into()),
            },
            Err(record_failure) => failures.push(record_failure.into()),
        }
        let repository = Path::new(mount.canonical_root.as_str());
        let delete_branch = GitCall::write(in_folder(repository, &["branch", "-D", branch_name]));
        if let Err(branch_failure) = self.deps.git.run(place, delete_branch).await {
            failures.push(branch_failure.into());
        }
        failures
    }

    fn name_walk<'a>(&'a self, mount: &'a AttachedMountRow) -> NameWalk<'a> {
        NameWalk {
            git: &self.deps.git,
            reads: &self.deps.reads,
            mount,
        }
    }
}

impl<W: Watcher + Send + 'static> NewWorktreeSuggestionSource for WorktreeCreator<W> {
    // The form's parts for the session's next tree on the mount, from the same plan `create`
    // names a tree with: the tail from the session's title, at the first ordinal whose branch and
    // folder are free, so the form never opens on a refusal.
    fn suggest_new_worktree<'a>(
        &'a self,
        repo_mount_id: &'a RepoMountId,
        session_id: &'a SessionId,
    ) -> BoxFuture<'a, Result<NewWorktreeSuggestion, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let mount = self
                .deps
                .worktrees
                .require_attached_mount(repo_mount_id)
                .await
                .map_err(WorktreeCreationError::Mount)?;
            let tail = self
                .deps
                .naming
                .read_suggested_tail(session_id, None)
                .await
                .map_err(WorktreeCreationError::Naming)?;
            let base = self
                .deps
                .naming
                .base_for(repo_mount_id, session_id)
                .await
                .map_err(WorktreeCreationError::Naming)?;
            let plan = WorktreeNamePlan::for_tail(base, tail);
            // An untitled session's suggestion carries no tail, so there is no name to walk.
            let ordinal = if plan.name_at(1).tail.is_empty() {
                1
            } else {
                self.name_walk(&mount).first_free_ordinal(&plan).await?
            };
            Ok(plan
                .describe_at(ordinal)
                .map_err(WorktreeCreationError::SuggestionText)?)
        })
    }
}

/// Undoes a tree git made that no row records: its folder and record, then the branch this call
/// made, which nothing else names. Each step runs only while what it removes is there, and the
/// branch only when `is_branch_new`; a record git left locked is removed too, since the tree is
/// this call's own. A folder `worktree remove` refuses goes only while a record of the repository
/// names it, so a folder that appeared at the name after git refused the add stays. Answers each
/// step's failure for the caller to carry.
async fn undo_unrecorded_tree(
    git: &GitRunner,
    mount: &AttachedMountRow,
    name: &WorktreeName,
    is_branch_new: bool,
) -> Vec<Box<dyn Error + Send + Sync>> {
    let mut failures: Vec<Box<dyn Error + Send + Sync>> = Vec::new();
    let place = mount.place.as_ref();
    let repository = Path::new(mount.canonical_root.as_str());
    match tokio::fs::try_exists(&name.folder_path).await {
        Ok(true) => {
            // Forced twice: once past the tree's changes, once past the lock a git ended before it
            // finished leaves on the record.
            let mut arguments =
                in_folder(repository, &["worktree", "remove", "--force", "--force"]);
            arguments.push(OsString::from(name.folder_path.as_os_str()));
            if let Err(remove_failure) = git.run(place, GitCall::write(arguments)).await {
                // A tree git left without its `.git` names no record git can find, so its folder
                // goes and the records naming it are found by their `gitdir`. git writes the record
                // before the folder, so a folder no record names is not this call's.
                match remove_tree_without_git(git, place, repository, &name.folder_path).await {
                    Ok(true) => {}
                    Ok(false) => failures.push(remove_failure.into()),
                    Err(fallback_failures) => {
                        failures.push(remove_failure.into());
                        failures.extend(fallback_failures);
                    }
                }
            }
        }
        Ok(false) => {}
        Err(read_failure) => failures.push(read_failure.into()),
    }
    if is_branch_new {
        failures.extend(delete_new_branch(git, place, repository, &name.branch_name).await);
    }
    failures
}

/// Deletes `branch_name`, which this call made and nothing else names, while it is there. Answers
/// the read's or the deletion's failure for the caller to carry.
async fn delete_new_branch(
    git: &GitRunner,
    place: Option<&Place>,
    repository: &Path,
    branch_name: &str,
) -> Vec<Box<dyn Error + Send + Sync>> {
    match has_branch(git, place, repository, branch_name).await {
        Ok(true) => {
            let delete_branch =
                GitCall::write(in_folder(repository, &["branch", "-D", branch_name]));
            match git.run(place, delete_branch).await {
                Ok(_) => Vec::new(),
                Err(branch_failure) => vec![branch_failure.into()],
            }
        }
        Ok(false) => Vec::new(),
        Err(read_failure) => vec![read_failure.into()],
    }
}

// Removes the tree at `folder`, then every record of the repository at `repository` naming it,
// while one does: answers `false`, removing nothing, when none names it. Fails with each step's
// failure.
async fn remove_tree_without_git(
    git: &GitRunner,
    place: Option<&Place>,
    repository: &Path,
    folder: &Path,
) -> Result<bool, Vec<Box<dyn Error + Send + Sync>>> {
    let common_folder = read_git_common_folder(git, place, repository, None)
        .await
        .map_err(|read_failure| vec![read_failure.into()])?;
    if !has_record_naming(&common_folder, folder)
        .await
        .map_err(|read_failure| vec![read_failure.into()])?
    {
        return Ok(false);
    }
    remove_folder(folder)
        .await
        .map_err(|folder_failure| vec![folder_failure.into()])?;
    let record_failures = remove_records_naming(&common_folder, folder).await;
    if record_failures.is_empty() {
        Ok(true)
    } else {
        Err(record_failures.into_iter().map(Into::into).collect())
    }
}

/// `original` beside the failures of undoing what was made before it; `original` alone when the
/// undo had none, so its refusal keeps its type.
fn with_undo_failures(
    original: WorktreeCreationError,
    undo_failures: Vec<Box<dyn Error + Send + Sync>>,
) -> WorktreeCreationError {
    if undo_failures.is_empty() {
        return original;
    }
    WorktreeCreationError::Undone(Box::new(CleanupFailures::new(
        original,
        undo_failures,
        "worktree creation",
    )))
}

/// `worktree.createFailed` for `reason`, with nothing underneath.
fn refused(reason: WorktreeCreateFailureReason) -> WorktreeCreationError {
    WorktreeRefusal::CreateFailed {
        reason,
        source: None,
    }
    .into()
}

/// `worktree.createFailed` for `reason`, keeping `failure` as its source.
fn create_failed(
    reason: WorktreeCreateFailureReason,
    failure: impl Error + Send + Sync + 'static,
) -> WorktreeCreationError {
    WorktreeRefusal::CreateFailed {
        reason,
        source: Some(Box::new(failure)),
    }
    .into()
}

// A failure after the carry's stash was pushed names the stash, which holds the only copy of the
// work once the tree that took it is undone.
fn keep_stash_named(
    carried: Option<&CarriedStash>,
    failure: WorktreeCreationError,
) -> WorktreeCreationError {
    match carried {
        Some(carried) => kept_stash_failure(KeptStash::Commit(&carried.commit), failure).into(),
        None => failure,
    }
}

// Whether the record's write failed at its insert because the active-branch index refused it: a
// live tree on the branch landed between the walk's read and the write.
fn is_active_branch_refusal(failure: &SessionEventEmitError) -> bool {
    let SessionEventEmitError::Append(SessionEventAppendError::Append(EventAppendError::Write(
        write,
    ))) = failure
    else {
        return false;
    };
    write.failed_statement().is_some_and(|(_index, error)| {
        error.sqlite_extended_error_code() == Some(rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
    })
}

// The move to `ready`'s failure: the row-moved refusal when the writer refused it, else the
// append's failure as it came.
fn explain_ready_failure(
    failure: SessionEventEmitError,
    worktree_id: WorktreeId,
) -> WorktreeCreationError {
    let SessionEventEmitError::Append(SessionEventAppendError::Append(EventAppendError::Write(
        write,
    ))) = failure
    else {
        return WorktreeCreationError::Ready(failure);
    };
    match WorktreeRowRefusal::explain(write, worktree_id, WorktreeRowChange::MarkReady) {
        Ok(refusal) => refusal.into(),
        Err(write) => WorktreeCreationError::Ready(SessionEventEmitError::Append(
            SessionEventAppendError::Append(EventAppendError::Write(write)),
        )),
    }
}

fn event_input(input: &CreateWorktreeInput, worktree_id: WorktreeId) -> EmitWorktreeEventInput {
    EmitWorktreeEventInput {
        session_id: input.session_id,
        worktree_id,
        repo_mount_id: Some(input.repo_mount_id),
        workspace_id: None,
        actor: input.actor.clone(),
    }
}

fn branch_ref_name(name: &WorktreeName) -> GitRefName {
    GitRefName::new(name.branch_name.clone()).expect("a branch name git's rule took is text")
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_sources;
#[cfg(test)]
mod tests;
