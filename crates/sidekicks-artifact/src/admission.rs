//! The one admission every upload a client sends passes before a byte of it is spooled: an ingest
//! stream at its opening and a publish once its frame is read. Admissions run one at a time against
//! the bound on open uploads and the disk's free room, read at each admission, less what the open
//! uploads have yet to write. A release only lowers those totals, so one landing during an
//! admission only makes it more careful.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::ingest::limits::MAX_ACTIVE_INGEST_STREAMS;
use crate::refusals::{ArtifactError, artifact_too_large_for_volume, ingest_capacity_exhausted};
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::mutex_lock::lock;
#[cfg(test)]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_store::database::writer::repack::VolumeFreeBytesReader;

// Each open upload's room yet to write, shared with the guard that releases it.
type OpenUploads = Arc<Mutex<Vec<Arc<AtomicU64>>>>;

/// The admission ledger over every open upload a client sent.
pub(crate) struct UploadAdmission {
    spool_folder: PathBuf,
    read_volume_free_bytes: VolumeFreeBytesReader,
    ledger: KeyedLock<()>,
    open_uploads: OpenUploads,
    /// Where a test holds an admission between reading the open uploads and installing its own.
    #[cfg(test)]
    pub(crate) pause: PausePoint,
}

/// One admitted upload's place among the open uploads and the room it has yet to write; dropping
/// it gives both back.
pub(crate) struct AdmittedUpload {
    remaining_bytes: Arc<AtomicU64>,
    open_uploads: OpenUploads,
}

impl AdmittedUpload {
    /// Sets the declared bytes the upload has yet to write, as its chunks land.
    pub(crate) fn set_remaining_bytes(&self, remaining_bytes: u64) {
        self.remaining_bytes
            .store(remaining_bytes, Ordering::Relaxed);
    }
}

impl Drop for AdmittedUpload {
    fn drop(&mut self) {
        lock_open_uploads(&self.open_uploads)
            .retain(|upload| !Arc::ptr_eq(upload, &self.remaining_bytes));
    }
}

impl UploadAdmission {
    /// An admission over the spools written in `spool_folder`, created at the first admission,
    /// reading the volume's free room with `read_volume_free_bytes`.
    pub(crate) fn new(
        spool_folder: PathBuf,
        read_volume_free_bytes: VolumeFreeBytesReader,
    ) -> Self {
        Self {
            spool_folder,
            read_volume_free_bytes,
            ledger: KeyedLock::new(),
            open_uploads: Arc::default(),
            #[cfg(test)]
            pause: PausePoint::default(),
        }
    }

    /// The folder the spools are written in.
    pub(crate) fn spool_folder(&self) -> &Path {
        &self.spool_folder
    }

    /// Admits an upload of `declared_size_bytes`, reserving that room until the returned upload
    /// drops. Fails with `artifact.tooLarge` when the disk could not hold it with no other upload
    /// open, naming `file_name` when there is one, with `artifact.ingest.capacityExhausted` at the
    /// bound on open uploads or when the disk has no room for it beside theirs, and with the
    /// disk's own failure; a failure admits nothing.
    pub(crate) async fn admit(
        &self,
        declared_size_bytes: u64,
        file_name: Option<&str>,
    ) -> Result<AdmittedUpload, ArtifactError> {
        let _ledger_hold = self.ledger.acquire(()).await;
        let spool_folder = self.spool_folder.clone();
        let read_volume_free_bytes = self.read_volume_free_bytes;
        let available_bytes = tokio::task::spawn_blocking(move || {
            sidekicks_platforms::create_private_folder(&spool_folder)?;
            read_volume_free_bytes(&spool_folder)
        })
        .await??;
        if declared_size_bytes > available_bytes {
            return Err(artifact_too_large_for_volume(file_name, available_bytes).into());
        }
        let (open_count, reserved_bytes) = {
            let open_uploads = lock_open_uploads(&self.open_uploads);
            let reserved_bytes: u64 = open_uploads
                .iter()
                .map(|upload| upload.load(Ordering::Relaxed))
                .sum();
            (open_uploads.len(), reserved_bytes)
        };
        #[cfg(test)]
        self.pause.pass().await;
        let has_room = available_bytes
            .checked_sub(reserved_bytes)
            .is_some_and(|room| declared_size_bytes <= room);
        if open_count >= MAX_ACTIVE_INGEST_STREAMS || !has_room {
            return Err(ingest_capacity_exhausted().into());
        }
        let remaining_bytes = Arc::new(AtomicU64::new(declared_size_bytes));
        lock_open_uploads(&self.open_uploads).push(Arc::clone(&remaining_bytes));
        Ok(AdmittedUpload {
            remaining_bytes,
            open_uploads: Arc::clone(&self.open_uploads),
        })
    }

    /// Holds the ledger, so no admission runs until the hold drops: for a pass that must see the
    /// open uploads hold still.
    pub(crate) async fn hold_still(&self) -> KeyHold<'_, ()> {
        self.ledger.acquire(()).await
    }
}

fn lock_open_uploads(open_uploads: &OpenUploads) -> MutexGuard<'_, Vec<Arc<AtomicU64>>> {
    // The list holds no invariant a panicking holder could break.
    lock(open_uploads)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

    use super::UploadAdmission;
    use crate::ingest::limits::MAX_ACTIVE_INGEST_STREAMS;
    use crate::test_store::refusal_code_of;

    /// The free room the test's volume reports.
    const FREE_BYTES: u64 = 1_000;

    /// An admission over a fresh folder whose volume always has [`FREE_BYTES`] free.
    fn test_admission(folder: &tempfile::TempDir) -> UploadAdmission {
        UploadAdmission::new(folder.path().join("spool"), |_folder| Ok(FREE_BYTES))
    }

    #[rstest]
    #[case::past_the_free_room(FREE_BYTES + 1, 0, RefusalCode::ArtifactTooLarge)]
    #[case::at_the_open_bound(
        1,
        MAX_ACTIVE_INGEST_STREAMS,
        RefusalCode::ArtifactIngestCapacityExhausted
    )]
    #[case::past_the_room_left(FREE_BYTES, 1, RefusalCode::ArtifactIngestCapacityExhausted)]
    #[tokio::test]
    async fn a_refused_admission_holds_nothing_and_a_release_admits_the_next(
        #[case] declared_size_bytes: u64,
        #[case] open_before: usize,
        #[case] expected: RefusalCode,
    ) {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let admission = test_admission(&folder);
        let mut open = Vec::new();
        for _ in 0..open_before {
            open.push(admission.admit(1, None).await.expect("an upload admits"));
        }
        let refused = admission
            .admit(declared_size_bytes, Some("a.txt"))
            .await
            .err()
            .expect("the admission refuses");
        assert_eq!(refusal_code_of(&refused), Some(expected));
        if declared_size_bytes <= FREE_BYTES {
            // Releasing one open upload, by its drop, gives back its place and its room.
            drop(open.pop());
            admission
                .admit(declared_size_bytes, Some("a.txt"))
                .await
                .expect("the freed place and room admit it");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn two_admissions_against_one_place_left_admit_exactly_one() {
        let folder = tempfile::tempdir().expect("the test makes a folder");
        let admission = Arc::new(test_admission(&folder));
        let mut open = Vec::new();
        for _ in 0..MAX_ACTIVE_INGEST_STREAMS - 1 {
            open.push(admission.admit(1, None).await.expect("an upload admits"));
        }
        let paused = admission.pause.arm();
        let first = tokio::spawn({
            let admission = Arc::clone(&admission);
            // The upload is kept, so its place stays taken while the other admission runs.
            async move { admission.admit(1, None).await.ok() }
        });
        paused
            .reached
            .await
            .expect("the first admission reaches the pause");
        let mut second = tokio::spawn({
            let admission = Arc::clone(&admission);
            // The upload is kept, so its place stays taken while the other admission runs.
            async move { admission.admit(1, None).await.ok() }
        });
        // The paused clock moves only once no task can go on, the second admission's disk read
        // included, so the wait ends with the second admission as far as it can get.
        let second_while_held = tokio::time::timeout(Duration::from_secs(1), &mut second).await;
        assert!(
            second_while_held.is_err(),
            "the second admission waits for the first"
        );
        paused.release.send(()).expect("the first admission waits");
        let admitted = [
            first.await.expect("the first admission ends"),
            second.await.expect("the second admission ends"),
        ];
        assert_eq!(admitted.iter().flatten().count(), 1);
    }
}
