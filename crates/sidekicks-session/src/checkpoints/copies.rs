//! The checkpoint copies: one file per content, named for the SHA-256 of its bytes in the owner's
//! `captures/copies` folder, so a content copied twice is kept once. A copy is a clone where the
//! volume makes one and a byte copy where it cannot; it is written under a temporary name, flushed,
//! and given its hash's name only whole, never over a copy already there. A copy already there is
//! taken as it stands, its times untouched, so every keeper holds the session's [`COPIES_LOCK`]
//! shared until a row names its copy, and the orphans walk removes none meanwhile.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{
    RegularFileOpen, create_missing_private_folders, create_new_file, file_mode_of, flush_file,
    flush_folder, flush_open_file, open_regular_file,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::clone_open_file::{CloneOpenFileError, clone_open_file};
use sidekicks_std::file::hashing_copy::copy_with_sha256;
use sidekicks_std::file::publish_without_replacing::{
    PublishOutcome, blocking_publish_without_replacing,
};
use sidekicks_std::file::removal_after_failure::remove_file_after_failure;
use sidekicks_std::keyed_lock::read_write::KeyedReadWriteLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::random_hex::random_hex;
use sidekicks_workspace::git::turn_snapshot::capture_folder::CAPTURES_SEGMENT;

/// The folder under the captures folder that holds the copies.
const COPIES_SEGMENT: &str = "copies";

/// The suffix of a copy's temporary name, `.<random>.copying`.
const TEMPORARY_SUFFIX: &str = ".copying";

/// Each session's copies lock: held shared by every keeper of a copy or a clone, from before it
/// keeps it until the write of the row that names it returns, and exclusive by the orphans walk
/// while it reads the names again and removes what they leave unnamed. One hold per operation, the
/// copies lock taken before the command windows' shadow lock.
pub static COPIES_LOCK: LazyLock<KeyedReadWriteLock<SessionId>> =
    LazyLock::new(KeyedReadWriteLock::new);

/// The sessions a keeper's row write failed for since the orphans walk last took them: what it
/// kept may lie unnamed with no later activity to bring the session to a walk.
static UNNAMED_KEEP_SESSIONS: LazyLock<Mutex<HashSet<SessionId>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Marks `session_id` for the next orphans walk, whatever its activity, after a keeper's write of
/// the row naming what it kept failed.
pub(crate) fn mark_unnamed_keep_session(session_id: SessionId) {
    lock(&UNNAMED_KEEP_SESSIONS).insert(session_id);
}

/// Takes the sessions [`mark_unnamed_keep_session`] marked since the last take.
pub(crate) fn take_unnamed_keep_sessions() -> HashSet<SessionId> {
    mem::take(&mut *lock(&UNNAMED_KEEP_SESSIONS))
}

/// The mode a byte copy is made with: its owner's alone.
const BYTE_COPY_MODE: u32 = 0o600;

/// The random bytes in a copy's temporary name, so two copies being written never meet.
const TEMPORARY_NAME_RANDOM_BYTES: usize = 8;

/// What keeping a copy names as its operation when cleaning up after it fails too.
const KEEPING: &str = "keeping a checkpoint copy";

/// An owner's folder of checkpoint copies. Every call blocks on the file system, so the caller
/// runs it off the async workers.
#[derive(Clone, Debug)]
pub struct CopyStore {
    /// `<owner>/captures/copies`.
    folder: PathBuf,
}

/// What stood at a path a copy was asked of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileCopyOutcome {
    /// A regular file, whose bytes were kept.
    Copied {
        /// The SHA-256 its copy is named for.
        hash: Sha256Hex,
        /// Its permission bits as a Unix mode (the low twelve), which a put-back gives it again.
        mode: u32,
    },
    /// Nothing: the path, or a folder on its way, was not found.
    Gone,
    /// A link, which was not followed.
    Link,
    /// A pipe, a socket, a device or a folder.
    SpecialFile,
}

/// Why a copy could not be kept. No failure leaves a temporary file behind unless its removal
/// failed too, which the failure then carries.
#[derive(Debug, thiserror::Error)]
pub enum FileCopyError {
    /// Opening or reading the file, reading its mode, or making the copy's temporary file, failed
    /// before anything was written; or flushing the copies folder failed once a copy had its name.
    #[error("the checkpoint copy could not be made")]
    Io(#[source] io::Error),
    /// A step on the copy's temporary file failed once it existed (hashing it, checking for a
    /// copy already named, flushing or publishing it), with the temporary file's removal's own
    /// failure beside it.
    #[error("the checkpoint copy could not be kept")]
    TemporaryFile(#[source] CleanupFailures<io::Error>),
    /// The clone failed for a reason other than the volume refusing it.
    #[error("the file could not be cloned")]
    Clone(#[source] io::Error),
}

impl CopyStore {
    /// Opens the copies folder under `owner_folder`, making it and any missing folder above it
    /// readable by their owner alone. Fails with the make's error.
    pub fn open(owner_folder: &Path) -> io::Result<Self> {
        let folder = copies_folder(owner_folder);
        create_missing_private_folders(&folder)?;
        Ok(Self { folder })
    }

    /// Where the copy of the content hashed `hash` is kept.
    pub fn copy_path(&self, hash: &Sha256Hex) -> PathBuf {
        self.folder.join(hash.as_str())
    }

    /// Keeps a copy of the regular file at the absolute `path`, opened through no link, or answers
    /// what stood there instead. Fails with `InvalidInput` as [`FileCopyError::Io`] when `path`
    /// has no parent or no name, and with any other open's error there: only a not-found open is
    /// [`FileCopyOutcome::Gone`].
    pub fn keep_file_copy(&self, path: &Path) -> Result<FileCopyOutcome, FileCopyError> {
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Err(FileCopyError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a copied path has a parent and a name",
            )));
        };
        let file = match open_regular_file(parent, Path::new(name)) {
            Ok(RegularFileOpen::Opened(file)) => file,
            Ok(RegularFileOpen::Gone) => return Ok(FileCopyOutcome::Gone),
            Ok(RegularFileOpen::Link) => return Ok(FileCopyOutcome::Link),
            Ok(RegularFileOpen::SpecialFile) => return Ok(FileCopyOutcome::SpecialFile),
            // The file's own folder was not found, or is no folder, so the file is absent too.
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                return Ok(FileCopyOutcome::Gone);
            }
            Err(error) => return Err(FileCopyError::Io(error)),
        };
        let mode = file_mode_of(&file).map_err(FileCopyError::Io)?;
        let temporary = self.temporary_path()?;
        let hash = match clone_open_file(&file, &temporary) {
            Ok(()) => self.keep_clone(&temporary)?,
            Err(CloneOpenFileError::Refused(_)) => self.keep_byte_copy(&mut &file)?,
            // A failed clone leaves nothing at the temporary path.
            Err(CloneOpenFileError::Failed(error)) => return Err(FileCopyError::Clone(error)),
        };
        Ok(FileCopyOutcome::Copied { hash, mode })
    }

    /// Keeps a copy of every byte `reader` gives, as a byte copy, and answers its hash.
    pub fn keep_copy_from(&self, mut reader: impl Read) -> Result<Sha256Hex, FileCopyError> {
        self.keep_byte_copy(&mut reader)
    }

    // Hashes the clone at `temporary` and gives it its hash's name. The clone carries its source's
    // read-only bit, so it is flushed by path, which opens it for writing where a flush needs that.
    fn keep_clone(&self, temporary: &Path) -> Result<Sha256Hex, FileCopyError> {
        let hashed =
            File::open(temporary).and_then(|clone| copy_hashing(&mut &clone, &mut io::sink()));
        match hashed {
            Ok(hash) => self.publish(temporary, hash, || flush_file(temporary)),
            Err(failure) => Err(FileCopyError::TemporaryFile(remove_file_after_failure(
                failure, temporary, KEEPING,
            ))),
        }
    }

    // Copies `reader`'s bytes into a new temporary file, hashing them, and gives it its hash's
    // name.
    fn keep_byte_copy(&self, reader: &mut impl Read) -> Result<Sha256Hex, FileCopyError> {
        let temporary = self.temporary_path()?;
        let mut copy = create_new_file(&temporary, BYTE_COPY_MODE).map_err(FileCopyError::Io)?;
        match copy_hashing(reader, &mut copy) {
            Ok(hash) => self.publish(&temporary, hash, move || flush_open_file(&copy)),
            Err(failure) => Err(FileCopyError::TemporaryFile(remove_file_after_failure(
                failure, &temporary, KEEPING,
            ))),
        }
    }

    // Gives the whole file at `temporary` its hash's name, or removes it when a copy already has
    // that name. Only a newly named copy is flushed, through `flush`; the folder is flushed either
    // way, so a copy another writer named is on disk before a row names it.
    fn publish(
        &self,
        temporary: &Path,
        hash: Sha256Hex,
        flush: impl FnOnce() -> io::Result<()>,
    ) -> Result<Sha256Hex, FileCopyError> {
        let target = self.copy_path(&hash);
        match target.try_exists() {
            Ok(true) => {
                fs::remove_file(temporary).map_err(|removal_failure| {
                    FileCopyError::TemporaryFile(CleanupFailures::new(
                        removal_failure,
                        Vec::new(),
                        KEEPING,
                    ))
                })?;
                flush_folder(&self.folder).map_err(FileCopyError::Io)?;
                return Ok(hash);
            }
            Ok(false) => {}
            Err(failure) => {
                return Err(FileCopyError::TemporaryFile(remove_file_after_failure(
                    failure, temporary, KEEPING,
                )));
            }
        }
        if let Err(failure) = flush() {
            return Err(FileCopyError::TemporaryFile(remove_file_after_failure(
                failure, temporary, KEEPING,
            )));
        }
        // Published or found named by another writer, the copy is flushed with its folder.
        let (PublishOutcome::Published | PublishOutcome::TargetExists) =
            blocking_publish_without_replacing(temporary, &target)
                .map_err(FileCopyError::TemporaryFile)?;
        flush_folder(&self.folder).map_err(FileCopyError::Io)?;
        Ok(hash)
    }

    // A new name in the copies folder: `.<random>` and the temporary suffix.
    fn temporary_path(&self) -> Result<PathBuf, FileCopyError> {
        let random = random_hex(TEMPORARY_NAME_RANDOM_BYTES)
            .map_err(|failure| FileCopyError::Io(io::Error::other(failure)))?;
        Ok(self.folder.join(format!(".{random}{TEMPORARY_SUFFIX}")))
    }
}

/// `<owner>/captures/copies`, the folder of `owner_folder`'s copies, made or not.
pub fn copies_folder(owner_folder: &Path) -> PathBuf {
    owner_folder.join(CAPTURES_SEGMENT).join(COPIES_SEGMENT)
}

/// Whether `name` in the copies folder is a copy's temporary file, written before the copy has
/// its hash's name.
pub fn is_copy_temporary(name: &OsStr) -> bool {
    name.to_str()
        .is_some_and(|name| name.starts_with('.') && name.ends_with(TEMPORARY_SUFFIX))
}

// Writes every byte of `reader` to `writer` and answers their SHA-256 in lowercase hex.
fn copy_hashing(reader: &mut impl Read, writer: &mut impl Write) -> io::Result<Sha256Hex> {
    let digest = copy_with_sha256(reader, writer, |_| {})?;
    Ok(Sha256Hex::new(base16ct::lower::encode_string(&digest))
        .expect("a SHA-256 in lowercase hex matches its pattern"))
}

#[cfg(test)]
pub(crate) mod tests;
