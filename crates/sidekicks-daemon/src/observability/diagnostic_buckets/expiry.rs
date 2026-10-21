//! The diagnostic-log expiry: each pass deletes whole every diagnostic file last written longer
//! ago than the bound, so a file is kept as long as its newest line is young enough. It covers the
//! daemon's service log files and each provider service's log and kept tail in `logs/`, every
//! diagnostic bucket, the crash dumps and crash reports, and the provider diagnostic folders in
//! each account home. A file still being written, the one the service log holds open or a running
//! provider service's log, is never deleted, and a running service's log past its cap is cut
//! instead. A file in `logs/` that is no diagnostic log is never touched, and no folder is removed.
//! A file that cannot be read, cut or deleted is told in the service log and the pass goes on.

use std::error::Error;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use crate::daemon::configuration::ConfigurationStore;
use crate::daemon::crash::monitor::CRASH_DUMPS_FOLDER_NAME;
use crate::daemon::scheduler::ScheduledJobOutcome;
use crate::daemon::service_log::{
    CRASH_REPORTS_FOLDER_NAME, is_service_log_file_name, service_log_folder,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::missing_entry::{MissingEntry, is_gone};
use crate::observability::diagnostic_buckets::account_homes::read_account_home_diagnostic_folders;
use crate::observability::diagnostic_buckets::recorders::diagnostic_bucket_folders;
use crate::provider::service_log::{
    SERVICE_LOG_CAP_BYTES, cap_provider_service_log, is_provider_service_log_file_name,
};

/// How often the expiry runs: hourly, so no log outlives its bound by more than an hour.
#[expect(dead_code, reason = "the daemon's start registers the hourly expiry")]
pub(crate) const DIAGNOSTIC_LOG_EXPIRY_INTERVAL: Duration = Duration::from_hours(1);

const DAY: Duration = Duration::from_hours(24);

/// Names, at each pass, the files the expiry leaves alone: the one the service log holds open and
/// each running provider service's log.
pub(crate) type LiveDiagnosticFiles = Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>;

/// What the expiry job reads.
pub(crate) struct DiagnosticExpiryDeps {
    /// The data folder, holding the service's logs, the buckets and the crash files.
    pub(crate) data_folder: PathBuf,
    /// The files each pass leaves alone.
    pub(crate) live_files: LiveDiagnosticFiles,
    /// The configuration holding `Keep diagnostic logs for`, read at each pass.
    pub(crate) configuration: Arc<ConfigurationStore>,
    /// The reads of the account homes.
    pub(crate) reads: Arc<DatabaseReadPool>,
}

/// The body of the hourly expiry job, run every [`DIAGNOSTIC_LOG_EXPIRY_INTERVAL`] with
/// `Keep diagnostic logs for` as it stands at each pass. Never fails: account homes that cannot be
/// read are told in the service log and the rest is expired.
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
            let now = SystemTime::now();
            let live_files = (deps.live_files)();
            let live_files: Vec<&Path> = live_files.iter().map(PathBuf::as_path).collect();
            let logs_folder = service_log_folder(&deps.data_folder);
            expire_diagnostic_logs(&logs_folder, &live_files, keep, now).await;
            let mut folders = diagnostic_bucket_folders(&deps.data_folder).to_vec();
            folders.push(deps.data_folder.join(CRASH_DUMPS_FOLDER_NAME));
            folders.push(deps.data_folder.join(CRASH_REPORTS_FOLDER_NAME));
            match read_account_home_diagnostic_folders(&deps.reads).await {
                Ok(account_home_folders) => folders.extend(account_home_folders),
                Err(failure) => tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "The account homes' diagnostics could not be expired"
                ),
            }
            expire_diagnostic_folders(folders, keep, now).await;
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

/// Deletes every plain file anywhere under each of `folders` last written before `now` less `keep`,
/// following no link and removing no folder. Never fails: a missing folder or file is skipped, and
/// any other failure is written to the service log and the pass goes on.
pub(crate) async fn expire_diagnostic_folders(
    folders: Vec<PathBuf>,
    keep: Duration,
    now: SystemTime,
) {
    let Some(cutoff) = now.checked_sub(keep) else {
        return;
    };
    let walked = tokio::task::spawn_blocking(move || {
        for folder in &folders {
            expire_folder(folder, cutoff);
        }
    })
    .await;
    if let Err(failure) = walked {
        tracing::warn!(
            error = &failure as &(dyn Error + 'static),
            "The diagnostic folders' expiry did not finish"
        );
    }
}

fn expire_folder(folder: &Path, cutoff: SystemTime) {
    for entry in WalkDir::new(folder).follow_root_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(failure) => {
                // A folder that is not there, or an entry deleted since the listing, holds nothing.
                if !failure.io_error().is_some_and(is_gone) {
                    tracing::warn!(
                        folder = %folder.display(),
                        error = &failure as &(dyn Error + 'static),
                        "A diagnostic folder could not be listed"
                    );
                }
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let deleted = std::fs::symlink_metadata(path)
            .and_then(|metadata| {
                if metadata.modified()? < cutoff {
                    std::fs::remove_file(path)?;
                }
                Ok(())
            })
            .none_if_missing();
        if let Err(failure) = deleted {
            tracing::warn!(
                file = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "A diagnostic file could not be expired"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use rusqlite::types::Value;
    use tokio_util::sync::CancellationToken;

    use super::{DiagnosticExpiryDeps, diagnostic_expiry_job};
    use crate::daemon::configuration::{
        ConfigurationStore, DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
    };
    use crate::daemon::crash::monitor::CRASH_DUMPS_FOLDER_NAME;
    use crate::daemon::service_log::CRASH_REPORTS_FOLDER_NAME;
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::statement::{StatementBindings, WriteStatement};
    use crate::database::writer::test_file::TestDatabase;
    use crate::events::log_service::tests::open_log;
    use crate::observability::diagnostic_buckets::recorders::diagnostic_bucket_folders;

    // Past the default bound of seven days.
    const OLD: Duration = Duration::from_hours(24 * 8);

    const NEW: Duration = Duration::from_hours(1);

    // Writes a file at `path` last written `age` ago.
    fn write_aged(path: &Path, age: Duration) {
        fs::create_dir_all(path.parent().expect("the file has a folder")).expect("folder made");
        fs::write(path, "line\n").expect("the file is written");
        fs::File::options()
            .write(true)
            .open(path)
            .and_then(|file| file.set_modified(SystemTime::now() - age))
            .expect("the file's time is set");
    }

    // A pass deletes whole every diagnostic file past the bound and keeps a newer one of each kind:
    // the service log, each bucket, the crash dumps and reports, and an account home's provider
    // diagnostics, where a session's transcript of the same age stays; a file in `logs/` that is no
    // log stays too. Killed by a per-session folder in a descriptor's list, by a bucket or crash
    // folder left out of the pass, and by the account homes left unread.
    #[tokio::test]
    async fn a_pass_deletes_every_diagnostic_past_the_bound_and_no_session_file() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
        ));
        let configuration = Arc::new(
            ConfigurationStore::open(Arc::clone(&log.writer), &reads)
                .await
                .expect("the configuration store opens"),
        );
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let home = tempfile::tempdir().expect("the account home is made");
        log.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(
                    "INSERT INTO provider_accounts (account_id, provider, credential_home_path, \
                     billing_mode, created_at, updated_at) \
                     VALUES ('account', 'claude', ?1, 'unknown', '2026-10-01T00:00:00Z', \
                     '2026-10-01T00:00:00Z')",
                ),
                bindings: StatementBindings::Positional(vec![Value::Text(
                    home.path().display().to_string(),
                )]),
                expected_row_count: Some(1),
            }])
            .await
            .expect("the account is written");
        let data = data_folder.path();
        let logs = data.join("logs");
        let mut expired = vec![
            logs.join("service-2026-10-01T00-00-00-000.log"),
            data.join(CRASH_DUMPS_FOLDER_NAME).join("crash.dmp"),
            data.join(CRASH_REPORTS_FOLDER_NAME).join("crash.json"),
            home.path().join("paste-cache").join("paste"),
            home.path()
                .join("feedback")
                .join("drafts")
                .join("draft.json"),
        ];
        let mut kept_old = vec![
            logs.join("notes.txt"),
            home.path()
                .join("projects")
                .join("project")
                .join("session.jsonl"),
        ];
        let mut kept_new = vec![
            logs.join("service-2026-10-20T00-00-00-000.log"),
            home.path().join("paste-cache").join("fresh"),
        ];
        for bucket in diagnostic_bucket_folders(data) {
            expired.push(bucket.join("2026-10-01.ndjson"));
            kept_new.push(bucket.join("2026-10-21.ndjson"));
        }
        for path in expired.iter().chain(&kept_old) {
            write_aged(path, OLD);
        }
        for path in &kept_new {
            write_aged(path, NEW);
        }

        let mut job = diagnostic_expiry_job(Arc::new(DiagnosticExpiryDeps {
            data_folder: data.to_path_buf(),
            live_files: Arc::new(Vec::new),
            configuration,
            reads,
        }));
        job(CancellationToken::new())
            .await
            .expect("the pass never fails");

        for path in &expired {
            assert!(!path.exists(), "{} is past the bound", path.display());
        }
        kept_old.append(&mut kept_new);
        for path in &kept_old {
            assert!(path.exists(), "{} is kept", path.display());
        }
    }
}
