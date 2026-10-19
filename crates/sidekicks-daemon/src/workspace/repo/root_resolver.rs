//! The canonical repository root of a path a person picked: the repository it belongs to, known by
//! its git common folder, with the main checkout's root as the canonical root and the path's own
//! working tree beside it. It also answers the narrower git questions the trust envelope and the
//! mount health probe ask of a folder.
//!
//! Every path it returns went through `real_path`, and git's answers are checked, not trusted:
//! git is asked rather than walking up for `.git`, which is a file in linked worktrees and
//! submodules; a path that names nothing is refused before git runs; the main checkout comes from
//! git's worktree list before the path's own working tree is considered, since a planted `.git`
//! file naming a repository's common folder makes git report the planted folder as its own top
//! level; and a repository's own `core.worktree` can make git report a sibling or an ancestor,
//! which the membership and fixpoint checks refuse as a mismatch.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sidekicks_contracts::repo::folders::{
    ROOT_RESOLUTION_DETAIL_MAX_LEN, RepoMountRootResolutionReason,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{PathRules, path_from_program_output};

use crate::file::bounded_read::read_within_ceiling;
use crate::file::real_location::resolve_real_path;
use crate::git::process::{
    GitCall, GitError, GitRunner, background_read, read_git_common_folder, strip_line_end,
};
use crate::git::worktree::reads::{ListedWorktree, read_listed_worktrees};
use crate::missing_entry::is_missing_entry;
use crate::text_cut::cut_to_code_points;
use crate::workspace::repo::errors::RepoRefusal;
use crate::workspace::trust_envelope::{components_equal, is_contained_within};

/// How long each one of the resolver's git calls may run, so one call a hung network folder holds
/// ends long before the runner's own bound. It bounds each call, not an attach: an attach makes
/// several calls in turn, and its file reads are held to the bounded read's ceiling apart from
/// them. A call past it reads `notReadable`, as a file read past that ceiling does, since a git
/// that cannot finish reading the folder says the folder is out of reach.
pub(crate) const ROOT_RESOLUTION_GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// git's exit code for a fatal error, half of its not-a-repository verdict.
const GIT_FATAL_EXIT_CODE: i32 = 128;

/// The start of git's not-a-repository line, matched at the start of a standard error line without
/// case: anywhere else it could sit inside a quoted path of another fatal error, and git escapes
/// control characters in a quoted path, so none can start a line of its own.
const NOT_A_REPOSITORY_MARKER: &str = "fatal: not a git repository";

/// The entry git's discovery looks for, a folder or a `gitdir:` file; it is only looked at.
const GIT_ENTRY_NAME: &str = ".git";

/// What an attach may keep about a path: every member absolute with each link resolved, and both
/// roots readable when resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoRootResolution {
    /// The main checkout's working tree root, or the path's own working tree where it is its own.
    pub(crate) canonical_root: PathBuf,
    /// The top level of the working tree the path sits in, which a bind naming no folder uses.
    pub(crate) working_tree_root: PathBuf,
    /// The repository's git common folder: its identity, shared by every working tree it has.
    pub(crate) common_folder: PathBuf,
}

// What git answered when asked for the top level of the working tree a folder sits in.
enum ToplevelAnswer {
    // The top level, with each link resolved.
    Toplevel(PathBuf),
    // git's own verdict that the folder is in no repository.
    NotARepository,
}

/// Resolves a path to its repository for a folder on this computer, asking git each time and
/// keeping nothing, since `git init` can make any folder a repository. Cloning it shares the
/// runner.
#[derive(Clone)]
pub(crate) struct RepoRootResolver {
    git: GitRunner,
    // The resolution every pick answers with, in place of the file system and git.
    #[cfg(test)]
    canned_resolution: Option<RepoRootResolution>,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the repository mount attach and its health read")
)]
impl RepoRootResolver {
    /// The resolver asking `git`, each call held to [`ROOT_RESOLUTION_GIT_TIMEOUT`].
    pub(crate) fn new(git: GitRunner) -> Self {
        Self {
            git,
            #[cfg(test)]
            canned_resolution: None,
        }
    }

    /// A resolver whose every pick resolves to `resolution`, for a test of what an attach does
    /// with a resolution no folder on the test's computer gives.
    #[cfg(test)]
    pub(crate) fn answering(git: GitRunner, resolution: RepoRootResolution) -> Self {
        Self {
            git,
            canned_resolution: Some(resolution),
        }
    }

    /// The repository `local_path` belongs to, both roots checked against git's answers. Fails
    /// with [`RepoRefusal::RootResolutionFailed`] on anything but a resolution: `notAbsolute` for
    /// a path naming no complete location, `pathNotFound` or `notReadable` from the path's own
    /// read before git runs, `notReadable` for any file read past the bounded read's ceiling,
    /// `notARepository` on git's verdict alone, `rootMismatch` for a working tree git does not
    /// name for the repository, `notReadable` when a git call passes its bound, and `vcsError` when
    /// git cannot answer otherwise.
    pub(crate) async fn resolve_canonical_root(
        &self,
        local_path: &Path,
    ) -> Result<RepoRootResolution, RepoRefusal> {
        #[cfg(test)]
        if let Some(resolution) = &self.canned_resolution {
            return Ok(resolution.clone());
        }
        // A relative path, `~` or a Windows root with no drive would be completed from the
        // daemon's own state into a plausible wrong root; `~` is the client's to expand.
        if !PathRules::NATIVE.names_complete_location(&local_path.to_string_lossy()) {
            return Err(root_resolution_refusal(
                RepoMountRootResolutionReason::NotAbsolute,
                None,
            ));
        }
        // Resolved first, so git never sees a link, and a path that names nothing is refused
        // before git could answer for whatever repository holds its parent.
        let input = resolve_real_path(local_path)
            .await
            .map_err(|error| refusal_of_filesystem_failure(&error))?;

        let working_tree_root = match self.query_toplevel(&input).await? {
            ToplevelAnswer::Toplevel(toplevel) => toplevel,
            ToplevelAnswer::NotARepository => {
                // A `.git` entry contradicts git's verdict: a mode-000 `.git` folder, an empty
                // one and a `gitdir:` file naming nothing all end with git's verdict too.
                if has_visible_git_entry(&input).await? {
                    return Err(root_resolution_refusal(
                        RepoMountRootResolutionReason::VcsError,
                        None,
                    ));
                }
                // Only the path given is looked at: a walk up its parents would be unbounded and
                // race their changes.
                return Err(root_resolution_refusal(
                    RepoMountRootResolutionReason::NotARepository,
                    None,
                ));
            }
        };
        let common_folder = self.query_common_folder(&input).await?;
        let listed = self.read_worktree_list(&input).await?;

        // The main checkout from the list's first record, before the path's own tree counts;
        // where that record is no working tree, the path's own tree is its own root.
        let main_checkout = self
            .verify_main_checkout(listed.first(), &common_folder)
            .await?;
        let canonical_root = main_checkout.as_ref().unwrap_or(&working_tree_root).clone();

        // Membership: the path sits inside its working tree, and that tree is the main checkout
        // or one git lists. Equality, never containment, so a planted holder inside or beside
        // the main checkout does not pass.
        if !is_contained_within(&input, &working_tree_root) {
            return Err(root_resolution_refusal(
                RepoMountRootResolutionReason::RootMismatch,
                None,
            ));
        }
        let is_main_checkout = components_equal(&working_tree_root, &canonical_root);
        if !is_main_checkout && !self.is_listed(&listed, &working_tree_root).await? {
            return Err(root_resolution_refusal(
                RepoMountRootResolutionReason::RootMismatch,
                None,
            ));
        }

        // Fixpoint: asked from the tree itself, git names that tree and the same common folder;
        // a redirected top level does not name itself. The verified main checkout has answered.
        if main_checkout.is_none() || !is_main_checkout {
            self.require_fixpoint(&working_tree_root, &common_folder)
                .await?;
        }

        require_readable_root(&canonical_root).await?;
        if !is_main_checkout {
            require_readable_root(&working_tree_root).await?;
        }
        Ok(RepoRootResolution {
            canonical_root,
            working_tree_root,
            common_folder,
        })
    }

    /// The git common folder of the repository whose working tree has `root` as its top level, or
    /// `None` when `root` names nothing or git says it is no such top level (its `.git` entry
    /// gone, broken or naming another tree). Fails with `notReadable` when `root` cannot be read
    /// or a git call passes its bound, and `vcsError` when git cannot answer otherwise.
    pub(crate) async fn read_repository_identity(
        &self,
        root: &Path,
    ) -> Result<Option<PathBuf>, RepoRefusal> {
        let Some(root) = resolve_real_path_or_none(root).await? else {
            return Ok(None);
        };
        match self.query_own_toplevel(&root).await? {
            Some(toplevel) if components_equal(&toplevel, &root) => {
                Ok(Some(self.query_common_folder(&root).await?))
            }
            Some(_) | None => Ok(None),
        }
    }

    /// The top level, each link resolved, of the working tree `folder` sits in, or `None` when git
    /// answers that it sits in none. Fails with `vcsError` when git cannot answer.
    pub(crate) async fn read_working_tree_root(
        &self,
        folder: &Path,
    ) -> Result<Option<PathBuf>, RepoRefusal> {
        self.query_own_toplevel(folder).await
    }

    /// The working trees git lists for the repository at `folder`, main record first, each link
    /// resolved; a bare record and a tree whose folder git recorded exactly and is gone are left
    /// out. Fails with `vcsError` when git cannot answer or a record it could not print exactly
    /// names nothing, and `notReadable` for a tree that cannot be read.
    pub(crate) async fn list_working_trees(
        &self,
        folder: &Path,
    ) -> Result<Vec<PathBuf>, RepoRefusal> {
        let mut trees = Vec::new();
        for record in self.read_worktree_list(folder).await? {
            if let Some(tree) = resolve_listed_tree(&record).await? {
                trees.push(tree);
            }
        }
        Ok(trees)
    }

    // The list's first record, each link resolved, when git asked from inside it names it as its
    // own top level and the same common folder; `None` when it is no such working tree.
    async fn verify_main_checkout(
        &self,
        first: Option<&ListedWorktree>,
        common_folder: &Path,
    ) -> Result<Option<PathBuf>, RepoRefusal> {
        let Some(first) = first else {
            return Ok(None);
        };
        let Some(candidate) = resolve_listed_tree(first).await? else {
            return Ok(None);
        };
        match self.query_own_toplevel(&candidate).await? {
            Some(toplevel) if components_equal(&toplevel, &candidate) => {}
            Some(_) | None => return Ok(None),
        }
        let candidate_common_folder = self.query_common_folder(&candidate).await?;
        Ok(components_equal(&candidate_common_folder, common_folder).then_some(candidate))
    }

    async fn require_fixpoint(
        &self,
        working_tree_root: &Path,
        common_folder: &Path,
    ) -> Result<(), RepoRefusal> {
        let is_fixpoint = match self.query_toplevel(working_tree_root).await? {
            ToplevelAnswer::Toplevel(toplevel) => {
                components_equal(&toplevel, working_tree_root)
                    && components_equal(
                        &self.query_common_folder(working_tree_root).await?,
                        common_folder,
                    )
            }
            ToplevelAnswer::NotARepository => false,
        };
        if is_fixpoint {
            Ok(())
        } else {
            Err(root_resolution_refusal(
                RepoMountRootResolutionReason::RootMismatch,
                None,
            ))
        }
    }

    // Whether git lists a working tree at `working_tree_root` among `listed`.
    async fn is_listed(
        &self,
        listed: &[ListedWorktree],
        working_tree_root: &Path,
    ) -> Result<bool, RepoRefusal> {
        for record in listed {
            if let Some(tree) = resolve_listed_tree(record).await?
                && components_equal(&tree, working_tree_root)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    // git's answer for the top level of the tree `folder` sits in: the top level or git's
    // not-a-repository verdict. Discovery and the fixpoint share it, so neither runs under a weaker
    // call; every other outcome is `vcsError`.
    async fn query_toplevel(&self, folder: &Path) -> Result<ToplevelAnswer, RepoRefusal> {
        match self.run_toplevel_read(folder).await {
            Ok(stdout) => Ok(ToplevelAnswer::Toplevel(
                resolve_reported_path(&path_of_output(stdout)?).await?,
            )),
            Err(error) if is_not_a_repository_verdict(&error) => Ok(ToplevelAnswer::NotARepository),
            Err(error) => Err(vcs_refusal(&error)),
        }
    }

    // The top level git names from `folder`, or `None` when git answers with a failure of its own
    // (no repository, no working tree, a `gitdir:` file naming nothing); `vcsError` when git could
    // not run or finish.
    async fn query_own_toplevel(&self, folder: &Path) -> Result<Option<PathBuf>, RepoRefusal> {
        match self.run_toplevel_read(folder).await {
            Ok(stdout) => Ok(Some(resolve_reported_path(&path_of_output(stdout)?).await?)),
            Err(error) if error.exit_code() == Some(GIT_FATAL_EXIT_CODE) => Ok(None),
            Err(error) => Err(vcs_refusal(&error)),
        }
    }

    async fn run_toplevel_read(&self, folder: &Path) -> Result<Vec<u8>, GitError> {
        let call = GitCall::read(background_read(folder, &["rev-parse", "--show-toplevel"]))
            .with_timeout(Some(ROOT_RESOLUTION_GIT_TIMEOUT));
        Ok(self.git.run(None, call).await?.stdout)
    }

    // The git common folder of the repository `folder` sits in, each link resolved; every failure
    // is `vcsError`.
    async fn query_common_folder(&self, folder: &Path) -> Result<PathBuf, RepoRefusal> {
        let common_folder =
            read_git_common_folder(&self.git, None, folder, Some(ROOT_RESOLUTION_GIT_TIMEOUT))
                .await
                .map_err(|error| vcs_refusal(&error))?;
        resolve_reported_path(&common_folder).await
    }

    // Every record git keeps of a tree for the repository `folder` sits in; every failure is
    // `vcsError`.
    async fn read_worktree_list(&self, folder: &Path) -> Result<Vec<ListedWorktree>, RepoRefusal> {
        read_listed_worktrees(&self.git, None, folder, Some(ROOT_RESOLUTION_GIT_TIMEOUT))
            .await
            .map_err(|error| vcs_refusal(&error))
    }
}

/// The refusal a failed read of a picked path gives: `pathNotFound` when the path names nothing,
/// `notReadable` for any other failure (a permission refusal of the path or a folder above it, a
/// link loop), each with the system's own reason, which names no path.
pub(crate) fn refusal_of_filesystem_failure(error: &io::Error) -> RepoRefusal {
    let reason = if is_missing_entry(error) {
        RepoMountRootResolutionReason::PathNotFound
    } else {
        RepoMountRootResolutionReason::NotReadable
    };
    root_resolution_refusal(reason, Some(error))
}

// A `rootResolutionFailed` refusal for `reason`, carrying the text of the system read that failed,
// cut to the wire's cap; `None` where no read failed or its text is blank.
fn root_resolution_refusal(
    reason: RepoMountRootResolutionReason,
    failed_read: Option<&io::Error>,
) -> RepoRefusal {
    let detail = failed_read.and_then(|error| {
        let text = error.to_string();
        // A blank or NUL-holding text says nothing a person can read, so none is sent.
        FreeFormText::new(cut_to_code_points(&text, ROOT_RESOLUTION_DETAIL_MAX_LEN).to_owned()).ok()
    });
    RepoRefusal::RootResolutionFailed { reason, detail }
}

// `vcsError` for a git call that could not answer, `notReadable` for one past its bound, the cause
// kept in the service log, since the refusal must not echo the path git was asked about.
fn vcs_refusal(error: &GitError) -> RepoRefusal {
    tracing::warn!(
        error = error as &(dyn Error + 'static),
        "git could not answer for a repository root"
    );
    let reason = match error {
        GitError::TimedOut { .. } => RepoMountRootResolutionReason::NotReadable,
        GitError::WslPlace { .. }
        | GitError::NotFound
        | GitError::Start(_)
        | GitError::OutputTooLarge { .. }
        | GitError::Read(_)
        | GitError::Exited { .. }
        | GitError::PathText(_)
        | GitError::NotStartable => RepoMountRootResolutionReason::VcsError,
    };
    root_resolution_refusal(reason, None)
}

// Whether git itself answered that the folder is in no repository: exit 128 with its own line. A
// git that was ended, timed out or could not start says nothing about the folder.
fn is_not_a_repository_verdict(error: &GitError) -> bool {
    let GitError::Exited {
        code: Some(GIT_FATAL_EXIT_CODE),
        stderr,
        ..
    } = error
    else {
        return false;
    };
    stderr.lines().any(|line| {
        line.get(..NOT_A_REPOSITORY_MARKER.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(NOT_A_REPOSITORY_MARKER))
    })
}

// The path git printed as its single answer, without its line end; `vcsError` for bytes this
// system cannot name.
fn path_of_output(stdout: Vec<u8>) -> Result<PathBuf, RepoRefusal> {
    path_from_program_output(strip_line_end(stdout)).map_err(|error| {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "git printed a repository path this system cannot name"
        );
        root_resolution_refusal(RepoMountRootResolutionReason::VcsError, None)
    })
}

// A path git reported, as a complete location with each link resolved. An empty, driveless or
// unresolvable answer is git's anomaly, not a bad path from the person: `vcsError`; a resolve the
// file system did not answer in time is `notReadable`, as the person's own path would be.
async fn resolve_reported_path(reported: &Path) -> Result<PathBuf, RepoRefusal> {
    if !PathRules::NATIVE.names_complete_location(&reported.to_string_lossy()) {
        return Err(root_resolution_refusal(
            RepoMountRootResolutionReason::VcsError,
            None,
        ));
    }
    resolve_real_path(reported).await.map_err(|error| {
        let reason = if error.kind() == io::ErrorKind::TimedOut {
            RepoMountRootResolutionReason::NotReadable
        } else {
            RepoMountRootResolutionReason::VcsError
        };
        root_resolution_refusal(reason, Some(&error))
    })
}

// `path` with each link resolved, or `None` when it names nothing; any other failed read is
// refused as the picked path's would be.
async fn resolve_real_path_or_none(path: &Path) -> Result<Option<PathBuf>, RepoRefusal> {
    match resolve_real_path(path).await {
        Ok(resolved) => Ok(Some(resolved)),
        Err(error) if is_missing_entry(&error) => Ok(None),
        Err(error) => Err(refusal_of_filesystem_failure(&error)),
    }
}

// A listed record's working tree with each link resolved, or `None` for a bare record and for a
// tree git recorded exactly whose folder is gone (git's own prunable record). A record from a git
// that could not print paths exactly may be a piece of a path a newline split, so one naming
// nothing is `vcsError` rather than a tree left out.
async fn resolve_listed_tree(record: &ListedWorktree) -> Result<Option<PathBuf>, RepoRefusal> {
    if record.is_bare {
        return Ok(None);
    }
    match resolve_real_path_or_none(&record.path).await? {
        Some(tree) => Ok(Some(tree)),
        None if record.is_path_exact => Ok(None),
        None => Err(root_resolution_refusal(
            RepoMountRootResolutionReason::VcsError,
            None,
        )),
    }
}

// Whether `<folder>/.git` is visibly there, following a link: true on a read and on every failure
// but `NotFound`, so a `.git` git cannot read still counts, and a dangling `.git` link counts as
// none, as it does for git. A look the file system does not answer in time is `notReadable`.
async fn has_visible_git_entry(folder: &Path) -> Result<bool, RepoRefusal> {
    let looked = read_within_ceiling(&folder.join(GIT_ENTRY_NAME), |entry| {
        Ok(std::fs::metadata(entry).map(drop))
    })
    .await
    .map_err(|error| refusal_of_filesystem_failure(&error))?;
    Ok(match looked {
        Ok(()) => true,
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    })
}

// The last gate before a root leaves: it opens for listing within the bounded read's ceiling.
// `real_path` proves only that it can be passed through (a mode-0111 root passes, and git answers
// there), and the root itself is opened, so a readable folder inside an unreadable root is
// refused.
async fn require_readable_root(root: &Path) -> Result<(), RepoRefusal> {
    read_within_ceiling(root, |root| std::fs::read_dir(root).map(drop))
        .await
        .map_err(|error| refusal_of_filesystem_failure(&error))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::path::PathBuf;

    use rstest::rstest;
    use sidekicks_contracts::repo::folders::RepoMountRootResolutionReason;
    use sidekicks_platforms::{
        CAN_OPEN_INSIDE_UNREADABLE_FOLDER, Spawner, is_superuser, make_folder_unreadable, real_path,
    };

    use super::{RepoRootResolution, RepoRootResolver};
    use crate::file::bounded_read::stall_reads_of;
    use crate::git::process::{GitCall, GitLimits, GitRunner, test_git_runner};
    use crate::workspace::repo::errors::RepoRefusal;

    // The path a case picks.
    #[derive(Clone, Copy, Debug)]
    enum Pick {
        // A linked worktree of the main checkout.
        LinkedWorktree,
        // A folder outside the repository whose `.git` file names the repository's git folder.
        PlantedGitFile,
        // A path that names nothing, resolved by a runner that finds no git.
        MissingPath,
        // A path under a main checkout no one may read, resolved by a runner that finds no git.
        UnreadableRoot,
        // The main checkout, whose reads never answer, resolved by a runner that finds no git.
        HeldRead,
    }

    // A runner whose every call fails as no git found, so a case that answers otherwise never ran
    // git.
    fn runner_without_git() -> GitRunner {
        GitRunner::new(
            Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts"),
            None,
            Vec::new().into(),
            GitLimits::DAEMON,
        )
    }

    // Catches a wrong main checkout, a planted `.git` admitted, git asked first, a lost reason, or a
    // read awaited past the ceiling.
    #[rstest]
    #[case::a_linked_worktree(Pick::LinkedWorktree)]
    #[case::a_planted_git_file(Pick::PlantedGitFile)]
    #[case::a_missing_path(Pick::MissingPath)]
    #[case::an_unreadable_root(Pick::UnreadableRoot)]
    #[case::a_held_read(Pick::HeldRead)]
    #[tokio::test]
    async fn a_picked_path_resolves_to_its_main_checkout_or_is_refused_with_its_reason(
        #[case] pick: Pick,
    ) {
        // Root reads and lists a folder whatever its mode.
        if matches!(pick, Pick::UnreadableRoot) && is_superuser() {
            return;
        }
        let git = test_git_runner();
        let temporary = tempfile::tempdir().expect("the temporary folder is made");
        let outer = real_path(temporary.path()).expect("the temporary folder resolves");
        let main = outer.join("main");
        let linked = outer.join("linked");
        // Each set-up call runs as a read, so none of the person's hooks runs.
        let set_up: [Vec<&OsStr>; 3] = [
            vec![OsStr::new("init"), main.as_os_str()],
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "-C",
            ]
            .into_iter()
            .map(OsStr::new)
            .chain([main.as_os_str()])
            .chain(["commit", "--allow-empty", "-m", "first"].map(OsStr::new))
            .collect(),
            vec![
                OsStr::new("-C"),
                main.as_os_str(),
                OsStr::new("worktree"),
                OsStr::new("add"),
                OsStr::new("-b"),
                OsStr::new("linked"),
                linked.as_os_str(),
            ],
        ];
        for arguments in set_up {
            git.run(None, GitCall::read(arguments))
                .await
                .expect("the repository is set up");
        }

        // Held to the test's end, then dropped before the temporary folder is removed.
        let _unreadable = matches!(pick, Pick::UnreadableRoot)
            .then(|| make_folder_unreadable(&main).expect("the root is made unreadable"));
        let _held = matches!(pick, Pick::HeldRead).then(|| stall_reads_of(&main, 0));
        let (resolver, path, expected): (_, PathBuf, Result<_, (_, bool)>) = match pick {
            Pick::LinkedWorktree => (
                RepoRootResolver::new(git),
                linked.clone(),
                Ok(RepoRootResolution {
                    canonical_root: main.clone(),
                    working_tree_root: linked,
                    common_folder: main.join(".git"),
                }),
            ),
            Pick::PlantedGitFile => {
                let planted = outer.join("planted");
                tokio::fs::create_dir(&planted)
                    .await
                    .expect("the planted folder is made");
                let pointer = format!("gitdir: {}\n", main.join(".git").display());
                tokio::fs::write(planted.join(".git"), pointer)
                    .await
                    .expect("the planted `.git` file is written");
                (
                    RepoRootResolver::new(git),
                    planted,
                    Err((RepoMountRootResolutionReason::RootMismatch, false)),
                )
            }
            Pick::MissingPath => (
                RepoRootResolver::new(runner_without_git()),
                outer.join("missing"),
                Err((RepoMountRootResolutionReason::PathNotFound, true)),
            ),
            // Where a path inside an unreadable folder still opens (Windows' bypass-traverse
            // right), the missing `inner` is found missing rather than refused.
            Pick::UnreadableRoot => (
                RepoRootResolver::new(runner_without_git()),
                main.join("inner"),
                Err((
                    if CAN_OPEN_INSIDE_UNREADABLE_FOLDER {
                        RepoMountRootResolutionReason::PathNotFound
                    } else {
                        RepoMountRootResolutionReason::NotReadable
                    },
                    true,
                )),
            ),
            Pick::HeldRead => (
                RepoRootResolver::new(runner_without_git()),
                main.clone(),
                Err((RepoMountRootResolutionReason::NotReadable, true)),
            ),
        };

        let resolved = resolver.resolve_canonical_root(&path).await;

        match expected {
            Ok(expected) => assert!(
                matches!(&resolved, Ok(resolution) if *resolution == expected),
                "{pick:?}: {resolved:?}"
            ),
            Err((expected_reason, has_detail)) => assert!(
                matches!(
                    &resolved,
                    Err(RepoRefusal::RootResolutionFailed { reason, detail })
                        if *reason == expected_reason && detail.is_some() == has_detail
                ),
                "{pick:?}: {resolved:?}"
            ),
        }
    }
}
