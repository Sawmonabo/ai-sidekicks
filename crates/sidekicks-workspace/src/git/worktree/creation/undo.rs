//! The undo of a tree a creation made and no row records: its folder, its record in the
//! repository's git folder and the branch the creation made.

use std::error::Error;
use std::ffi::OsString;
use std::path::Path;

use sidekicks_contracts::place::Place;

use crate::git::process::{GitCall, GitRunner, in_folder, read_git_common_folder};
use crate::git::worktree::naming::WorktreeName;
use crate::git::worktree::reads::has_branch;
use crate::git::worktree::rows::AttachedMountRow;
use crate::git::worktree::tree_records::{has_record_naming, remove_records_naming};

/// Undoes a tree git made that no row records: its folder and record, then the branch this call
/// made, which nothing else names. Each step runs only while what it removes is there, and the
/// branch only when `is_branch_new`; a record git left locked is removed too, since the tree is
/// this call's own. A folder `worktree remove` refuses goes only while a record of the repository
/// names it, so a folder that appeared at the name after git refused the add stays. Answers each
/// step's failure for the caller to carry.
pub(super) async fn undo_unrecorded_tree(
    git: &GitRunner,
    mount: &AttachedMountRow,
    name: &WorktreeName,
    is_branch_new: bool,
) -> Vec<Box<dyn Error + Send + Sync>> {
    let mut failures: Vec<Box<dyn Error + Send + Sync>> = Vec::new();
    let place = mount.place.as_ref();
    let repository = Path::new(mount.canonical_root.as_str());
    match tokio::fs::try_exists(&name.folder_path).await {
        Ok(true) => {
            // Forced twice: once past the tree's changes, once past the lock a git ended before it
            // finished leaves on the record.
            let mut arguments =
                in_folder(repository, &["worktree", "remove", "--force", "--force"]);
            arguments.push(OsString::from(name.folder_path.as_os_str()));
            if let Err(remove_failure) = git.run(place, GitCall::write(arguments)).await {
                // A tree git left without its `.git` names no record git can find, so its folder
                // goes and the records naming it are found by their `gitdir`. git writes the record
                // before the folder, so a folder no record names is not this call's.
                match remove_tree_without_git(git, place, repository, &name.folder_path).await {
                    Ok(true) => {}
                    Ok(false) => failures.push(remove_failure.into()),
                    Err(fallback_failures) => {
                        failures.push(remove_failure.into());
                        failures.extend(fallback_failures);
                    }
                }
            }
        }
        Ok(false) => {}
        Err(read_failure) => failures.push(read_failure.into()),
    }
    if is_branch_new {
        failures.extend(delete_new_branch(git, place, repository, &name.branch_name).await);
    }
    failures
}

/// Deletes `branch_name`, which this call made and nothing else names, while it is there. Answers
/// the read's or the deletion's failure for the caller to carry.
pub(super) async fn delete_new_branch(
    git: &GitRunner,
    place: Option<&Place>,
    repository: &Path,
    branch_name: &str,
) -> Vec<Box<dyn Error + Send + Sync>> {
    match has_branch(git, place, repository, branch_name).await {
        Ok(true) => {
            let delete_branch =
                GitCall::write(in_folder(repository, &["branch", "-D", branch_name]));
            match git.run(place, delete_branch).await {
                Ok(_) => Vec::new(),
                Err(branch_failure) => vec![branch_failure.into()],
            }
        }
        Ok(false) => Vec::new(),
        Err(read_failure) => vec![read_failure.into()],
    }
}

// Removes the tree at `folder`, then every record of the repository at `repository` naming it,
// while one does: answers `false`, removing nothing, when none names it. Fails with each step's
// failure.
pub(super) async fn remove_tree_without_git(
    git: &GitRunner,
    place: Option<&Place>,
    repository: &Path,
    folder: &Path,
) -> Result<bool, Vec<Box<dyn Error + Send + Sync>>> {
    let common_folder = read_git_common_folder(git, place, repository, None)
        .await
        .map_err(|read_failure| vec![read_failure.into()])?;
    if !has_record_naming(&common_folder, folder)
        .await
        .map_err(|read_failure| vec![read_failure.into()])?
    {
        return Ok(false);
    }
    sidekicks_std::file::remove_tree_awaited(folder)
        .await
        .map_err(|folder_failure| vec![folder_failure.into()])?;
    let record_failures = remove_records_naming(&common_folder, folder).await;
    if record_failures.is_empty() {
        Ok(true)
    } else {
        Err(record_failures.into_iter().map(Into::into).collect())
    }
}
