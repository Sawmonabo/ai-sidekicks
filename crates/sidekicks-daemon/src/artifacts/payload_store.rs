//! The content-addressed store of artifact payloads: a payload is kept once, under its SHA-256, and
//! every manifest over the same bytes references that one copy. The key is the digest, so no
//! caller's string is ever part of a stored path.
//!
//! Writing a payload and recording the reference to it run inside one exclusion per storage key, so
//! a removal deciding whether any reference is left cannot interleave with a write that adds one.
//! The bytes and every folder entry leading to them are flushed to disk before the reference is
//! recorded: a crash between leaves stored bytes nothing references, never a reference to missing
//! bytes, and a record that fails takes back the bytes its own call moved in.
//!
//! A payload goes only once no reference names it, the count derived again under its key, never
//! kept: a session's purge reclaims the payloads its rows named once they are deleted, and the
//! orphan sweep reclaims bytes a crash left behind with nothing naming them.

use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension as _;

use crate::artifacts::refusals::ArtifactError;
use crate::daemon::scheduler::budget::ProcessorMeter;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::{MissingEntry as _, is_missing_entry};

// The digest's algorithm, the key's prefix and the store's top folder.
const CONTENT_HASH_ALGORITHM: &str = "sha256";

// A SHA-256 digest's length in lowercase hex digits.
const SHA256_HEX_LEN: usize = 64;

// Whether any reference still names a storage key.
const KEY_REFERENCED_SQL: &str = "SELECT 1 FROM artifact_payload_refs WHERE storage_path = ?1";

// Every storage key a reference names.
const REFERENCED_KEYS_SQL: &str = "SELECT DISTINCT storage_path FROM artifact_payload_refs";

/// Why a payload no reference names was not reclaimed; the orphan sweep tries it again.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PayloadReclaimError {
    /// SQLite refused the count of the payload's references.
    #[error("the payload's references could not be counted")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The store's folder could not be listed or the payload's file not removed.
    #[error("the stored payload could not be removed")]
    Disk(#[from] io::Error),
}

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

    /// Unlinks each payload of `content_hashes` that no reference names any more, whether one does
    /// read on `reads` under the payload's key, so an admit of the same bytes keeps them; for a
    /// purge, after its rows' delete committed. A payload already gone counts as removed; one whose
    /// read or removal fails is logged and left to the orphan sweep.
    pub(crate) async fn reclaim_unreferenced(
        &self,
        reads: &DatabaseReadPool,
        content_hashes: impl IntoIterator<Item = ContentHash>,
    ) {
        for content_hash in content_hashes {
            if let Err(error) = self.reclaim(reads, content_hash).await {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "a stored payload no reference names was not removed; the orphan sweep \
                     removes it"
                );
            }
        }
    }

    /// Reclaims every stored payload no reference names, as
    /// [`PayloadStore::reclaim_unreferenced`] does, for bytes a crash left behind: run at the
    /// daemon's start and on the ingest reaper's cadence, its listing charged to `meter`. Answers
    /// the payloads it examined, each one stored. Fails when the store's folder cannot be listed or
    /// the referenced keys read.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start schedules the reaper, whose pass sweeps"
        )
    )]
    pub(crate) async fn sweep_orphans(
        &self,
        reads: &DatabaseReadPool,
        meter: &ProcessorMeter,
    ) -> Result<u64, PayloadReclaimError> {
        let algorithm_folder = self.objects_folder.join(CONTENT_HASH_ALGORITHM);
        let stored = meter
            .run_blocking(move || list_stored(&algorithm_folder))
            .await
            .map_err(io::Error::other)??;
        let referenced = reads
            .read(ReadLength::Long, |connection| {
                connection
                    .prepare_cached(REFERENCED_KEYS_SQL)?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<HashSet<String>>>()
                    .map_err(PayloadReclaimError::from)
            })
            .await?;
        let examined = u64::try_from(stored.len()).expect("a payload count fits in u64");
        // Each is read again under its key, since an admit may reference it after the list.
        let orphans = stored
            .into_iter()
            .filter(|content_hash| !referenced.contains(content_hash.as_str()));
        self.reclaim_unreferenced(reads, orphans).await;
        Ok(examined)
    }

    // Removes the payload once, under its key, no reference names it.
    async fn reclaim(
        &self,
        reads: &DatabaseReadPool,
        content_hash: ContentHash,
    ) -> Result<(), PayloadReclaimError> {
        let _key_hold = self.storage_key_lock.acquire(content_hash.clone()).await;
        let key = content_hash.as_str().to_owned();
        let is_referenced = reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(KEY_REFERENCED_SQL)?
                    .query_row([key], |_row| Ok(()))
                    .optional()
                    .map(|found| found.is_some())
                    .map_err(PayloadReclaimError::from)
            })
            .await?;
        if is_referenced {
            return Ok(());
        }
        let object_path = self.object_path_of(&content_hash);
        tokio::task::spawn_blocking(move || std::fs::remove_file(&object_path).none_if_missing())
            .await
            .map_err(io::Error::other)??;
        Ok(())
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

// Every payload under the algorithm's folder, by the names of its fan-out folders' files; an
// entry not named as a payload is no payload of the store's and is passed over.
fn list_stored(algorithm_folder: &Path) -> io::Result<Vec<ContentHash>> {
    let fan_out_folders = match std::fs::read_dir(algorithm_folder) {
        Ok(entries) => entries,
        Err(error) if is_missing_entry(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut stored = Vec::new();
    for fan_out_folder in fan_out_folders {
        for entry in std::fs::read_dir(fan_out_folder?.path())? {
            let name = entry?.file_name();
            if let Some(hex) = name.to_str()
                && let Ok(content_hash) =
                    ContentHash::from_stored(format!("{CONTENT_HASH_ALGORITHM}:{hex}"))
            {
                stored.push(content_hash);
            }
        }
    }
    Ok(stored)
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
    use std::sync::Arc;

    use sha2::{Digest as _, Sha256};
    use tokio::sync::oneshot;

    use super::{ContentHash, PayloadStore};
    use crate::artifacts::refusals::ArtifactError;
    use crate::artifacts::test_store::{ArtifactTestStore, write_payload_reference};
    use crate::daemon::scheduler::budget::ProcessorMeter;

    fn content_hash_of(bytes: &[u8]) -> ContentHash {
        ContentHash::of_sha256(&Sha256::digest(bytes))
    }

    // Stores `bytes` with no reference and answers their hash.
    async fn store_unreferenced(
        store: &ArtifactTestStore,
        bytes: &[u8],
        name: &str,
    ) -> ContentHash {
        let content_hash = content_hash_of(bytes);
        let spool = store.spool_folder().join(name);
        std::fs::create_dir_all(store.spool_folder()).expect("the test makes the spool folder");
        std::fs::write(&spool, bytes).expect("the test writes a spool");
        store
            .payloads
            .admit(spool, &content_hash, async { Ok(()) })
            .await
            .expect("the bytes are stored");
        content_hash
    }

    // Catches an unlink without the reference count read again under the payload's key: a payload
    // a manifest names stays, one nothing names goes, and the bytes an admit is referencing while
    // it holds their key stay though their reclaim was asked first.
    #[tokio::test]
    async fn a_reclaim_removes_only_bytes_no_reference_names_under_their_key() {
        let store = ArtifactTestStore::open().await;
        let named = store_unreferenced(&store, b"named", "named").await;
        write_payload_reference(&store.writer, store.session_id, &named).await;
        let unnamed = store_unreferenced(&store, b"unnamed", "unnamed").await;
        let admitted = store_unreferenced(&store, b"admitted", "admitted").await;

        let spool = store.spool_folder().join("admitted again");
        std::fs::write(&spool, b"admitted").expect("the test writes a spool");
        let (reached, holding) = oneshot::channel();
        let (release, released) = oneshot::channel::<()>();
        let admitting = tokio::spawn({
            let payloads = Arc::clone(&store.payloads);
            let admitted = admitted.clone();
            let writer = Arc::clone(&store.writer);
            let session_id = store.session_id;
            async move {
                payloads
                    .admit(spool, &admitted.clone(), async move {
                        reached.send(()).expect("the test waits for the key's hold");
                        released.await.expect("the test releases the admit");
                        write_payload_reference(&writer, session_id, &admitted).await;
                        Ok(())
                    })
                    .await
            }
        });
        holding.await.expect("the admit holds the key");
        let reclaiming = tokio::spawn({
            let payloads = Arc::clone(&store.payloads);
            let reads = Arc::clone(&store.reads);
            let hashes = vec![admitted.clone(), named.clone(), unnamed.clone()];
            async move { payloads.reclaim_unreferenced(&reads, hashes).await }
        });
        // The reclaim reaches the admitted bytes' key while the admit still holds it.
        tokio::task::yield_now().await;
        release.send(()).expect("the admit waits");
        admitting
            .await
            .expect("the admit ends")
            .expect("the admit records");
        reclaiming.await.expect("the reclaim ends");

        assert!(
            store.payloads.object_path_of(&named).exists(),
            "a named payload stays"
        );
        assert!(
            !store.payloads.object_path_of(&unnamed).exists(),
            "an unnamed payload goes"
        );
        assert!(
            store.payloads.object_path_of(&admitted).exists(),
            "bytes an admit referenced under their key stay"
        );
        // The sweep counts each payload it examined, the two kept ones that it does not remove.
        // Killed by a count of the payloads removed in place of those examined.
        let examined = store
            .payloads
            .sweep_orphans(&store.reads, &ProcessorMeter::default())
            .await
            .expect("the sweep ends cleanly");
        assert_eq!(examined, 2);
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
