//! The key `.claude.json` files a project's entry under in its `projects` map, found as Claude Code
//! finds it: the root with every link resolved, then the root of the repository it sits in, the
//! main checkout's for a linked worktree.

use std::fs;
use std::path::{Path, PathBuf};

use sidekicks_platforms::{real_path, resolve_path_against};
use sidekicks_std::file::bounded_read::read_within_ceiling;
use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_workspace::git::GIT_ENTRY_NAME;

use crate::driver::claude::session::settings_file::ClaudeSettingsReadError;

// The start of a linked worktree's `.git` file, before the path of its own git folder.
const GIT_FOLDER_LINE_PREFIX: &str = "gitdir:";
// The file in a worktree's git folder naming the repository's common git folder.
const COMMON_FOLDER_FILE: &str = "commondir";
// The file in a worktree's git folder naming the worktree's `.git` file back.
const WORKTREE_LINK_FILE: &str = "gitdir";
// The folder of the common git folder holding each linked worktree's git folder.
const WORKTREES_FOLDER: &str = "worktrees";

/// The key `.claude.json` files the project rooted at `root` under: the root with every link
/// resolved, the names below its deepest existing folder kept as written, then the nearest folder
/// at or above it holding a `.git` entry, which for a linked worktree whose git folder names it
/// back is the main checkout's root. Fails as the resolve does, or when the walk gives no answer
/// within the bounded read's ceiling.
pub(crate) async fn resolve_claude_config_project_key(
    root: &str,
) -> Result<String, ClaudeSettingsReadError> {
    let root = Path::new(root);
    let failed = |failure| ClaudeSettingsReadError {
        path: root.to_path_buf(),
        failure,
    };
    let resolved = resolve_real_location(root).await.map_err(failed)?;
    let key = read_within_ceiling(&resolved, |folder| Ok(find_project_folder(folder)))
        .await
        .map_err(failed)?;
    Ok(key.to_string_lossy().into_owned())
}

// The folder Claude Code files `folder`'s project under: the root of the repository it sits in,
// the main checkout's for a linked worktree, else `folder` itself. A `.git` entry that cannot be
// read is passed over, as Claude Code passes it over.
fn find_project_folder(folder: &Path) -> PathBuf {
    let Some(repository_root) = folder.ancestors().find(|ancestor| {
        fs::metadata(ancestor.join(GIT_ENTRY_NAME))
            .is_ok_and(|entry| entry.is_dir() || entry.is_file())
    }) else {
        return folder.to_path_buf();
    };
    find_main_checkout(repository_root).unwrap_or_else(|| repository_root.to_path_buf())
}

// The main checkout of the linked worktree rooted at `worktree_root`: the worktree's `.git` file
// names its git folder, whose `commondir` names the repository's common git folder, which must
// hold it under `worktrees/`, and whose `gitdir` names the worktree's `.git` file back. Each path
// is joined and folded as written, as Claude Code joins it. `None` where any of them is missing or
// does not agree, as for a checkout of its own or a submodule. The main checkout is the common
// folder's parent where the common folder is a `.git` folder, else the common folder itself.
fn find_main_checkout(worktree_root: &Path) -> Option<PathBuf> {
    let read_line = |file: &Path| Some(fs::read_to_string(file).ok()?.trim().to_owned());
    let git_line = read_line(&worktree_root.join(GIT_ENTRY_NAME))?;
    let git_folder = resolve_path_against(
        worktree_root.to_str()?,
        git_line.strip_prefix(GIT_FOLDER_LINE_PREFIX)?.trim(),
    )
    .ok()?;
    let git_folder = Path::new(&git_folder);
    let common_line = read_line(&git_folder.join(COMMON_FOLDER_FILE))?;
    let common_folder =
        PathBuf::from(resolve_path_against(git_folder.to_str()?, &common_line).ok()?);
    if git_folder.parent()? != common_folder.join(WORKTREES_FOLDER) {
        return None;
    }
    let link_line = read_line(&git_folder.join(WORKTREE_LINK_FILE))?;
    let linked_back = resolve_path_against(git_folder.to_str()?, &link_line).ok()?;
    if real_path(Path::new(&linked_back)).ok()? != worktree_root.join(GIT_ENTRY_NAME) {
        return None;
    }
    if common_folder.file_name()? == GIT_ENTRY_NAME {
        common_folder.parent().map(Path::to_path_buf)
    } else {
        Some(common_folder)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_platforms::real_path;

    use super::resolve_claude_config_project_key;

    // The shape of the folder a project is attached at.
    #[derive(Debug)]
    enum AttachedFolder {
        // A folder in no repository.
        Plain,
        // A folder inside a repository's own checkout.
        RepositorySubfolder,
        // A folder inside a linked worktree of a repository.
        WorktreeSubfolder,
        // A checkout whose `.git` file names a git folder with no `commondir`, as a submodule's
        // does.
        SubmoduleCheckout,
    }

    fn write(file: &Path, text: &str) {
        fs::create_dir_all(file.parent().expect("a file sits in a folder")).expect("folder made");
        fs::write(file, text).expect("file written");
    }

    // Lays out `folder`'s shape under `scratch` and answers the folder attached and the key
    // Claude Code files it under.
    fn lay_out(scratch: &Path, folder: &AttachedFolder) -> (PathBuf, PathBuf) {
        let main = scratch.join("main");
        fs::create_dir_all(main.join(".git").join("objects")).expect("git folder made");
        match folder {
            AttachedFolder::Plain => {
                let plain = scratch.join("plain").join("app");
                fs::create_dir_all(&plain).expect("folder made");
                (plain.clone(), plain)
            }
            AttachedFolder::RepositorySubfolder => {
                let package = main.join("packages").join("app");
                fs::create_dir_all(&package).expect("folder made");
                (package, main)
            }
            AttachedFolder::WorktreeSubfolder => {
                let worktree = scratch.join("worktree");
                let git_folder = main.join(".git").join("worktrees").join("worktree");
                write(&git_folder.join("commondir"), "../..\n");
                write(
                    &git_folder.join("gitdir"),
                    &format!("{}\n", worktree.join(".git").display()),
                );
                write(
                    &worktree.join(".git"),
                    &format!("gitdir: {}\n", git_folder.display()),
                );
                let package = worktree.join("packages").join("app");
                fs::create_dir_all(&package).expect("folder made");
                (package, main)
            }
            AttachedFolder::SubmoduleCheckout => {
                let submodule = main.join("vendor").join("lib");
                let git_folder = main.join(".git").join("modules").join("lib");
                fs::create_dir_all(&git_folder).expect("git folder made");
                write(&submodule.join(".git"), "gitdir: ../../.git/modules/lib\n");
                (submodule.clone(), submodule)
            }
        }
    }

    // The daemon writes and reads a `local` server under this key in the person's own config, so
    // a wrong key adds an entry Claude Code never loads and misses the person's own.
    #[rstest]
    #[case::plain(AttachedFolder::Plain)]
    #[case::repository_subfolder(AttachedFolder::RepositorySubfolder)]
    #[case::worktree_subfolder(AttachedFolder::WorktreeSubfolder)]
    #[case::submodule_checkout(AttachedFolder::SubmoduleCheckout)]
    #[tokio::test]
    async fn a_project_is_keyed_by_the_folder_claude_code_files_it_under(
        #[case] folder: AttachedFolder,
    ) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let scratch = real_path(scratch.path()).expect("the scratch folder resolves");
        let (attached, expected) = lay_out(&scratch, &folder);

        let key = resolve_claude_config_project_key(attached.to_str().expect("UTF-8"))
            .await
            .expect("the key resolves");

        assert_eq!(Path::new(&key), expected, "{folder:?}");
    }
}
