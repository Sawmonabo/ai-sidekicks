//! The checkpoint copies: one file per content, named for the SHA-256 of its bytes in the owner's
//! `captures/copies` folder, so a content copied twice is kept once. A copy is a clone where the
//! volume makes one and a byte copy where it cannot; it is written under a temporary name, flushed,
//! and given its hash's name only whole, never over a copy already there.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_platforms::{
    RegularFileOpen, create_missing_private_folders, create_new_file, flush_folder,
    flush_open_file, open_regular_file,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::clone_open_file::{CloneOpenFileError, clone_open_file};
use sidekicks_std::file::publish_without_replacing::{
    PublishOutcome, blocking_publish_without_replacing,
};
use sidekicks_std::random_hex::random_hex;
use sidekicks_workspace::git::turn_snapshot::capture_folder::CAPTURES_SEGMENT;

/// The folder under the captures folder that holds the copies.
const COPIES_SEGMENT: &str = "copies";

/// The mode a byte copy is made with: its owner's alone.
const BYTE_COPY_MODE: u32 = 0o600;

/// The random bytes in a copy's temporary name, so two copies being written never meet.
const TEMPORARY_NAME_RANDOM_BYTES: usize = 8;

/// The bytes read at a time while a copy is hashed.
const HASH_CHUNK_BYTES: usize = 64 * 1024;

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
    /// A regular file, whose bytes are kept under this hash.
    Copied(Sha256Hex),
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
    /// Opening or reading the file, or making the copy's temporary file, failed before anything
    /// was written; or flushing the copies folder failed once the copy had its name.
    #[error("the checkpoint copy could not be made")]
    Io(#[source] io::Error),
    /// Hashing, flushing or publishing the copy's temporary file failed, with the temporary
    /// file's removal's own failure beside it.
    #[error("the checkpoint copy could not be kept")]
    Publish(#[source] CleanupFailures<io::Error>),
    /// The clone failed for a reason other than the volume refusing it.
    #[error("the file could not be cloned")]
    Clone(#[source] io::Error),
}

impl CopyStore {
    /// Opens the copies folder under `owner_folder`, making it and any missing folder above it
    /// readable by their owner alone. Fails with the make's error.
    pub fn open(owner_folder: &Path) -> io::Result<Self> {
        let folder = owner_folder.join(CAPTURES_SEGMENT).join(COPIES_SEGMENT);
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
        let temporary = self.temporary_path()?;
        let hash = match clone_open_file(&file, &temporary) {
            Ok(()) => self.keep_clone(&temporary)?,
            Err(CloneOpenFileError::Refused(_)) => self.keep_byte_copy(&mut &file)?,
            // A failed clone leaves nothing at the temporary path.
            Err(CloneOpenFileError::Failed(error)) => return Err(FileCopyError::Clone(error)),
        };
        Ok(FileCopyOutcome::Copied(hash))
    }

    /// Keeps a copy of every byte `reader` gives, as a byte copy, and answers its hash.
    pub fn keep_copy_from(&self, mut reader: impl Read) -> Result<Sha256Hex, FileCopyError> {
        self.keep_byte_copy(&mut reader)
    }

    // Hashes the clone at `temporary` and gives it its hash's name.
    fn keep_clone(&self, temporary: &Path) -> Result<Sha256Hex, FileCopyError> {
        let hashed = File::open(temporary).and_then(|clone| {
            let hash = copy_hashing(&mut &clone, &mut io::sink())?;
            Ok((clone, hash))
        });
        match hashed {
            Ok((clone, hash)) => self.publish(temporary, clone, hash),
            Err(failure) => Err(remove_temporary_after(failure, temporary)),
        }
    }

    // Copies `reader`'s bytes into a new temporary file, hashing them, and gives it its hash's
    // name.
    fn keep_byte_copy(&self, reader: &mut impl Read) -> Result<Sha256Hex, FileCopyError> {
        let temporary = self.temporary_path()?;
        let mut copy = create_new_file(&temporary, BYTE_COPY_MODE).map_err(FileCopyError::Io)?;
        match copy_hashing(reader, &mut copy) {
            Ok(hash) => self.publish(&temporary, copy, hash),
            Err(failure) => Err(remove_temporary_after(failure, &temporary)),
        }
    }

    // Gives the whole file at `temporary`, open as `copy`, its hash's name, or removes it when a
    // copy already has that name. Only a newly named copy is flushed, with the folder after it.
    fn publish(
        &self,
        temporary: &Path,
        copy: File,
        hash: Sha256Hex,
    ) -> Result<Sha256Hex, FileCopyError> {
        let target = self.copy_path(&hash);
        match target.try_exists() {
            Ok(true) => {
                fs::remove_file(temporary).map_err(|removal_failure| {
                    FileCopyError::Publish(CleanupFailures::new(
                        removal_failure,
                        Vec::new(),
                        KEEPING,
                    ))
                })?;
                return Ok(hash);
            }
            Ok(false) => {}
            Err(failure) => return Err(remove_temporary_after(failure, temporary)),
        }
        if let Err(failure) = flush_open_file(&copy) {
            return Err(remove_temporary_after(failure, temporary));
        }
        drop(copy);
        match blocking_publish_without_replacing(temporary, &target)
            .map_err(FileCopyError::Publish)?
        {
            PublishOutcome::Published => flush_folder(&self.folder).map_err(FileCopyError::Io)?,
            PublishOutcome::TargetExists => {}
        }
        Ok(hash)
    }

    // A new name in the copies folder: `.<random>.copying`.
    fn temporary_path(&self) -> Result<PathBuf, FileCopyError> {
        let random = random_hex(TEMPORARY_NAME_RANDOM_BYTES)
            .map_err(|failure| FileCopyError::Io(io::Error::other(failure)))?;
        Ok(self.folder.join(format!(".{random}.copying")))
    }
}

// Writes every byte of `reader` to `writer` and answers their SHA-256 in lowercase hex.
fn copy_hashing(reader: &mut impl Read, writer: &mut impl Write) -> io::Result<Sha256Hex> {
    let mut hasher = Sha256::new();
    let mut chunk = vec![0; HASH_CHUNK_BYTES];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let chunk = &chunk[..read];
        hasher.update(chunk);
        writer.write_all(chunk)?;
    }
    Ok(
        Sha256Hex::new(base16ct::lower::encode_string(&hasher.finalize()))
            .expect("a SHA-256 in lowercase hex matches its pattern"),
    )
}

// Removes the temporary file after `failure`, keeping the removal's own failure beside it.
fn remove_temporary_after(failure: io::Error, temporary: &Path) -> FileCopyError {
    let removal_failures = match fs::remove_file(temporary) {
        Ok(()) => Vec::new(),
        Err(removal_failure) => vec![removal_failure],
    };
    FileCopyError::Publish(CleanupFailures::new(failure, removal_failures, KEEPING))
}

#[cfg(test)]
mod tests;
