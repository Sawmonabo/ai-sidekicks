//! Whether a watched worktree's branch has merged back into its base or the base's upstream; a
//! merge into any other branch is not read.
//!
//! - The row records the last tip seen holding commits of its own: each check that counts a commit
//!   on the branch, merge commits not counted, that neither the base nor its upstream holds records
//!   the tip, and while it records none and the tip is contained, the newest `commit:` entry in the
//!   branch's reflog seeds it. A branch that only caught up with its base, by a fast-forward or a
//!   merge commit, or never left it, records none and never reads merged.
//! - The checks run on the recorded tip, never on a later tip that discarded its work: it has
//!   merged when the base or its upstream holds it, or, where neither does, when nothing on it is
//!   left unapplied there: each of its commits' patches found on that side, or all of its changes
//!   as one squashed patch. The patch test runs once per combination of the recorded tip, the
//!   base's and the upstream's.
//! - A base that names no local or remote-tracking branch, and a recorded tip the repository no
//!   longer holds, read as not merged, each logged once.

use std::collections::HashSet;
use std::io;
use std::path::Path;

use sidekicks_contracts::place::Place;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::WriteError;

use super::WorkingFolderWatcherDeps;
use super::tree_state::StandingTree;
use crate::git::process::{GitCall, GitError, GitRunner, background_read, strip_line_end};
use crate::git::turn_snapshot::capture::{SNAPSHOT_IDENTITY_EMAIL, SNAPSHOT_IDENTITY_NAME};
use crate::git::worktree::reads::{BRANCH_REF_PREFIX, read_ref_heads};

// Records the last tip of the tree's branch seen holding commits of its own.
const RECORD_OWN_COMMIT_TIP_SQL: &str =
    "UPDATE worktrees SET own_commit_tip = @tip, updated_at = @now WHERE id = @worktree_id";

// The prefix of every remote-tracking branch's full ref name.
const REMOTE_REF_PREFIX: &str = "refs/remotes/";

// The reflog subject git writes for a commit made on the branch.
const COMMIT_REFLOG_PREFIX: &[u8] = b"commit:";

// `merge-base`'s exit when the two commits share no history.
const NO_MERGE_BASE_EXIT_CODE: i32 = 1;

// `rev-parse --verify --quiet`'s exit when the repository holds no such commit.
const NOT_HELD_EXIT_CODE: i32 = 1;

/// What a folder's merged checks keep between changes: the last patch test's tips and verdict, and
/// each base already logged as naming no branch and each recorded tip as gone.
#[derive(Default)]
pub(super) struct MergedCheck {
    last_patch_test: Option<(BranchTips, bool)>,
    unresolved_bases: HashSet<String>,
    missing_tips: HashSet<String>,
}

// The commits a check reads: the branch's tip, its base's and the base's upstream's, where it has
// one. The patch test's tip is the recorded one.
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
    /// on its row the last tip seen holding commits of its own. Fails as git or the write does.
    pub(super) async fn has_merged_back(
        &mut self,
        deps: &WorkingFolderWatcherDeps,
        place: Option<&Place>,
        folder: &Path,
        tree: &StandingTree,
    ) -> Result<bool, MergedReadError> {
        let git = &deps.git;
        let branch_ref = format!("{BRANCH_REF_PREFIX}{}", tree.row.branch_name.as_str());
        let Some(mut tips) = self
            .read_tips(git, place, folder, &branch_ref, &tree.base)
            .await?
        else {
            return Ok(false);
        };
        if count_past(git, place, folder, &tips.tip, &tips, Commits::OwnOnly).await? > 0 {
            // The tip holds work the base and its upstream lack, so neither contains it.
            if tree.own_commit_tip.as_deref() != Some(tips.tip.as_str()) {
                record_own_commit_tip(deps, tree, &tips.tip).await?;
            }
        } else {
            let recorded = match &tree.own_commit_tip {
                Some(recorded) => recorded.clone(),
                None => {
                    if count_past(git, place, folder, &tips.tip, &tips, Commits::All).await? > 0 {
                        return Ok(false);
                    }
                    let Some(seed) = newest_commit_on(git, place, folder, &branch_ref).await?
                    else {
                        return Ok(false);
                    };
                    record_own_commit_tip(deps, tree, &seed).await?;
                    seed
                }
            };
            match count_past(git, place, folder, &recorded, &tips, Commits::All).await {
                Ok(0) => return Ok(true),
                Ok(_) => {}
                Err(error) => {
                    if is_commit_held(git, place, folder, &recorded).await? {
                        return Err(error.into());
                    }
                    if self.missing_tips.insert(recorded) {
                        tracing::warn!(
                            "a worktree's recorded branch tip is gone from its repository, so its \
                             branch is not read as merged back"
                        );
                    }
                    return Ok(false);
                }
            }
            tips.tip = recorded;
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

// Which commits a count takes.
#[derive(Clone, Copy)]
enum Commits {
    All,
    // Merge commits left out.
    OwnOnly,
}

// The commits `commit` holds that neither the base nor its upstream holds; with `All`, none exactly
// when either holds `commit`.
async fn count_past(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    commit: &str,
    tips: &BranchTips,
    commits: Commits,
) -> Result<u64, GitError> {
    let excluded: Vec<String> = tips.targets().map(|target| format!("^{target}")).collect();
    let mut arguments = vec!["rev-list", "--count"];
    if matches!(commits, Commits::OwnOnly) {
        arguments.push("--no-merges");
    }
    arguments.push(commit);
    arguments.extend(excluded.iter().map(String::as_str));
    arguments.push("--");
    let output = read(git, place, folder, &arguments).await?;
    String::from_utf8_lossy(&strip_line_end(output))
        .parse()
        .map_err(|error| GitError::Read(io::Error::new(io::ErrorKind::InvalidData, error)))
}

// The commit the newest `commit:` entry in the branch's reflog made; `None` when it records none.
async fn newest_commit_on(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    branch_ref: &str,
) -> Result<Option<String>, GitError> {
    let reflog = read(
        git,
        place,
        folder,
        &[
            "log",
            "--walk-reflogs",
            "--format=%H%x00%gs",
            branch_ref,
            "--",
        ],
    )
    .await?;
    Ok(reflog.split(|byte| *byte == b'\n').find_map(|entry| {
        let (commit, subject) = entry.split_at(entry.iter().position(|byte| *byte == 0)?);
        subject[1..]
            .starts_with(COMMIT_REFLOG_PREFIX)
            .then(|| String::from_utf8_lossy(commit).into_owned())
    }))
}

// Whether the repository holds `commit`.
async fn is_commit_held(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    commit: &str,
) -> Result<bool, GitError> {
    let object = format!("{commit}^{{commit}}");
    match read(
        git,
        place,
        folder,
        &["rev-parse", "--verify", "--quiet", &object],
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(error) if error.exit_code() == Some(NOT_HELD_EXIT_CODE) => Ok(false),
        Err(error) => Err(error),
    }
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

async fn record_own_commit_tip(
    deps: &WorkingFolderWatcherDeps,
    tree: &StandingTree,
    tip: &str,
) -> Result<(), WriteError> {
    let now = WireInstant::now();
    deps.writer
        .write(vec![WriteStatement {
            sql: RECORD_OWN_COMMIT_TIP_SQL.into(),
            bindings: StatementBindings::Named(vec![
                text_binding("@tip", tip),
                text_binding("@worktree_id", tree.row.id.text().as_str()),
                text_binding("@now", now.as_str()),
            ]),
            expected_row_count: None,
        }])
        .await?;
    Ok(())
}
