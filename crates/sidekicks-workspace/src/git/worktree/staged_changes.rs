//! The temporary worktree a review of a folder's staged changes runs in: a detached checkout of the
//! folder's `HEAD` under the daemon's worktrees folder, holding the index's staged changes and none
//! of the unstaged or untracked work, removed with its own git record by its `close`. The folder's
//! own checkout and index are only read. Each tree sits in a folder of its own beside a file
//! naming its repository, written before git runs, so one a stopped daemon left behind is removed
//! at the next start with its record, even when git was ended before the tree had its `.git`; that
//! folder stays until its tree and records are gone. A record is removed by name, never by a
//! repository-wide prune, which would also drop the records of the person's trees whose folders
//! are missing, such as one on an unplugged drive.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_platforms::path_from_program_output;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::random_hex::random_hex;

use crate::git::process::{
    GitCall, GitError, GitRunner, in_folder, read_git_common_folder, strip_line_end,
};
use crate::git::worktree::folder_names::read_folder_names;
use crate::git::worktree::reads::GIT_FILE_NAME;
use crate::git::worktree::service::remove_folder as remove_tree_folder;
use crate::git::worktree::tree_records::{TreeRecordRemovalError, remove_records_naming};

// A dotted sibling of the project folders, which a slug never names and no sweep reads.
const STAGED_CHANGES_SEGMENT: &str = ".staged-changes";

// In each worktree's own folder: the tree, and the file naming the repository it was made from.
const TREE_FOLDER_NAME: &str = "tree";
const REPOSITORY_ROOT_FILE_NAME: &str = "repository";

// How many random bytes name a worktree's folder, so two never meet.
const WORKTREE_NAME_BYTES: usize = 16;

// What a failure of opening a worktree names as the operation its cleanup followed.
const OPENING: &str = "staged worktree opening";

/// Why a step of opening, closing or sweeping a staged-changes worktree failed.
#[derive(Debug, thiserror::Error)]
pub enum StagedChangesError {
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
    /// A git record naming the worktree could not be read or removed.
    #[error(transparent)]
    Records(#[from] TreeRecordRemovalError),
    /// A worktree's folder or its git record could not be read or removed.
    #[error("the staged-changes worktree or record {} could not be removed", path.display())]
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
pub struct StagedChangesWorktrees {
    folder: PathBuf,
    git: GitRunner,
}

impl StagedChangesWorktrees {
    /// The worktrees under `worktrees_folder`, the daemon's own and absolute, made with `git`.
    pub fn new(worktrees_folder: &Path, git: GitRunner) -> Self {
        Self {
            folder: worktrees_folder.join(STAGED_CHANGES_SEGMENT),
            git,
        }
    }

    /// Opens a worktree of `working_folder`'s repository at `place`, detached at its `HEAD`,
    /// holding exactly the staged changes in its index and working files. Fails when the folder is
    /// no git working tree, its `HEAD` names no commit, or a step fails; a worktree made before
    /// the failure is removed first, and the failure carries any failure of that removal.
    pub async fn open_staged_worktree(
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
        let name = random_hex(WORKTREE_NAME_BYTES)
            .map_err(|failure| without_cleanup(StagedChangesError::Naming(failure)))?;
        let holder = self.folder.join(name);
        if let Err(source) = make_holder(&holder, &repository_root).await {
            let cleanup_failures = remove_folder(holder.clone())
                .await
                .err()
                .into_iter()
                .collect();
            return Err(CleanupFailures::new(
                StagedChangesError::Folder {
                    path: holder,
                    source,
                },
                cleanup_failures,
                OPENING,
            ));
        }
        let worktree = StagedChangesWorktree {
            folder: holder.join(TREE_FOLDER_NAME),
            holder,
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
    /// repository's records too, before any review opens one. Every entry is tried, and one whose
    /// read or removal failed keeps its folder, the file naming its repository included, for the
    /// next start to try again; the answer is every failure, empty when all went.
    pub async fn sweep_left_worktrees(&self) -> Vec<StagedChangesError> {
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
            let holder = self.folder.join(name);
            let holder_failures = self.remove_left_worktree(&holder).await;
            if holder_failures.is_empty()
                && let Err(failure) = remove_folder(holder).await
            {
                failures.push(failure);
            }
            failures.extend(holder_failures);
        }
        failures
    }

    // Removes the tree a stopped daemon left in `holder` and the records naming it, leaving the
    // holder itself; answers each step's failure.
    async fn remove_left_worktree(&self, holder: &Path) -> Vec<StagedChangesError> {
        let folder = holder.join(TREE_FOLDER_NAME);
        let mut failures = Vec::new();
        // Read before the tree goes: its `.git` file names the repository, and the file beside it
        // does for a tree git was ended before writing one.
        let common_git_folder = match self.read_left_common_folder(holder, &folder).await {
            Ok(common_git_folder) => common_git_folder,
            Err(failure) => {
                failures.push(failure);
                None
            }
        };
        if let Err(failure) = remove_folder(folder.clone()).await {
            failures.push(failure);
        }
        if let Some(common_git_folder) = common_git_folder {
            failures.extend(
                remove_records_naming(&common_git_folder, &folder)
                    .await
                    .into_iter()
                    .map(StagedChangesError::from),
            );
        }
        failures
    }

    // The git common folder of the tree a stopped daemon left at `folder` in `holder`: from its
    // `.git` while it has one, else from the repository the file beside it names, and `None` when
    // neither names one, as before git ran. git is asked in the tree only while its `.git` stands,
    // since in a folder without one it answers whatever repository holds the daemon's folder. The
    // daemon's own folder is on this computer, never in a WSL 2 distribution.
    async fn read_left_common_folder(
        &self,
        holder: &Path,
        folder: &Path,
    ) -> Result<Option<PathBuf>, StagedChangesError> {
        let git_file = folder.join(GIT_FILE_NAME);
        let git_file_failure = if tokio::fs::try_exists(&git_file).await.map_err(|source| {
            StagedChangesError::Folder {
                path: git_file.clone(),
                source,
            }
        })? {
            match read_git_common_folder(&self.git, None, folder, None).await {
                Ok(common_git_folder) => return Ok(Some(common_git_folder)),
                Err(failure) => Some(failure),
            }
        } else {
            None
        };
        let root_file = holder.join(REPOSITORY_ROOT_FILE_NAME);
        let Some(root) = tokio::fs::read(&root_file)
            .await
            .none_if_missing()
            .map_err(|source| StagedChangesError::Folder {
                path: root_file.clone(),
                source,
            })?
        else {
            return match git_file_failure {
                Some(failure) => Err(failure.into()),
                None => Ok(None),
            };
        };
        let repository_root = path_from_program_output(root)
            .map_err(|failure| StagedChangesError::from(GitError::PathText(failure)))?;
        Ok(Some(
            read_git_common_folder(&self.git, None, &repository_root, None).await?,
        ))
    }
}

/// A temporary worktree holding only a folder's staged changes, removed by [`Self::close`].
pub struct StagedChangesWorktree {
    holder: PathBuf,
    folder: PathBuf,
    repository_root: PathBuf,
    place: Option<Place>,
    git: GitRunner,
}

impl StagedChangesWorktree {
    /// The worktree's folder, absolute.
    pub fn folder(&self) -> &Path {
        &self.folder
    }

    /// Removes the worktree and its own record from the repository. Every step runs whatever
    /// failed before it; fails with the first failure, carrying the rest.
    pub async fn close(self) -> Result<(), CleanupFailures<StagedChangesError>> {
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
    // to discard; a worktree whose making failed has no `.git` git could find its record by, so
    // its folder goes and the records naming it are removed by name, as they are after a removal
    // git left unfinished. Every step runs whatever failed before it, and the holder, with the
    // file naming its repository, stays after any failure, so the next start's sweep tries again.
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
        // Read from the repository's own checkout, which stands whether or not the tree was made.
        match read_git_common_folder(&self.git, place, &self.repository_root, None).await {
            Ok(common_git_folder) => {
                failures.extend(
                    remove_records_naming(&common_git_folder, &self.folder)
                        .await
                        .into_iter()
                        .map(StagedChangesError::from),
                );
            }
            Err(failure) => failures.push(failure.into()),
        }
        if failures.is_empty()
            && let Err(failure) = remove_folder(self.holder.clone()).await
        {
            failures.push(failure);
        }
        failures
    }
}

// Makes the worktree's own folder `holder` and writes in it the file naming `repository_root`.
async fn make_holder(holder: &Path, repository_root: &Path) -> io::Result<()> {
    tokio::fs::create_dir_all(holder).await?;
    tokio::fs::write(
        holder.join(REPOSITORY_ROOT_FILE_NAME),
        repository_root.as_os_str().as_encoded_bytes(),
    )
    .await
}

// Removes `folder` and everything in it; a folder already gone passes.
async fn remove_folder(folder: PathBuf) -> Result<(), StagedChangesError> {
    remove_tree_folder(&folder)
        .await
        .map_err(|source| StagedChangesError::Remove {
            path: folder,
            source,
        })
}

#[cfg(test)]
mod tests;
