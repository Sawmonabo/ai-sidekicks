//! The `worktree.status.read` answer, folded from what the service read. Nothing here touches
//! the file system, git, a clock or a database: the service reads git's list of trees, the
//! daemon's records and the figures, and hands them in typed.
//!
//! The read lists the trees still standing, so a `retired` record is left out rather than refused
//! (a tree a discard kept has its own list). Every other state is carried as recorded: `dirty` and
//! `merged` are verdicts the service wrote, and nothing here infers cleanliness. The fold keeps the
//! order it receives and never sorts.

use sidekicks_contracts::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::worktree::lifecycle::{
    ListedWorktreeState, NewWorktreeSuggestion, RepoRootStatus, WorktreeId, WorktreeState,
    WorktreeStatusReadResponse, WorktreeStatusRecord,
};

/// The `worktrees` columns of a tree the daemon made, and the base its branch context recorded,
/// each parsed to its type where the row is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorktreeRecordRow {
    /// `worktrees.id`.
    pub(crate) id: WorktreeId,
    /// The mount the tree belongs to; the projection refuses one other than the read's.
    pub(crate) repo_mount_id: RepoMountId,
    /// The session that made it.
    pub(crate) created_by_session_id: SessionId,
    /// The run that made it; `None` for a tree prepared before any run.
    pub(crate) created_by_run_id: Option<RunId>,
    /// Its state.
    pub(crate) state: WorktreeState,
    /// When it was made.
    pub(crate) created_at: WireInstant,
    /// When it last changed.
    pub(crate) updated_at: WireInstant,
    /// The base the tree was cut from, from its first branch context; `None` when none recorded
    /// it, which the projection refuses.
    pub(crate) base_branch_name: Option<GitRefName>,
}

/// One tree's row: where it is, what it is on, its figures, and its record when the app made it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorktreeStatusRow {
    /// The tree's folder.
    pub(crate) path: FilesystemPath,
    /// Its name.
    pub(crate) name: FreeFormText<FILE_PATH_MAX_LEN>,
    /// Its branch.
    pub(crate) branch_name: GitRefName,
    /// Commits ahead of the branch's upstream; `None` when it has none.
    pub(crate) ahead: Option<SafeInt<0>>,
    /// Commits behind the branch's upstream; `None` when it has none.
    pub(crate) behind: Option<SafeInt<0>>,
    /// Uncommitted files.
    pub(crate) uncommitted_file_count: SafeInt<0>,
    /// Commits no remote-tracking branch reaches.
    pub(crate) unpushed_commit_count: SafeInt<0>,
    /// The sessions standing in it.
    pub(crate) occupying_session_ids: Vec<SessionId>,
    /// The session whose agent runs in the tree, if one does.
    pub(crate) running_session_id: Option<SessionId>,
    /// The daemon's record of a tree it made; `None` for one the person made.
    pub(crate) record: Option<WorktreeRecordRow>,
}

/// One read's worth of input: the project's mount, its own checkout and its trees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorktreeStatusReading {
    /// The mount the read resolved the project to; every record must belong to it.
    pub(crate) repo_mount_id: RepoMountId,
    /// The project's own checkout.
    pub(crate) repo_root: RepoRootStatus,
    /// Its trees, in the order git listed them.
    pub(crate) worktrees: Vec<WorktreeStatusRow>,
    /// When the ahead and behind figures were last true, when the last fetch failed.
    pub(crate) counts_as_of: Option<WireInstant>,
    /// The new-worktree form's suggestion, when the read named the asking session.
    pub(crate) new_worktree: Option<NewWorktreeSuggestion>,
}

/// Why a reading could not be folded. Neither message names a path.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeStatusProjectionError {
    /// A record belongs to another mount than the reading's. Leaving it out would hide the
    /// caller's mispaired query, and listing it would show another project's trees as this one's.
    #[error(
        "Worktree status-read projection refused a worktree record on a different project mount \
         than the one being read: record \"{}\". Projecting it would list another project's \
         worktrees, and no screen could detect it.",
        .worktree_id
    )]
    ForeignMount {
        /// The record's worktree.
        worktree_id: WorktreeId,
    },
    /// A record names no base, so its row has no true branch to show it was cut from.
    #[error(
        "Worktree status-read projection found no recorded base for worktree \"{}\", so its row \
         cannot name the branch it was cut off.",
        .worktree_id
    )]
    NoRecordedBase {
        /// The record's worktree.
        worktree_id: WorktreeId,
    },
}

/// Folds one project's trees onto the `worktree.status.read` answer, leaving out `retired`
/// records. Refuses a record of another mount than the reading's, and one that recorded no base.
pub(crate) fn project_worktree_status_read(
    reading: WorktreeStatusReading,
) -> Result<WorktreeStatusReadResponse, WorktreeStatusProjectionError> {
    let mut worktrees = Vec::with_capacity(reading.worktrees.len());
    for row in reading.worktrees {
        let Some(record) = row.record else {
            worktrees.push(WorktreeStatusRecord::Person {
                path: row.path,
                name: row.name,
                branch_name: row.branch_name,
                ahead: row.ahead,
                behind: row.behind,
                uncommitted_file_count: row.uncommitted_file_count,
                unpushed_commit_count: row.unpushed_commit_count,
                occupying_session_ids: row.occupying_session_ids,
                running_session_id: row.running_session_id,
            });
            continue;
        };
        // Checked before the retired skip, so a mispaired query fails whatever the record's state.
        if record.repo_mount_id != reading.repo_mount_id {
            return Err(WorktreeStatusProjectionError::ForeignMount {
                worktree_id: record.id,
            });
        }
        let Ok(state) = ListedWorktreeState::try_from(record.state) else {
            continue;
        };
        let Some(base_branch_name) = record.base_branch_name else {
            return Err(WorktreeStatusProjectionError::NoRecordedBase {
                worktree_id: record.id,
            });
        };
        worktrees.push(WorktreeStatusRecord::App {
            worktree_id: record.id,
            repo_mount_id: record.repo_mount_id,
            base_branch_name,
            state,
            created_by_session_id: record.created_by_session_id,
            created_by_run_id: record.created_by_run_id,
            created_at: record.created_at,
            updated_at: record.updated_at,
            path: row.path,
            name: row.name,
            branch_name: row.branch_name,
            ahead: row.ahead,
            behind: row.behind,
            uncommitted_file_count: row.uncommitted_file_count,
            unpushed_commit_count: row.unpushed_commit_count,
            occupying_session_ids: row.occupying_session_ids,
            running_session_id: row.running_session_id,
        });
    }
    Ok(WorktreeStatusReadResponse {
        repo_root: reading.repo_root,
        worktrees,
        counts_as_of: reading.counts_as_of,
        new_worktree: reading.new_worktree,
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::repo::mount::RepoMountId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_contracts::worktree::lifecycle::{
        ListedWorktreeState, RepoRootStatus, WorktreeId, WorktreeState, WorktreeStatusRecord,
    };

    use super::{
        WorktreeRecordRow, WorktreeStatusProjectionError, WorktreeStatusReading, WorktreeStatusRow,
        project_worktree_status_read,
    };

    const READ_MOUNT: &str = "0192f3a4-5b6c-7d8e-9f01-000000000001";
    const OTHER_MOUNT: &str = "0192f3a4-5b6c-7d8e-9f01-000000000002";
    const WORKTREE: &str = "0192f3a4-5b6c-7d8e-9f01-000000000003";
    const SESSION: &str = "0192f3a4-5b6c-7d8e-9f01-000000000004";

    fn text<const MAX: usize>(value: &str) -> FreeFormText<MAX> {
        FreeFormText::new(value.to_owned()).expect("the text is short")
    }

    fn mount(id: &str) -> RepoMountId {
        RepoMountId::new(id).expect("the id is a UUID")
    }

    fn instant() -> WireInstant {
        WireInstant::try_from("2026-10-14T09:30:00.000Z".to_owned())
            .expect("the instant is RFC 3339")
    }

    fn reading_of(
        repo_mount_id: &str,
        state: WorktreeState,
        has_base: bool,
    ) -> WorktreeStatusReading {
        let record = WorktreeRecordRow {
            id: WorktreeId::new(WORKTREE).expect("the id is a UUID"),
            repo_mount_id: mount(repo_mount_id),
            created_by_session_id: SessionId::new(SESSION).expect("the id is a UUID"),
            created_by_run_id: None,
            state,
            created_at: instant(),
            updated_at: instant(),
            base_branch_name: has_base.then(|| text("main")),
        };
        WorktreeStatusReading {
            repo_mount_id: mount(READ_MOUNT),
            repo_root: RepoRootStatus {
                path: FilesystemPath::new("/repos/app".to_owned()).expect("the path is short"),
                branch_name: text("main"),
            },
            worktrees: vec![WorktreeStatusRow {
                path: FilesystemPath::new("/worktrees/app/feature".to_owned())
                    .expect("the path is short"),
                name: text("feature"),
                branch_name: text("feature"),
                ahead: None,
                behind: None,
                uncommitted_file_count: SafeInt::ZERO,
                unpushed_commit_count: SafeInt::ZERO,
                occupying_session_ids: Vec::new(),
                running_session_id: None,
                record: Some(record),
            }],
            counts_as_of: None,
            new_worktree: None,
        }
    }

    // What the fold answers: the listed records' states, or the refusal's kind.
    #[derive(Debug, PartialEq, Eq)]
    enum Outcome {
        Listed(Vec<ListedWorktreeState>),
        ForeignMount,
        NoRecordedBase,
    }

    #[rstest]
    #[case::live_record_listed(
        READ_MOUNT,
        WorktreeState::Dirty,
        true,
        Outcome::Listed(vec![ListedWorktreeState::Dirty])
    )]
    #[case::retired_record_left_out(
        READ_MOUNT,
        WorktreeState::Retired,
        false,
        Outcome::Listed(Vec::new())
    )]
    #[case::foreign_mount_refused_even_retired(
        OTHER_MOUNT,
        WorktreeState::Retired,
        true,
        Outcome::ForeignMount
    )]
    #[case::no_base_refused(READ_MOUNT, WorktreeState::Ready, false, Outcome::NoRecordedBase)]
    fn lists_live_records_of_the_read_mount_with_their_base(
        #[case] repo_mount_id: &str,
        #[case] state: WorktreeState,
        #[case] has_base: bool,
        #[case] expected: Outcome,
    ) {
        let outcome = match project_worktree_status_read(reading_of(repo_mount_id, state, has_base))
        {
            Ok(response) => Outcome::Listed(
                response
                    .worktrees
                    .into_iter()
                    .filter_map(|record| match record {
                        WorktreeStatusRecord::App { state, .. } => Some(state),
                        WorktreeStatusRecord::Person { .. } => None,
                    })
                    .collect(),
            ),
            Err(WorktreeStatusProjectionError::ForeignMount { .. }) => Outcome::ForeignMount,
            Err(WorktreeStatusProjectionError::NoRecordedBase { .. }) => Outcome::NoRecordedBase,
        };
        assert_eq!(outcome, expected);
    }
}
