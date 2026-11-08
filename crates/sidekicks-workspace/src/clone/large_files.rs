//! Git LFS for a clone: whether it is installed, the filter settings a clone runs with so large
//! files arrive whole without the person's global git config being written, the clone's
//! repositories (the top one and its checked-out submodules), and whether any of them keeps files
//! in it.

use std::io;
use std::path::{Path, PathBuf};

use memchr::memmem;
use sidekicks_contracts::place::Place;
use sidekicks_platforms::path_from_program_output;
use sidekicks_std::file::real_location::resolve_real_path;
use sidekicks_std::missing_entry::{MissingEntry, is_missing_entry};

use crate::git::index_objects::{IndexObjectsError, list_stage_entries, read_stage_entry};
use crate::git::process::{GitCall, GitError, GitRunner, background_read};
use crate::git::{GIT_ENTRY_NAME, GITLINK_MODE};

/// The four filter settings `git lfs install` writes, exactly as Git LFS writes them, passed to
/// the clone as `-c` options so its checkout fetches large files; the clone's own config gets them
/// from `git lfs install --local` afterwards.
pub(crate) const LARGE_FILES_CLONE_OPTIONS: [&str; 8] = [
    "-c",
    "filter.lfs.required=true",
    "-c",
    "filter.lfs.clean=git-lfs clean -- %f",
    "-c",
    "filter.lfs.smudge=git-lfs smudge -- %f",
    "-c",
    "filter.lfs.process=git-lfs filter-process",
];

// The `.gitattributes` setting that sends files through Git LFS.
const LARGE_FILES_ATTRIBUTE: &[u8] = b"filter=lfs";

/// Why the clone's repositories, or a repository's large-file attributes, could not be read.
#[derive(Debug, thiserror::Error)]
pub enum LargeFilesReadError {
    /// git could not list a repository's index.
    #[error("git could not list a cloned repository's submodules")]
    Index(#[from] IndexObjectsError),
    /// git printed a path this system cannot name.
    #[error("git named a cloned repository's submodule by a path this system cannot name")]
    Git(#[from] GitError),
    /// A repository's folder, a submodule's folder or a `.gitattributes` file could not be read.
    #[error("a cloned repository's files could not be read")]
    File(#[from] io::Error),
}

/// Whether Git LFS is installed for the git a project at `place` runs: `git lfs version` exits 0.
/// A git that exits with any failure means no; fails with the run's error when git did not run to
/// an exit code (not found, not started, timed out, ended by a signal).
pub(crate) async fn is_large_files_installed(
    git: &GitRunner,
    place: Option<&Place>,
) -> Result<bool, GitError> {
    match git.run(place, GitCall::read(["lfs", "version"])).await {
        Ok(_) => Ok(true),
        Err(refused) if refused.exit_code().is_some() => Ok(false),
        Err(failure) => Err(failure),
    }
}

/// Whether the clone at `root` keeps files in Git LFS: any of its repositories (see
/// [`clone_repositories`]) names the filter in its top `.gitattributes`, read as bytes, so a name
/// that is not UTF-8 does not fail the read. A missing file means no; fails as the listing does,
/// and with any other read's error.
pub(crate) async fn keeps_large_files(
    git: &GitRunner,
    place: Option<&Place>,
    root: &Path,
) -> Result<bool, LargeFilesReadError> {
    for repository in clone_repositories(git, place, root).await? {
        let attributes = tokio::fs::read(repository.join(".gitattributes"))
            .await
            .none_if_missing()?;
        if attributes.is_some_and(|attributes| names_large_files_filter(&attributes)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The clone's repositories, each link resolved: the top one at `root` first, then each submodule
/// its index records (mode 160000) that is checked out and lies inside it, each followed by its own
/// submodules. `.gitmodules` is never read, so a path it names outside the clone is never listed.
/// Fails with git's error when an index cannot be listed, and the file error when a folder cannot
/// be resolved or looked at.
pub(crate) async fn clone_repositories(
    git: &GitRunner,
    place: Option<&Place>,
    root: &Path,
) -> Result<Vec<PathBuf>, LargeFilesReadError> {
    let mut repositories = Vec::new();
    // Taken from the end, with each repository's submodules pushed in reverse, so the listing
    // runs depth first in the index's order.
    let mut waiting = vec![resolve_real_path(root).await?];
    while let Some(repository) = waiting.pop() {
        let submodules = checked_out_submodules(git, place, &repository).await?;
        repositories.push(repository);
        waiting.extend(submodules.into_iter().rev());
    }
    Ok(repositories)
}

// The submodules the index of `repository` (resolved) records, in its order, each resolved and
// kept only when it lies inside `repository` and is checked out. The index is listed entry by
// entry, only its gitlinks kept, since a large one lists past what one read of git may hold, and
// never fetches an object a partial clone lacks.
async fn checked_out_submodules(
    git: &GitRunner,
    place: Option<&Place>,
    repository: &Path,
) -> Result<Vec<PathBuf>, LargeFilesReadError> {
    let mut gitlink_paths = Vec::new();
    list_stage_entries(
        git,
        place,
        background_read(repository, &[]),
        &[],
        None,
        |entry| gitlink_paths.extend(gitlink_path(entry).map(<[u8]>::to_vec)),
    )
    .await?;
    let mut submodules = Vec::new();
    for path in gitlink_paths {
        let path = path_from_program_output(path).map_err(GitError::PathText)?;
        let folder = match resolve_real_path(&repository.join(path)).await {
            Ok(folder) => folder,
            Err(error) if is_missing_entry(&error) => continue,
            Err(error) => return Err(error.into()),
        };
        // Strictly inside, so the walk ends; kept once, though a conflicted entry has a line per
        // stage.
        let is_inside = folder.starts_with(repository) && folder != repository;
        if is_inside && !submodules.contains(&folder) && is_checked_out(&folder).await? {
            submodules.push(folder);
        }
    }
    Ok(submodules)
}

// The path of one `ls-files --stage` entry when its mode records a submodule.
fn gitlink_path(entry: &[u8]) -> Option<&[u8]> {
    read_stage_entry(entry)
        .filter(|entry| entry.mode == GITLINK_MODE)
        .map(|entry| entry.path)
}

// Whether `folder` has its `.git` entry, which git writes when it checks a submodule out; a
// dangling `.git` link counts as none, as it does for git.
async fn is_checked_out(folder: &Path) -> io::Result<bool> {
    match tokio::fs::metadata(folder.join(GIT_ENTRY_NAME)).await {
        Ok(_) => Ok(true),
        Err(error) if is_missing_entry(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

// Whether `attributes` holds `filter=lfs` as a whole word, a byte that is no ASCII letter, digit
// or underscore (or the text's end) on each side, as a regular expression's `\b` reads it.
fn names_large_files_filter(attributes: &[u8]) -> bool {
    let is_word_byte = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'_';
    memmem::find_iter(attributes, LARGE_FILES_ATTRIBUTE).any(|start| {
        let before = start
            .checked_sub(1)
            .and_then(|before| attributes.get(before));
        let after = attributes.get(start + LARGE_FILES_ATTRIBUTE.len());
        !before.is_some_and(is_word_byte) && !after.is_some_and(is_word_byte)
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::Path;

    use sidekicks_platforms::real_path;

    use super::{checked_out_submodules, clone_repositories, keeps_large_files};
    use crate::git::process::{
        GIT_OUTPUT_MAX_BYTES, GitCall, GitRunner, in_folder, strip_line_end, test_git_runner,
        write_link,
    };

    // The test's own identity and the local submodule clone, never the person's config.
    const SETTINGS: [&str; 8] = [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "protocol.file.allow=always",
    ];

    const LARGE_FILES_ATTRIBUTES: &str = "*.bin filter=lfs diff=lfs merge=lfs -text\n";

    // Runs git in `folder` with the test's settings, as a read so none of the person's hooks run.
    async fn run_in(git: &GitRunner, folder: &Path, arguments: &[&str]) -> Vec<u8> {
        let arguments = SETTINGS
            .iter()
            .map(OsString::from)
            .chain(in_folder(folder, arguments));
        git.run(None, GitCall::read(arguments))
            .await
            .expect("the repository is set up")
            .stdout
    }

    async fn make_repository(git: &GitRunner, folder: &Path, attributes: &str) {
        tokio::fs::create_dir_all(folder)
            .await
            .expect("the folder is made");
        run_in(git, folder, &["init"]).await;
        tokio::fs::write(folder.join(".gitattributes"), attributes)
            .await
            .expect("the attributes are written");
    }

    // Catches the inside check dropped (the `escape` gitlink links to `neighbor`), `.gitmodules`
    // read in place of the index (it names `../neighbor` and the untracked `vendored`), and the
    // submodule's attributes skipped (the top repository names no large files).
    #[tokio::test]
    async fn a_clone_lists_its_checked_out_submodules_inside_it_and_reads_their_attributes() {
        let git = test_git_runner();
        let temporary = tempfile::tempdir().expect("the temporary folder is made");
        let outer = real_path(temporary.path()).expect("the temporary folder resolves");
        let top = outer.join("top");
        let source = outer.join("source");
        let neighbor = outer.join("neighbor");

        make_repository(&git, &neighbor, LARGE_FILES_ATTRIBUTES).await;
        make_repository(&git, &source, LARGE_FILES_ATTRIBUTES).await;
        run_in(&git, &source, &["add", ".gitattributes"]).await;
        run_in(&git, &source, &["commit", "-m", "first"]).await;
        make_repository(&git, &top, "*.txt text\n").await;
        let source_text = source.to_str().expect("the temporary path is Unicode");
        run_in(&git, &top, &["submodule", "add", source_text, "lib/sub"]).await;
        make_repository(&git, &top.join("vendored"), LARGE_FILES_ATTRIBUTES).await;
        let commit = strip_line_end(run_in(&git, &source, &["rev-parse", "HEAD"]).await);
        let commit = String::from_utf8(commit).expect("an id is ASCII");
        let gitlink = format!("160000,{commit},escape");
        run_in(
            &git,
            &top,
            &["update-index", "--add", "--cacheinfo", &gitlink],
        )
        .await;
        write_link(&git, &outer.join("scratch"), &top, "escape", "../neighbor").await;
        let mut gitmodules = tokio::fs::read_to_string(top.join(".gitmodules"))
            .await
            .expect("the submodule list is read");
        gitmodules.push_str(
            "[submodule \"neighbor\"]\n\tpath = ../neighbor\n\turl = ../neighbor\n\
             [submodule \"vendored\"]\n\tpath = vendored\n\turl = ./vendored\n",
        );
        tokio::fs::write(top.join(".gitmodules"), gitmodules)
            .await
            .expect("the submodule list is written");

        let repositories = clone_repositories(&git, None, &top)
            .await
            .expect("the clone's repositories are listed");
        assert_eq!(repositories, [top.clone(), top.join("lib").join("sub")]);
        assert!(
            keeps_large_files(&git, None, &top)
                .await
                .expect("the attributes are read")
        );
    }

    // The packs in the git folder of `repository`.
    fn pack_count(repository: &Path) -> usize {
        std::fs::read_dir(repository.join(".git/objects/pack"))
            .expect("the pack folder is listed")
            .filter(|entry| {
                entry
                    .as_ref()
                    .expect("the entry reads")
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "pack")
            })
            .count()
    }

    // A partial clone holding no tree, its index sparse with `outside/` one folder entry, lists the
    // gitlink inside its cone and fetches nothing from its promisor remote. Killed by `--sparse`
    // dropped (git expands the index and fetches `outside`'s tree, or fails without the fetch),
    // and, on a git before 2.35, by the fetch guard dropped (the tree is fetched).
    #[tokio::test]
    async fn a_sparse_partial_clone_lists_its_submodules_without_fetching() {
        let git = test_git_runner();
        let temporary = tempfile::tempdir().expect("the temporary folder is made");
        let outer = real_path(temporary.path()).expect("the temporary folder resolves");
        let source = outer.join("source");
        let clone = outer.join("clone");
        make_repository(&git, &source, "").await;
        for (path, text) in [
            ("inside/kept.txt", "kept\n"),
            ("outside/away.txt", "away\n"),
        ] {
            let file = source.join(path);
            tokio::fs::create_dir_all(file.parent().expect("a file has a folder"))
                .await
                .expect("the folder is made");
            tokio::fs::write(&file, text)
                .await
                .expect("the file is written");
        }
        run_in(&git, &source, &["add", "."]).await;
        run_in(&git, &source, &["commit", "-m", "first"]).await;
        let commit = strip_line_end(run_in(&git, &source, &["rev-parse", "HEAD"]).await);
        let commit = String::from_utf8(commit).expect("an id is ASCII");
        let gitlink = format!("160000,{commit},inside/sub");
        run_in(
            &git,
            &source,
            &["update-index", "--add", "--cacheinfo", &gitlink],
        )
        .await;
        run_in(&git, &source, &["commit", "-m", "sub"]).await;
        run_in(&git, &source, &["config", "uploadpack.allowFilter", "true"]).await;
        run_in(
            &git,
            &source,
            &[
                "sparse-checkout",
                "set",
                "--cone",
                "--sparse-index",
                "inside",
            ],
        )
        .await;
        let source_url = format!(
            "file://{}",
            source.to_str().expect("the temporary path is Unicode")
        );
        let clone_text = clone.to_str().expect("the temporary path is Unicode");
        run_in(
            &git,
            &outer,
            &[
                "clone",
                "--quiet",
                "--no-checkout",
                "--filter=tree:0",
                &source_url,
                clone_text,
            ],
        )
        .await;
        // The source's sparse index, whose `outside/` entry names a tree the clone lacks.
        tokio::fs::copy(source.join(".git/index"), clone.join(".git/index"))
            .await
            .expect("the index is copied");
        tokio::fs::copy(
            source.join(".git/info/sparse-checkout"),
            clone.join(".git/info/sparse-checkout"),
        )
        .await
        .expect("the sparse patterns are copied");
        for [key, value] in [
            ["core.sparseCheckout", "true"],
            ["core.sparseCheckoutCone", "true"],
            ["index.sparse", "true"],
        ] {
            run_in(&git, &clone, &["config", key, value]).await;
        }
        tokio::fs::create_dir_all(clone.join("inside/sub"))
            .await
            .expect("the submodule's folder is made");
        tokio::fs::write(
            clone.join("inside/sub/.git"),
            "gitdir: ../../.git/modules/sub\n",
        )
        .await
        .expect("the submodule's entry is written");
        let packs = pack_count(&clone);

        let submodules = checked_out_submodules(&git, None, &clone)
            .await
            .expect("the clone's submodules are listed");

        assert_eq!(submodules, [clone.join("inside").join("sub")]);
        assert_eq!(pack_count(&clone), packs);
    }

    // An index whose listing passes what one git read may hold still lists the submodule recorded
    // after it. Killed by the listing read whole under the output bound: the read fails, or a cut
    // listing loses the submodule at its end.
    #[tokio::test]
    async fn an_index_listed_past_the_output_bound_lists_every_submodule() {
        let git = test_git_runner();
        let temporary = tempfile::tempdir().expect("the temporary folder is made");
        let outer = real_path(temporary.path()).expect("the temporary folder resolves");
        let top = outer.join("top");
        let source = outer.join("source");
        make_repository(&git, &source, "").await;
        run_in(&git, &source, &["add", ".gitattributes"]).await;
        run_in(&git, &source, &["commit", "-m", "first"]).await;
        make_repository(&git, &top, "").await;
        let source_text = source.to_str().expect("the temporary path is Unicode");
        // Sorted after every file below, so a listing cut at the bound loses it.
        run_in(&git, &top, &["submodule", "add", source_text, "zz/sub"]).await;
        let blob =
            strip_line_end(run_in(&git, &top, &["hash-object", "-w", ".gitattributes"]).await);
        let blob = String::from_utf8(blob).expect("an id is ASCII");
        let folder = vec!["a".repeat(200); 4].join("/");
        let entry_bytes = format!("100644 {blob} 0\tfiles/{folder}/00000000\0").len();
        let mut index_info = Vec::new();
        for ordinal in 0..=GIT_OUTPUT_MAX_BYTES / entry_bytes {
            index_info.extend(format!("100644 {blob}\tfiles/{folder}/{ordinal:08}\n").into_bytes());
        }
        let arguments = SETTINGS
            .iter()
            .map(OsString::from)
            .chain(in_folder(&top, &["update-index", "--index-info"]));
        git.run(None, GitCall::read(arguments).with_input(index_info))
            .await
            .expect("the files are staged");

        let repositories = clone_repositories(&git, None, &top)
            .await
            .expect("the clone's repositories are listed");

        assert_eq!(repositories, [top.clone(), top.join("zz").join("sub")]);
    }
}
