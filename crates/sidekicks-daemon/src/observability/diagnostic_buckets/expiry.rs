//! The diagnostic-log expiry: each pass deletes whole every diagnostic log last written longer ago
//! than the bound, the daemon's service log files and each provider service's log and kept tail,
//! so a log is kept as long as its newest line is young enough. A file still being written, the
//! one the service log holds open or a running provider service's log, is never deleted, and a
//! running service's log past its cap is cut instead. A file in the folder that is no diagnostic
//! log is never touched. A file that cannot be read, cut or deleted is told in the service log
//! and the pass goes on.

use std::error::Error;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use crate::daemon::configuration::ConfigurationStore;
use crate::daemon::scheduler::ScheduledJobOutcome;
use crate::daemon::service_log::is_service_log_file_name;
use crate::missing_entry::MissingEntry;
use crate::provider::service_log::{
    SERVICE_LOG_CAP_BYTES, cap_provider_service_log, is_provider_service_log_file_name,
};

/// How often the expiry runs: hourly, so no log outlives its bound by more than an hour.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start registers the hourly expiry")
)]
pub(crate) const DIAGNOSTIC_LOG_EXPIRY_INTERVAL: Duration = Duration::from_hours(1);

const DAY: Duration = Duration::from_hours(24);

/// Names, at each pass, the files the expiry leaves alone: the one the service log holds open and
/// each running provider service's log.
pub(crate) type LiveDiagnosticFiles = Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>;

/// What the expiry job reads.
pub(crate) struct DiagnosticExpiryDeps {
    /// The folder of the service's logs.
    pub(crate) logs_folder: PathBuf,
    /// The files each pass leaves alone.
    pub(crate) live_files: LiveDiagnosticFiles,
    /// The configuration holding `Keep diagnostic logs for`, read at each pass.
    pub(crate) configuration: Arc<ConfigurationStore>,
}

/// The body of the hourly expiry job, run every [`DIAGNOSTIC_LOG_EXPIRY_INTERVAL`] with
/// `Keep diagnostic logs for` as it stands at each pass. Never fails, as
/// [`expire_diagnostic_logs`] never does.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start registers the hourly expiry")
)]
pub(crate) fn diagnostic_expiry_job(
    deps: Arc<DiagnosticExpiryDeps>,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    move |_stop| {
        let deps = Arc::clone(&deps);
        async move {
            let days = deps
                .configuration
                .current()
                .retention
                .keep_diagnostic_logs_days
                .get();
            let keep = DAY.saturating_mul(u32::try_from(days).unwrap_or(u32::MAX));
            let live_files = (deps.live_files)();
            let live_files: Vec<&Path> = live_files.iter().map(PathBuf::as_path).collect();
            expire_diagnostic_logs(&deps.logs_folder, &live_files, keep, SystemTime::now()).await;
            Ok(())
        }
        .boxed()
    }
}

/// Deletes each diagnostic log in `logs_folder` last written before `now` less `keep`, except
/// `live_files`, the one the service log holds open and the log of each provider service still
/// running, each of the latter cut instead once past its cap. Never fails: a missing folder or
/// file is skipped, and any other failure is written to the service log and the pass goes on.
pub(crate) async fn expire_diagnostic_logs(
    logs_folder: &Path,
    live_files: &[&Path],
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
    let live_file_names: Vec<&OsStr> = live_files
        .iter()
        .filter_map(|file| file.file_name())
        .collect();
    for name in names {
        let path = logs_folder.join(&name);
        if live_file_names.contains(&OsStr::new(&name)) {
            if is_provider_service_log_file_name(&name)
                && let Err(failure) = cap_provider_service_log(&path, SERVICE_LOG_CAP_BYTES).await
            {
                tracing::warn!(
                    file = %path.display(),
                    error = &failure as &(dyn Error + 'static),
                    "A running provider service's log could not be cut"
                );
            }
            continue;
        }
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
        // A name that is not UTF-8 is no diagnostic log's.
        if let Ok(name) = entry.file_name().into_string()
            && (is_service_log_file_name(&name) || is_provider_service_log_file_name(&name))
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
