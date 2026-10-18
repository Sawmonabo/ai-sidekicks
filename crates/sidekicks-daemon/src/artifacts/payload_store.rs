//! The content-addressed store of artifact payloads: a payload is kept once, under its SHA-256, and
//! every manifest over the same bytes references that one copy. The key is the digest, so no
//! caller's string is ever part of a stored path.
//!
//! Writing a payload and recording the reference to it run inside one exclusion per storage key, so
//! a removal deciding whether any reference is left cannot interleave with a write that adds one.
//! The bytes and every folder entry leading to them are flushed to disk before the reference is
//! recorded: a crash between leaves stored bytes nothing references, never a reference to missing
//! bytes, and a record that fails takes back the bytes its own call moved in.

use std::fmt;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};

use crate::artifacts::refusals::ArtifactError;
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::MissingEntry as _;

// The digest's algorithm, the key's prefix and the store's top folder.
const CONTENT_HASH_ALGORITHM: &str = "sha256";

// A SHA-256 digest's length in lowercase hex digits.
const SHA256_HEX_LEN: usize = 64;

/// A payload's content hash, `sha256:<64 lowercase hex digits>`: the manifest's digest and the
/// payload's key in the store.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ContentHash(String);

/// Stored text that is no content hash; it names no value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the stored text is not a sha256 content hash")]
pub(crate) struct NotAContentHash;

impl ContentHash {
    /// The content hash of a payload whose SHA-256 digest is `digest`.
    pub(crate) fn of_sha256(digest: &[u8]) -> Self {
        Self(format!(
            "{CONTENT_HASH_ALGORITHM}:{}",
            base16ct::lower::encode_string(digest)
        ))
    }

    /// Takes stored text back as a content hash, refusing anything but `sha256:` and 64 lowercase
    /// hex digits, so a damaged row can never name a path outside the store.
    pub(crate) fn from_stored(text: String) -> Result<Self, NotAContentHash> {
        let is_content_hash = text
            .strip_prefix(CONTENT_HASH_ALGORITHM)
            .and_then(|rest| rest.strip_prefix(':'))
            .is_some_and(|hex| {
                hex.len() == SHA256_HEX_LEN
                    && hex
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            });
        if is_content_hash {
            Ok(Self(text))
        } else {
            Err(NotAContentHash)
        }
    }

    /// The hash's text, `sha256:<hex>`.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    // The hex digits after the algorithm's prefix.
    fn hex(&self) -> &str {
        &self.0[CONTENT_HASH_ALGORITHM.len() + 1..]
    }
}

impl fmt::Display for ContentHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The content-addressed payload store under one folder.
pub(crate) struct PayloadStore {
    objects_folder: PathBuf,
    storage_key_lock: KeyedLock<ContentHash>,
}

impl PayloadStore {
    /// A store under `objects_folder`, made private here with any missing folder above it, and its
    /// entry flushed into its parent. Blocks on the file system; fails with its failure.
    pub(crate) fn new(objects_folder: PathBuf) -> io::Result<Self> {
        sidekicks_platforms::create_private_folder(&objects_folder)?;
        sidekicks_platforms::flush_folder(
            objects_folder
                .parent()
                .expect("the store's folder is never a file system root"),
        )?;
        Ok(Self {
            objects_folder,
            storage_key_lock: KeyedLock::new(),
        })
    }

    /// Stores the file at `source_path` under `content_hash`, moving it in place, or deleting it
    /// when the same bytes are already stored, then awaits `record_reference` while still holding
    /// the key, and returns what it answers. `source_path` must be on the store's volume. Fails
    /// with the file system's failure or `record_reference`'s; a failed record deletes the bytes
    /// this call moved in, and bytes stored before it stay for the references they have.
    pub(crate) async fn admit<Recorded>(
        &self,
        source_path: PathBuf,
        content_hash: &ContentHash,
        record_reference: impl Future<Output = Result<Recorded, ArtifactError>>,
    ) -> Result<Recorded, ArtifactError> {
        let _key_hold = self.storage_key_lock.acquire(content_hash.clone()).await;
        let object_path = self.object_path_of(content_hash);
        let objects_folder = self.objects_folder.clone();
        let moved_into = object_path.clone();
        let was_stored = tokio::task::spawn_blocking(move || {
            move_into_store(&source_path, &moved_into, &objects_folder)
        })
        .await??;
        let failure = match record_reference.await {
            Ok(recorded) => return Ok(recorded),
            Err(failure) => failure,
        };
        if was_stored {
            return Err(failure);
        }
        // Nothing can have referenced these bytes yet: every reference is recorded under this key.
        let removal = tokio::task::spawn_blocking(move || {
            std::fs::remove_file(&object_path).none_if_missing()
        })
        .await;
        let cleanup_failures = match removal {
            Ok(Ok(_removed)) => Vec::new(),
            Ok(Err(removal_failure)) => vec![removal_failure],
            Err(interrupted) => vec![io::Error::other(interrupted)],
        };
        Err(failure.with_cleanup_failures(cleanup_failures, "taking back the stored payload"))
    }

    /// Where the payload stored under `content_hash` sits, `sha256/ab/abcd…` under the store's
    /// folder: the first two hex digits fan the payloads out over 256 folders.
    pub(crate) fn object_path_of(&self, content_hash: &ContentHash) -> PathBuf {
        let hex = content_hash.hex();
        self.objects_folder
            .join(CONTENT_HASH_ALGORITHM)
            .join(&hex[..2])
            .join(hex)
    }
}

// Moves `source` to `object` and flushes it and each folder entry the move may have made, or
// deletes `source` when `object` is already stored; answers whether it was.
fn move_into_store(source: &Path, object: &Path, objects_folder: &Path) -> io::Result<bool> {
    if object.try_exists()? {
        std::fs::remove_file(source)?;
        return Ok(true);
    }
    let fan_out_folder = object
        .parent()
        .expect("a stored payload sits in its fan-out folder");
    let algorithm_folder = fan_out_folder
        .parent()
        .expect("a fan-out folder sits in the algorithm's folder");
    sidekicks_platforms::flush_file(source)?;
    sidekicks_platforms::create_private_folder(fan_out_folder)?;
    sidekicks_platforms::rename_replacing(source, object)?;
    // Each folder holds the entry of what is below it, any of which this move may have made.
    sidekicks_platforms::flush_folder(fan_out_folder)?;
    sidekicks_platforms::flush_folder(algorithm_folder)?;
    sidekicks_platforms::flush_folder(objects_folder)?;
    Ok(false)
}

#[cfg(test)]
mod tests {
    use sha2::{Digest as _, Sha256};

    use super::{ContentHash, PayloadStore};
    use crate::artifacts::refusals::ArtifactError;

    fn content_hash_of(bytes: &[u8]) -> ContentHash {
        ContentHash::of_sha256(&Sha256::digest(bytes))
    }

    #[tokio::test]
    async fn a_failed_record_takes_back_only_the_bytes_its_own_call_moved_in() {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let store =
            PayloadStore::new(folder.path().join("objects")).expect("the test makes the store");
        let stored_hash = content_hash_of(b"kept");
        let source = folder.path().join("first");
        std::fs::write(&source, b"kept").expect("the test writes a spool");
        store
            .admit(source.clone(), &stored_hash, async { Ok(()) })
            .await
            .expect("the first admit records");
        let stored = store.object_path_of(&stored_hash);
        assert!(stored.exists() && !source.exists());

        // The same bytes again: the source goes, and a failed record leaves the earlier copy.
        let second = folder.path().join("second");
        std::fs::write(&second, b"kept").expect("the test writes a spool");
        let refused = store
            .admit(second.clone(), &stored_hash, async {
                Err::<(), _>(ArtifactError::Disk(std::io::Error::other("refused")))
            })
            .await;
        assert!(refused.is_err());
        assert!(
            !second.exists(),
            "a payload already stored drops its source"
        );
        assert!(stored.exists(), "bytes stored before the call stay");

        // New bytes whose record fails are taken back.
        let new_hash = content_hash_of(b"new");
        let third = folder.path().join("third");
        std::fs::write(&third, b"new").expect("the test writes a spool");
        let refused = store
            .admit(third, &new_hash, async {
                Err::<(), _>(ArtifactError::Disk(std::io::Error::other("refused")))
            })
            .await;
        assert!(refused.is_err());
        assert!(!store.object_path_of(&new_hash).exists());
    }

    #[test]
    fn a_stored_key_outside_the_hash_form_is_refused() {
        let hash = content_hash_of(b"kept");
        assert_eq!(
            ContentHash::from_stored(hash.as_str().to_owned()).as_ref(),
            Ok(&hash)
        );
        let (algorithm, hex) = hash
            .as_str()
            .split_once(':')
            .expect("a hash names its algorithm");
        let uppercase = format!("{algorithm}:{}", hex.to_ascii_uppercase());
        for damaged in ["sha256:../../etc", &uppercase, "md5:00", ""] {
            assert!(ContentHash::from_stored(damaged.to_owned()).is_err());
        }
    }
}
