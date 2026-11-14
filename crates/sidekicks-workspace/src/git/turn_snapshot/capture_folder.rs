//! The capture folder: a bare repository of the daemon's own, one per owner and repository, that
//! every capture step writes its objects and its ref into, so a capture leaves the repository's own
//! `.git` as it was. The repository is attached to each call by `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
//! never by an `objects/info/alternates` file, so the folder packs alone with nothing attached.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sha2::{Digest as _, Sha256};
use sidekicks_contracts::place::Place;
use sidekicks_platforms::{
    create_new_private_folder, create_private_folder, os_text_bytes, os_text_stable_bytes,
    path_from_program_output, rename_replacing,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::remove_tree_awaited;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::random_hex::random_hex;
use tokio::sync::OwnedMutexGuard;

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{GitCall, GitError, GitRunner};
use crate::git::turn_snapshot::capture::{ObjectFormat, UnrecognizedObjectFormat};
use crate::git::turn_snapshot::capture_steps::{INDEX_LOCK_SUFFIX, joined};
use crate::git::turn_snapshot::repack::CapturePacking;

/// The folder under an owner's folder that holds its capture folders.
pub const CAPTURES_SEGMENT: &str = "captures";

/// A git folder's object folder.
pub(crate) const OBJECTS_SEGMENT: &str = "objects";

/// The folder in a capture folder that holds the indexes captures stage into.
pub(crate) const INDEXES_SEGMENT: &str = "indexes";

/// The variable naming the object folder a git call writes into.
const OBJECT_FOLDER_VARIABLE: &str = "GIT_OBJECT_DIRECTORY";

/// The variable listing the object folders a git call also reads.
const ALTERNATE_OBJECT_FOLDERS_VARIABLE: &str = "GIT_ALTERNATE_OBJECT_DIRECTORIES";

/// The hex digits of a real path's name, its sha256: a capture folder's and a kept index's.
const REAL_PATH_NAME_LENGTH: usize = 64;

/// The random bytes in the name of a capture folder still being made, so two makers never meet.
const PARTIAL_NAME_BYTES: usize = 8;

/// The extension that ends the name of a capture folder still being made.
const PARTIAL_EXTENSION: &str = "partial";

/// The name prefix of a capture's scratch index.
const SCRATCH_INDEX_PREFIX: &str = "scratch-";

/// The extension of a capture's scratch index.
const SCRATCH_INDEX_EXTENSION: &str = "index";

const SETUP_OPERATION: &str = "making the capture folder";

/// Why a capture folder could not be opened or made.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CaptureFolderError {
    /// A file system call on the folder or the repository's path failed.
    #[error("the capture folder could not be made or reached")]
    Io(#[source] io::Error),
    /// The name of the folder being made could not be drawn.
    #[error("the capture folder being made could not be named")]
    PartialName(#[source] getrandom::Error),
    /// A git call making the folder failed.
    #[error(transparent)]
    Git(#[from] GitError),
    /// git named an object format this code does not know.
    #[error(transparent)]
    ObjectFormat(#[from] UnrecognizedObjectFormat),
    /// Making the folder failed and removing what was made of it failed too.
    #[error(transparent)]
    Setup(Box<CleanupFailures<CaptureFolderError, io::Error>>),
}

/// Where a capture's git calls write: a git folder for the snapshot refs and its object folder for
/// every object, with the repository's object folder attached to each call. A capture folder is
/// named for the sha256 of the repository's common git folder by its real path, so two checkouts
/// of one repository share one folder and a symlinked spelling of it opens the same one.
#[derive(Clone, Debug)]
pub(crate) struct CaptureFolder {
    /// The git folder the snapshot refs are written in.
    folder: PathBuf,
    /// Its object folder, where every capture write lands.
    objects: PathBuf,
    /// The object folder as one quoted entry of git's alternate list.
    objects_alternate: OsString,
    /// The repository's common object folder, which a write reads the history it builds on from,
    /// as one quoted entry of git's alternate list.
    repository_objects: OsString,
}

impl CaptureFolder {
    /// The capture folder of the repository whose common git folder is `repository`, for the
    /// owner whose folder is `owner`: `<owner>/captures/<sha256 hex of the real path>/`, made once
    /// as a bare repository in the repository's object format, with automatic gc and maintenance
    /// off, and reused when present. A repository whose move `packing` still carries opens at its
    /// new folder's name, once the owner's folder is carried there. Fails as git or the file
    /// system does, and with `AlreadyExists` when that carry finds both names taken.
    pub(crate) async fn open_or_create(
        git: &GitRunner,
        place: Option<&Place>,
        packing: &CapturePacking,
        owner: &Path,
        repository: &Path,
    ) -> Result<Self, CaptureFolderError> {
        let located = Self::locate(packing, owner, repository)
            .await
            .map_err(CaptureFolderError::Io)?;
        let is_present = tokio::fs::try_exists(&located.capture_folder.folder)
            .await
            .map_err(CaptureFolderError::Io)?;
        if !is_present {
            let captures = owner.join(CAPTURES_SEGMENT);
            located
                .capture_folder
                .create(git, place, &located.repository, &captures, &located.name)
                .await?;
        }
        Ok(located.capture_folder)
    }

    /// The capture folder [`open_or_create`](Self::open_or_create) would open for `owner` and the
    /// repository whose common git folder is `repository`, carried as it would carry it, or `None`
    /// when it was never made; nothing is made and no git runs. Fails as the file system does.
    pub(crate) async fn open_existing(
        packing: &CapturePacking,
        owner: &Path,
        repository: &Path,
    ) -> io::Result<Option<Self>> {
        let located = Self::locate(packing, owner, repository).await?;
        let is_present = tokio::fs::try_exists(&located.capture_folder.folder).await?;
        Ok(is_present.then_some(located.capture_folder))
    }

    // Where the capture folder of `owner` and `repository` is, made or not. A name on a carry
    // `packing` holds is carried first, from each old name oldest first, so no folder opens at the
    // new name while an old one holds the repository's captures, and a stored old common folder
    // reads the newest one's objects. A name on a carry whose move's write is out waits for it, so
    // nothing is renamed for a move that is then refused.
    async fn locate(
        packing: &CapturePacking,
        owner: &Path,
        repository: &Path,
    ) -> io::Result<LocatedCaptureFolder> {
        let name = real_path_name(repository).await?;
        let captures = owner.join(CAPTURES_SEGMENT);
        loop {
            match packing.carries().pending(&name) {
                None => {
                    return Ok(LocatedCaptureFolder {
                        capture_folder: Self::new(
                            captures.join(&name),
                            &repository.join(OBJECTS_SEGMENT),
                        )?,
                        repository: repository.to_path_buf(),
                        name,
                    });
                }
                Some(PendingCarry::Awaited(write)) => drop(write.lock().await),
                Some(PendingCarry::Written(carry)) => {
                    let to = captures.join(&carry.new_name);
                    for old_name in &carry.old_names {
                        packing
                            .move_capture_folder(&captures.join(old_name), &to)
                            .await?;
                    }
                    return Ok(LocatedCaptureFolder {
                        capture_folder: Self::new(to, &carry.moved_to.join(OBJECTS_SEGMENT))?,
                        repository: carry.moved_to,
                        name: carry.new_name,
                    });
                }
            }
        }
    }

    // The capture folder at the git folder `folder`, attaching the object folder
    // `repository_objects` to its writes.
    fn new(folder: PathBuf, repository_objects: &Path) -> io::Result<Self> {
        let objects = folder.join(OBJECTS_SEGMENT);
        Ok(Self {
            objects_alternate: quote_alternate(&objects)?,
            repository_objects: quote_alternate(repository_objects)?,
            objects,
            folder,
        })
    }

    /// The git folder the snapshot refs are written in and read from.
    pub(crate) fn folder(&self) -> &Path {
        &self.folder
    }

    /// The folder holding the indexes captures stage into; made by the first capture that needs
    /// it.
    pub(crate) fn indexes_folder(&self) -> PathBuf {
        self.folder.join(INDEXES_SEGMENT)
    }

    /// The scratch index named for `name` in the indexes folder, which one capture stages into and
    /// removes when it ends.
    pub(crate) fn scratch_index(&self, name: &str) -> PathBuf {
        self.indexes_folder().join(format!(
            "{SCRATCH_INDEX_PREFIX}{name}.{SCRATCH_INDEX_EXTENSION}"
        ))
    }

    /// The variables of a call in this folder that must see the repository's history, a write or a
    /// read: its objects go to this folder's object folder and the repository's is attached.
    pub(crate) fn write_environment(&self) -> [(&'static str, &OsStr); 2] {
        [
            (OBJECT_FOLDER_VARIABLE, self.objects.as_os_str()),
            (ALTERNATE_OBJECT_FOLDERS_VARIABLE, &self.repository_objects),
        ]
    }

    /// The variable of a call run in the repository that must see the captures: this folder's
    /// object folder attached.
    pub(crate) fn read_environment(&self) -> [(&'static str, &OsStr); 1] {
        [(ALTERNATE_OBJECT_FOLDERS_VARIABLE, &self.objects_alternate)]
    }

    // Makes the folder beside its place under a name no other maker draws, then renames it in, so
    // a maker that stops midway leaves no half-made folder in its place; one another maker put
    // there first is kept.
    async fn create(
        &self,
        git: &GitRunner,
        place: Option<&Place>,
        repository: &Path,
        captures: &Path,
        name: &str,
    ) -> Result<(), CaptureFolderError> {
        let suffix = random_hex(PARTIAL_NAME_BYTES).map_err(CaptureFolderError::PartialName)?;
        let partial = captures.join(format!("{name}.{suffix}.{PARTIAL_EXTENSION}"));
        let (parent, made) = (captures.to_path_buf(), partial.clone());
        joined(
            tokio::task::spawn_blocking(move || {
                create_private_folder(&parent)?;
                create_new_private_folder(&made)
            })
            .await,
        )
        .map_err(CaptureFolderError::Io)?;
        let placed = match self.set_up(git, place, repository, &partial).await {
            Ok(()) => {
                let (from, to) = (partial.clone(), self.folder.clone());
                joined(tokio::task::spawn_blocking(move || rename_replacing(&from, &to)).await)
                    .map_err(CaptureFolderError::Io)
            }
            Err(failure) => Err(failure),
        };
        let Err(failure) = placed else {
            return Ok(());
        };
        let removed = remove_tree_awaited(&partial).await;
        // A folder another maker renamed in first is a whole one, so this maker only lost the
        // place to it.
        if removed.is_ok()
            && tokio::fs::try_exists(&self.folder)
                .await
                .map_err(CaptureFolderError::Io)?
        {
            return Ok(());
        }
        Err(CaptureFolderError::Setup(Box::new(CleanupFailures::new(
            failure,
            removed.err().into_iter().collect(),
            SETUP_OPERATION,
        ))))
    }

    // `partial` as a bare repository in the object format of the repository at `repository` and the
    // files ref format, with automatic gc and maintenance off, so nothing packs or prunes the
    // captures but the daemon.
    // Pruning is off too: since git 2.54 a maintenance run's geometric strategy reads no `gc.auto`
    // and its cruft repack expires unreachable objects after two weeks, and a capture with no ref
    // is unreachable.
    async fn set_up(
        &self,
        git: &GitRunner,
        place: Option<&Place>,
        repository: &Path,
        partial: &Path,
    ) -> Result<(), CaptureFolderError> {
        let format_read = GitCall::read([
            git_folder_argument(repository),
            "rev-parse".into(),
            "--show-object-format".into(),
        ]);
        let output = git.run(place, format_read).await?;
        let format = ObjectFormat::from_show_object_format(&output.stdout)?;
        // An empty template, so the person's template folder adds no hooks or settings here.
        let init = GitCall::read([
            OsString::from("init"),
            "--quiet".into(),
            "--bare".into(),
            "--template=".into(),
            format!("--object-format={}", format.name()).into(),
            partial.into(),
        ])
        // A ref write in a reftable folder deletes tables outside the packing lock; the variable
        // outranks the person's settings, and a git before 2.44 knows only the files format.
        .with_environment("GIT_DEFAULT_REF_FORMAT", "files");
        git.run(place, init).await?;
        for [key, value] in [
            ["gc.auto", "0"],
            ["maintenance.auto", "false"],
            ["gc.pruneExpire", "never"],
        ] {
            let setting = GitCall::read([
                git_folder_argument(partial),
                "config".into(),
                key.into(),
                value.into(),
            ]);
            git.run(place, setting).await?;
        }
        Ok(())
    }
}

// A capture folder found, the common git folder it reads objects from and its name.
struct LocatedCaptureFolder {
    capture_folder: CaptureFolder,
    repository: PathBuf,
    name: String,
}

/// One moved repository's capture folders still to be renamed from each of its old common folders'
/// names to its newest one's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CaptureCarry {
    /// The old common folders' names, oldest first, the newest name never among them.
    old_names: Vec<String>,
    /// The newest common folder's name.
    new_name: String,
    /// The newest common folder.
    moved_to: PathBuf,
}

impl CaptureCarry {
    /// The carry of the repository whose common git folder moved from each of `moved_from` in turn,
    /// oldest first, to `moved_to`; a folder resolving to the newest name, as one moved back does,
    /// is no old one. Fails as resolving a path does.
    pub(crate) async fn new(moved_from: &[PathBuf], moved_to: &Path) -> io::Result<Self> {
        let new_name = real_path_name(moved_to).await?;
        let mut old_names: Vec<String> = Vec::with_capacity(moved_from.len());
        for folder in moved_from {
            let name = real_path_name(folder).await?;
            if name != new_name && !old_names.contains(&name) {
                old_names.push(name);
            }
        }
        Ok(Self {
            old_names,
            new_name,
            moved_to: moved_to.to_path_buf(),
        })
    }

    /// The old common folders' names, oldest first, which each owner's capture folder is renamed
    /// from.
    pub(crate) fn old_names(&self) -> &[String] {
        &self.old_names
    }

    /// The newest common folder's name, which each owner's capture folder is renamed to.
    pub(crate) fn new_name(&self) -> &str {
        &self.new_name
    }

    /// Whether the folders are renamed: a checkout that moved within its repository, whose common
    /// folder stayed, keeps its capture folders' names.
    pub(crate) fn is_rename(&self) -> bool {
        !self.old_names.is_empty()
    }

    /// The newest common folder, which the stored rows are rewritten to.
    pub(crate) fn moved_to(&self) -> &Path {
        &self.moved_to
    }

    // Whether `name` is an end of the carry, old or new.
    fn holds_name(&self, name: &str) -> bool {
        self.new_name == name || self.old_names.iter().any(|old_name| old_name == name)
    }

    // Whether every name of `other` is one of this carry's.
    fn covers(&self, other: &Self) -> bool {
        self.holds_name(&other.new_name) && other.old_names.iter().all(|name| self.holds_name(name))
    }
}

/// The carries this daemon run holds pending, each from before its move's write until the write
/// that ends it: a capture folder named for an end of one opens only once its owner's folder is
/// renamed to the newest name, and one named for a carry whose move's write is out waits for that
/// write's end.
#[derive(Debug, Default)]
pub(crate) struct CaptureCarries {
    /// The carries pending, each written carry the one chain of its repository's moves.
    pending: Mutex<Vec<HeldCarry>>,
}

// A pending carry, and while its move's write is out, that write.
#[derive(Debug)]
struct HeldCarry {
    carry: CaptureCarry,
    write: Option<MoveWrite>,
}

// A move's write still out: the name of the common folder of the mount it ends, whose written
// carry it takes forward, and the lock it holds until it ends.
#[derive(Debug)]
struct MoveWrite {
    replaced_name: String,
    lock: Arc<tokio::sync::Mutex<()>>,
}

// What an opener finds pending for a capture folder name.
enum PendingCarry {
    // A carry whose write committed, to carry before opening.
    Written(CaptureCarry),
    // The lock of a move's write still out, to wait on before looking again.
    Awaited(Arc<tokio::sync::Mutex<()>>),
}

impl CaptureCarries {
    /// Holds `carry`, whose move's write committed in an earlier run, pending in place of every
    /// carry it covers; a carry that renames nothing is never held, since no folder waits for it.
    pub(crate) fn expect(&self, carry: CaptureCarry) {
        if !carry.is_rename() {
            return;
        }
        let mut pending = lock(&self.pending);
        pending.retain(|held| held.write.is_some() || !carry.covers(&held.carry));
        pending.push(HeldCarry { carry, write: None });
    }

    /// Holds `carry` pending while the write of its move, which ends the mount whose common folder
    /// is named `replaced_name`, is out: a capture folder named for an end of it, or of the written
    /// carry ending at `replaced_name`, waits until the answer is written or dropped, so nothing is
    /// renamed for a write that is refused.
    pub(crate) fn expect_write(
        &self,
        replaced_name: String,
        carry: CaptureCarry,
    ) -> CaptureCarryWrite<'_> {
        let write_lock = Arc::new(tokio::sync::Mutex::new(()));
        let hold = Arc::clone(&write_lock)
            .try_lock_owned()
            .expect("a lock no one else holds yet is free");
        lock(&self.pending).push(HeldCarry {
            carry: carry.clone(),
            write: Some(MoveWrite {
                replaced_name: replaced_name.clone(),
                lock: Arc::clone(&write_lock),
            }),
        });
        CaptureCarryWrite {
            carries: self,
            carry,
            replaced_name,
            write: Some((write_lock, hold)),
        }
    }

    /// Ends every written carry `carry` covers, once the rows name the newest folder.
    pub(crate) fn finish(&self, carry: &CaptureCarry) {
        lock(&self.pending).retain(|held| held.write.is_some() || !carry.covers(&held.carry));
    }

    // What is pending for the capture folder name `name`: the lock of a move's write still out
    // that it waits on, or else the written carry it is an end of.
    fn pending(&self, name: &str) -> Option<PendingCarry> {
        let pending = lock(&self.pending);
        let is_written_on = |replaced_name: &str| {
            pending.iter().any(|held| {
                held.write.is_none()
                    && held.carry.new_name == replaced_name
                    && held.carry.holds_name(name)
            })
        };
        let awaited = pending.iter().find_map(|held| {
            let write = held.write.as_ref()?;
            (held.carry.holds_name(name)
                || write.replaced_name == name
                || is_written_on(&write.replaced_name))
            .then(|| Arc::clone(&write.lock))
        });
        if let Some(write_lock) = awaited {
            return Some(PendingCarry::Awaited(write_lock));
        }
        pending
            .iter()
            .find(|held| held.write.is_none() && held.carry.holds_name(name))
            .map(|held| PendingCarry::Written(held.carry.clone()))
    }

    // Takes the move's write `write_lock` names out of the pending carries.
    fn remove_write(pending: &mut Vec<HeldCarry>, write_lock: &Arc<tokio::sync::Mutex<()>>) {
        pending.retain(|held| {
            !held
                .write
                .as_ref()
                .is_some_and(|write| Arc::ptr_eq(&write.lock, write_lock))
        });
    }
}

/// A move's carry held pending while its write is out. [`written`](Self::written) once the write
/// commits; dropped otherwise, which withdraws it. Either way an opener waiting on it looks again
/// only once the pending carries say what the write did.
pub(crate) struct CaptureCarryWrite<'a> {
    /// The pending carries it is held in.
    carries: &'a CaptureCarries,
    /// The move's own carry.
    carry: CaptureCarry,
    /// The name of the ended mount's common folder.
    replaced_name: String,
    /// The write's lock and its hold, until the write's end is known.
    write: Option<(Arc<tokio::sync::Mutex<()>>, OwnedMutexGuard<()>)>,
}

impl CaptureCarryWrite<'_> {
    /// Ends the wait as the move's write committed: the written carry ending at the ended mount's
    /// name is taken into this one, as the write took its record forward, and the chain is held
    /// pending as one written carry unless it renames nothing. Answers that chain, the carry the
    /// move runs.
    pub(crate) fn written(mut self) -> CaptureCarry {
        let write = self.write.take();
        let mut pending = lock(&self.carries.pending);
        if let Some((write_lock, _)) = &write {
            CaptureCarries::remove_write(&mut pending, write_lock);
        }
        let mut old_names = Vec::new();
        pending.retain(|held| {
            let is_taken = held.write.is_none() && held.carry.new_name == self.replaced_name;
            if is_taken {
                old_names.extend(held.carry.old_names.iter().cloned());
                old_names.push(held.carry.new_name.clone());
            }
            !is_taken
        });
        old_names.extend(self.carry.old_names.iter().cloned());
        let mut chain_names: Vec<String> = Vec::with_capacity(old_names.len());
        for name in old_names {
            if name != self.carry.new_name && !chain_names.contains(&name) {
                chain_names.push(name);
            }
        }
        let chain = CaptureCarry {
            old_names: chain_names,
            new_name: self.carry.new_name.clone(),
            moved_to: self.carry.moved_to.clone(),
        };
        if chain.is_rename() {
            pending.push(HeldCarry {
                carry: chain.clone(),
                write: None,
            });
        }
        drop(pending);
        // Released only now, so an opener waiting on the write finds the chain.
        drop(write);
        chain
    }
}

impl Drop for CaptureCarryWrite<'_> {
    fn drop(&mut self) {
        if let Some((write_lock, hold)) = self.write.take() {
            CaptureCarries::remove_write(&mut lock(&self.carries.pending), &write_lock);
            drop(hold);
        }
    }
}

/// Whether `folder` is a capture folder by its path: its name is 64 lowercase hex digits and its
/// parent is an owner's captures folder, so a copy, a large file's folder and a folder still being
/// made are not.
pub fn is_capture_folder(folder: &Path) -> bool {
    let is_captures_parent = folder
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|parent| parent == CAPTURES_SEGMENT);
    let is_capture_name = folder
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(is_real_path_name);
    is_captures_parent && is_capture_name
}

/// Whether `name` is one [`real_path_name`] gives: 64 lowercase hex digits.
pub(crate) fn is_real_path_name(name: &str) -> bool {
    name.len() == REAL_PATH_NAME_LENGTH
        && name
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether `name`, an entry of an owner's captures folder, names a capture folder still being made:
/// `<name>.<suffix>.partial`. A name that is not UTF-8 is none.
pub(crate) fn is_partial_capture_folder_name(name: &OsStr) -> bool {
    name.to_str()
        .and_then(|name| name.strip_suffix(PARTIAL_EXTENSION))
        .and_then(|stem| stem.strip_suffix('.'))
        .is_some_and(|stem| !stem.is_empty())
}

/// Whether `name`, an entry of a capture folder's indexes folder, names a scratch index or git's
/// lock file beside one. A name that is not UTF-8 is none.
pub(crate) fn is_scratch_index_file_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let index_name = name.strip_suffix(INDEX_LOCK_SUFFIX).unwrap_or(name);
    index_name
        .strip_prefix(SCRATCH_INDEX_PREFIX)
        .and_then(|rest| rest.strip_suffix(SCRATCH_INDEX_EXTENSION))
        .is_some_and(|rest| rest.ends_with('.'))
}

/// The sha256 of `folder`'s real path as lowercase hex, so every spelling of one folder gives one
/// name. Fails as resolving the path does.
pub(crate) async fn real_path_name(folder: &Path) -> io::Result<String> {
    let real_folder = canonical_folder_path(folder).await?;
    Ok(base16ct::lower::encode_string(&Sha256::digest(
        os_text_stable_bytes(real_folder.as_os_str()),
    )))
}

/// `--git-dir=<folder>`, the argument that runs a call against the git folder `folder`.
pub(crate) fn git_folder_argument(folder: &Path) -> OsString {
    let mut argument = OsString::from("--git-dir=");
    argument.push(folder);
    argument
}

/// The arguments of a call against the git folder `folder`: each of `settings` in turn, then
/// `--git-dir=<folder>` and `arguments`.
pub(crate) fn in_git_folder(
    folder: &Path,
    settings: &[&[&str]],
    arguments: &[&str],
) -> Vec<OsString> {
    settings
        .iter()
        .flat_map(|setting| setting.iter().map(OsString::from))
        .chain([git_folder_argument(folder)])
        .chain(arguments.iter().map(OsString::from))
        .collect()
}

// `objects` as one entry of git's alternate list, in the C-style quotes git reads there, so a path
// holding the list's separator or a quote stays one entry. Fails for a path this system cannot
// give as bytes.
fn quote_alternate(objects: &Path) -> io::Result<OsString> {
    let bytes = os_text_bytes(objects.as_os_str())?;
    let mut quoted = Vec::with_capacity(bytes.len() + 2);
    quoted.push(b'"');
    for &byte in bytes.iter() {
        if byte == b'"' || byte == b'\\' {
            quoted.push(b'\\');
        }
        quoted.push(byte);
    }
    quoted.push(b'"');
    path_from_program_output(quoted).map(PathBuf::into_os_string)
}

#[cfg(test)]
mod tests;
