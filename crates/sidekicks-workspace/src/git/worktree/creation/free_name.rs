//! The first name a new tree can take, and the tree made at it. Git's branch-name rule judges each
//! candidate first. A name the daemon derived then moves to its next ordinal while a live tree, a
//! branch or a folder holds it, and a name the caller supplied is refused instead. `worktree add
//! -b` makes the tree; its taken-branch or taken-folder line moves a derived name on and refuses a
//! supplied one, and a tree git made before its checkout hook failed is kept, the hook's words
//! beside it.

use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::place::Place;
use sidekicks_std::error_description::describe_error;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};

use super::{
    MadeTree, NameCollision, WorktreeCreationError, create_failed, delete_new_branch, refused,
    undo_unrecorded_tree, with_undo_failures,
};
use crate::git::branch_name_pattern::read_branch_name_refusal;
use crate::git::process::{
    GitCall, GitError, GitRunner, background_read, in_folder, read_git_common_folder,
};
use crate::git::worktree::errors::{WorktreeCreateFailureReason, WorktreeRefusal};
use crate::git::worktree::naming::{
    WorktreeName, WorktreeNamePlan, read_taken_branch_line, read_taken_folder_line,
};
use crate::git::worktree::reads::{
    RECORD_LOCK_FILE_NAME, has_branch, read_branch_names, read_linked_tree_record,
};
use crate::git::worktree::rows::{AttachedMountRow, LIVE_WORKTREE_STATE_PREDICATE};
use crate::git::worktree::tree_records::{has_record_naming, hold_records};

// The index's own predicate, read before git runs so a daemon-made live tree on the name is the
// typed collision rather than git's line.
static SELECT_LIVE_WORKTREE_ON_BRANCH_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM worktrees
 WHERE repo_mount_id = ? AND branch_name = ? AND {}
 LIMIT 1",
        LIVE_WORKTREE_STATE_PREDICATE.as_str()
    )
});

// How the line `worktree add` prints before it makes the tree starts.
const GIT_PREPARING_LINE_START: &str = "Preparing worktree ";

/// Where the walk names and makes trees: the daemon's git and read pool, and the attached mount
/// whose repository every git call runs in.
pub(super) struct NameWalk<'a> {
    /// The daemon's git.
    pub(super) git: &'a GitRunner,
    /// The daemon's read pool, for the live trees on a branch.
    pub(super) reads: &'a DatabaseReadPool,
    /// The mount the tree is made from.
    pub(super) mount: &'a AttachedMountRow,
}

// What a walk judges a name against: every local branch, and the repository's git common folder,
// whose records may name a folder.
struct TakenNames {
    branches: Vec<String>,
    common_folder: PathBuf,
}

// What one `worktree add -b` did.
enum AddOutcome {
    Made(MadeTree),
    // Git refused the branch as taken, with its line.
    Taken(String),
    // Git refused the folder as taken by something it did not make.
    FolderTaken,
}

impl NameWalk<'_> {
    /// Makes the tree from `base_ref` at the first name git and the index accept: ordinal 1 only
    /// under `Refuse`, each ordinal in turn under `Suffix`. Git's own check decides; the index,
    /// branch and folder reads only spare `Suffix` a refused git call. Fails with
    /// `worktree.createFailed` (`branchNameInvalid`, `branchNameTaken`, `worktreeFolderTaken`,
    /// `executionRootUnavailable`, `gitInvocationFailed`), `worktree.branchCollision` for a
    /// supplied name a live tree holds, or a read's failure; a tree git left behind is undone
    /// first.
    pub(super) async fn make_tree_at_first_free_name(
        &self,
        plan: &WorktreeNamePlan,
        collision: NameCollision,
        base_ref: &GitRefName,
    ) -> Result<MadeTree, WorktreeCreationError> {
        let taken = match collision {
            NameCollision::Suffix => Some(self.read_taken_names().await?),
            NameCollision::Refuse => None,
        };
        let common_folder = match &taken {
            Some(taken) => taken.common_folder.clone(),
            None => self.read_common_folder().await?,
        };
        // `Refuse` stops at ordinal 1, made or refused; `Suffix` walks until a name is free, which
        // it reaches because only finitely many names are taken.
        let mut ordinal = 1;
        loop {
            let name = plan.name_at(ordinal);
            self.require_valid_branch_name(&name.branch_name).await?;
            match &taken {
                Some(taken) => {
                    if !self.is_name_free(&name, taken).await? {
                        ordinal += 1;
                        continue;
                    }
                }
                None => self.refuse_taken_name(&name).await?,
            }
            match self.add_worktree(name, base_ref, &common_folder).await? {
                AddOutcome::Made(tree) => return Ok(tree),
                AddOutcome::Taken(git_line) => match collision {
                    NameCollision::Refuse => {
                        return Err(refused(WorktreeCreateFailureReason::BranchNameTaken {
                            git_line,
                        }));
                    }
                    NameCollision::Suffix => ordinal += 1,
                },
                AddOutcome::FolderTaken => match collision {
                    NameCollision::Refuse => {
                        return Err(refused(WorktreeCreateFailureReason::WorktreeFolderTaken));
                    }
                    NameCollision::Suffix => ordinal += 1,
                },
            }
        }
    }

    /// The first ordinal of `plan` whose branch and folder are free, by the rule `Suffix` walks
    /// with. Fails with `gitInvocationFailed` when the branches cannot be listed, or a read's
    /// failure.
    pub(super) async fn first_free_ordinal(
        &self,
        plan: &WorktreeNamePlan,
    ) -> Result<u32, WorktreeCreationError> {
        let taken = self.read_taken_names().await?;
        let mut ordinal = 1;
        while !self.is_name_free(&plan.name_at(ordinal), &taken).await? {
            ordinal += 1;
        }
        Ok(ordinal)
    }

    fn place(&self) -> Option<&Place> {
        self.mount.place.as_ref()
    }

    fn repository(&self) -> &Path {
        Path::new(self.mount.canonical_root.as_str())
    }

    // Every local branch, read once per walk; a read that does not complete fails the creation.
    async fn read_branch_names(&self) -> Result<Vec<String>, WorktreeCreationError> {
        read_branch_names(self.git, self.place(), self.repository())
            .await
            .map_err(|failure| {
                create_failed(WorktreeCreateFailureReason::GitInvocationFailed, failure)
            })
    }

    // Git's own branch-name rule, run before any row or tree exists; its refusal carries its line.
    async fn require_valid_branch_name(
        &self,
        branch_name: &str,
    ) -> Result<(), WorktreeCreationError> {
        match read_branch_name_refusal(self.git, branch_name).await {
            Ok(None) => Ok(()),
            Ok(Some(line)) => Err(refused(WorktreeCreateFailureReason::BranchNameInvalid {
                line,
            })),
            Err(failure) => Err(create_failed(
                WorktreeCreateFailureReason::GitInvocationFailed,
                failure,
            )),
        }
    }

    // A supplied name is refused while a live tree holds its branch or its folder exists.
    async fn refuse_taken_name(&self, name: &WorktreeName) -> Result<(), WorktreeCreationError> {
        if self.has_live_worktree_on(&name.branch_name).await? {
            return Err(WorktreeRefusal::BranchCollision {
                repo_mount_id: self.mount.id,
                branch_name: GitRefName::new(name.branch_name.clone())
                    .expect("a branch name git's rule took is text"),
            }
            .into());
        }
        if is_folder_present(&name.folder_path).await? {
            return Err(refused(WorktreeCreateFailureReason::WorktreeFolderTaken));
        }
        Ok(())
    }

    // Free when no live tree holds the branch, no branch git has holds it or sits inside or above
    // it, the folder does not exist, and no record git keeps names it, as one a crash left would.
    async fn is_name_free(
        &self,
        name: &WorktreeName,
        taken: &TakenNames,
    ) -> Result<bool, WorktreeCreationError> {
        Ok(!self.has_live_worktree_on(&name.branch_name).await?
            && !taken
                .branches
                .iter()
                .any(|branch| do_branches_conflict(branch, &name.branch_name))
            && !is_folder_present(&name.folder_path).await?
            && !has_record_naming(&taken.common_folder, &name.folder_path)
                .await
                .map_err(WorktreeCreationError::TreeFolder)?)
    }

    // The branches and the git common folder a walk judges names against, read once per walk; a
    // read that does not complete fails the creation.
    async fn read_taken_names(&self) -> Result<TakenNames, WorktreeCreationError> {
        Ok(TakenNames {
            branches: self.read_branch_names().await?,
            common_folder: self.read_common_folder().await?,
        })
    }

    // The repository's git common folder; a read that does not complete fails the creation.
    async fn read_common_folder(&self) -> Result<PathBuf, WorktreeCreationError> {
        read_git_common_folder(self.git, self.place(), self.repository(), None)
            .await
            .map_err(|failure| {
                create_failed(WorktreeCreateFailureReason::GitInvocationFailed, failure)
            })
    }

    async fn has_live_worktree_on(&self, branch_name: &str) -> Result<bool, WorktreeCreationError> {
        let repo_mount_id = self.mount.id.to_string();
        let branch_name = branch_name.to_owned();
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_LIVE_WORKTREE_ON_BRANCH_SQL.as_str())?
                    .exists([repo_mount_id, branch_name])?)
            })
            .await
    }

    // `git worktree add -b` at the name's folder, with the repository's hooks and file watch, as
    // the person's own tree gets them, holding the records of the repository whose git common
    // folder is `common_folder` while git writes its record. On git's taken-folder line only the
    // branch it made before that check is deleted, so whatever stands at the folder stays. Any
    // other failure that is neither git's taken-branch line nor a made tree whose checkout hook
    // failed undoes what git left and fails.
    async fn add_worktree(
        &self,
        name: WorktreeName,
        base_ref: &GitRefName,
        common_folder: &Path,
    ) -> Result<AddOutcome, WorktreeCreationError> {
        if let Some(parent) = name.folder_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|failure| {
                create_failed(
                    WorktreeCreateFailureReason::ExecutionRootUnavailable,
                    failure,
                )
            })?;
        }
        // Read first so an undo deletes the branch only when this call made it: git can fail on a
        // bad base before it checks the branch, and the person's own branch of that name stays.
        let is_branch_new =
            !has_branch(self.git, self.place(), self.repository(), &name.branch_name)
                .await
                .map_err(|failure| {
                    create_failed(WorktreeCreateFailureReason::GitInvocationFailed, failure)
                })?;
        let mut arguments = in_folder(
            self.repository(),
            &["worktree", "add", "-b", &name.branch_name],
        );
        arguments.push(name.folder_path.clone().into_os_string());
        arguments.push(OsString::from(base_ref.as_str()));
        let records_hold = hold_records(common_folder).await.map_err(|failure| {
            create_failed(
                WorktreeCreateFailureReason::ExecutionRootUnavailable,
                failure,
            )
        })?;
        let added = self.git.run(self.place(), GitCall::write(arguments)).await;
        drop(records_hold);
        let Err(failure) = added else {
            return Ok(AddOutcome::Made(MadeTree {
                name,
                hook_output: None,
            }));
        };
        if let GitError::Exited { stderr, .. } = &failure
            && let Some(git_line) = read_taken_branch_line(stderr)
        {
            return Ok(AddOutcome::Taken(git_line.to_owned()));
        }
        if let GitError::Exited { stderr, .. } = &failure
            && read_taken_folder_line(stderr, &name.folder_path).is_some()
        {
            let undo_failures = if is_branch_new {
                delete_new_branch(self.git, self.place(), self.repository(), &name.branch_name)
                    .await
            } else {
                Vec::new()
            };
            if undo_failures.is_empty() {
                return Ok(AddOutcome::FolderTaken);
            }
            return Err(with_undo_failures(
                refused(WorktreeCreateFailureReason::WorktreeFolderTaken),
                undo_failures,
            ));
        }
        // git runs the checkout hook only once the tree is made, and a failing hook does not undo
        // it, so a tree whose record stands unlocked with its HEAD resolving is kept.
        let judgment_failure = match is_tree_made(self.git, self.place(), &name.folder_path).await {
            Ok(true) => {
                let hook_output = match &failure {
                    GitError::Exited { stderr, .. } => without_git_preamble(stderr),
                    GitError::WslPlace { .. }
                    | GitError::NotFound
                    | GitError::Start(_)
                    | GitError::TimedOut { .. }
                    | GitError::OutputTooLarge { .. }
                    | GitError::Read(_)
                    | GitError::PathText(_)
                    | GitError::NotStartable => describe_error(&failure),
                };
                return Ok(AddOutcome::Made(MadeTree {
                    name,
                    hook_output: Some(hook_output),
                }));
            }
            Ok(false) => None,
            Err(judgment_failure) => Some(judgment_failure),
        };
        // git's `stderr` rides only on the source: it is the value most likely to name a path.
        let mut undo_failures =
            undo_unrecorded_tree(self.git, self.mount, &name, is_branch_new).await;
        undo_failures.extend(judgment_failure);
        Err(with_undo_failures(
            create_failed(WorktreeCreateFailureReason::GitInvocationFailed, failure),
            undo_failures,
        ))
    }
}

// What the checkout hook printed: git's standard error without the line `worktree add` opens
// with, trimmed.
fn without_git_preamble(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|line| !line.starts_with(GIT_PREPARING_LINE_START))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

// Whether `folder` holds a tree git finished making: its own record stands with no `locked` file,
// and its HEAD resolves. A git ended by its time bound leaves the record locked, so it reads as not
// made. Fails when the record, the lock or HEAD cannot be read.
async fn is_tree_made(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<bool, Box<dyn Error + Send + Sync>> {
    let Some(record_folder) = read_linked_tree_record(git, place, folder).await? else {
        return Ok(false);
    };
    if tokio::fs::try_exists(record_folder.join(RECORD_LOCK_FILE_NAME)).await? {
        return Ok(false);
    }
    let head = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &["rev-parse", "--verify", "--quiet", "HEAD"],
            )),
        )
        .await;
    match head {
        Ok(_) => Ok(true),
        Err(failure) if failure.exit_code().is_some() => Ok(false),
        Err(failure) => Err(failure.into()),
    }
}

// Whether `folder` exists; a read that cannot tell fails the creation.
async fn is_folder_present(folder: &Path) -> Result<bool, WorktreeCreationError> {
    tokio::fs::try_exists(folder)
        .await
        .map_err(WorktreeCreationError::TreeFolder)
}

// `feature` and `feature/x` cannot both be branches: one would be a folder of the other's file.
fn do_branches_conflict(existing: &str, candidate: &str) -> bool {
    existing == candidate
        || existing
            .strip_prefix(candidate)
            .is_some_and(|rest| rest.starts_with('/'))
        || candidate
            .strip_prefix(existing)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{AddOutcome, NameWalk, do_branches_conflict};
    use crate::git::process::test_repository::git_in;
    use crate::git::worktree::creation::tests::{CreationFixture, plan_for};
    use crate::git::worktree::creation::{NameCollision, WorktreeCreationError};
    use crate::git::worktree::errors::{WorktreeCreateFailureReason, WorktreeRefusal};
    use crate::git::worktree::reads::has_branch;

    // Kills dropping the inside-or-above conflict, either way round, and a prefix that is no
    // folder of the other (`feat` beside `feature`) read as one.
    #[rstest]
    #[case::same("feature", "feature", true)]
    #[case::candidate_holds_existing("feature/x", "feature", true)]
    #[case::existing_holds_candidate("feature", "feature/x", true)]
    #[case::shared_prefix_only("feat", "feature", false)]
    #[case::siblings("feature/x", "feature/y", false)]
    fn a_branch_conflicts_with_one_inside_or_above_it(
        #[case] existing: &str,
        #[case] candidate: &str,
        #[case] expected: bool,
    ) {
        assert_eq!(do_branches_conflict(existing, candidate), expected);
    }

    // A crash left git's record of a tree whose folder is gone, on another branch; `worktree add`
    // refuses that folder as missing but registered. Kills a walk that reads only the branch, the
    // index and the folder, and stops on git's refusal.
    #[tokio::test]
    async fn suffix_moves_past_a_folder_a_stale_record_names() {
        let fixture = CreationFixture::new().await;
        let plan = plan_for(&fixture, "stale");
        let stale_folder = plan.name_at(1).folder_path;
        git_in(
            &fixture.git,
            &fixture.repository,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "elsewhere",
                &stale_folder.to_string_lossy(),
            ],
        )
        .await;
        tokio::fs::remove_dir_all(&stale_folder)
            .await
            .expect("the tree's folder goes missing");
        let walk = NameWalk {
            git: &fixture.git,
            reads: &fixture.reads,
            mount: &fixture.mount,
        };

        let made = walk
            .make_tree_at_first_free_name(
                &plan,
                NameCollision::Suffix,
                &CreationFixture::base_ref(),
            )
            .await
            .expect("a suffixed name is made");

        assert_eq!(made.name.branch_name, "stale-2");
    }

    // Kills a derived name that does not move past a taken branch, and git's taken line for a
    // supplied name mapped to another reason or read without its line.
    #[tokio::test]
    async fn suffix_moves_past_a_taken_branch_and_refuse_answers_git_s_taken_line() {
        let fixture = CreationFixture::new().await;
        git_in(&fixture.git, &fixture.repository, &["branch", "feature"]).await;
        git_in(&fixture.git, &fixture.repository, &["branch", "release/x"]).await;
        let walk = NameWalk {
            git: &fixture.git,
            reads: &fixture.reads,
            mount: &fixture.mount,
        };
        let base_ref = CreationFixture::base_ref();

        let suffixed = walk
            .make_tree_at_first_free_name(
                &plan_for(&fixture, "feature"),
                NameCollision::Suffix,
                &base_ref,
            )
            .await
            .expect("a suffixed name is made");
        assert_eq!(suffixed.name.branch_name, "feature-2");
        assert!(
            suffixed
                .name
                .folder_path
                .ends_with(format!("{}-feature-2", fixture.session_short_id()))
        );
        assert!(suffixed.name.folder_path.join(".git").exists());

        let refused = walk
            .make_tree_at_first_free_name(
                &plan_for(&fixture, "release"),
                NameCollision::Refuse,
                &base_ref,
            )
            .await
            .expect_err("a supplied name a branch sits inside is refused");
        let WorktreeCreationError::Refused(WorktreeRefusal::CreateFailed {
            reason: WorktreeCreateFailureReason::BranchNameTaken { git_line },
            ..
        }) = &refused
        else {
            panic!("expected branchNameTaken, got {refused:?}");
        };
        assert!(
            git_line.starts_with("fatal: "),
            "git's line as printed: {git_line}"
        );
        assert!(
            git_line.contains("'refs/heads/release/x' exists"),
            "{git_line}"
        );
    }

    // The person's own tree appears at the name between the walk's free check and `worktree add`,
    // which git refuses as existing after it made the branch. Kills an undo run on that refusal,
    // which would remove the person's tree and its record, and a made branch left behind.
    #[tokio::test]
    async fn an_add_refused_as_existing_leaves_the_tree_standing_at_the_folder() {
        let fixture = CreationFixture::new().await;
        let name = plan_for(&fixture, "fix").name_at(1);
        git_in(
            &fixture.git,
            &fixture.repository,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "own",
                &name.folder_path.to_string_lossy(),
            ],
        )
        .await;
        std::fs::write(name.folder_path.join("notes.txt"), "kept").expect("its file is written");
        let walk = NameWalk {
            git: &fixture.git,
            reads: &fixture.reads,
            mount: &fixture.mount,
        };
        let branch_name = name.branch_name.clone();
        let folder = name.folder_path.clone();

        let outcome = walk
            .add_worktree(
                name,
                &CreationFixture::base_ref(),
                &fixture.repository.join(".git"),
            )
            .await
            .expect("the taken folder is an outcome, not a failure");

        assert!(matches!(outcome, AddOutcome::FolderTaken));
        assert_eq!(
            std::fs::read_to_string(folder.join("notes.txt")).expect("the tree's file is left"),
            "kept"
        );
        let records = std::fs::read_dir(fixture.repository.join(".git").join("worktrees"))
            .expect("the records are listed")
            .count();
        assert_eq!(records, 1, "the person's tree keeps its record");
        assert!(
            !has_branch(&fixture.git, None, &fixture.repository, &branch_name)
                .await
                .expect("the branches are read"),
            "the branch git made before refusing the folder is left"
        );
    }
}
