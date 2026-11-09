//! An export that has not ended: the marker in its folder and the record in the data folder that
//! say so, the removal of a failed export's folder, and at the start the folder of an export a
//! restart cut short, set aside under a name of its own before the socket binds and removed after.

use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sidekicks_contracts::daemon::data::DataExportJobId;
use sidekicks_std::file::atomic_write::{
    AtomicWriteError, remove_file_durably, write_file_atomically,
};
use sidekicks_std::file::remove_tree_awaited;
use sidekicks_std::missing_entry::MissingEntry as _;

// The file in a running export's folder that says the export has not ended, holding its job's id.
pub(super) const UNFINISHED_MARKER_FILE_NAME: &str = ".sidekicks-export-unfinished";

// The file in the data folder that names the running export's folder.
pub(super) const RUNNING_EXPORT_RECORD_FILE_NAME: &str = "running-export.json";

// The marker and the record are the service's own, read by no one else.
const PRIVATE_FILE_MODE: u32 = 0o600;

/// The running export as the data folder's record names it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunningExportRecord {
    folder: String,
    job_id: String,
}

// Records the export of `job_id` into `destination` as running: the record in the data folder,
// then the marker in its folder, each written whole and flushed, so no marked folder goes unnamed.
pub(super) async fn record_running_export(
    data_folder: &Path,
    destination: &Path,
    job_id: DataExportJobId,
) -> Result<(), AtomicWriteError> {
    let job_text = job_id.to_string();
    let record = serde_json::to_vec(&RunningExportRecord {
        folder: destination.to_string_lossy().into_owned(),
        job_id: job_text.clone(),
    })
    .expect("a record of two strings is JSON");
    write_file_atomically(
        &data_folder.join(RUNNING_EXPORT_RECORD_FILE_NAME),
        record,
        PRIVATE_FILE_MODE,
    )
    .await?;
    write_file_atomically(
        &destination.join(UNFINISHED_MARKER_FILE_NAME),
        job_text,
        PRIVATE_FILE_MODE,
    )
    .await
}

// Removes a failed export's folder, its marker written back first where the failure came after
// the marker went, so a removal cut short leaves a folder the next start still removes. A folder
// never made is `Ok`. Fails as the marker's write or the removal fails.
pub(super) async fn remove_failed_export(
    destination: &Path,
    job_id: DataExportJobId,
) -> io::Result<()> {
    if tokio::fs::symlink_metadata(destination)
        .await
        .none_if_missing()?
        .is_none()
    {
        return Ok(());
    }
    write_file_atomically(
        &destination.join(UNFINISHED_MARKER_FILE_NAME),
        job_id.to_string(),
        PRIVATE_FILE_MODE,
    )
    .await
    .map_err(io::Error::other)?;
    remove_marked_export(destination).await
}

// Removes an unfinished export's `folder` with its marker last, so a removal cut short leaves the
// folder marked. A folder already gone is `Ok`; fails with the first removal's error.
async fn remove_marked_export(folder: &Path) -> io::Result<()> {
    let Some(mut entries) = tokio::fs::read_dir(folder).await.none_if_missing()? else {
        return Ok(());
    };
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_name() != UNFINISHED_MARKER_FILE_NAME {
            remove_tree_awaited(&entry.path()).await?;
        }
    }
    remove_tree_awaited(folder).await
}

// Removes the running export's record; a record left behind names a folder without its marker,
// which the next start keeps.
pub(super) async fn forget_running_export(data_folder: &Path) {
    if let Err(failure) =
        remove_file_durably(&data_folder.join(RUNNING_EXPORT_RECORD_FILE_NAME)).await
    {
        tracing::warn!(
            error = &failure as &(dyn Error + 'static),
            "the running export's record could not be removed"
        );
    }
}

/// The folder of an export a restart cut short, set aside beside where it was until
/// [`CutShortExport::remove`] removes it, with the record that names it.
pub(crate) struct CutShortExport {
    data_folder: PathBuf,
    aside: PathBuf,
    record: Vec<u8>,
}

/// Renames the folder of the export a restart cut short, which the record in `data_folder` names,
/// aside while that export's marker is still in it, so the export's name is free before any export
/// can begin; a folder whose marker is gone keeps every file in it and its record goes. Answers the
/// folder set aside, also one an earlier start set aside and did not finish removing. A failure is
/// written to the service log, and a folder that could not be set aside keeps its record.
pub(crate) async fn set_aside_cut_short_export(data_folder: &Path) -> Option<CutShortExport> {
    let record_path = data_folder.join(RUNNING_EXPORT_RECORD_FILE_NAME);
    let held = match tokio::fs::read(&record_path).await.none_if_missing() {
        Ok(Some(held)) => held,
        Ok(None) => return None,
        Err(failure) => {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the running export's record could not be read"
            );
            return None;
        }
    };
    let record = match serde_json::from_slice::<RunningExportRecord>(&held) {
        Ok(record) => record,
        Err(failure) => {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the running export's record is not one the service writes"
            );
            forget_running_export(data_folder).await;
            return None;
        }
    };
    let folder = PathBuf::from(record.folder);
    let aside = aside_folder(&folder, &record.job_id);
    let set_aside = async {
        if is_marked_unfinished(&folder, &record.job_id).await? {
            tokio::fs::rename(&folder, &aside).await?;
        }
        is_marked_unfinished(&aside, &record.job_id).await
    };
    match set_aside.await {
        Ok(true) => Some(CutShortExport {
            data_folder: data_folder.to_path_buf(),
            aside,
            record: held,
        }),
        Ok(false) => {
            forget_running_export(data_folder).await;
            None
        }
        Err(failure) => {
            tracing::warn!(
                folder = %folder.display(),
                error = &failure as &(dyn Error + 'static),
                "the folder of an export a restart cut short could not be set aside; the next \
                 start tries again"
            );
            None
        }
    }
}

impl CutShortExport {
    /// Removes the folder set aside, its marker last, then the record, unless an export begun
    /// since wrote its own. A failure is written to the service log, and the record is kept for
    /// the next start.
    pub(crate) async fn remove(self) {
        if let Err(failure) = remove_marked_export(&self.aside).await {
            tracing::warn!(
                folder = %self.aside.display(),
                error = &failure as &(dyn Error + 'static),
                "the folder of an export a restart cut short could not be removed; the next start \
                 tries again"
            );
            return;
        }
        tracing::info!(
            folder = %self.aside.display(),
            "the folder of an export a restart cut short was removed"
        );
        let record_path = self.data_folder.join(RUNNING_EXPORT_RECORD_FILE_NAME);
        match tokio::fs::read(&record_path).await.none_if_missing() {
            Ok(Some(held)) if held == self.record => forget_running_export(&self.data_folder).await,
            Ok(_) => {}
            Err(failure) => tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the running export's record could not be read"
            ),
        }
    }
}

// Where the folder of `job_id`'s cut-short export is set aside: beside it, under its name with the
// job's id after it.
fn aside_folder(folder: &Path, job_id: &str) -> PathBuf {
    let mut name = OsString::from(folder.as_os_str());
    name.push(format!(".cut-short-{job_id}"));
    PathBuf::from(name)
}

// Whether `folder` is a folder, not a link to one, holding the marker of the export `job_id`.
async fn is_marked_unfinished(folder: &Path, job_id: &str) -> io::Result<bool> {
    let Some(metadata) = tokio::fs::symlink_metadata(folder)
        .await
        .none_if_missing()?
    else {
        return Ok(false);
    };
    if !metadata.is_dir() {
        return Ok(false);
    }
    let marker = tokio::fs::read(folder.join(UNFINISHED_MARKER_FILE_NAME))
        .await
        .none_if_missing()?;
    Ok(marker.as_deref() == Some(job_id.as_bytes()))
}
