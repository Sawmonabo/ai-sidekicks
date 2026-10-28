//! Git's record of a tree put back: its name by git's own rule and counter, the linking files
//! between the tree and its record as git writes them, and the record's files written from the
//! kept one.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_platforms::{PathRules, real_path, relative_path};
use tokio::task::JoinError;

use super::{PutBackBranch, PutBackFailure, PutBackStepError, PutBackTools, at};
use crate::git::process::{
    CONFIG_UNSET_EXIT_CODE, GitCall, GitError, GitRunner, background_read, in_folder,
};
use crate::git::worktree::copy::{TreeCopyPolicy, copy_tree};
use crate::git::worktree::kept_copy::KEPT_RECORD_ENTRY;
use crate::git::worktree::kept_copy::saved_state::{
    RefStorePayload, read_rebase_folder, write_back_ref_store,
};
use crate::git::worktree::reads::{
    BRANCH_REF_PREFIX, GIT_FILE_NAME, LINKED_RECORDS_FOLDER_NAME, RECORD_COMMONDIR_FILE_NAME,
    RECORD_GITDIR_FILE_NAME, RECORD_LOCK_FILE_NAME,
};
use crate::git::worktree::tree_records::hold_records;

// What a record's `commondir` holds: the repository's git common folder, two folders up.
const COMMONDIR_TEXT: &[u8] = b"../..\n";
// A rebase's file naming the branch being rebased.
const REBASE_HEAD_NAME_FILE_NAME: &str = "head-name";

// The one config read of how a tree's linking files are written, in the repository: whether they
// are relative, and whether the repository already reads relative ones.
const LINKING_SETTINGS_PATTERN: &str =
    r"^(worktree\.userelativepaths|extensions\.relativeworktrees)$";
const USE_RELATIVE_PATHS_KEY: &[u8] = b"worktree.userelativepaths";
const RELATIVE_WORKTREES_KEY: &[u8] = b"extensions.relativeworktrees";
const GIT_TRUE: &[u8] = b"true";

/// A record name from a tree folder's name as git's `sanitize_refname_component` makes it, so a
/// record's refs are addressable as `worktrees/<name>/…`: a control character, a space, `:`, `?`,
/// `[`, `\`, `^`, `~`, `*` and the `{` of `@{` become `-`; `..` becomes `.`; a leading `.` becomes
/// `-`; a trailing `.lock` is stripped as often as it repeats; a trailing `.` stays.
pub(super) fn sanitize_record_name(name: &str) -> String {
    let mut sanitized = String::with_capacity(name.len());
    let mut last = '\0';
    for character in name.chars() {
        match character {
            '.' if last == '.' => {}
            '{' if last == '@' => sanitized.push('-'),
            '\0'..='\u{1f}' | '\u{7f}' | ' ' | ':' | '?' | '[' | '\\' | '^' | '~' | '*' => {
                sanitized.push('-')
            }
            other => sanitized.push(other),
        }
        last = character;
    }
    if name.starts_with('.') {
        sanitized.replace_range(0..1, "-");
    }
    if name.ends_with(".lock") {
        while let Some(stripped) = sanitized.strip_suffix(".lock") {
            sanitized.truncate(stripped.len());
        }
    }
    sanitized
}

/// Why the linking files could not be prepared.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LinkingFilesError {
    /// git's settings could not be read.
    #[error("the repository's worktree linking settings could not be read")]
    Settings(#[source] GitError),
    /// git read a setting in a form these reads do not know.
    #[error("git answered the worktree linking settings in an unexpected form")]
    Unexpected,
    /// The repository could not be made to read relative linking files.
    #[error("the repository could not be set to read relative worktree paths")]
    Raise(#[source] GitError),
    /// A folder could not be resolved.
    #[error("{} could not be resolved", path.display())]
    RealPath {
        /// The folder.
        path: PathBuf,
        /// The failure.
        #[source]
        source: io::Error,
    },
    /// A resolved folder is no text a relative path is written in.
    #[error("{} is no text a relative path can be written from", path.display())]
    PathText {
        /// The folder.
        path: PathBuf,
    },
    /// The blocking task that resolved the folders ended before it finished.
    #[error("resolving the put-back's folders ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// The record a put-back took, and whether it made the folder of records too.
#[derive(Debug)]
pub(super) struct TakenRecord {
    /// The record's folder.
    pub(super) record_folder: PathBuf,
    /// Whether the put-back made `<common folder>/worktrees/` itself.
    pub(super) is_records_folder_made: bool,
}

// The record folder a put-back writes, by git's own naming: the tree folder's name sanitized as
// git sanitizes it, with the first free number after it when another record, or the refs a
// repository keeps apart, already has it; chosen and made under the repository's records hold.
pub(super) async fn take_record_folder(
    common_folder: &Path,
    tree_name: &str,
    payload: Option<&RefStorePayload>,
) -> Result<TakenRecord, PutBackFailure> {
    let name = sanitize_record_name(tree_name);
    let records_folder = common_folder.join(LINKED_RECORDS_FOLDER_NAME);
    let record_failure = |path: &Path| {
        let path = path.to_path_buf();
        move |source| PutBackFailure::Record { path, source }
    };
    // Held while the name is chosen and made, so the cleanup's check of a free name and its removal
    // of that name's refs never fall between.
    let _records_hold = hold_records(common_folder)
        .await
        .map_err(record_failure(common_folder))?;
    let is_records_folder_made = match tokio::fs::create_dir(&records_folder).await {
        Ok(()) => true,
        Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => false,
        Err(failure) => return Err(record_failure(&records_folder)(failure)),
    };
    // Each number is a new name and only finitely many are taken, so the counter ends.
    let mut ordinal = 0_u64;
    loop {
        let candidate = if ordinal == 0 {
            name.clone()
        } else {
            format!("{name}{ordinal}")
        };
        ordinal += 1;
        if let Some(payload) = payload {
            let refs_folder = payload.tree_refs_folder(&candidate);
            if tokio::fs::try_exists(&refs_folder)
                .await
                .map_err(record_failure(&refs_folder))?
            {
                continue;
            }
        }
        let record_folder = records_folder.join(&candidate);
        match tokio::fs::create_dir(&record_folder).await {
            Ok(()) => {
                return Ok(TakenRecord {
                    record_folder,
                    is_records_folder_made,
                });
            }
            Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => {}
            Err(failure) => return Err(record_failure(&record_folder)(failure)),
        }
    }
}

// Whether the repository writes a tree's linking files relative to each other, and whether it
// already reads relative ones.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct LinkingSettings {
    is_relative: bool,
    has_relative_extension: bool,
}

// Reads the linking settings in the repository at `canonical_root` with one `git config` call.
pub(super) async fn read_linking_settings(
    git: &GitRunner,
    place: Option<&Place>,
    canonical_root: &Path,
) -> Result<LinkingSettings, LinkingFilesError> {
    let call = GitCall::read(background_read(
        canonical_root,
        &[
            "config",
            "--includes",
            "-z",
            "--type=bool",
            "--get-regexp",
            LINKING_SETTINGS_PATTERN,
        ],
    ));
    let output = match git.run(place, call).await {
        Ok(output) => output.stdout,
        Err(failure) if failure.exit_code() == Some(CONFIG_UNSET_EXIT_CODE) => {
            return Ok(LinkingSettings::default());
        }
        Err(failure) => return Err(LinkingFilesError::Settings(failure)),
    };
    let mut settings = LinkingSettings::default();
    // Each entry is `<key>\n<value>` ended by a NUL; a later value wins.
    for entry in output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let separator = entry
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or(LinkingFilesError::Unexpected)?;
        let (key, value) = (&entry[..separator], &entry[separator + 1..]);
        let is_true = value == GIT_TRUE;
        if key == USE_RELATIVE_PATHS_KEY {
            settings.is_relative = is_true;
        } else if key == RELATIVE_WORKTREES_KEY {
            settings.has_relative_extension = is_true;
        }
    }
    Ok(settings)
}

// A tree's two linking files as written: its `.git` file and its record's `gitdir`.
pub(super) struct LinkingFiles {
    pub(super) tree_git_file: String,
    record_gitdir: String,
}

// The linking files of the tree at `target_folder` and its record at `record_folder`, from their
// real paths as git writes them: absolute, or each relative to the other when the repository asks,
// the repository first set to read relative ones where it does not yet.
pub(super) async fn prepare_linking_files(
    tools: PutBackTools<'_>,
    canonical_root: &Path,
    settings: LinkingSettings,
    target_folder: &Path,
    record_folder: &Path,
) -> Result<LinkingFiles, LinkingFilesError> {
    let (tree, record) = (target_folder.to_path_buf(), record_folder.to_path_buf());
    let (tree, record) = tokio::task::spawn_blocking(move || {
        let real = |folder: PathBuf| {
            real_path(&folder).map_err(|source| LinkingFilesError::RealPath {
                path: folder.clone(),
                source,
            })
        };
        Ok::<_, LinkingFilesError>((real(tree)?, real(record)?))
    })
    .await
    .map_err(LinkingFilesError::Interrupted)??;
    if !settings.is_relative {
        return Ok(LinkingFiles {
            tree_git_file: format!("gitdir: {}\n", record.display()),
            record_gitdir: format!("{}\n", tree.join(GIT_FILE_NAME).display()),
        });
    }
    if !settings.has_relative_extension {
        for (key, value) in [
            ("core.repositoryFormatVersion", "1"),
            ("extensions.relativeWorktrees", "true"),
        ] {
            tools
                .git()
                .run(
                    tools.place(),
                    GitCall::write(in_folder(canonical_root, &["config", key, value])),
                )
                .await
                .map_err(LinkingFilesError::Raise)?;
        }
    }
    let text = |path: &Path| {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| LinkingFilesError::PathText {
                path: path.to_path_buf(),
            })
    };
    let (tree_text, record_text) = (text(&tree)?, text(&record)?);
    Ok(LinkingFiles {
        tree_git_file: format!(
            "gitdir: {}\n",
            relative_path(PathRules::NATIVE, &record_text, &tree_text)
        ),
        record_gitdir: format!(
            "{}/{GIT_FILE_NAME}\n",
            relative_path(PathRules::NATIVE, &tree_text, &record_text)
        ),
    })
}

// Writes the new record: the kept record's entries but its lock, which is already written, then
// `commondir`, the refs kept apart with git's stubs over the copied ones, `gitdir`, and on a new
// branch its HEAD, once `commondir` names the repository so git can open the record.
pub(super) async fn write_record(
    tools: PutBackTools<'_>,
    kept_folder: &Path,
    record_folder: &Path,
    linking: &LinkingFiles,
    payload: Option<&RefStorePayload>,
    new_branch: Option<&PutBackBranch>,
) -> Result<(), PutBackStepError> {
    copy_kept_record(&kept_folder.join(KEPT_RECORD_ENTRY), record_folder).await?;
    let commondir = record_folder.join(RECORD_COMMONDIR_FILE_NAME);
    tokio::fs::write(&commondir, COMMONDIR_TEXT)
        .await
        .map_err(at(&commondir))?;
    if let Some(payload) = payload {
        write_back_ref_store(payload, kept_folder, record_folder)
            .await
            .map_err(PutBackStepError::SavedState)?;
    }
    let gitdir = record_folder.join(RECORD_GITDIR_FILE_NAME);
    tokio::fs::write(&gitdir, &linking.record_gitdir)
        .await
        .map_err(at(&gitdir))?;
    if let Some(new_branch) = new_branch {
        point_record_at_branch(tools, record_folder, &new_branch.name).await?;
    }
    Ok(())
}

// Copies each entry of the kept record into `record_folder` but its lock, cloned where the volume
// can.
async fn copy_kept_record(
    kept_record: &Path,
    record_folder: &Path,
) -> Result<(), PutBackStepError> {
    let (kept_record, record_folder) = (kept_record.to_path_buf(), record_folder.to_path_buf());
    tokio::task::spawn_blocking(move || {
        for entry in fs::read_dir(&kept_record).map_err(at(&kept_record))? {
            let name = entry.map_err(at(&kept_record))?.file_name();
            if name == RECORD_LOCK_FILE_NAME {
                continue;
            }
            copy_tree(
                &kept_record.join(&name),
                &record_folder.join(&name),
                TreeCopyPolicy::IntoEmpty,
                None,
            )
            .map_err(PutBackStepError::RecordCopy)?;
        }
        Ok(())
    })
    .await
    .map_err(PutBackStepError::Interrupted)?
}

// Puts the record's HEAD, or a rebase's branch, on `branch`. HEAD goes through git, which writes
// it wherever the repository keeps refs; a rebase's `head-name` is a file in either ref store.
async fn point_record_at_branch(
    tools: PutBackTools<'_>,
    record_folder: &Path,
    branch: &str,
) -> Result<(), PutBackStepError> {
    let branch_ref = format!("{BRANCH_REF_PREFIX}{branch}");
    match read_rebase_folder(record_folder)
        .await
        .map_err(PutBackStepError::SavedState)?
    {
        None => {
            let arguments: Vec<OsString> = vec![
                "--git-dir".into(),
                record_folder.as_os_str().to_owned(),
                "symbolic-ref".into(),
                "HEAD".into(),
                branch_ref.into(),
            ];
            tools
                .git()
                .run(tools.place(), GitCall::write(arguments))
                .await
                .map_err(PutBackStepError::Head)?;
        }
        Some(rebase_folder) => {
            let head_name = record_folder
                .join(rebase_folder)
                .join(REBASE_HEAD_NAME_FILE_NAME);
            tokio::fs::write(&head_name, format!("{branch_ref}\n"))
                .await
                .map_err(at(&head_name))?;
        }
    }
    Ok(())
}
