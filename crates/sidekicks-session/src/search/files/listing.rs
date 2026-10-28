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
use std::sync::{Arc, Mutex};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{DirEntry, Match, WalkBuilder};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::methods::SessionFileSearchEntryKind;
use sidekicks_platforms::path_from_program_output;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::retry::read::{is_retryable_read_failure, read_with_one_retry};
use sidekicks_workspace::git::process::{GitCall, GitError, GitRunner};
use tokio::task::JoinError;

/// The listing inside a working tree: tracked entries and the untracked ones the repository does
/// not ignore, NUL-separated, each tracked one with its mode (`-s`) and each untracked one marked
/// by its tag (`-t`), so a tracked repository and a link are told from a file. An entry in
/// conflict is listed once per stage.
const LIST_FILES_ARGUMENTS: [&str; 7] = [
    "ls-files",
    "-z",
    "-t",
    "-s",
    "--cached",
    "--others",
    "--exclude-standard",
];

/// The tag `-t` puts before an untracked entry.
const UNTRACKED_TAG: &[u8] = b"? ";

/// The length of every tag `-t` prints, its letter and a space.
const TAG_LENGTH: usize = 2;

/// The mode of a tracked repository inside the working tree (a submodule).
const GITLINK_MODE: &[u8] = b"160000";

/// The mode of a tracked link.
const LINK_MODE: &[u8] = b"120000";

/// The length of every mode `-s` prints, in octal.
const MODE_LENGTH: usize = 6;

/// What git prints, in the C locale the runner sets, for a folder outside any working tree.
const OUTSIDE_WORKING_TREE_STDERR: &str = "not a git repository";

/// The repository's own folder, never a folder of the working folder.
const GIT_FOLDER_NAME: &str = ".git";

/// A folder's rules file, which git reads only as a regular file, never through a link.
const RULES_FILE_NAME: &str = ".gitignore";

/// A working folder's files and folders, and how many files it could not name.
#[derive(Debug)]
pub(crate) struct WorkingFolderListing {
    /// Every file and folder, each path relative to the working folder and `/`-separated.
    pub(crate) entries: Vec<ListedEntry>,
    /// The files left out because their names are not UTF-8, which no row can carry; they still
    /// count as files the search was matched against.
    pub(crate) dropped_file_count: usize,
}

/// One file or folder of a working folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ListedEntry {
    /// The path, relative to the working folder and `/`-separated.
    pub(crate) path: String,
    /// Whether it names a file or a folder.
    pub(crate) kind: SessionFileSearchEntryKind,
}

/// Why a working folder could not be listed.
#[derive(Debug, thiserror::Error)]
pub enum ListingError {
    /// git failed for a reason other than the folder lying outside any working tree.
    #[error("git could not list the working folder")]
    Git(#[from] GitError),
    /// The walk could not read the working folder, or met a failure another moment may clear.
    #[error("the working folder could not be walked")]
    Walk(#[source] ignore::Error),
    /// The blocking task that walked the folder or read git's listing ended before it answered.
    #[error("the listing of the working folder did not finish")]
    Task(#[source] JoinError),
}

impl ListingError {
    // Whether another moment may clear the failure, as the one read retry asks.
    fn is_retryable(&self) -> bool {
        match self {
            Self::Walk(error) => error.io_error().is_some_and(is_retryable_walk_failure),
            Self::Git(_) | Self::Task(_) => false,
        }
    }
}

/// Lists `folder`'s files and folders for a project at `place`, through git inside a working tree
/// and by a walk outside one, retrying once a read another moment may clear. Fails with `Git` for
/// any other git failure, a project in a WSL 2 distribution among them, `Walk` when the walk
/// cannot read `folder` or meets a failure that persists, and `Task` when a blocking task ends.
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
                .map_err(ListingError::Task)?;
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
    // A link's kind is read from its target on disk, so the listing is read off the runtime.
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || listing_of_git_output(&folder, &listed.stdout))
        .await
        .map_err(ListingError::Task)
}

// The entries git listed in `folder`, NUL-separated, and every folder above them. An untracked
// repository, listed with a trailing `/`, and a tracked one are folders; a link takes its target's
// kind; an entry in conflict is listed once.
fn listing_of_git_output(folder: &Path, stdout: &[u8]) -> WorkingFolderListing {
    let mut entries = Vec::new();
    let mut folders = BTreeSet::new();
    let mut dropped_file_count = 0;
    let mut last_tracked_path: Option<&[u8]> = None;
    for listed in stdout
        .split(|byte| *byte == 0)
        .filter(|line| !line.is_empty())
    {
        let Some(listed) = git_entry_of(listed) else {
            tracing::warn!(
                folder = %folder.display(),
                "the file search listed the folder past an entry git printed in no known form"
            );
            continue;
        };
        if listed.is_tracked {
            if last_tracked_path == Some(listed.path) {
                continue;
            }
            last_tracked_path = Some(listed.path);
        }
        let named = path_from_program_output(listed.path.to_vec())
            .ok()
            .and_then(|path| path.to_str().map(str::to_owned));
        let Some(path) = named else {
            if listed.kind != GitEntryKind::Folder {
                dropped_file_count += 1;
            }
            continue;
        };
        // git prints `/` between a path's names on every system.
        for (separator_index, _) in path.match_indices('/') {
            folders.insert(path[..separator_index].to_owned());
        }
        let is_folder = match listed.kind {
            GitEntryKind::Folder => true,
            GitEntryKind::File => false,
            GitEntryKind::Target => is_folder_target(&folder.join(&path)),
        };
        if is_folder {
            folders.insert(path);
        } else {
            entries.push(ListedEntry {
                path,
                kind: SessionFileSearchEntryKind::File,
            });
        }
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

/// What kind of entry git listed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GitEntryKind {
    File,
    Folder,
    /// A tracked link, or an untracked name, which git lists with no `/` for a file and a link to
    /// a folder alike: its kind is what it leads to on disk.
    Target,
}

/// One entry of git's listing: its path's bytes, its kind as git tells it, and whether it is
/// tracked.
struct GitEntry<'listing> {
    path: &'listing [u8],
    kind: GitEntryKind,
    is_tracked: bool,
}

// One entry of the listing: an untracked `? <path>`, a folder's path ending in `/`, or a tracked
// `<tag><mode> <id> <stage>\t<path>`; `None` for any other form.
fn git_entry_of(listed: &[u8]) -> Option<GitEntry<'_>> {
    if let Some(path) = listed.strip_prefix(UNTRACKED_TAG) {
        return Some(match path.strip_suffix(b"/") {
            Some(folder) => GitEntry {
                path: folder,
                kind: GitEntryKind::Folder,
                is_tracked: false,
            },
            None => GitEntry {
                path,
                kind: GitEntryKind::Target,
                is_tracked: false,
            },
        });
    }
    let staged = listed.get(TAG_LENGTH..)?;
    let mode = staged.get(..MODE_LENGTH)?;
    let path_start = staged.iter().position(|byte| *byte == b'\t')? + 1;
    let kind = if mode == GITLINK_MODE {
        GitEntryKind::Folder
    } else if mode == LINK_MODE {
        GitEntryKind::Target
    } else {
        GitEntryKind::File
    };
    Some(GitEntry {
        path: &staged[path_start..],
        kind,
        is_tracked: true,
    })
}

// Whether `path` leads to a folder, through any links; a target that cannot be read is no folder.
fn is_folder_target(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
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
        // A link is listed as its target's kind, though the walk never follows it.
        let is_entry_folder = if entry.path_is_symlink() {
            is_folder_target(entry.path())
        } else {
            is_folder(&entry)
        };
        let kind = if is_entry_folder {
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
    if let Some(failure) = lock(&rules.failure).take() {
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
        if lock(&self.failure).is_some() {
            return false;
        }
        let is_entry_folder = is_folder(entry);
        if is_entry_folder && entry.file_name() == GIT_FOLDER_NAME {
            return false;
        }
        let Some(parent) = entry.path().parent() else {
            return true;
        };
        let mut matchers = lock(&self.matchers);
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
            lock(&self.failure).get_or_insert(error);
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
    use std::ffi::OsString;
    use std::path::Path;

    use sidekicks_contracts::session::methods::SessionFileSearchEntryKind;
    use sidekicks_platforms::{is_illegal_byte_sequence, path_from_program_output};
    use sidekicks_workspace::git::process::{GitCall, in_folder, test_git_runner, write_link};

    use super::{WorkingFolderListing, list_working_folder, listing_of_git_output};

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
        // Windows names no path with such bytes.
        let Ok(name) = path_from_program_output(b"caf\xe9.txt".to_vec()) else {
            tracing::warn!("skipped: this system names no path that is not UTF-8");
            return;
        };
        match std::fs::write(root.path().join(name), "not UTF-8\n") {
            Ok(()) => {}
            // APFS refuses such a name.
            Err(error) if is_illegal_byte_sequence(&error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "skipped: this file system refuses a file name that is not UTF-8, so the \
                     drop cannot be shown here"
                );
                return;
            }
            Err(error) => panic!("the file that is not UTF-8 is written: {error}"),
        }

        let listing = walk_listing(root.path()).await;

        assert_eq!(listed_paths(&listing), ["plain.txt"]);
        assert_eq!(listing.dropped_file_count, 1);
    }

    // Fails when git's name that is not UTF-8 is listed lossily or goes uncounted, and when an
    // entry in conflict is listed once per stage.
    #[test]
    fn listing_of_git_output_drops_a_name_that_is_not_utf8_and_lists_a_conflict_once() {
        let folder = tempfile::tempdir().expect("the temporary folder is made");
        let stdout = b"? caf\xe9.txt\0? plain.txt\0\
            M 100644 1111111111111111111111111111111111111111 1\tconflict.txt\0\
            M 100644 2222222222222222222222222222222222222222 2\tconflict.txt\0";

        let listing = listing_of_git_output(folder.path(), stdout);

        assert_eq!(listed_paths(&listing), ["conflict.txt", "plain.txt"]);
        assert_eq!(listing.dropped_file_count, 1);
    }

    // Fails when an untracked repository is listed as a file or under its `/`, or when a tracked
    // repository or a link to a folder, tracked or not, is kinded a file by git's listing or the
    // walk.
    #[tokio::test]
    async fn listing_kinds_repositories_and_folder_links_as_folders() {
        let git = test_git_runner();
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let work = root.path().join("work");
        let outside = root.path().join("outside");
        for folder in [&work, &outside] {
            write_files(folder, &[("docs/guide.md", "guide\n")]);
            write_link(&git, &folder.join(".links"), folder, "docs-link", "docs").await;
            std::fs::remove_dir_all(folder.join(".links")).expect("the scratch is removed");
        }
        write_files(&work, &[("nested/notes.txt", "notes\n")]);
        for repository in [&work, &work.join("nested")] {
            git.run(
                None,
                GitCall::write([OsString::from("init"), repository.clone().into()]),
            )
            .await
            .expect("the repository is made");
        }
        write_link(
            &git,
            &root.path().join("links"),
            &work,
            "untracked-link",
            "docs",
        )
        .await;
        for staged in [
            &["add", "docs-link"][..],
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                "160000,1111111111111111111111111111111111111111,sub",
            ][..],
        ] {
            git.run(None, GitCall::write(in_folder(&work, staged)))
                .await
                .expect("the entry is staged");
        }

        let listed = list_working_folder(&git, None, &work)
            .await
            .expect("the working tree is listed");
        let walked = walk_listing(&outside).await;

        assert_eq!(
            listed_paths(&listed),
            [
                "docs-link/",
                "docs/",
                "docs/guide.md",
                "nested/",
                "sub/",
                "untracked-link/"
            ]
        );
        assert_eq!(
            listed_paths(&walked),
            ["docs-link/", "docs/", "docs/guide.md"]
        );
    }
}
