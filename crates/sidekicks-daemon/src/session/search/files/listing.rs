//! Lists a working folder's files and folders as paths relative to it, `/`-separated: the
//! repository's own view through `git ls-files` inside a git working tree, and outside one a walk
//! of the folder that honors every `.gitignore` in it as git does. A rules file that cannot be
//! read holds no rules and a folder below the working folder that cannot be read holds nothing, as
//! git counts them, each named in the service log, git's own warnings inside a working tree too.
//! A read that fails for a reason another moment can clear is tried once more.

use std::collections::{BTreeSet, HashMap};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{DirEntry, Match, WalkBuilder};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::methods::SessionFileSearchEntryKind;
use sidekicks_platforms::path_from_program_output;
use tokio::task::JoinError;

use crate::git::process::{GitCall, GitError, GitRunner};
use crate::read_retry::{is_retryable_read_failure, read_with_one_retry};

/// The listing inside a working tree: tracked files and the untracked ones the repository does
/// not ignore, each once, NUL-separated.
const LIST_FILES_ARGUMENTS: [&str; 6] = [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate",
];

/// What git prints, in the C locale the runner sets, for a folder outside any working tree.
const OUTSIDE_WORKING_TREE_STDERR: &str = "not a git repository";

/// The repository's own folder, never a folder of the working folder.
const GIT_FOLDER_NAME: &str = ".git";

/// A folder's rules file, which git reads only as a regular file, never through a link.
const RULES_FILE_NAME: &str = ".gitignore";

/// A working folder's files and folders, and how many files it could not name.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the `@` file search ranks and counts the listed entries"
    )
)]
#[derive(Debug)]
pub(crate) struct WorkingFolderListing {
    /// Every file and folder, each path relative to the working folder and `/`-separated.
    pub(crate) entries: Vec<ListedEntry>,
    /// The files left out because their names are not UTF-8, which no row can carry; they still
    /// count as files the search was matched against.
    pub(crate) dropped_file_count: usize,
}

/// One file or folder of a working folder.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the `@` file search turns each listed entry into a row"
    )
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ListedEntry {
    /// The path, relative to the working folder and `/`-separated.
    pub(crate) path: String,
    /// Whether it names a file or a folder.
    pub(crate) kind: SessionFileSearchEntryKind,
}

/// Why a working folder could not be listed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ListingError {
    /// git failed for a reason other than the folder lying outside any working tree.
    #[error("git could not list the working folder")]
    Git(#[from] GitError),
    /// The walk could not read the working folder, or met a failure another moment may clear.
    #[error("the working folder could not be walked")]
    Walk(#[source] ignore::Error),
    /// The walk's blocking task ended before it answered.
    #[error("the walk of the working folder did not finish")]
    WalkTask(#[source] JoinError),
}

impl ListingError {
    // Whether another moment may clear the failure, as the one read retry asks.
    fn is_retryable(&self) -> bool {
        match self {
            Self::Walk(error) => error.io_error().is_some_and(is_retryable_walk_failure),
            Self::Git(_) | Self::WalkTask(_) => false,
        }
    }
}

/// Lists `folder`'s files and folders for a project at `place`, through git inside a working tree
/// and by a walk outside one, retrying once a read another moment may clear. Fails with `Git` for
/// any other git failure, a project in a WSL 2 distribution among them, `Walk` when the walk
/// cannot read `folder` or meets a failure that persists, and `WalkTask` when the walk's task ends.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the `@` file search lists a session's working folder through it"
    )
)]
pub(crate) async fn list_working_folder(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<WorkingFolderListing, ListingError> {
    read_with_one_retry(
        || read_working_folder(git, place, folder),
        ListingError::is_retryable,
    )
    .await
}

async fn read_working_folder(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<WorkingFolderListing, ListingError> {
    let listed = match git
        .run(
            place,
            GitCall::live_index_read(folder, &LIST_FILES_ARGUMENTS),
        )
        .await
    {
        Ok(listed) => listed,
        Err(GitError::Exited { ref stderr, .. })
            if stderr.contains(OUTSIDE_WORKING_TREE_STDERR) =>
        {
            let folder = folder.to_path_buf();
            return tokio::task::spawn_blocking(move || walk_folder(&folder))
                .await
                .map_err(ListingError::WalkTask)?;
        }
        Err(error) => return Err(error.into()),
    };
    // A listing git answered carries only warnings on stderr, such as a rules file it could not
    // read.
    for warning in listed.stderr.lines().filter(|line| !line.is_empty()) {
        tracing::warn!(
            folder = %folder.display(),
            warning,
            "the file search listed the folder past git's warning"
        );
    }
    Ok(listing_of_git_output(&listed.stdout))
}

// The files git listed, NUL-separated, and every folder above them, since git lists files only.
fn listing_of_git_output(stdout: &[u8]) -> WorkingFolderListing {
    let mut entries = Vec::new();
    let mut folders = BTreeSet::new();
    let mut dropped_file_count = 0;
    for listed_path in stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path = path_from_program_output(listed_path.to_vec());
        let Some(path) = path.ok().and_then(|path| path.to_str().map(str::to_owned)) else {
            dropped_file_count += 1;
            continue;
        };
        // git prints `/` between a path's names on every system.
        for (separator_index, _) in path.match_indices('/') {
            folders.insert(path[..separator_index].to_owned());
        }
        entries.push(ListedEntry {
            path,
            kind: SessionFileSearchEntryKind::File,
        });
    }
    entries.extend(folders.into_iter().map(|path| ListedEntry {
        path,
        kind: SessionFileSearchEntryKind::Folder,
    }));
    WorkingFolderListing {
        entries,
        dropped_file_count,
    }
}

// Walks `folder`, outside any working tree, as git would list it. An entry below `folder` that
// cannot be read is logged and listed past; `folder` itself failing, or a failure another moment
// may clear, fails the walk.
fn walk_folder(folder: &Path) -> Result<WorkingFolderListing, ListingError> {
    let rules = Arc::new(FolderRules {
        folder: folder.to_path_buf(),
        matchers: Mutex::new(HashMap::new()),
        failure: Mutex::new(None),
    });
    let filter_rules = Arc::clone(&rules);
    let walk = WalkBuilder::new(folder)
        .standard_filters(false)
        .follow_links(false)
        .filter_entry(move |entry| filter_rules.keeps(entry))
        .build();
    let mut entries = Vec::new();
    let mut dropped_file_count = 0;
    for walked in walk {
        let entry = match walked {
            Ok(entry) => entry,
            Err(error) => {
                let fails_walk = error.depth().is_none_or(|depth| depth == 0)
                    || error.io_error().is_some_and(is_retryable_walk_failure);
                if fails_walk {
                    return Err(ListingError::Walk(error));
                }
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    folder = %folder.display(),
                    "the file search listed the folder past an entry it could not read"
                );
                continue;
            }
        };
        if entry.depth() == 0 {
            continue;
        }
        let kind = if is_folder(&entry) {
            SessionFileSearchEntryKind::Folder
        } else {
            SessionFileSearchEntryKind::File
        };
        match relative_path_of(folder, entry.path()) {
            Some(path) => entries.push(ListedEntry { path, kind }),
            // A folder's own name is left out with it; each file below it is counted.
            None => match kind {
                SessionFileSearchEntryKind::File => dropped_file_count += 1,
                SessionFileSearchEntryKind::Folder => {}
            },
        }
    }
    if let Some(failure) = rules
        .failure
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    {
        return Err(ListingError::Walk(failure));
    }
    Ok(WorkingFolderListing {
        entries,
        dropped_file_count,
    })
}

// The rules of every folder the walk has entered, each read at the first entry seen in it, and
// the first rules read that failed in a way another moment may clear.
struct FolderRules {
    folder: PathBuf,
    matchers: Mutex<HashMap<PathBuf, Gitignore>>,
    failure: Mutex<Option<ignore::Error>>,
}

impl FolderRules {
    // Whether the walk keeps `entry`: never the repository's own folder, and otherwise the
    // verdict of the deepest rules file that names it. A folder left out takes everything under
    // it along, as in git.
    fn keeps(&self, entry: &DirEntry) -> bool {
        if self
            .failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
        {
            return false;
        }
        let is_entry_folder = is_folder(entry);
        if is_entry_folder && entry.file_name() == GIT_FOLDER_NAME {
            return false;
        }
        let Some(parent) = entry.path().parent() else {
            return true;
        };
        let mut matchers = self.matchers.lock().unwrap_or_else(PoisonError::into_inner);
        if !matchers.contains_key(parent) {
            let matcher = self.read_rules(parent);
            matchers.insert(parent.to_path_buf(), matcher);
        }
        for ancestor in entry
            .path()
            .ancestors()
            .skip(1)
            .take_while(|ancestor| ancestor.starts_with(&self.folder))
        {
            let Some(matcher) = matchers.get(ancestor) else {
                continue;
            };
            match matcher.matched(entry.path(), is_entry_folder) {
                Match::Ignore(_) => return false,
                Match::Whitelist(_) => return true,
                Match::None => {}
            }
        }
        true
    }

    // `folder`'s rules: none when it has no rules file, when the file is a link, which git reads
    // no rules through, or when it cannot be read.
    fn read_rules(&self, folder: &Path) -> Gitignore {
        let rules_path = folder.join(RULES_FILE_NAME);
        match std::fs::symlink_metadata(&rules_path) {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    tracing::warn!(
                        folder = %self.folder.display(),
                        rules_file = %rules_path.display(),
                        "the file search read no rules from a rules file that is a link, as git \
                         reads none through one"
                    );
                }
                return Gitignore::empty();
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Gitignore::empty(),
            Err(error) => {
                return self.rules_unreadable(ignore::Error::WithPath {
                    path: rules_path,
                    err: Box::new(ignore::Error::Io(error)),
                });
            }
        }
        let mut builder = GitignoreBuilder::new(folder);
        if let Some(error) = builder.add(&rules_path) {
            if error.io_error().is_some() {
                return self.rules_unreadable(error);
            }
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                folder = %self.folder.display(),
                "the file search read a rules file past the lines it could not read as rules"
            );
        }
        builder.build().unwrap_or_else(|error| {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                folder = %self.folder.display(),
                "the file search read no rules from a rules file it could not build"
            );
            Gitignore::empty()
        })
    }

    // A rules file that could not be read holds no rules, as in git; a failure another moment may
    // clear is kept to fail the walk, which is then tried once more.
    fn rules_unreadable(&self, error: ignore::Error) -> Gitignore {
        if error.io_error().is_some_and(is_retryable_walk_failure) {
            self.failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_or_insert(error);
        } else {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                folder = %self.folder.display(),
                "the file search read no rules from a rules file it could not read"
            );
        }
        Gitignore::empty()
    }
}

// Whether the walk's failure is one another moment may clear, read from the system's own error,
// which the walk keeps as the source of the error it reports.
fn is_retryable_walk_failure(error: &io::Error) -> bool {
    let system_error = error
        .source()
        .and_then(|source| source.downcast_ref::<io::Error>())
        .unwrap_or(error);
    is_retryable_read_failure(system_error)
}

fn is_folder(entry: &DirEntry) -> bool {
    entry
        .file_type()
        .is_some_and(|file_type| file_type.is_dir())
}

// `path` relative to `folder`, its names joined by `/`; `None` when a name is not UTF-8.
fn relative_path_of(folder: &Path, path: &Path) -> Option<String> {
    let names = path
        .strip_prefix(folder)
        .ok()?
        .components()
        .map(|component| component.as_os_str().to_str())
        .collect::<Option<Vec<_>>>()?;
    Some(names.join("/"))
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::path::Path;

    use sidekicks_contracts::session::methods::SessionFileSearchEntryKind;
    use sidekicks_platforms::path_from_program_output;

    use super::{WorkingFolderListing, list_working_folder};
    use crate::git::process::{test_git_runner, write_link};

    // Writes each `(path, text)` under `folder`, making the folders on the way.
    fn write_files(folder: &Path, files: &[(&str, &str)]) {
        for (path, text) in files {
            let path = folder.join(path);
            let parent = path.parent().expect("a written file has a parent");
            std::fs::create_dir_all(parent).expect("the folders are made");
            std::fs::write(&path, text).expect("the file is written");
        }
    }

    // The listed paths, folders marked with a trailing `/`, sorted.
    fn listed_paths(listing: &WorkingFolderListing) -> Vec<String> {
        let mut paths: Vec<String> = listing
            .entries
            .iter()
            .map(|entry| match entry.kind {
                SessionFileSearchEntryKind::File => entry.path.clone(),
                SessionFileSearchEntryKind::Folder => format!("{}/", entry.path),
            })
            .collect();
        paths.sort();
        paths
    }

    // Lists `folder`, which lies outside any working tree, so the walk runs.
    async fn walk_listing(folder: &Path) -> WorkingFolderListing {
        list_working_folder(&test_git_runner(), None, folder)
            .await
            .expect("the folder is listed")
    }

    // Fails when a shallower rules file's verdict wins over a deeper one's re-include, or when a
    // deeper rules file is not read.
    #[tokio::test]
    async fn listing_takes_the_deepest_rules_verdict() {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        write_files(
            root.path(),
            &[
                (".gitignore", "*.log\n"),
                ("top.log", "ignored\n"),
                ("notes/.gitignore", "!keep.log\n"),
                ("notes/keep.log", "re-included\n"),
                ("notes/drop.log", "ignored\n"),
            ],
        );

        let listing = walk_listing(root.path()).await;

        assert_eq!(
            listed_paths(&listing),
            [".gitignore", "notes/", "notes/.gitignore", "notes/keep.log"]
        );
    }

    // Fails when the walk descends into an ignored folder, where a rules file's re-include would
    // list a file git never lists.
    #[tokio::test]
    async fn listing_lists_nothing_under_an_ignored_folder() {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        write_files(
            root.path(),
            &[
                (".gitignore", "build/\n"),
                ("build/.gitignore", "!inner.txt\n"),
                ("build/inner.txt", "under an ignored folder\n"),
                ("src/main.rs", "fn main() {}\n"),
            ],
        );

        let listing = walk_listing(root.path()).await;

        assert_eq!(
            listed_paths(&listing),
            [".gitignore", "src/", "src/main.rs"]
        );
    }

    // Fails when a rules file that is a link is read through it, which git never does.
    #[tokio::test]
    async fn listing_reads_no_rules_through_a_linked_rules_file() {
        let git = test_git_runner();
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let folder = root.path().join("folder");
        write_files(
            &folder,
            &[
                ("shared-rules", "linked.txt\n"),
                ("sub/linked.txt", "listed\n"),
            ],
        );
        write_link(
            &git,
            &root.path().join("links"),
            &folder,
            "sub/.gitignore",
            "../shared-rules",
        )
        .await;
        assert!(
            std::fs::symlink_metadata(folder.join("sub/.gitignore"))
                .expect("the link is there")
                .file_type()
                .is_symlink()
        );

        let listing = walk_listing(&folder).await;

        assert!(
            listed_paths(&listing).contains(&"sub/linked.txt".to_owned()),
            "a linked rules file's rules were applied"
        );
    }

    // Fails when a name that is not UTF-8 is listed lossily, fails the listing, or goes uncounted.
    #[tokio::test]
    async fn listing_drops_and_counts_a_name_that_is_not_utf8() {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        write_files(root.path(), &[("plain.txt", "plain\n")]);
        let created = path_from_program_output(b"caf\xe9.txt".to_vec())
            .and_then(|name| std::fs::write(root.path().join(name), "not UTF-8\n"));
        // APFS refuses such a name (`EILSEQ`), and Windows names no path with it.
        if let Err(error) = created {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "skipped: this system refuses a file name that is not UTF-8, so the drop cannot \
                 be shown here"
            );
            return;
        }

        let listing = walk_listing(root.path()).await;

        assert_eq!(listed_paths(&listing), ["plain.txt"]);
        assert_eq!(listing.dropped_file_count, 1);
    }
}
