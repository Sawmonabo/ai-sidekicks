//! The temporary worktree a review of a folder's staged changes runs in: a detached checkout of the
//! folder's `HEAD` under the daemon's worktrees folder, holding the index's staged changes and none
//! of the unstaged or untracked work, removed and pruned by its `close`. The folder's own checkout
//! and index are only read. One a stopped daemon left behind is removed at the next start.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_platforms::{path_from_program_output, remove_tree};

use crate::git::process::{
    GitCall, GitError, GitRunner, in_folder, read_git_common_folder, strip_line_end,
};
use crate::git::worktree::folder_names::read_folder_names;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::random_hex::random_hex;

// A dotted sibling of the project folders, which a slug never names and no sweep reads.
const STAGED_CHANGES_SEGMENT: &str = ".staged-changes";

// How many random bytes name a worktree's folder, so two never meet.
const WORKTREE_NAME_BYTES: usize = 16;

// What a failure of opening a worktree names as the operation its cleanup followed.
const OPENING: &str = "staged worktree opening";

/// Why a step of opening, closing or sweeping a staged-changes worktree failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StagedChangesError {
    /// A git call failed.
    #[error("a git call on a staged-changes worktree failed")]
    Git(#[from] GitError),
    /// The staged-changes folder could not be made or listed.
    #[error("the staged-changes folder {} could not be made or listed", path.display())]
    Folder {
        /// The folder.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        source: io::Error,
    },
    /// The system's random source could not name a worktree's folder.
    #[error("a staged-changes worktree's folder could not be named")]
    Naming(#[source] getrandom::Error),
    /// A worktree's folder could not be removed.
    #[error("the staged-changes worktree {} could not be removed", path.display())]
    Remove {
        /// The worktree's folder.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        source: io::Error,
    },
}

/// Opens temporary worktrees of a folder's staged changes under the daemon's worktrees folder.
#[derive(Clone)]
pub(crate) struct StagedChangesWorktrees {
    folder: PathBuf,
    git: GitRunner,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Claude Code's staged review reads the index through it"
    )
)]
impl StagedChangesWorktrees {
    /// The worktrees under `worktrees_folder`, the daemon's own and absolute, made with `git`.
    pub(crate) fn new(worktrees_folder: &Path, git: GitRunner) -> Self {
        Self {
            folder: worktrees_folder.join(STAGED_CHANGES_SEGMENT),
            git,
        }
    }

    /// Opens a worktree of `working_folder`'s repository at `place`, detached at its `HEAD`,
    /// holding exactly the staged changes in its index and working files. Fails when the folder is
    /// no git working tree, its `HEAD` names no commit, or a step fails; a worktree made before
    /// the failure is removed first, and the failure carries any failure of that removal.
    pub(crate) async fn open_staged_worktree(
        &self,
        place: Option<&Place>,
        working_folder: &Path,
    ) -> Result<StagedChangesWorktree, CleanupFailures<StagedChangesError>> {
        let without_cleanup = |failure: StagedChangesError| {
            CleanupFailures::<StagedChangesError>::new(failure, Vec::new(), OPENING)
        };
        let toplevel = self
            .git
            .run(
                place,
                GitCall::read(in_folder(working_folder, &["rev-parse", "--show-toplevel"])),
            )
            .await
            .map_err(|failure| without_cleanup(failure.into()))?;
        // Handed back to git, so every byte of a name that is not UTF-8 is kept.
        let repository_root = path_from_program_output(strip_line_end(toplevel.stdout))
            .map_err(|failure| without_cleanup(GitError::PathText(failure).into()))?;
        // The person's diff settings never shape it: fixed prefixes, no external or
        // text-converting driver, no color, so `apply` reads exactly the index's change.
        let staged_patch = self
            .git
            .run(
                place,
                GitCall::read(in_folder(
                    &repository_root,
                    &[
                        "diff",
                        "--cached",
                        "--binary",
                        "--no-color",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--src-prefix=a/",
                        "--dst-prefix=b/",
                    ],
                )),
            )
            .await
            .map_err(|failure| without_cleanup(failure.into()))?
            .stdout;
        tokio::fs::create_dir_all(&self.folder)
            .await
            .map_err(|source| {
                without_cleanup(StagedChangesError::Folder {
                    path: self.folder.clone(),
                    source,
                })
            })?;
        let name = random_hex(WORKTREE_NAME_BYTES)
            .map_err(|failure| without_cleanup(StagedChangesError::Naming(failure)))?;
        let worktree = StagedChangesWorktree {
            folder: self.folder.join(name),
            repository_root,
            place: place.cloned(),
            git: self.git.clone(),
        };
        if let Err(opening_failure) = worktree.fill(staged_patch).await {
            // Whatever step failed, a folder and a record `worktree add` left go too.
            let cleanup_failures = worktree.remove(false).await;
            return Err(CleanupFailures::new(
                opening_failure,
                cleanup_failures,
                OPENING,
            ));
        }
        Ok(worktree)
    }

    /// Removes every worktree a stopped daemon left in the staged-changes folder, each from its
    /// repository's records too, before any review opens one. Every entry is tried; the answer is
    /// every failure, empty when all went.
    pub(crate) async fn sweep_left_worktrees(&self) -> Vec<StagedChangesError> {
        let names = match read_folder_names(&self.folder).await {
            Ok(names) => names,
            Err(source) => {
                return vec![StagedChangesError::Folder {
                    path: self.folder.clone(),
                    source,
                }];
            }
        };
        let mut failures = Vec::new();
        for name in names {
            let folder = self.folder.join(name);
            // The daemon's own folder is on this computer, never in a WSL 2 distribution. Read
            // before the folder goes, since its `.git` file is what names the repository.
            let common_git_folder =
                match read_git_common_folder(&self.git, None, &folder, None).await {
                    Ok(common_git_folder) => Some(common_git_folder),
                    Err(failure) => {
                        failures.push(failure.into());
                        None
                    }
                };
            if let Err(failure) = remove_folder(folder).await {
                failures.push(failure);
            }
            if let Some(common_git_folder) = common_git_folder
                && let Err(failure) = self
                    .git
                    .run(
                        None,
                        GitCall::read(in_folder(&common_git_folder, &["worktree", "prune"])),
                    )
                    .await
            {
                failures.push(failure.into());
            }
        }
        failures
    }
}

/// A temporary worktree holding only a folder's staged changes, removed by [`Self::close`].
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Claude Code's staged review reads the index through it"
    )
)]
pub(crate) struct StagedChangesWorktree {
    folder: PathBuf,
    repository_root: PathBuf,
    place: Option<Place>,
    git: GitRunner,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Claude Code's staged review reads the index through it"
    )
)]
impl StagedChangesWorktree {
    /// The worktree's folder, absolute.
    pub(crate) fn folder(&self) -> &Path {
        &self.folder
    }

    /// Removes the worktree and prunes its record from the repository. Every step runs whatever
    /// failed before it; fails with the first failure, carrying the rest.
    pub(crate) async fn close(self) -> Result<(), CleanupFailures<StagedChangesError>> {
        let mut failures = self.remove(true).await.into_iter();
        match failures.next() {
            Some(first) => Err(CleanupFailures::new(
                first,
                failures.collect(),
                "staged worktree removal",
            )),
            None => Ok(()),
        }
    }
}

impl StagedChangesWorktree {
    // Makes the worktree at `HEAD` and applies `staged_patch` to its index and files.
    async fn fill(&self, staged_patch: Vec<u8>) -> Result<(), StagedChangesError> {
        let place = self.place.as_ref();
        let mut add = in_folder(&self.repository_root, &["worktree", "add", "--detach"]);
        add.extend([self.folder.clone().into_os_string(), OsString::from("HEAD")]);
        self.git.run(place, GitCall::write(add)).await?;
        // `apply` refuses an empty patch, and with nothing staged the checkout is already the set.
        // Whitespace warnings are off: the patch is the index's own change, applied as staged.
        if !staged_patch.is_empty() {
            self.git
                .run(
                    place,
                    GitCall::read(in_folder(
                        &self.folder,
                        &["apply", "--index", "--whitespace=nowarn"],
                    ))
                    .with_input(staged_patch),
                )
                .await?;
        }
        Ok(())
    }

    // `--force` because the worktree holds the staged changes, which git would otherwise refuse
    // to discard; a worktree whose making failed has no record git could remove by name, so its
    // folder goes and the prune drops any record. Every step runs whatever failed before it.
    async fn remove(&self, is_worktree_made: bool) -> Vec<StagedChangesError> {
        let place = self.place.as_ref();
        let mut failures = Vec::new();
        if is_worktree_made {
            let mut remove = in_folder(&self.repository_root, &["worktree", "remove", "--force"]);
            remove.push(self.folder.clone().into_os_string());
            if let Err(failure) = self.git.run(place, GitCall::read(remove)).await {
                failures.push(failure.into());
            }
        }
        if let Err(failure) = remove_folder(self.folder.clone()).await {
            failures.push(failure);
        }
        if let Err(failure) = self
            .git
            .run(
                place,
                GitCall::read(in_folder(&self.repository_root, &["worktree", "prune"])),
            )
            .await
        {
            failures.push(failure.into());
        }
        failures
    }
}

// Removes `folder` and everything in it off the async workers; a folder already gone passes.
async fn remove_folder(folder: PathBuf) -> Result<(), StagedChangesError> {
    let removing = folder.clone();
    tokio::task::spawn_blocking(move || remove_tree(&removing))
        .await
        .map_err(io::Error::other)
        .and_then(|removed| removed)
        .map_err(|source| StagedChangesError::Remove {
            path: folder,
            source,
        })
}
