//! Where a daemon keeps the record of each lasting Codex service on a Codex folder, so a later
//! daemon finds the same processes again: one JSON file per service, named for the socket it
//! listens on, holding its process, where its socket really is and whether it was asked to drain,
//! in a folder per Codex folder under the daemon's data folder, never in the Codex folder itself;
//! each is replaced whole through a temporary file and read or written only under the one lock of
//! its Codex folder's records, so two daemons never start two services on one socket. The lock's
//! file is never removed: a lock follows the open file, so removing a file someone waits on would
//! hand the next taker a lock on another file.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sidekicks_platforms::{
    LeftoverSweep, ProcessRecord, create_private_folder, real_path, replace_file_atomically,
};

use crate::provider::service_log::provider_home_key;

/// The folder in the data folder that holds the lasting services' records.
const RECORD_FOLDER_NAME: &str = "codex-services";

/// The end of a record file's name, after the socket's own name.
const RECORD_FILE_SUFFIX: &str = ".json";

/// The file whose lock guards every record of one Codex folder, beside them.
const RECORDS_LOCK_NAME: &str = "records.lock";

/// The mode a record is written with, before the umask: the user's alone.
const RECORD_FILE_MODE: u32 = 0o600;

/// What a record keeps of one lasting service.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LastingServiceRecord {
    /// What a later daemon re-pins the service's process from.
    pub(crate) process: ProcessRecord,
    /// Where the service's socket really is, which the home's link names while the service holds
    /// it; `None` from the launch until the service answers on it.
    pub(crate) physical_socket: Option<PathBuf>,
    /// Whether the service was asked to drain, so it ends by itself once its running replies
    /// finish; such a service is never joined, nor is the home's link pointed at it.
    pub(crate) is_draining: bool,
}

impl LastingServiceRecord {
    /// The record of a service just launched as `process`, before it answers.
    pub(crate) fn launched(process: ProcessRecord) -> Self {
        Self {
            process,
            physical_socket: None,
            is_draining: false,
        }
    }
}

/// The record file of the lasting service on one socket of a Codex folder.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct LastingServiceRecordFile {
    record: PathBuf,
    lock: PathBuf,
}

impl LastingServiceRecordFile {
    /// The record file of the service on `codex_home` listening on `socket`, in `data_folder`;
    /// `codex_home` is resolved first, so two spellings of one folder share one record. Fails with
    /// the resolve's error, a missing folder among them, and with `InvalidInput` for a socket path
    /// that names no file.
    pub(crate) fn of_socket(
        data_folder: &Path,
        codex_home: &Path,
        socket: &Path,
    ) -> io::Result<Self> {
        let socket_name = socket.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "a Codex service's socket path names no file",
            )
        })?;
        let record = home_record_folder(data_folder, codex_home)?.join(format!(
            "{}{RECORD_FILE_SUFFIX}",
            socket_name.to_string_lossy()
        ));
        Ok(Self::at(record))
    }

    // The record at `record`, with its folder's lock beside it.
    fn at(record: PathBuf) -> Self {
        let lock = record.with_file_name(RECORDS_LOCK_NAME);
        Self { record, lock }
    }

    /// Removes the record once the service whose process is `ended` has ended, when the record
    /// still names that process; a record a later start wrote is left. Takes the folder's lock, so
    /// it is blocking. Fails as the lock, the read or the removal does.
    pub(crate) fn remove_if_naming(&self, ended: &ProcessRecord) -> io::Result<()> {
        let locked = self.lock()?;
        if locked.read()?.is_some_and(|kept| kept.process == *ended) {
            locked.remove()?;
        }
        Ok(())
    }

    /// Takes the lock of the Codex folder's records, waiting while another daemon or another
    /// start holds it; blocking, so it runs in `spawn_blocking`. The lock is released when the
    /// answer and every record held through it drop, the holder's crash included. Fails with the
    /// system's error from making the folder, opening the lock file or taking the lock.
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
            hold: Arc::new(lock),
        })
    }
}

/// A record file while its Codex folder's lock is held; reads and writes need the hold.
pub(crate) struct LockedServiceRecord {
    file: LastingServiceRecordFile,
    hold: Arc<File>,
}

/// The folder of the records of the services on `codex_home`, named for the folder resolved.
fn home_record_folder(data_folder: &Path, codex_home: &Path) -> io::Result<PathBuf> {
    let key = provider_home_key(&real_path(codex_home)?);
    Ok(data_folder.join(RECORD_FOLDER_NAME).join(key))
}

impl LockedServiceRecord {
    /// The record file the hold is on.
    pub(crate) fn file(&self) -> &LastingServiceRecordFile {
        &self.file
    }

    /// The record `file` of the same Codex folder under this same hold.
    pub(crate) fn sibling(&self, file: LastingServiceRecordFile) -> Self {
        Self {
            file,
            hold: Arc::clone(&self.hold),
        }
    }

    /// Every other record file kept for the same Codex folder, each under this same hold, so no
    /// second lock is taken while this one is held. Blocking. Fails with the folder's read error.
    pub(crate) fn others(&self) -> io::Result<Vec<Self>> {
        let folder = self
            .file
            .record
            .parent()
            .expect("a record file sits in its folder");
        let mut others = Vec::new();
        for entry in std::fs::read_dir(folder)? {
            let path = entry?.path();
            let is_record = path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(RECORD_FILE_SUFFIX));
            if is_record && path != self.file.record {
                others.push(Self {
                    file: LastingServiceRecordFile::at(path),
                    hold: Arc::clone(&self.hold),
                });
            }
        }
        Ok(others)
    }

    /// The record kept, or `None` when none is. Blocking. Fails with the read's error, and with
    /// `InvalidData` for a file that does not read as a record.
    pub(crate) fn read(&self) -> io::Result<Option<LastingServiceRecord>> {
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
    pub(crate) fn write(&self, record: &LastingServiceRecord) -> io::Result<()> {
        let text = serde_json::to_vec(record).expect("a process record writes as JSON");
        replace_file_atomically(
            &self.file.record,
            &text,
            RECORD_FILE_MODE,
            LeftoverSweep::Unswept,
        )
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

    use super::{LastingServiceRecord, LastingServiceRecordFile};

    // Fails when the record reads back as anything but what was written, or a removed record
    // still reads.
    #[test]
    fn codex_service_record_reads_back_what_was_written_and_nothing_once_removed() {
        let data_folder = tempfile::tempdir().expect("a scratch folder is made");
        let record = LastingServiceRecord {
            process: pin_child_process(std::process::id())
                .expect("this process pins")
                .record()
                .expect("the record reads")
                .expect("this process runs"),
            physical_socket: Some(data_folder.path().join("real.sock")),
            is_draining: true,
        };
        let file = LastingServiceRecordFile::of_socket(
            data_folder.path(),
            data_folder.path(),
            &data_folder.path().join("app-server-control.sock"),
        )
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
