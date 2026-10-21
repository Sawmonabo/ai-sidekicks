//! What a working folder's watches cover: the tree less what git ignores and less the git folder,
//! and in the tree's own git folder only its HEAD and its index; and the count of the folders the
//! tree's watch keeps, which is what a watch per folder costs.

use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsStr;
use std::path::{Component, Path};
use std::sync::{Arc, PoisonError, RwLock};

use ignore::WalkBuilder;
use sidekicks_contracts::place::Place;

use crate::file_watch::WalkFilter;
use crate::git::process::{GitCall, GitError, GitRunner, background_read};
use crate::missing_entry::is_missing_entry;

const GIT_FOLDER_NAME: &str = ".git";

/// The file whose change may change what git ignores in the tree.
pub(super) const IGNORE_FILE_NAME: &str = ".gitignore";

// The files in a tree's own git folder whose change the tree's readers must see.
const HEAD_FILE_NAME: &str = "HEAD";
const INDEX_FILE_NAME: &str = "index";

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

/// Reads what git ignores in `folder` at `place`: a folder git ignores whole is listed once, not
/// entered. Fails as [`GitRunner::run`] does.
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
                    "ls-files",
                    "-z",
                    "--others",
                    "--ignored",
                    "--exclude-standard",
                    "--directory",
                ],
            )),
        )
        .await?;
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
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

/// The git-folder watch's filter: the folder itself and its HEAD and index, nothing deeper, so on a
/// system that watches one folder at a time it takes one watch.
pub(super) fn git_folder_filter() -> WalkFilter {
    WalkFilter::new(|relative_path| {
        let mut components = relative_path.components();
        match (components.next(), components.next()) {
            (None, _) => true,
            (Some(Component::Normal(name)), None) => {
                name == OsStr::new(HEAD_FILE_NAME) || name == OsStr::new(INDEX_FILE_NAME)
            }
            (Some(_), _) => false,
        }
    })
}

/// Whether a changed path in the git folder is its HEAD, and whether it is its index.
pub(super) fn git_folder_change(path: &Path) -> (bool, bool) {
    let name = path.file_name();
    (
        name == Some(OsStr::new(HEAD_FILE_NAME)),
        name == Some(OsStr::new(INDEX_FILE_NAME)),
    )
}

/// The folders under `root` that `coverage` keeps, the root among them: what a watch per folder
/// takes for the tree. An entry that cannot be read is logged and not counted. Blocks while it
/// walks.
pub(super) fn count_kept_folders(root: &Path, coverage: &TreeCoverage) -> u64 {
    let walk_root = root.to_path_buf();
    let entry_coverage = coverage.clone();
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .follow_links(false)
        .filter_entry(move |entry| match entry.path().strip_prefix(&walk_root) {
            Ok(relative_path) => entry_coverage.keeps(relative_path),
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
