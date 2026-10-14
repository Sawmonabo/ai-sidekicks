//! The diagnostic-log expiry: each pass deletes whole every service log file last written longer
//! ago than the bound, so a log is kept as long as its newest line is young enough. The file the
//! service log holds open is never deleted, and a file in the folder that is no service log file
//! is never touched. A file that cannot be read or deleted is told in the service log and
//! the pass goes on.

use std::error::Error;
use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::daemon::service_log::is_service_log_file_name;
use crate::missing_entry::MissingEntry;

/// How often the expiry runs: hourly, so no log outlives its bound by more than an hour.
pub(crate) const DIAGNOSTIC_LOG_EXPIRY_INTERVAL: Duration = Duration::from_hours(1);

/// Deletes each service log file in `logs_folder` last written before `now` less `keep`, except
/// `live_file`, the one the service log holds open. Never fails: a missing folder or file is
/// skipped, and any other failure is written to the service log and the pass goes on.
pub(crate) async fn expire_diagnostic_logs(
    logs_folder: &Path,
    live_file: Option<&Path>,
    keep: Duration,
    now: SystemTime,
) {
    let names = match list_service_log_names(logs_folder).await.none_if_missing() {
        Ok(Some(names)) => names,
        Ok(None) => return,
        Err(failure) => {
            tracing::warn!(
                folder = %logs_folder.display(),
                error = &failure as &(dyn Error + 'static),
                "The diagnostic logs could not be listed"
            );
            return;
        }
    };
    let Some(cutoff) = now.checked_sub(keep) else {
        return;
    };
    // Compared by name, so the folder may be spelled differently by the caller and the log.
    let live_file_name = live_file.and_then(Path::file_name);
    for name in names {
        if live_file_name == Some(OsStr::new(&name)) {
            continue;
        }
        let path = logs_folder.join(name);
        // A file deleted since the listing is already gone.
        if let Err(failure) = delete_if_written_before(&path, cutoff)
            .await
            .none_if_missing()
        {
            tracing::warn!(
                file = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "A diagnostic log could not be expired"
            );
        }
    }
}

async fn list_service_log_names(logs_folder: &Path) -> io::Result<Vec<String>> {
    let mut entries = tokio::fs::read_dir(logs_folder).await?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        // A name that is not UTF-8 is no service log file's.
        if let Ok(name) = entry.file_name().into_string()
            && is_service_log_file_name(&name)
        {
            names.push(name);
        }
    }
    Ok(names)
}

// Deletes the file at `path` when it is a plain file last written before `cutoff`.
async fn delete_if_written_before(path: &Path, cutoff: SystemTime) -> io::Result<()> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if metadata.is_file() && metadata.modified()? < cutoff {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}
