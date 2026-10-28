//! Git's record of a kept tree, which a crash or a failed removal can leave behind in the
//! repository. It is found again by the folder git named at the discard, and removed only while it
//! is still the kept copy's own. It is renamed aside first and judged again, so a record a put-back
//! or a live tree took under that name since goes back, never away, and a removal a crash cut short
//! is finished at the record's next look. A record goes back under its name only while that name is
//! free. When another record has taken it for the same tree, the one aside is a duplicate git would
//! still list, holding its branch, so it is removed; one for another tree stays there, and the
//! service log says so.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_contracts::place::Place;
use sidekicks_platforms::CAN_RENAME_REPLACE_EMPTY_FOLDER;
use sidekicks_std::cleanup_failures::CleanupFailures;

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::GitRunner;
use crate::git::worktree::claims::{KeptCopyClaims, KeptCopyClaimsReadError};
use crate::git::worktree::folder_names::read_folder_names;
use crate::git::worktree::kept_copy::KEPT_REF_STORE_ENTRY;
use crate::git::worktree::kept_copy::folder_move::{
    LeftoverKind, LeftoverNamesInUse, is_leftover_name, leftover_name, rename_folder,
};
use crate::git::worktree::kept_copy::saved_state::{RepositoryStoreSettings, SavedStateError};
use crate::git::worktree::reads::{
    GIT_FILE_NAME, RECORD_GITDIR_FILE_NAME, common_folder_of_record, read_record_git_file,
    read_record_named_by,
};
use crate::git::worktree::service::remove_folder;

/// What a stale record's removal reads before it removes anything: what live trees and put-backs
/// hold, and the leftover names in use.
#[derive(Clone, Copy)]
pub(crate) struct StaleRecordTools<'a> {
    /// What live trees and put-backs hold, read when asked.
    pub(crate) claims: &'a KeptCopyClaims,
    /// The leftover names in use, which a record set aside holds.
    pub(crate) leftover_names: &'a Arc<LeftoverNamesInUse>,
}

/// Why a stale record's removal stopped; what it set aside stays for the next look.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StaleRecordError {
    /// What live trees and put-backs hold could not be read.
    #[error(transparent)]
    Claims(#[from] KeptCopyClaimsReadError),
    /// A file or folder of the record could not be read, renamed or removed.
    #[error("{} could not be read, renamed or removed", path.display())]
    File {
        /// The entry.
        path: PathBuf,
        /// The failure.
        #[source]
        source: io::Error,
    },
    /// A path could not be resolved to compare it, or is no text the resolution reads.
    #[error("a record's path could not be resolved to compare it")]
    Resolve(#[source] io::Error),
    /// The system gave no random bytes for the record's name aside.
    #[error("the record's name aside could not be made")]
    LeftoverName(#[source] getrandom::Error),
    /// The repository's refs payload could not be read to remove the tree's refs there.
    #[error("the repository's refs payload could not be read")]
    RefStore(#[source] SavedStateError),
    /// The record set aside could not take its name back, and the empty folder that held the name
    /// could not be removed either.
    #[error(transparent)]
    TakeName(#[from] CleanupFailures<io::Error>),
}

fn at(path: &Path) -> impl FnOnce(io::Error) -> StaleRecordError {
    let path = path.to_path_buf();
    move |source| StaleRecordError::File { path, source }
}

/// Removes `record_folder`, git's record of the kept tree as named at the discard, only while it
/// is the copy's own: it names `<original_path>/.git`, where no live row or `.git` claims it, and
/// no put-back is making it, so another tree's record is never reached. First finishes this
/// record's removals a crash cut short. Answers whether it is gone. Fails as a read, a rename or a
/// removal does, a claim's read among them.
pub(crate) async fn remove_stale_tree_record(
    tools: StaleRecordTools<'_>,
    record_folder: &Path,
    original_path: &Path,
) -> Result<bool, StaleRecordError> {
    finish_record_removals_cut_short(tools, record_folder).await?;
    let Some(judged_git_file) =
        read_own_stale_record_git_file(tools, record_folder, original_path).await?
    else {
        return Ok(false);
    };
    let removing_folder = leftover_name(record_folder, LeftoverKind::Removing)
        .map_err(StaleRecordError::LeftoverName)?;
    let _removing_name = tools.leftover_names.hold(&removing_folder);
    match rename_folder(record_folder, &removing_folder).await {
        Ok(()) => {}
        // Another removal of the same record took it first.
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(failure) => return Err(at(record_folder)(failure)),
    }
    // Judged again once renamed: a record a put-back or a live tree took since goes back.
    let is_claimed_since = read_named_git_file(&removing_folder).await?.as_ref()
        != Some(&judged_git_file)
        || tools.claims.is_live_tree_at(original_path).await?
        || is_record_being_restored(tools, record_folder).await?;
    if is_claimed_since {
        put_record_back(&removing_folder, record_folder).await?;
        return Ok(false);
    }
    remove_folder(&removing_folder)
        .await
        .map_err(at(&removing_folder))?;
    Ok(true)
}

/// Removes the kept copy's stale record as [`remove_stale_tree_record`] does, then, once it is
/// gone and the copy in `kept_folder` kept refs from a refs payload, the tree's refs folder there,
/// so no later record of that name finds them. Answers whether the record is gone. Fails as the
/// record's removal, the payload's read or the folder's removal does.
pub(crate) async fn remove_stale_record_and_refs(
    tools: StaleRecordTools<'_>,
    git: &GitRunner,
    place: Option<&Place>,
    kept_folder: &Path,
    record_folder: &Path,
    original_path: &Path,
) -> Result<bool, StaleRecordError> {
    let is_removed = remove_stale_tree_record(tools, record_folder, original_path).await?;
    let kept_ref_store = kept_folder.join(KEPT_REF_STORE_ENTRY);
    let has_kept_refs = tokio::fs::try_exists(&kept_ref_store)
        .await
        .map_err(at(&kept_ref_store))?;
    let (true, true, Some(common_folder), Some(record_name)) = (
        is_removed,
        has_kept_refs,
        common_folder_of_record(record_folder),
        record_folder.file_name().and_then(OsStr::to_str),
    ) else {
        return Ok(is_removed);
    };
    let settings = RepositoryStoreSettings::read(git, place, common_folder)
        .await
        .map_err(StaleRecordError::RefStore)?;
    if let Some(payload) = settings.ref_store_payload(common_folder) {
        let refs_folder = payload.tree_refs_folder(record_name);
        remove_folder(&refs_folder)
            .await
            .map_err(at(&refs_folder))?;
    }
    Ok(true)
}

// The `.git` the record names when the record is the kept copy's own and stale, as
// `remove_stale_tree_record` describes; `None` otherwise.
async fn read_own_stale_record_git_file(
    tools: StaleRecordTools<'_>,
    record_folder: &Path,
    original_path: &Path,
) -> Result<Option<PathBuf>, StaleRecordError> {
    let Some(git_file) = read_named_git_file(record_folder).await? else {
        return Ok(None);
    };
    let is_named_git_file = git_file
        .file_name()
        .is_some_and(|name| name == GIT_FILE_NAME);
    if !is_named_git_file || tools.claims.is_live_tree_at(original_path).await? {
        return Ok(None);
    }
    let named_tree = git_file.parent().unwrap_or(&git_file);
    // Both sides resolved, since git writes `gitdir` from the real path while a row may keep
    // another spelling of the same folder.
    let is_own_tree = canonical(named_tree).await? == canonical(original_path).await?;
    if !is_own_tree
        || is_record_being_restored(tools, record_folder).await?
        || is_record_named_by(&git_file, record_folder).await?
    {
        return Ok(None);
    }
    Ok(Some(git_file))
}

// Whether a put-back's mark names the record, which that put-back is making.
async fn is_record_being_restored(
    tools: StaleRecordTools<'_>,
    record_folder: &Path,
) -> Result<bool, StaleRecordError> {
    let record_key = canonical(record_folder).await?;
    for restoring in tools.claims.restoring_records().await? {
        if canonical(&restoring).await? == record_key {
            return Ok(true);
        }
    }
    Ok(false)
}

// Finishes each removal of the record at `record_folder` a crash cut short, left under the record's
// name with `.removing-<suffix>` added: one whose tree's `.git` names the record goes back under
// the record's name, since that tree lives on it, and any other is removed.
async fn finish_record_removals_cut_short(
    tools: StaleRecordTools<'_>,
    record_folder: &Path,
) -> Result<(), StaleRecordError> {
    let (Some(records_folder), Some(record_name)) = (
        record_folder.parent(),
        record_folder.file_name().and_then(|name| name.to_str()),
    ) else {
        return Ok(());
    };
    let leftovers: Vec<PathBuf> = read_folder_names(records_folder)
        .await
        .map_err(at(records_folder))?
        .into_iter()
        .filter(|name| is_leftover_name(name, Some(record_name), LeftoverKind::Removing))
        .map(|name| records_folder.join(name))
        .filter(|leftover| !tools.leftover_names.is_in_use(leftover))
        .collect();
    for leftover in leftovers {
        let is_tree_live = match read_named_git_file(&leftover).await? {
            Some(git_file) => is_record_named_by(&git_file, record_folder).await?,
            None => false,
        };
        if is_tree_live {
            put_record_back(&leftover, record_folder).await?;
        } else {
            remove_folder(&leftover).await.map_err(at(&leftover))?;
        }
    }
    Ok(())
}

// Puts a record set aside back under its name while the name is free. A name another record has
// taken is left to it, since the live tree reads that one: the record aside is removed when the
// taken one names the same `.git`, and otherwise stays where it is.
async fn put_record_back(
    aside_folder: &Path,
    record_folder: &Path,
) -> Result<(), StaleRecordError> {
    if take_record_name(aside_folder, record_folder).await? {
        return Ok(());
    }
    let aside_git_file = read_named_git_file(aside_folder).await?;
    let taken_git_file = read_named_git_file(record_folder).await?;
    if is_same_git_file(aside_git_file.as_deref(), taken_git_file.as_deref()).await? {
        remove_folder(aside_folder)
            .await
            .map_err(at(aside_folder))?;
        return Ok(());
    }
    tracing::warn!(
        record = %record_folder.display(),
        aside = %aside_folder.display(),
        "Git's record of a kept worktree was taken again while an earlier copy of it was set \
         aside, so that copy is left where it is"
    );
    Ok(())
}

// Moves the record set aside to `record_folder` while that name is free, answering whether it did.
// Where a rename replaces an empty folder, the name is taken by making that folder first, so a
// put-back's making of it fails and takes the next number, and the rename then replaces the empty
// folder; where the system refuses to rename a folder onto one that exists, the rename alone takes
// it.
async fn take_record_name(
    aside_folder: &Path,
    record_folder: &Path,
) -> Result<bool, StaleRecordError> {
    if !CAN_RENAME_REPLACE_EMPTY_FOLDER {
        return match rename_folder(aside_folder, record_folder).await {
            Ok(()) => Ok(true),
            Err(failure) => {
                if tokio::fs::try_exists(record_folder)
                    .await
                    .map_err(at(record_folder))?
                {
                    Ok(false)
                } else {
                    Err(at(aside_folder)(failure))
                }
            }
        };
    }
    match tokio::fs::create_dir(record_folder).await {
        Ok(()) => {}
        Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(failure) => return Err(at(record_folder)(failure)),
    }
    if let Err(failure) = rename_folder(aside_folder, record_folder).await {
        let cleanup_failures = tokio::fs::remove_dir(record_folder)
            .await
            .err()
            .into_iter()
            .collect();
        return Err(
            CleanupFailures::new(failure, cleanup_failures, "putting git's record back").into(),
        );
    }
    Ok(true)
}

/// The `.git` a record's `gitdir` names, as [`read_record_git_file`] reads it, with its failure
/// carried as a stale record's.
pub(crate) async fn read_named_git_file(
    record_folder: &Path,
) -> Result<Option<PathBuf>, StaleRecordError> {
    read_record_git_file(record_folder)
        .await
        .map_err(at(&record_folder.join(RECORD_GITDIR_FILE_NAME)))
}

async fn canonical(folder: &Path) -> Result<PathBuf, StaleRecordError> {
    canonical_folder_path(folder)
        .await
        .map_err(StaleRecordError::Resolve)
}

/// Whether `first` and `second` name one `.git` file: the same name in folders that resolve to one.
/// Fails when either folder cannot be resolved.
pub(crate) async fn is_same_git_file(
    first: Option<&Path>,
    second: Option<&Path>,
) -> Result<bool, StaleRecordError> {
    let (Some(first), Some(second)) = (first, second) else {
        return Ok(false);
    };
    if first.file_name() != second.file_name() {
        return Ok(false);
    }
    let (Some(first_folder), Some(second_folder)) = (first.parent(), second.parent()) else {
        return Ok(false);
    };
    Ok(canonical(first_folder).await? == canonical(second_folder).await?)
}

/// Whether the `.git` at `git_file` names `record_folder`. Fails when the file cannot be read or
/// its path resolved.
pub(crate) async fn is_record_named_by(
    git_file: &Path,
    record_folder: &Path,
) -> Result<bool, StaleRecordError> {
    let Some(named_record) = read_record_named_by(git_file).await.map_err(at(git_file))? else {
        return Ok(false);
    };
    Ok(canonical(&named_record).await? == canonical(record_folder).await?)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use rstest::rstest;
    use rusqlite::params;
    use sidekicks_contracts::worktree::lifecycle::WorktreeState;
    use sidekicks_platforms::{make_folder_link, real_path};
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::events::log_service::test_fixture::open_log;

    use super::{StaleRecordTools, remove_stale_tree_record};
    use crate::git::worktree::claims::KeptCopyClaims;
    use crate::git::worktree::kept_copy::folder_move::LeftoverNamesInUse;
    use crate::git::worktree::schema::schema_parts;
    use crate::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

    const READ_STATEMENT_CAPACITY: usize = 4;

    // Kills comparing the record's `gitdir` with the original path as written, which keeps a stale
    // record whose path git wrote through another spelling; and dropping either live-tree
    // judgment: the records folder is read-only while a live row stands, so a record renamed aside
    // fails the removal where the system refuses that rename, even when it would go back.
    #[rstest]
    #[case::stale_record_named_through_another_spelling(false)]
    #[case::record_held_by_a_live_row_s_tree(true)]
    #[tokio::test]
    async fn a_stale_record_is_removed_unless_a_live_tree_stands_at_its_path(
        #[case] is_live_row: bool,
    ) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let real_scratch = real_path(scratch.path()).expect("the scratch folder resolves");
        // The row keeps the tree's path through a link; git wrote the real one.
        let link = real_scratch.join("trees-link");
        fs::create_dir(real_scratch.join("trees")).expect("the trees folder is made");
        make_folder_link(&real_scratch.join("trees"), &link).expect("the link is made");
        let original_path = link.join("fix");
        let record_folder = real_scratch.join("repo/.git/worktrees/fix");
        fs::create_dir_all(&record_folder).expect("the record is made");
        let gitdir = real_scratch.join("trees/fix/.git");
        fs::write(
            record_folder.join("gitdir"),
            format!("{}\n", gitdir.display()),
        )
        .expect("the record's gitdir is written");

        let database = TestDatabase::new(schema_parts());
        // Opening the log makes the database's tables.
        let _log = open_log(&database, None).await;
        let connection = database.reader();
        for row in project_and_mount_rows("mount", None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        if is_live_row {
            connection
                .execute(
                    "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, \
                     base_ref, fs_root, state, created_at, updated_at) VALUES ('live', 'mount', \
                     'session', 'fix', 'main', ?1, ?2, ?3, ?3)",
                    params![
                        original_path.to_str().expect("the scratch path is text"),
                        <&'static str>::from(WorktreeState::Ready),
                        PARENT_ROWS_AT
                    ],
                )
                .expect("a live tree stands at the original path");
        }
        let claims = KeptCopyClaims::new(Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        )));
        let leftover_names = Arc::new(LeftoverNamesInUse::default());
        let tools = StaleRecordTools {
            claims: &claims,
            leftover_names: &leftover_names,
        };

        let records_folder = record_folder.parent().expect("a record sits in a folder");
        let permissions = fs::metadata(records_folder)
            .expect("the records folder's permissions read")
            .permissions();
        if is_live_row {
            let mut read_only = permissions.clone();
            read_only.set_readonly(true);
            fs::set_permissions(records_folder, read_only)
                .expect("the records folder is read-only");
        }

        let removal = remove_stale_tree_record(tools, &record_folder, &original_path).await;

        fs::set_permissions(records_folder, permissions).expect("the permissions are put back");
        let is_removed = removal.expect("the record is judged with nothing renamed");
        let is_record_kept = is_live_row;
        assert_eq!(is_removed, !is_record_kept);
        assert_eq!(record_folder.exists(), is_record_kept);
        let names: Vec<_> = fs::read_dir(records_folder)
            .expect("the records folder reads")
            .map(|entry| entry.expect("an entry reads").file_name())
            .collect();
        assert_eq!(
            names.len(),
            usize::from(is_record_kept),
            "nothing is left aside"
        );
    }
}
