//! Whether a watched worktree's branch has merged back into its base.
//!
//! - A branch can read merged only once it has held commits of its own. The row records that the
//!   first time a check counts a commit on the branch that neither its base nor the base's
//!   upstream holds, or, while it records none, finds a `commit:` entry in the branch's reflog. A
//!   branch that only caught up with its base, or never left it, never reads merged.
//! - Such a branch has merged when its base or the base's upstream holds its tip, or, where neither
//!   does, when nothing on it is left unapplied there: each of its commits' patches found on that
//!   side, or all of its changes as one squashed patch. The patch test runs once per combination of
//!   the branch's, the base's and the upstream's tips.
//! - A base that names no local or remote-tracking branch reads as not merged, logged once.

use std::collections::HashSet;
use std::io;
use std::path::Path;

use sidekicks_contracts::place::Place;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::writer::WriteError;

use super::WorkingFolderWatcherDeps;
use super::tree_state::StandingTree;
use crate::git::process::{GitCall, GitError, GitRunner, background_read, strip_line_end};
use crate::git::turn_snapshot::capture::{SNAPSHOT_IDENTITY_EMAIL, SNAPSHOT_IDENTITY_NAME};
use crate::git::worktree::reads::{BRANCH_REF_PREFIX, read_ref_heads};
use crate::git::worktree::rows::transition_statement;

// Records that the tree's branch has held a commit of its own.
const MARK_OWN_COMMITS_SQL: &str = "UPDATE worktrees SET has_own_commits = 1, updated_at = @now
  WHERE id = @worktree_id AND has_own_commits = 0";

// The prefix of every remote-tracking branch's full ref name.
const REMOTE_REF_PREFIX: &str = "refs/remotes/";

// The reflog subject git writes for a commit made on the branch.
const COMMIT_REFLOG_PREFIX: &[u8] = b"commit:";

// `merge-base`'s exit when the two commits share no history.
const NO_MERGE_BASE_EXIT_CODE: i32 = 1;

/// What a folder's merged checks keep between changes: the last patch test's tips and verdict, and
/// each base already logged as naming no branch.
#[derive(Default)]
pub(super) struct MergedCheck {
    last_patch_test: Option<(BranchTips, bool)>,
    unresolved_bases: HashSet<String>,
}

// The commits a check reads: the branch's tip, its base's and the base's upstream's, where it has
// one.
#[derive(Clone, Debug, PartialEq, Eq)]
struct BranchTips {
    tip: String,
    base: String,
    upstream: Option<String>,
}

impl BranchTips {
    // The base's commit, then its upstream's.
    fn targets(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.base.as_str()).chain(self.upstream.as_deref())
    }
}

/// Why whether a branch merged back could not be read.
#[derive(Debug, thiserror::Error)]
pub(super) enum MergedReadError {
    /// A git read failed.
    #[error("a worktree's branch or its base could not be read")]
    Git(#[from] GitError),
    /// The row's record of the branch's own commits could not be written.
    #[error("that a worktree's branch held commits of its own could not be recorded")]
    Write(#[from] WriteError),
}

impl MergedCheck {
    /// Whether `tree`'s branch, checked out at `folder`, has merged back into its base, recording
    /// on its row when it is first seen holding commits of its own. Fails as git or the write does.
    pub(super) async fn has_merged_back(
        &mut self,
        deps: &WorkingFolderWatcherDeps,
        place: Option<&Place>,
        folder: &Path,
        tree: &StandingTree,
    ) -> Result<bool, MergedReadError> {
        let git = &deps.git;
        let branch_ref = format!("{BRANCH_REF_PREFIX}{}", tree.row.branch_name.as_str());
        let Some(tips) = self
            .read_tips(git, place, folder, &branch_ref, &tree.base)
            .await?
        else {
            return Ok(false);
        };
        let is_contained = count_own_commits(git, place, folder, &tips).await? == 0;
        if is_contained {
            if tree.has_own_commits {
                return Ok(true);
            }
            if !has_committed_on(git, place, folder, &branch_ref).await? {
                return Ok(false);
            }
            mark_own_commits(deps, tree).await?;
            return Ok(true);
        }
        if !tree.has_own_commits {
            mark_own_commits(deps, tree).await?;
        }
        if let Some((last_tips, verdict)) = &self.last_patch_test
            && *last_tips == tips
        {
            return Ok(*verdict);
        }
        let verdict = is_applied(git, place, folder, &tips).await?;
        self.last_patch_test = Some((tips, verdict));
        Ok(verdict)
    }

    // The branch's tip and its base's, with the base's upstream's where it follows one that
    // exists here; `None` when the branch is gone or the base names no branch.
    async fn read_tips(
        &mut self,
        git: &GitRunner,
        place: Option<&Place>,
        folder: &Path,
        branch_ref: &str,
        base: &str,
    ) -> Result<Option<BranchTips>, GitError> {
        // A base is stored as given: a local branch's short name first, then a full ref name, then
        // a remote-tracking branch's short name.
        let mut base_refs = vec![
            format!("{BRANCH_REF_PREFIX}{base}"),
            base.to_owned(),
            format!("{REMOTE_REF_PREFIX}{base}"),
        ];
        base_refs.dedup();
        let mut names = vec![branch_ref];
        names.extend(base_refs.iter().map(String::as_str));
        let mut heads = read_ref_heads(git, place, folder, &names).await?;
        let Some(tip) = heads.remove(branch_ref).map(|head| head.commit) else {
            return Ok(None);
        };
        let Some(base_head) = base_refs.iter().find_map(|name| heads.remove(name)) else {
            if self.unresolved_bases.insert(base.to_owned()) {
                tracing::warn!(
                    "a worktree's base names no branch, so its branch is not read as merged back"
                );
            }
            return Ok(None);
        };
        let upstream = match &base_head.upstream {
            Some(upstream) => read_ref_heads(git, place, folder, &[upstream.as_str()])
                .await?
                .remove(upstream)
                .map(|head| head.commit),
            None => None,
        };
        Ok(Some(BranchTips {
            tip,
            base: base_head.commit,
            upstream,
        }))
    }
}

// The commits on the branch that neither the base nor its upstream holds; none when either holds
// the tip.
async fn count_own_commits(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    tips: &BranchTips,
) -> Result<u64, GitError> {
    let excluded: Vec<String> = tips.targets().map(|target| format!("^{target}")).collect();
    let mut arguments = vec!["rev-list", "--count", tips.tip.as_str()];
    arguments.extend(excluded.iter().map(String::as_str));
    arguments.push("--");
    let output = read(git, place, folder, &arguments).await?;
    String::from_utf8_lossy(&strip_line_end(output))
        .parse()
        .map_err(|error| GitError::Read(io::Error::new(io::ErrorKind::InvalidData, error)))
}

// Whether the branch's reflog records a commit made on it.
async fn has_committed_on(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    branch_ref: &str,
) -> Result<bool, GitError> {
    let reflog = read(
        git,
        place,
        folder,
        &["log", "--walk-reflogs", "--format=%gs", branch_ref, "--"],
    )
    .await?;
    Ok(reflog
        .split(|byte| *byte == b'\n')
        .any(|subject| subject.starts_with(COMMIT_REFLOG_PREFIX)))
}

// Whether the base or its upstream holds every change the branch makes: each commit's patch, else
// the branch's whole change as one squashed patch.
async fn is_applied(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    tips: &BranchTips,
) -> Result<bool, GitError> {
    for target in tips.targets() {
        if is_fully_applied(git, place, folder, target, &tips.tip).await? {
            return Ok(true);
        }
    }
    for target in tips.targets() {
        let Some(squash) = squash_commit(git, place, folder, target, &tips.tip).await? else {
            continue;
        };
        if is_fully_applied(git, place, folder, target, &squash).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

// Whether every non-merge commit `tip` holds past `target` has a commit of the same patch there.
async fn is_fully_applied(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    target: &str,
    tip: &str,
) -> Result<bool, GitError> {
    let range = format!("{target}...{tip}");
    let unapplied = read(
        git,
        place,
        folder,
        &[
            "rev-list",
            "--cherry-pick",
            "--right-only",
            "--no-merges",
            "-n1",
            &range,
            "--",
        ],
    )
    .await?;
    Ok(strip_line_end(unapplied).is_empty())
}

// One commit holding `tip`'s tree on the commit it shares with `target`, the branch's whole change
// as one patch; `None` when the two share no history. It writes one commit object no ref names,
// which git's own cleanup prunes.
async fn squash_commit(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    target: &str,
    tip: &str,
) -> Result<Option<String>, GitError> {
    let merge_base = match read(git, place, folder, &["merge-base", target, tip]).await {
        Ok(merge_base) => String::from_utf8_lossy(&strip_line_end(merge_base)).into_owned(),
        Err(error) if error.exit_code() == Some(NO_MERGE_BASE_EXIT_CODE) => return Ok(None),
        Err(error) => return Err(error),
    };
    let tree = format!("{tip}^{{tree}}");
    let call = GitCall::read(background_read(
        folder,
        &["commit-tree", &tree, "-p", &merge_base, "-m", "squash"],
    ))
    .with_environment("GIT_AUTHOR_NAME", SNAPSHOT_IDENTITY_NAME)
    .with_environment("GIT_AUTHOR_EMAIL", SNAPSHOT_IDENTITY_EMAIL)
    .with_environment("GIT_COMMITTER_NAME", SNAPSHOT_IDENTITY_NAME)
    .with_environment("GIT_COMMITTER_EMAIL", SNAPSHOT_IDENTITY_EMAIL);
    let squash = git.run(place, call).await?;
    Ok(Some(
        String::from_utf8_lossy(&strip_line_end(squash.stdout)).into_owned(),
    ))
}

// The standard output of a background read of `arguments` in `folder`.
async fn read(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    arguments: &[&str],
) -> Result<Vec<u8>, GitError> {
    Ok(git
        .run(place, GitCall::read(background_read(folder, arguments)))
        .await?
        .stdout)
}

async fn mark_own_commits(
    deps: &WorkingFolderWatcherDeps,
    tree: &StandingTree,
) -> Result<(), WriteError> {
    let now = WireInstant::now();
    deps.writer
        .write(vec![transition_statement(
            MARK_OWN_COMMITS_SQL,
            &tree.row.id,
            &now,
            None,
        )])
        .await?;
    Ok(())
}
