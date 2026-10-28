//! What git's record of a tree names, read and kept for its kept copy: HEAD and `ORIG_HEAD` as git
//! reads them in the tree, since either ref store may keep them; `MERGE_HEAD` and a rebase's `onto`
//! and `orig-head`, files in the record whichever ref store it uses; the objects the index names
//! that HEAD's tree lacks, packed; the LFS objects its staged pointers name; the commits its pins
//! keep; and, for a repository that keeps its refs apart (`extensions.refStorage =
//! <format>://<payload>`), the tree's own refs folder in that payload, kept and written back under
//! a put-back's record name.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_platforms::path_from_program_output;
use sidekicks_std::file::clone_or_copy::clone_or_copy;
use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use tokio::task::JoinError;

use crate::git::GITLINK_MODE;
use crate::git::process::{CONFIG_UNSET_EXIT_CODE, GitCall, GitError, GitRunner, background_read};
use crate::git::worktree::copy::{TreeCopyError, TreeCopyPolicy, copy_tree};
use crate::git::worktree::kept_copy::pins::{KeptPin, KeptWorktreePins};
use crate::git::worktree::kept_copy::{KEPT_LFS_ENTRY, KEPT_REF_STORE_ENTRY};
use crate::git::worktree::reads::{LINKED_RECORDS_FOLDER_NAME, read_current_branch};

// A git LFS pointer is a small text blob; anything larger is never one.
const LFS_POINTER_MAX_BYTES: u64 = 1024;
const LFS_POINTER_VERSION_LINE: &str = "version https://git-lfs.github.com/spec/v1";
const LFS_POINTER_OID_PREFIX: &str = "oid sha256:";
const LFS_OBJECT_ID_LENGTH: usize = 64;

const CONFLICT_STAGE_UNEXPECTED: &str =
    "git ls-files answered a conflict stage in an unexpected form";

// The one config read of both stores, run in the tree so its own `config.worktree` counts.
const STORE_SETTINGS_PATTERN: &str = r"^(lfs\.storage|extensions\.refstorage)$";
const LFS_STORAGE_KEY: &[u8] = b"lfs.storage";
const REF_STORAGE_KEY: &[u8] = b"extensions.refstorage";
// git-lfs's store when the repository names none, in its git common folder.
const DEFAULT_LFS_FOLDER_NAME: &str = "lfs";
// What splits `extensions.refStorage`'s format from its payload.
const REF_STORAGE_PAYLOAD_SEPARATOR: &str = "://";

// The stubs git writes in a tree's record when its refs live in a payload, so the record still
// reads as a git folder: a HEAD naming no branch, and `refs/heads` saying where the refs are.
const REF_STORE_HEAD_STUB: &[u8] = b"ref: refs/heads/.invalid\n";

// A record's file naming HEAD: a commit's id while detached, else the ref it is on.
const HEAD_FILE_NAME: &str = "HEAD";

// The record's rebase folders, the merge backend's first.
const REBASE_FOLDER_NAMES: [&str; 2] = ["rebase-merge", "rebase-apply"];

/// Why a read or a keep of the saved state failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SavedStateError {
    /// A git call failed.
    #[error(transparent)]
    Git(#[from] GitError),
    /// Two git reads run together failed.
    #[error(transparent)]
    GitReads(#[from] SettleFailures<GitError>),
    /// The LFS store git names is a path this system cannot name.
    #[error("the repository's LFS store is a path this system cannot name")]
    PathText(#[source] io::Error),
    /// The refs storage git names is not text.
    #[error("the repository's refs storage setting is not text")]
    RefStorageText(#[source] std::string::FromUtf8Error),
    /// git answered in a form these reads do not know.
    #[error("{0}")]
    Unexpected(&'static str),
    /// A file or folder could not be read or written.
    #[error("{} could not be read or written", path.display())]
    File {
        /// The entry.
        path: PathBuf,
        /// The failure.
        #[source]
        source: io::Error,
    },
    /// A folder's copy failed.
    #[error(transparent)]
    Copy(#[from] TreeCopyError),
    /// The blocking task that copied ended before it finished.
    #[error("a copy of the saved state ended before it finished")]
    Interrupted(#[source] JoinError),
}

fn at(path: &Path) -> impl FnOnce(io::Error) -> SavedStateError {
    let path = path.to_path_buf();
    move |source| SavedStateError::File { path, source }
}

/// HEAD's commit and branch, and `ORIG_HEAD`, as git reads them in the tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HeadRefs {
    /// The commit HEAD names.
    pub(crate) commit: GitObjectId,
    /// The branch HEAD names, or `None` while it is detached.
    pub(crate) branch: Option<String>,
    /// The commit `ORIG_HEAD` names, when it names one.
    pub(crate) orig_head: Option<GitObjectId>,
}

/// Reads HEAD's commit and branch and `ORIG_HEAD` in `tree_folder`, two git reads side by side.
/// Fails with git's failures, or `Unexpected` when git names no commit for HEAD.
pub(crate) async fn read_head_refs(
    git: &GitRunner,
    place: Option<&Place>,
    tree_folder: &Path,
) -> Result<HeadRefs, SavedStateError> {
    // One `<object> <type>` line per name in the order asked, or `<name> missing`.
    let objects = GitCall::read(background_read(
        tree_folder,
        &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    ))
    .with_input(b"HEAD\nORIG_HEAD\n".to_vec());
    let (objects, branch) = settle_all(
        tokio::join!(
            git.run(place, objects),
            read_current_branch(git, place, tree_folder)
        ),
        "reading the tree's HEAD",
    )?;
    let mut lines = objects.stdout.split(|byte| *byte == b'\n').map(commit_of);
    let commit = lines.next().flatten().ok_or(SavedStateError::Unexpected(
        "git names no commit for the tree's HEAD",
    ))?;
    Ok(HeadRefs {
        commit,
        branch,
        orig_head: lines.next().flatten(),
    })
}

// The commit a `--batch-check` line names, when it names one.
fn commit_of(line: &[u8]) -> Option<GitObjectId> {
    let line = std::str::from_utf8(line).ok()?;
    let (object, object_type) = line.split_once(' ')?;
    (object_type == "commit")
        .then(|| GitObjectId::new(object.to_owned()))
        .flatten()
}

/// The objects the index of `tree_folder` names that HEAD's tree does not: the new side of every
/// staged change, from git's own index-to-HEAD comparison, and every stage of a conflicted path,
/// which may come from no commit the pins keep. A submodule's commit and a side with no object are
/// left out. Fails with git's failure, or `Unexpected` for an answer in another form.
pub(crate) async fn list_index_objects_missing_from_head(
    git: &GitRunner,
    place: Option<&Place>,
    tree_folder: &Path,
) -> Result<Vec<GitObjectId>, SavedStateError> {
    let staged = git
        .run(
            place,
            GitCall::read(background_read(
                tree_folder,
                &["diff-index", "--cached", "--no-renames", "-z", "HEAD"],
            )),
        )
        .await?;
    let mut missing = BTreeSet::new();
    let mut has_conflict = false;
    // With renames off each change is two fields, `:<old mode> <new mode> <old object> <new
    // object> <status>` and its path, which may itself start with `:`; the output ends with a NUL.
    let fields: Vec<&[u8]> = staged.stdout.split(|byte| *byte == 0).collect();
    for change in fields.chunks_exact(2).map(|pair| pair[0]) {
        let unexpected =
            SavedStateError::Unexpected("git diff-index answered a change in an unexpected form");
        let Some(change) = std::str::from_utf8(change)
            .ok()
            .and_then(|change| change.strip_prefix(':'))
        else {
            return Err(unexpected);
        };
        let parts: Vec<&str> = change.split(' ').collect();
        let [_, new_mode, _, new_object, status] = parts[..] else {
            return Err(unexpected);
        };
        if status == "U" {
            has_conflict = true;
            continue;
        }
        if new_mode == GITLINK_MODE || is_no_object(new_object) {
            continue;
        }
        missing.insert(GitObjectId::new(new_object.to_owned()).ok_or(unexpected)?);
    }
    if has_conflict {
        missing.extend(list_conflict_stage_objects(git, place, tree_folder).await?);
    }
    Ok(missing.into_iter().collect())
}

// The object id git prints for a side that has none, such as a deleted or unmerged path.
fn is_no_object(object: &str) -> bool {
    !object.is_empty() && object.bytes().all(|byte| byte == b'0')
}

// The blob of every stage of every conflicted path; each entry is `<mode> <object> <stage>`, a tab,
// then its path.
async fn list_conflict_stage_objects(
    git: &GitRunner,
    place: Option<&Place>,
    tree_folder: &Path,
) -> Result<Vec<GitObjectId>, SavedStateError> {
    let unmerged = git
        .run(
            place,
            GitCall::read(background_read(tree_folder, &["ls-files", "-u", "-z"])),
        )
        .await?;
    let mut objects = Vec::new();
    for entry in unmerged.stdout.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let header = entry
            .split(|byte| *byte == b'\t')
            .next()
            .unwrap_or_default();
        let mut parts = std::str::from_utf8(header)
            .ok()
            .into_iter()
            .flat_map(|header| header.split(' '));
        let (Some(mode), Some(object)) = (parts.next(), parts.next()) else {
            return Err(SavedStateError::Unexpected(CONFLICT_STAGE_UNEXPECTED));
        };
        let object = GitObjectId::new(object.to_owned())
            .ok_or(SavedStateError::Unexpected(CONFLICT_STAGE_UNEXPECTED))?;
        if mode != GITLINK_MODE {
            objects.push(object);
        }
    }
    Ok(objects)
}

/// Packs `objects` from the repository of `tree_folder` into `objects_folder` as one pack named as
/// a repository's own `objects/pack/` names it, so a put-back moves it in as it is; nothing is made
/// for no objects. Fails with the folder's making or git's failure.
pub(crate) async fn pack_objects(
    git: &GitRunner,
    place: Option<&Place>,
    tree_folder: &Path,
    objects_folder: &Path,
    objects: &[GitObjectId],
) -> Result<(), SavedStateError> {
    if objects.is_empty() {
        return Ok(());
    }
    tokio::fs::create_dir_all(objects_folder)
        .await
        .map_err(at(objects_folder))?;
    // `pack-objects <base>` writes `<base>-<hash>.pack` and its index.
    let mut arguments = background_read(tree_folder, &["pack-objects", "-q"]);
    arguments.push(objects_folder.join("pack").into_os_string());
    git.run(
        place,
        GitCall::read(arguments).with_input(object_lines(objects)),
    )
    .await?;
    Ok(())
}

fn object_lines<'a>(objects: impl IntoIterator<Item = &'a GitObjectId>) -> Vec<u8> {
    let mut lines = Vec::new();
    for object in objects {
        lines.extend_from_slice(object.as_str().as_bytes());
        lines.push(b'\n');
    }
    lines
}

/// The LFS store and the refs payload a repository's config names, as one read in a tree finds
/// them: the tree's own `config.worktree` wins, as git-lfs's last-value read lets it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RepositoryStoreSettings {
    lfs_storage: Option<PathBuf>,
    ref_storage: Option<String>,
}

/// Where a repository keeps its refs apart from its git folder: the payload as its config writes
/// it, and the folder that names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RefStorePayload {
    text: String,
    folder: PathBuf,
}

impl RepositoryStoreSettings {
    /// Reads `lfs.storage` and `extensions.refStorage` in `tree_folder` with one `git config` call,
    /// includes followed; a repository that sets neither reads as both unset. Fails with git's
    /// failure, `PathText` for a store this system cannot name, or `RefStorageText`.
    pub(crate) async fn read(
        git: &GitRunner,
        place: Option<&Place>,
        tree_folder: &Path,
    ) -> Result<Self, SavedStateError> {
        let call = GitCall::read(background_read(
            tree_folder,
            &[
                "config",
                "--includes",
                "-z",
                "--get-regexp",
                STORE_SETTINGS_PATTERN,
            ],
        ));
        let output = match git.run(place, call).await {
            Ok(output) => output.stdout,
            Err(failure) if failure.exit_code() == Some(CONFIG_UNSET_EXIT_CODE) => {
                return Ok(Self::default());
            }
            Err(failure) => return Err(failure.into()),
        };
        let mut settings = Self::default();
        // Each entry is `<key>\n<value>` ended by a NUL; a later value wins.
        for entry in output.split(|byte| *byte == 0) {
            let Some(separator) = entry.iter().position(|byte| *byte == b'\n') else {
                continue;
            };
            let (key, value) = (&entry[..separator], &entry[separator + 1..]);
            if key == LFS_STORAGE_KEY {
                settings.lfs_storage = Some(
                    path_from_program_output(value.to_vec()).map_err(SavedStateError::PathText)?,
                );
            } else if key == REF_STORAGE_KEY {
                settings.ref_storage = Some(
                    String::from_utf8(value.to_vec()).map_err(SavedStateError::RefStorageText)?,
                );
            }
        }
        Ok(settings)
    }

    /// The repository's LFS store for its git common folder `common_folder`: `lfs` there when the
    /// config names none, a relative store joined to it, an absolute one as given.
    pub(crate) fn lfs_store(&self, common_folder: &Path) -> PathBuf {
        match &self.lfs_storage {
            Some(storage) => common_folder.join(storage),
            None => common_folder.join(DEFAULT_LFS_FOLDER_NAME),
        }
    }

    /// Where the repository with git common folder `common_folder` keeps its refs apart, or `None`
    /// when they live in its git folder.
    pub(crate) fn ref_store_payload(&self, common_folder: &Path) -> Option<RefStorePayload> {
        let (_format, payload) = self
            .ref_storage
            .as_deref()?
            .split_once(REF_STORAGE_PAYLOAD_SEPARATOR)?;
        (!payload.is_empty()).then(|| RefStorePayload::resolve(payload, common_folder))
    }
}

impl RefStorePayload {
    /// The payload `text` as a config writes it, a relative one resolved against the git common
    /// folder `common_folder`, as git resolves it.
    pub(crate) fn resolve(text: &str, common_folder: &Path) -> Self {
        Self {
            text: text.to_owned(),
            folder: common_folder.join(text),
        }
    }

    /// The folder holding the refs of the tree whose record is named `record_name`.
    pub(crate) fn tree_refs_folder(&self, record_name: &str) -> PathBuf {
        self.folder
            .join(LINKED_RECORDS_FOLDER_NAME)
            .join(record_name)
    }

    // The `refs/heads` stub's line in the record named `record_name`, as git writes it, with the
    // payload as the config writes it.
    fn heads_stub(&self, record_name: &str) -> String {
        format!(
            "this worktree stores references in {}/{LINKED_RECORDS_FOLDER_NAME}/{record_name}\n",
            self.text
        )
    }
}

/// Copies the refs of the tree whose record is `record_folder` from `payload` into `kept_folder`,
/// answering their folder in the payload, which goes with the record; `None` when the tree has
/// none there. Fails with the record's name that is not text, or the copy's failure.
pub(crate) async fn keep_ref_store(
    payload: &RefStorePayload,
    record_folder: &Path,
    kept_folder: &Path,
) -> Result<Option<PathBuf>, SavedStateError> {
    let source = payload.tree_refs_folder(record_name_of(record_folder)?);
    let kept = kept_folder.join(KEPT_REF_STORE_ENTRY);
    on_blocking_thread(move || {
        if !source.try_exists().map_err(at(&source))? {
            return Ok(None);
        }
        copy_tree(&source, &kept, TreeCopyPolicy::IntoEmpty, None)?;
        Ok(Some(source))
    })
    .await
}

/// Writes the kept refs in `kept_folder` back into `payload` under the name of the put-back's
/// record `record_folder`, a fresh folder where the copy kept none, then writes the record's stubs
/// as git writes them, its `HEAD` and `refs/heads` replacing the kept ones. Answers the refs folder
/// written, which the put-back's undo removes. Fails with `AlreadyExists` when that folder is
/// there, the record's name that is not text, or a write's failure.
pub(crate) async fn write_back_ref_store(
    payload: &RefStorePayload,
    kept_folder: &Path,
    record_folder: &Path,
) -> Result<PathBuf, SavedStateError> {
    let record_name = record_name_of(record_folder)?;
    let destination = payload.tree_refs_folder(record_name);
    let heads_stub = payload.heads_stub(record_name);
    let kept = kept_folder.join(KEPT_REF_STORE_ENTRY);
    let record_folder = record_folder.to_path_buf();
    on_blocking_thread(move || {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(at(parent))?;
        }
        if kept.try_exists().map_err(at(&kept))? {
            copy_tree(&kept, &destination, TreeCopyPolicy::IntoEmpty, None)?;
        } else {
            fs::create_dir(&destination).map_err(at(&destination))?;
        }
        let head = record_folder.join("HEAD");
        fs::write(&head, REF_STORE_HEAD_STUB).map_err(at(&head))?;
        let refs = record_folder.join("refs");
        fs::create_dir_all(&refs).map_err(at(&refs))?;
        let heads = refs.join("heads");
        fs::write(&heads, heads_stub).map_err(at(&heads))?;
        Ok(destination)
    })
    .await
}

fn record_name_of(record_folder: &Path) -> Result<&str, SavedStateError> {
    record_folder
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(SavedStateError::Unexpected(
            "a tree's record is named in no text",
        ))
}

/// Keeps in `kept_folder` the LFS object each staged pointer among `objects` names, from the
/// repository of `tree_folder`, whose store is `lfs_store`; an object the store lacks is an
/// alternate's to keep. Fails with git's failure or a copy's.
pub(crate) async fn keep_lfs_objects(
    git: &GitRunner,
    place: Option<&Place>,
    tree_folder: &Path,
    lfs_store: &Path,
    kept_folder: &Path,
    objects: &[GitObjectId],
) -> Result<(), SavedStateError> {
    if objects.is_empty() {
        return Ok(());
    }
    let sizes = git
        .run(
            place,
            GitCall::read(background_read(
                tree_folder,
                &[
                    "cat-file",
                    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                ],
            ))
            .with_input(object_lines(objects)),
        )
        .await?;
    let small_blobs: Vec<GitObjectId> = sizes
        .stdout
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            let line = std::str::from_utf8(line).ok()?;
            let mut parts = line.split(' ');
            let (object, object_type, size) = (parts.next()?, parts.next()?, parts.next()?);
            let is_small_blob = object_type == "blob"
                && size
                    .parse::<u64>()
                    .is_ok_and(|size| size <= LFS_POINTER_MAX_BYTES);
            is_small_blob
                .then(|| GitObjectId::new(object.to_owned()))
                .flatten()
        })
        .collect();
    if small_blobs.is_empty() {
        return Ok(());
    }
    let blobs = git
        .run(
            place,
            GitCall::read(background_read(tree_folder, &["cat-file", "--batch"]))
                .with_input(object_lines(&small_blobs)),
        )
        .await?;
    let lfs_object_ids = read_pointed_lfs_objects(&blobs.stdout)?;
    if lfs_object_ids.is_empty() {
        return Ok(());
    }
    let (lfs_store, kept) = (lfs_store.to_path_buf(), kept_folder.join(KEPT_LFS_ENTRY));
    on_blocking_thread(move || {
        for lfs_object_id in lfs_object_ids {
            let source = lfs_object_path(&lfs_store, &lfs_object_id);
            if !source.try_exists().map_err(at(&source))? {
                continue;
            }
            fs::create_dir_all(&kept).map_err(at(&kept))?;
            let destination = kept.join(&lfs_object_id);
            clone_or_copy(&source, &destination).map_err(at(&destination))?;
        }
        Ok(())
    })
    .await
}

// The LFS object ids the pointers among `cat-file --batch`'s blobs name, each once: every blob is a
// `<object> <type> <size>` line, its bytes, then a newline.
fn read_pointed_lfs_objects(batch: &[u8]) -> Result<BTreeSet<String>, SavedStateError> {
    let unexpected =
        || SavedStateError::Unexpected("git cat-file answered a blob in an unexpected form");
    let mut lfs_object_ids = BTreeSet::new();
    let mut rest = batch;
    while !rest.is_empty() {
        let header_end = rest
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(unexpected)?;
        let size = std::str::from_utf8(&rest[..header_end])
            .ok()
            .and_then(|header| header.rsplit(' ').next())
            .and_then(|size| size.parse::<usize>().ok())
            .ok_or_else(unexpected)?;
        let body_end = header_end + 1 + size;
        let blob = rest.get(header_end + 1..body_end).ok_or_else(unexpected)?;
        if let Some(lfs_object_id) = pointed_lfs_object(blob) {
            lfs_object_ids.insert(lfs_object_id);
        }
        rest = rest.get(body_end + 1..).unwrap_or_default();
    }
    Ok(lfs_object_ids)
}

// The LFS object a pointer blob names: a blob that starts with git-lfs's version line and holds
// an `oid sha256:<64 hex>` line.
fn pointed_lfs_object(blob: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(blob).ok()?;
    if !text.starts_with(LFS_POINTER_VERSION_LINE) {
        return None;
    }
    text.lines()
        .filter_map(|line| line.strip_prefix(LFS_POINTER_OID_PREFIX))
        .find(|id| {
            id.len() == LFS_OBJECT_ID_LENGTH
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .map(str::to_owned)
}

/// Where the LFS store `lfs_store` keeps one object: `objects/<aa>/<bb>/<id>`.
pub(crate) fn lfs_object_path(lfs_store: &Path, lfs_object_id: &str) -> PathBuf {
    lfs_store
        .join("objects")
        .join(lfs_object_id.get(0..2).unwrap_or_default())
        .join(lfs_object_id.get(2..4).unwrap_or_default())
        .join(lfs_object_id)
}

/// HEAD's commit as the kept record `kept_record` names it, read once the record is copied, so the
/// pins and the row hold what is kept: the id a detached HEAD's file holds, else the commit HEAD
/// names in `tree_folder`, whose refs the record shares, a ref store keeping HEAD out of the file
/// included. Fails with the file's read or git's failure, or `Unexpected` when git names no commit.
pub(crate) async fn read_kept_head_commit(
    git: &GitRunner,
    place: Option<&Place>,
    tree_folder: &Path,
    kept_record: &Path,
) -> Result<GitObjectId, SavedStateError> {
    if let Some(commit) = read_first_object_id(&kept_record.join(HEAD_FILE_NAME)).await? {
        return Ok(commit);
    }
    let output = git
        .run(
            place,
            GitCall::read(background_read(
                tree_folder,
                &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            )),
        )
        .await?;
    String::from_utf8(output.stdout)
        .ok()
        .and_then(|commit| GitObjectId::new(commit.trim().to_owned()))
        .ok_or(SavedStateError::Unexpected(
            "git names no commit for the tree's HEAD",
        ))
}

/// The commits the saved state in the kept record `record_folder` names: HEAD's `head_commit`,
/// `ORIG_HEAD`'s `orig_head`, a merge's first `MERGE_HEAD`, and a rebase's `onto` and `orig-head`.
/// Fails with a file's read.
pub(crate) async fn read_state_pins(
    record_folder: &Path,
    head_commit: GitObjectId,
    orig_head: Option<GitObjectId>,
) -> Result<KeptWorktreePins, SavedStateError> {
    let mut pins = KeptWorktreePins::default();
    pins.set(KeptPin::Head, Some(head_commit));
    pins.set(KeptPin::OrigHead, orig_head);
    pins.set(
        KeptPin::MergeHead,
        read_first_object_id(&record_folder.join("MERGE_HEAD")).await?,
    );
    if let Some(rebase_folder) = read_rebase_folder(record_folder).await? {
        let rebase_folder = record_folder.join(rebase_folder);
        pins.set(
            KeptPin::RebaseOnto,
            read_first_object_id(&rebase_folder.join("onto")).await?,
        );
        pins.set(
            KeptPin::RebaseOrigHead,
            read_first_object_id(&rebase_folder.join("orig-head")).await?,
        );
    }
    Ok(pins)
}

// The object id a state file's first line names; none for a missing file or another first line.
async fn read_first_object_id(path: &Path) -> Result<Option<GitObjectId>, SavedStateError> {
    let Some(text) = read_optional_text(path).await? else {
        return Ok(None);
    };
    Ok(text
        .lines()
        .next()
        .and_then(|line| GitObjectId::new(line.trim().to_owned())))
}

async fn read_optional_text(path: &Path) -> Result<Option<String>, SavedStateError> {
    Ok(tokio::fs::read(path)
        .await
        .none_if_missing()
        .map_err(at(path))?
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}

/// The rebase folder of the record `record_folder`, `rebase-merge` or `rebase-apply`, or `None`
/// when no rebase runs. Fails with an entry's read other than its absence.
pub(crate) async fn read_rebase_folder(
    record_folder: &Path,
) -> Result<Option<&'static str>, SavedStateError> {
    for candidate in REBASE_FOLDER_NAMES {
        let head_name = record_folder.join(candidate).join("head-name");
        if tokio::fs::try_exists(&head_name)
            .await
            .map_err(at(&head_name))?
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// The branch the kept record `record_folder` was on: in a rebase the branch being rebased, from
/// the rebase's `head-name`, else `head_branch`. Fails with a file's read.
pub(crate) async fn read_kept_branch(
    record_folder: &Path,
    head_branch: Option<String>,
) -> Result<Option<String>, SavedStateError> {
    let Some(rebase_folder) = read_rebase_folder(record_folder).await? else {
        return Ok(head_branch);
    };
    let head_name =
        read_optional_text(&record_folder.join(rebase_folder).join("head-name")).await?;
    Ok(head_name.and_then(|text| {
        text.lines()
            .find_map(|line| line.strip_prefix("refs/heads/"))
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(str::to_owned)
    }))
}

async fn on_blocking_thread<Answer: Send + 'static>(
    work: impl FnOnce() -> Result<Answer, SavedStateError> + Send + 'static,
) -> Result<Answer, SavedStateError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(SavedStateError::Interrupted)?
}

#[cfg(test)]
mod tests {
    use std::fs;

    use sidekicks_platforms::real_path;

    use super::{RefStorePayload, keep_ref_store, read_kept_head_commit, write_back_ref_store};
    use crate::git::process::test_git_runner;
    use crate::git::process::test_repository::{commit_empty, git_in, make_test_repository};
    use crate::git::worktree::kept_copy::KEPT_REF_STORE_ENTRY;

    // A commit lands in the detached tree once its record is copied. Kills HEAD's commit read from
    // the live tree instead of the kept record, which would pin a commit the copy does not hold.
    #[tokio::test]
    async fn the_kept_head_is_the_copied_record_s_after_the_live_tree_moves() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let scratch_path = real_path(scratch.path()).expect("the scratch folder resolves");
        let git = test_git_runner();
        let repository = make_test_repository(&git, &scratch_path, "app").await;
        let tree = scratch_path.join("tree");
        git_in(
            &git,
            &repository,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                &tree.to_string_lossy(),
            ],
        )
        .await;
        let kept_head = git_in(&git, &tree, &["rev-parse", "HEAD"]).await;
        let record = git_in(&git, &tree, &["rev-parse", "--absolute-git-dir"]).await;
        let kept_record = scratch_path.join("kept-record");
        fs::create_dir(&kept_record).expect("the kept record is made");
        fs::copy(
            std::path::Path::new(&record).join("HEAD"),
            kept_record.join("HEAD"),
        )
        .expect("the record's HEAD is copied");
        commit_empty(&git, &tree, "after the copy").await;

        let head = read_kept_head_commit(&git, None, &tree, &kept_record)
            .await
            .expect("the kept HEAD is read");

        assert_eq!(head.as_str(), kept_head);
    }

    // Kills a discard that keeps no payload refs, a write-back to the old record's name, and stubs
    // that name the resolved folder or miss git's newline.
    #[tokio::test]
    async fn a_tree_s_payload_refs_are_kept_and_written_back_under_the_new_record_name() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let common_folder = scratch.path().join("repo/.git");
        let payload = RefStorePayload::resolve("../refs-apart", &common_folder);
        let old_refs = payload.tree_refs_folder("fix");
        fs::create_dir_all(old_refs.join("refs/heads")).expect("the old refs folder is made");
        fs::write(old_refs.join("HEAD"), b"ref: refs/heads/fix\n").expect("HEAD is written");
        fs::write(old_refs.join("refs/heads/fix"), b"0123\n").expect("the branch is written");
        let old_record = common_folder.join("worktrees/fix");
        let kept_folder = scratch.path().join("kept");
        fs::create_dir_all(&kept_folder).expect("the kept folder is made");

        let kept = keep_ref_store(&payload, &old_record, &kept_folder)
            .await
            .expect("the refs are kept");

        assert_eq!(kept, Some(old_refs.clone()));
        assert_eq!(
            fs::read(kept_folder.join(KEPT_REF_STORE_ENTRY).join("HEAD")).expect("HEAD is kept"),
            b"ref: refs/heads/fix\n"
        );
        // A put-back takes the next record name while the old payload folder stays behind.
        let new_record = common_folder.join("worktrees/fix1");
        fs::create_dir_all(new_record.join("refs")).expect("the new record is made");
        fs::write(new_record.join("refs/heads"), b"stale stub\n").expect("the kept stub is there");

        let written = write_back_ref_store(&payload, &kept_folder, &new_record)
            .await
            .expect("the refs are written back");

        assert_eq!(written, payload.tree_refs_folder("fix1"));
        assert_eq!(
            fs::read(written.join("refs/heads/fix")).expect("the branch is written back"),
            b"0123\n"
        );
        assert_eq!(
            fs::read(new_record.join("HEAD")).expect("the HEAD stub is written"),
            b"ref: refs/heads/.invalid\n"
        );
        assert_eq!(
            fs::read_to_string(new_record.join("refs/heads")).expect("the heads stub is written"),
            "this worktree stores references in ../refs-apart/worktrees/fix1\n"
        );
    }
}
