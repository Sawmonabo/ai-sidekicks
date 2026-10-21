//! Where a daemon keeps the record of the lasting Codex service on a Codex folder, so a later
//! daemon finds the same process again: one JSON file per folder under the daemon's data folder,
//! never in the Codex folder itself, replaced whole through a temporary file and read or written
//! only under a lock on the file beside it, so two daemons never start two services on one folder.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::{
    ProcessRecord, create_private_folder, real_path, replace_file_atomically,
};

use crate::provider::service_log::provider_home_key;

/// The folder in the data folder that holds the lasting services' records.
const RECORD_FOLDER_NAME: &str = "codex-services";

/// The mode a record is written with, before the umask: the user's alone.
const RECORD_FILE_MODE: u32 = 0o600;

/// The record file of the lasting service on one Codex folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LastingServiceRecordFile {
    record: PathBuf,
    lock: PathBuf,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start keeps the lasting Codex service's record under its lock"
    )
)]
impl LastingServiceRecordFile {
    /// The record file of the service on `codex_home`, in `data_folder`; `codex_home` is resolved
    /// first, so two spellings of one folder share one record. Fails with the resolve's error, a
    /// missing folder among them.
    pub(crate) fn of_home(data_folder: &Path, codex_home: &Path) -> io::Result<Self> {
        let key = provider_home_key(&real_path(codex_home)?);
        let record = data_folder
            .join(RECORD_FOLDER_NAME)
            .join(format!("{key}.json"));
        let lock = record.with_extension("json.lock");
        Ok(Self { record, lock })
    }

    /// Takes the record's lock, waiting while another daemon holds it; blocking, so it runs in
    /// `spawn_blocking`. The lock is released when the answer drops, the holder's crash
    /// included. Fails with the system's error from making the folder, opening the lock file or
    /// taking the lock.
    pub(crate) fn lock(&self) -> io::Result<LockedServiceRecord> {
        let folder = self
            .lock
            .parent()
            .expect("a record file sits in its folder");
        create_private_folder(folder)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&self.lock)?;
        lock.lock()?;
        Ok(LockedServiceRecord {
            file: self.clone(),
            _lock: lock,
        })
    }
}

/// The record file while its lock is held; reads and writes need the hold.
pub(crate) struct LockedServiceRecord {
    file: LastingServiceRecordFile,
    _lock: File,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start reads, writes and removes the lasting Codex service's record"
    )
)]
impl LockedServiceRecord {
    /// The record kept, or `None` when none is. Blocking. Fails with the read's error, and with
    /// `InvalidData` for a file that does not read as a record.
    pub(crate) fn read(&self) -> io::Result<Option<ProcessRecord>> {
        let text = match std::fs::read(&self.file.record) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        serde_json::from_slice(&text)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    /// Keeps `record` in place of any record kept before, whole or not at all. Blocking. Fails
    /// with the replace's error.
    pub(crate) fn write(&self, record: &ProcessRecord) -> io::Result<()> {
        let text = serde_json::to_vec(record).expect("a process record writes as JSON");
        replace_file_atomically(&self.file.record, &text, RECORD_FILE_MODE)
            .map_err(io::Error::other)
    }

    /// Removes the record, for a service that has ended; a missing record is already gone.
    /// Blocking. Fails with the removal's error.
    pub(crate) fn remove(&self) -> io::Result<()> {
        match std::fs::remove_file(&self.file.record) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_platforms::pin_child_process;

    use super::LastingServiceRecordFile;

    // Fails when the record reads back as anything but what was written, or a removed record
    // still reads.
    #[test]
    fn codex_service_record_reads_back_what_was_written_and_nothing_once_removed() {
        let data_folder = tempfile::tempdir().expect("a scratch folder is made");
        let record = pin_child_process(std::process::id())
            .expect("this process pins")
            .record()
            .expect("the record reads")
            .expect("this process runs");
        let file = LastingServiceRecordFile::of_home(data_folder.path(), data_folder.path())
            .expect("the folder resolves");

        let locked = file.lock().expect("the lock is taken");
        let before = locked.read().expect("a missing record reads");
        locked.write(&record).expect("the record is written");
        let written = locked.read().expect("the record reads");
        locked.remove().expect("the record is removed");
        let removed = locked.read().expect("a removed record reads");

        assert_eq!(before, None);
        assert_eq!(written, Some(record));
        assert_eq!(removed, None);
    }
}
