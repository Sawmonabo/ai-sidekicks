//! What a working folder's watches cover: the tree less what git ignores and less the git folder;
//! in the tree's own git folder its HEAD, index, config and refs, and in a linked tree's common
//! folder only the shared config and refs; and the count of the folders each watch keeps, which is
//! what a watch per folder costs.

use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};

use ignore::WalkBuilder;
use sidekicks_contracts::place::Place;

use crate::file_watch::{WalkFilter, WatchedRoot};
use crate::git::process::{GitCall, GitError, GitRunner, background_read};
use crate::missing_entry::is_missing_entry;

const GIT_FOLDER_NAME: &str = ".git";

/// The file whose change may change what git ignores in the tree.
pub(super) const IGNORE_FILE_NAME: &str = ".gitignore";

// The entries in a git folder whose change the tree's readers must see: its HEAD and index, the
// config naming each branch's upstream, and the refs, packed, loose or in a reftable, where a
// branch tip moves without either.
const HEAD_FILE_NAME: &str = "HEAD";
const INDEX_FILE_NAME: &str = "index";
const CONFIG_FILE_NAME: &str = "config";
const PACKED_REFS_FILE_NAME: &str = "packed-refs";
const REFTABLE_FOLDER_NAME: &str = "reftable";
const REF_FOLDER_NAMES: [&str; 2] = ["refs", REFTABLE_FOLDER_NAME];

// The files a tree's own git folder keeps; a linked tree's common folder keeps only the shared
// ones, since its HEAD and index are the main checkout's.
const OWN_GIT_FOLDER_FILE_NAMES: [&str; 4] = [
    HEAD_FILE_NAME,
    INDEX_FILE_NAME,
    CONFIG_FILE_NAME,
    PACKED_REFS_FILE_NAME,
];
const COMMON_FOLDER_FILE_NAMES: [&str; 2] = [CONFIG_FILE_NAME, PACKED_REFS_FILE_NAME];

// What starts an ignored path's entry in git's short status.
const IGNORED_ENTRY_MARK: &[u8] = b"!! ";

/// What git ignores in a tree, each path relative with `/` between parts and a folder ending in
/// `/`, as git prints them; read at each change, so a fresh read takes effect at once.
#[derive(Clone, Default)]
pub(super) struct IgnoredPaths {
    paths: Arc<RwLock<HashSet<Vec<u8>>>>,
}

impl IgnoredPaths {
    /// Holds `paths` from now on; answers whether they differ from the ones held before.
    pub(super) fn replace(&self, paths: HashSet<Vec<u8>>) -> bool {
        let mut held = self.paths.write().unwrap_or_else(PoisonError::into_inner);
        let is_changed = *held != paths;
        *held = paths;
        is_changed
    }

    // Whether `relative_path` is a path git ignores or lies in a folder it ignores.
    fn holds(&self, relative_path: &Path) -> bool {
        let paths = self.paths.read().unwrap_or_else(PoisonError::into_inner);
        if paths.is_empty() {
            return false;
        }
        let mut prefix = Vec::new();
        for component in relative_path.components() {
            let Component::Normal(part) = component else {
                continue;
            };
            prefix.extend_from_slice(part.as_encoded_bytes());
            if paths.contains(&prefix) {
                return true;
            }
            prefix.push(b'/');
            if paths.contains(&prefix) {
                return true;
            }
        }
        false
    }
}

/// Reads what git ignores in `folder` at `place`: each path an ignore pattern matches, a folder
/// the pattern names whole listed once and not entered, while a folder whose files each match on
/// their own is not, so a file added to it later is seen. Fails as [`GitRunner::run`] does.
pub(super) async fn read_ignored_paths(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<HashSet<Vec<u8>>, GitError> {
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &[
                    "status",
                    "--porcelain",
                    "-z",
                    "--ignored=matching",
                    "--untracked-files=normal",
                    "--no-renames",
                ],
            )),
        )
        .await?;
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|entry| entry.strip_prefix(IGNORED_ENTRY_MARK))
        .filter(|ignored| !ignored.is_empty())
        .map(<[u8]>::to_vec)
        .collect())
}

/// Whether a tree-relative path is kept by the tree's watch: nothing git ignores, and nothing in
/// the git folder. A linked tree's `.git` is a pointer file whose change says the repository may
/// have moved, so it is kept; a checkout's `.git` folder is the git-folder watch's, refused whole.
#[derive(Clone)]
pub(super) struct TreeCoverage {
    ignored: IgnoredPaths,
    is_linked_tree: bool,
}

impl TreeCoverage {
    /// The coverage of a tree whose ignored paths are `ignored`; `is_linked_tree` when its `.git`
    /// is a pointer file.
    pub(super) fn new(ignored: IgnoredPaths, is_linked_tree: bool) -> Self {
        Self {
            ignored,
            is_linked_tree,
        }
    }

    /// Whether the watch keeps `relative_path`.
    pub(super) fn keeps(&self, relative_path: &Path) -> bool {
        let mut components = relative_path.components();
        if let Some(Component::Normal(first)) = components.next()
            && first == OsStr::new(GIT_FOLDER_NAME)
        {
            return self.is_linked_tree && components.next().is_none();
        }
        !self.ignored.holds(relative_path)
    }

    /// The watch's filter over this coverage.
    pub(super) fn filter(&self) -> WalkFilter {
        let coverage = self.clone();
        WalkFilter::new(move |relative_path| coverage.keeps(relative_path))
    }
}

/// Whether `relative_path` is a linked tree's `.git` pointer file.
pub(super) fn is_git_pointer(relative_path: &Path) -> bool {
    relative_path == Path::new(GIT_FOLDER_NAME)
}

/// The git-folder watch's roots, `git_folders` in order: the tree's own git folder first, keeping
/// the folder, its HEAD, index, config and `packed-refs`, and everything under `refs/` and
/// `reftable/`; then a linked tree's common folder, keeping the folder, its config and
/// `packed-refs`, and everything under `refs/` and `reftable/`. On a system that watches one
/// folder at a time each takes one watch for the folder and one for each ref folder.
pub(super) fn git_folder_roots(git_folders: &[PathBuf]) -> Vec<WatchedRoot> {
    git_folders
        .iter()
        .enumerate()
        .map(|(place, git_folder)| WatchedRoot {
            path: git_folder.clone(),
            filter: WalkFilter::new(git_folder_keeps(place)),
        })
        .collect()
}

// What the git folder at `place` among a watch's git folders keeps: the tree's own first, then the
// common one.
fn git_folder_keeps(place: usize) -> fn(&Path) -> bool {
    if place == 0 {
        keeps_in_own_git_folder
    } else {
        keeps_in_common_folder
    }
}

// Whether the tree's own git folder's watch keeps `relative_path`, relative to that folder.
fn keeps_in_own_git_folder(relative_path: &Path) -> bool {
    keeps_git_entry(relative_path, &OWN_GIT_FOLDER_FILE_NAMES)
}

// Whether a linked tree's common folder's watch keeps `relative_path`, relative to that folder.
fn keeps_in_common_folder(relative_path: &Path) -> bool {
    keeps_git_entry(relative_path, &COMMON_FOLDER_FILE_NAMES)
}

// Whether `relative_path`, relative to a git folder, is the folder itself, one of `file_names` at
// its top, or a ref folder or anything under one.
fn keeps_git_entry(relative_path: &Path, file_names: &[&str]) -> bool {
    let mut components = relative_path.components();
    match (components.next(), components.next()) {
        (None, _) => true,
        (Some(Component::Normal(name)), rest) => {
            REF_FOLDER_NAMES
                .iter()
                .any(|folder| name == OsStr::new(folder))
                || (rest.is_none() && file_names.iter().any(|file| name == OsStr::new(file)))
        }
        (Some(_), _) => false,
    }
}

/// Whether a changed path, relative to the tree's own git folder, may have moved the tree's HEAD:
/// the HEAD file, or under reftable, whose HEAD file never changes, the tree's own ref stack.
pub(super) fn may_move_head(relative_path: &Path) -> bool {
    relative_path == Path::new(HEAD_FILE_NAME)
        || relative_path
            .components()
            .next()
            .is_some_and(|first| first == Component::Normal(OsStr::new(REFTABLE_FOLDER_NAME)))
}

/// The folders under each of `git_folders` the git-folder watch keeps, each folder among them,
/// each git folder counted with its own filter. Blocks while it walks.
pub(super) fn count_git_folder_watches(git_folders: &[PathBuf]) -> u64 {
    git_folders
        .iter()
        .enumerate()
        .map(|(place, git_folder)| count_kept_folders(git_folder, git_folder_keeps(place)))
        .sum()
}

/// The folders under `root` that `keeps` answers true for, by their path relative to `root`, the
/// root among them: what a watch per folder takes. An entry that cannot be read is logged and not
/// counted. Blocks while it walks.
pub(super) fn count_kept_folders(
    root: &Path,
    keeps: impl Fn(&Path) -> bool + Send + Sync + 'static,
) -> u64 {
    let walk_root = root.to_path_buf();
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .follow_links(false)
        .filter_entry(move |entry| match entry.path().strip_prefix(&walk_root) {
            Ok(relative_path) => keeps(relative_path),
            Err(_) => false,
        });
    let mut folders: u64 = 0;
    for entry in builder.build() {
        match entry {
            Ok(entry) if entry.file_type().is_some_and(|kind| kind.is_dir()) => folders += 1,
            Ok(_) => {}
            // An entry removed while the walk runs is no failure.
            Err(error) if error.io_error().is_some_and(is_missing_entry) => {}
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "an entry under a working folder could not be read, so it is not counted against \
                 the machine's watch limit"
            ),
        }
    }
    folders
}
