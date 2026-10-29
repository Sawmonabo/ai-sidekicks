//! The diagnostic-log expiry: each pass deletes whole every diagnostic file last written longer ago
//! than the bound, so a file is kept as long as its newest line is young enough. It covers the
//! daemon's service log files and each provider service's log and kept tail in `logs/`, every
//! diagnostic bucket, the crash dumps and crash reports, and the provider diagnostic folders in
//! each account home, and asks each account home's driver to expire what its provider keeps there
//! beyond those folders. A file still being written, the one the service log holds open, a running
//! provider service's log, a partial crash dump or a crash-safe write's temporary file in either
//! crash folder, which the crash pass removes itself once no writer holds it, is never deleted, and
//! a running service's log past its cap is cut instead. A file in `logs/` that is no diagnostic log
//! is never touched, and no folder is removed. A file that cannot be read, cut or deleted is told
//! in the service log and the pass goes on. Each pass is metered against its processor budget.

use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_platforms::atomic_write_target_of;
use sidekicks_provider::account::homes::{account_home_diagnostic_folders, read_account_homes};
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::service_log::{
    SERVICE_LOG_CAP_BYTES, cap_provider_service_log, is_provider_service_log_file_name,
};
use sidekicks_std::missing_entry::{MissingEntry, is_gone};
use sidekicks_std::scheduler::ScheduledJobOutcome;
use sidekicks_std::scheduler::budget::{
    BudgetTerm, JobBudget, JobWorkload, MeteredJobOutcome, ProcessorMeter, metered_job,
};
use sidekicks_store::data_folder::service_log_folder;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

use crate::daemon::configuration::ConfigurationStore;
use crate::daemon::crash::monitor::{CRASH_DUMPS_FOLDER_NAME, is_partial_dump_name};
use crate::daemon::service_log::{
    CRASH_REPORTS_FOLDER_NAME, ServiceLogFiles, is_service_log_file_name,
};
use crate::observability::diagnostic_buckets::recorders::diagnostic_bucket_folders;

/// How often the expiry runs: hourly, so no log outlives its bound by more than an hour.
pub(crate) const DIAGNOSTIC_LOG_EXPIRY_INTERVAL: Duration = Duration::from_hours(1);

const DAY: Duration = Duration::from_hours(24);

// What an expiry pass counts its work in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiagnosticExpiryWorkUnit {
    // Entries the expiry examined.
    EntriesExamined,
    // Files the expiry deleted.
    FilesDeleted,
    // Rows a provider's own diagnostic store deleted for the expiry.
    RowsDeleted,
}

// A pass's processor time: under 1 ms per entry examined, 5 ms per file deleted and 20 µs per row
// a provider's own diagnostic store deleted.
const DIAGNOSTIC_EXPIRY_BUDGET: JobBudget<DiagnosticExpiryWorkUnit> = JobBudget::new(&[
    BudgetTerm {
        figure: Duration::from_millis(1),
        per: 1,
        unit: DiagnosticExpiryWorkUnit::EntriesExamined,
    },
    BudgetTerm {
        figure: Duration::from_millis(5),
        per: 1,
        unit: DiagnosticExpiryWorkUnit::FilesDeleted,
    },
    BudgetTerm {
        figure: Duration::from_micros(20),
        per: 1,
        unit: DiagnosticExpiryWorkUnit::RowsDeleted,
    },
]);

/// Names, at each pass, the files the expiry leaves alone: the one the service log holds open and
/// each running provider service's log. Blocking. Fails when a running service's log cannot be
/// named, which leaves the pass deleting nothing.
pub(crate) type LiveDiagnosticFiles = Arc<dyn Fn() -> io::Result<Vec<PathBuf>> + Send + Sync>;

/// The files each pass leaves alone: the service log's live file and each running provider
/// service's log, read at each pass.
pub(crate) fn live_diagnostic_files(
    service_log: ServiceLogFiles,
    providers: Arc<ProviderRegistry>,
) -> LiveDiagnosticFiles {
    Arc::new(move || {
        let mut files = providers.running_service_log_files()?;
        files.extend(service_log.live_file());
        Ok(files)
    })
}

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
    /// The drivers, each asked to expire what its provider keeps in its account homes.
    pub(crate) drivers: Arc<ProviderRegistry>,
}

// What a pass examined and deleted, in its budget's units.
#[derive(Default)]
struct ExpiryCount {
    examined: u64,
    deleted: u64,
    rows_deleted: u64,
}

/// The hourly expiry job, run every [`DIAGNOSTIC_LOG_EXPIRY_INTERVAL`] with
/// `Keep diagnostic logs for` as it stands at each pass and metered against its processor budget.
/// Never fails: account homes that cannot be read are told in the service log and the rest is
/// expired, and a pass that cannot name the running services' logs is told there and deletes
/// nothing.
pub(crate) fn diagnostic_expiry_job(
    deps: Arc<DiagnosticExpiryDeps>,
) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static {
    metered_job(
        DIAGNOSTIC_EXPIRY_BUDGET,
        Box::new(move |_stop, meter| run_expiry(Arc::clone(&deps), meter).boxed()),
    )
}

// One pass: every deletion runs on one blocking thread, metered, and only the cut of a running
// provider service's log runs after it.
async fn run_expiry(
    deps: Arc<DiagnosticExpiryDeps>,
    meter: ProcessorMeter,
) -> MeteredJobOutcome<DiagnosticExpiryWorkUnit> {
    let days = deps
        .configuration
        .current()
        .retention
        .keep_diagnostic_logs_days
        .get();
    let keep = DAY.saturating_mul(u32::try_from(days).unwrap_or(u32::MAX));
    let Some(cutoff) = SystemTime::now().checked_sub(keep) else {
        return Ok(None);
    };
    let live_files = Arc::clone(&deps.live_files);
    let logs_folder = service_log_folder(&deps.data_folder);
    let crash_folders = [
        deps.data_folder.join(CRASH_DUMPS_FOLDER_NAME),
        deps.data_folder.join(CRASH_REPORTS_FOLDER_NAME),
    ];
    let mut folders = diagnostic_bucket_folders(&deps.data_folder).to_vec();
    let mut driven_homes: Vec<(Arc<dyn ProviderDriver>, PathBuf)> = Vec::new();
    match read_account_homes(&deps.reads, &meter).await {
        Ok(account_homes) => {
            for account_home in account_homes {
                folders.extend(account_home_diagnostic_folders(
                    &deps.drivers,
                    &account_home.provider,
                    &account_home.home,
                ));
                // An account whose provider no driver answers has nothing more to expire.
                if let Some((_, driver)) = deps
                    .drivers
                    .drivers()
                    .find(|(provider, _)| provider.as_str() == account_home.provider)
                {
                    driven_homes.push((Arc::clone(driver), account_home.home));
                }
            }
        }
        Err(failure) => tracing::warn!(
            error = &failure as &(dyn Error + 'static),
            "the account homes' diagnostics could not be expired"
        ),
    }
    let expired = meter
        .run_blocking(move || {
            let mut count = ExpiryCount::default();
            // A pass that cannot name every live log deletes nothing, so no live log is expired.
            // Compared by name, so the folder may be spelled differently by the caller and the log.
            let live_file_names: Vec<OsString> = live_files()?
                .iter()
                .filter_map(|file| file.file_name().map(ToOwned::to_owned))
                .collect();
            let live_logs =
                expire_diagnostic_logs(&logs_folder, &live_file_names, cutoff, &mut count);
            for folder in &folders {
                expire_folder(folder, cutoff, &mut count, |_name| false);
            }
            // A partial dump and a write's temporary file are the crash pass's: it removes one no
            // writer holds, under its lock.
            for folder in &crash_folders {
                expire_folder(folder, cutoff, &mut count, |name| {
                    is_partial_dump_name(name) || atomic_write_target_of(name).is_some()
                });
            }
            for (driver, home) in &driven_homes {
                match driver.expire_account_home_diagnostics(home, cutoff) {
                    Ok(rows_deleted) => count.rows_deleted += rows_deleted,
                    Err(failure) => tracing::warn!(
                        home = %home.display(),
                        error = &*failure as &(dyn Error + 'static),
                        "a provider's diagnostics in an account home could not be expired"
                    ),
                }
            }
            Ok::<_, io::Error>((count, live_logs))
        })
        .await;
    let (count, live_logs) = match expired {
        Ok(Ok(expired)) => expired,
        Ok(Err(failure)) => {
            tracing::error!(
                error = &failure as &(dyn Error + 'static),
                "the running provider services' logs could not be named, so the diagnostic logs' \
                 expiry deleted nothing"
            );
            return Ok(None);
        }
        Err(failure) => {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "the diagnostic logs' expiry did not finish"
            );
            return Ok(None);
        }
    };
    for path in live_logs {
        if let Err(failure) = cap_provider_service_log(&path, SERVICE_LOG_CAP_BYTES).await {
            tracing::warn!(
                file = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "a running provider service's log could not be cut"
            );
        }
    }
    let mut workload = JobWorkload::of(DiagnosticExpiryWorkUnit::EntriesExamined, count.examined);
    workload.add(DiagnosticExpiryWorkUnit::FilesDeleted, count.deleted);
    workload.add(DiagnosticExpiryWorkUnit::RowsDeleted, count.rows_deleted);
    Ok(Some(workload))
}

// Deletes each diagnostic log in `logs_folder` last written before `cutoff`, except those named in
// `live_file_names`, and answers the running provider services' logs among them for their cut. A
// missing folder or file is skipped, and any other failure is written to the service log.
fn expire_diagnostic_logs(
    logs_folder: &Path,
    live_file_names: &[OsString],
    cutoff: SystemTime,
    count: &mut ExpiryCount,
) -> Vec<PathBuf> {
    let names = match list_service_log_names(logs_folder).none_if_missing() {
        Ok(Some(names)) => names,
        Ok(None) => return Vec::new(),
        Err(failure) => {
            tracing::warn!(
                folder = %logs_folder.display(),
                error = &failure as &(dyn Error + 'static),
                "the diagnostic logs could not be listed"
            );
            return Vec::new();
        }
    };
    let mut live_logs = Vec::new();
    for name in names {
        count.examined += 1;
        let path = logs_folder.join(&name);
        if live_file_names.iter().any(|live| *live == *name) {
            if is_provider_service_log_file_name(&name) {
                live_logs.push(path);
            }
            continue;
        }
        // A file deleted since the listing is already gone.
        match delete_if_written_before(&path, cutoff).none_if_missing() {
            Ok(Some(true)) => count.deleted += 1,
            Ok(Some(false) | None) => {}
            Err(failure) => tracing::warn!(
                file = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "a diagnostic log could not be expired"
            ),
        }
    }
    live_logs
}

fn list_service_log_names(logs_folder: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(logs_folder)? {
        // A name that is not UTF-8 is no diagnostic log's.
        if let Ok(name) = entry?.file_name().into_string()
            && (is_service_log_file_name(&name) || is_provider_service_log_file_name(&name))
        {
            names.push(name);
        }
    }
    Ok(names)
}

// Deletes the file at `path` when it is a plain file last written before `cutoff`; answers whether
// it did.
fn delete_if_written_before(path: &Path, cutoff: SystemTime) -> io::Result<bool> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_file() && metadata.modified()? < cutoff {
        std::fs::remove_file(path)?;
        return Ok(true);
    }
    Ok(false)
}

// Deletes every plain file anywhere under `folder` last written before `cutoff`, except one whose
// name `is_owned_elsewhere` takes, following no link and removing no folder. A missing folder or
// file is skipped, and any other failure is written to the service log.
fn expire_folder(
    folder: &Path,
    cutoff: SystemTime,
    count: &mut ExpiryCount,
    is_owned_elsewhere: impl Fn(&str) -> bool,
) {
    for entry in WalkDir::new(folder).follow_root_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(failure) => {
                // A folder that is not there, or an entry deleted since the listing, holds nothing.
                if !failure.io_error().is_some_and(is_gone) {
                    tracing::warn!(
                        folder = %folder.display(),
                        error = &failure as &(dyn Error + 'static),
                        "a diagnostic folder could not be listed"
                    );
                }
                continue;
            }
        };
        count.examined += 1;
        if !entry.file_type().is_file()
            || entry.file_name().to_str().is_some_and(&is_owned_elsewhere)
        {
            continue;
        }
        let path = entry.path();
        match delete_if_written_before(path, cutoff).none_if_missing() {
            Ok(Some(true)) => count.deleted += 1,
            Ok(Some(false) | None) => {}
            Err(failure) => tracing::warn!(
                file = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "a diagnostic file could not be expired"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::fs;
    use std::io;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use rusqlite::types::Value;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
    use sidekicks_provider::driver::test_registry::registry_of_first_providers;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::events::log_service::test_fixture::open_log;
    use tokio_util::sync::CancellationToken;

    use super::{DiagnosticExpiryDeps, diagnostic_expiry_job};
    use crate::daemon::configuration::{
        ConfigurationStore, DAEMON_CONFIGURATION_STATEMENT_CAPACITY,
    };
    use crate::daemon::crash::monitor::CRASH_DUMPS_FOLDER_NAME;
    use crate::daemon::schema::schema_parts;
    use crate::daemon::service_log::CRASH_REPORTS_FOLDER_NAME;
    use crate::observability::diagnostic_buckets::recorders::diagnostic_bucket_folders;

    // Past the default bound of seven days.
    const OLD: Duration = Duration::from_hours(24 * 8);

    const NEW: Duration = Duration::from_hours(1);

    const KEEP: Duration = Duration::from_hours(24 * 7);

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
    // the service log, each bucket, the crash dumps and reports, and every folder each provider's
    // descriptor names in its account home, where a session's file of the same age stays; a file in
    // `logs/` that is no log stays too, and so do a partial dump and a write's temporary file, the
    // crash pass's; each account home's driver is asked once to expire what its provider keeps
    // there, with the bound's cutoff; and an account whose provider no driver answers keeps its
    // folders whole. Killed by a per-session folder in a descriptor's list, by a bucket or crash
    // folder left out of the pass, by a partial dump or a crash folder's temporary file expired, by
    // the account homes left unread, by a descriptor's folders not read, by folders read for a
    // provider no driver answers, by the driver never asked or asked about another home, and by a
    // cutoff off the bound.
    #[tokio::test]
    async fn a_pass_deletes_every_diagnostic_past_the_bound_and_no_session_file() {
        let database = TestDatabase::new(schema_parts());
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
        let data = data_folder.path();
        let logs = data.join("logs");
        let mut expired = vec![
            logs.join("service-2026-10-01T00-00-00-000.log"),
            data.join(CRASH_DUMPS_FOLDER_NAME).join("crash.dmp"),
            data.join(CRASH_REPORTS_FOLDER_NAME).join("crash.json"),
        ];
        let mut kept_old = vec![
            logs.join("notes.txt"),
            data.join(CRASH_DUMPS_FOLDER_NAME).join("crash.dmp.partial"),
            data.join(CRASH_REPORTS_FOLDER_NAME)
                .join("x.json.a1b2c3.tmp"),
        ];
        let mut kept_new = vec![logs.join("service-2026-10-20T00-00-00-000.log")];
        for bucket in diagnostic_bucket_folders(data) {
            expired.push(bucket.join("2026-10-01.ndjson"));
            kept_new.push(bucket.join("2026-10-21.ndjson"));
        }
        let homes: Vec<tempfile::TempDir> = PROVIDERS
            .iter()
            .map(|_| tempfile::tempdir().expect("an account home is made"))
            .collect();
        // The last provider has no driver in the registry.
        let driven_count = PROVIDERS.len() - 1;
        let started = SystemTime::now();
        let mut drivers: Vec<Arc<dyn ProviderDriver>> = Vec::new();
        for (index, (descriptor, home)) in PROVIDERS.iter().zip(&homes).enumerate() {
            let home = home.path();
            log.writer
                .write(vec![WriteStatement {
                    sql: Cow::Borrowed(
                        "INSERT INTO provider_accounts (account_id, provider, \
                         credential_home_path, billing_mode, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, 'unknown', '2026-10-01T00:00:00Z', \
                         '2026-10-01T00:00:00Z')",
                    ),
                    bindings: StatementBindings::Positional(vec![
                        Value::Text(format!("account-{}", descriptor.id)),
                        Value::Text(descriptor.id.to_owned()),
                        Value::Text(home.display().to_string()),
                    ]),
                    expected_row_count: Some(1),
                }])
                .await
                .expect("the account is written");
            kept_old.push(home.join("session.jsonl"));
            kept_old.push(home.join("projects").join("project").join("session.jsonl"));
            let folders = descriptor
                .account_home_diagnostic_folders
                .iter()
                .map(|components| {
                    components
                        .iter()
                        .fold(home.to_path_buf(), |path, part| path.join(part))
                });
            if index == driven_count {
                kept_old.extend(folders.map(|folder| folder.join("old").join("diagnostic")));
                continue;
            }
            for folder in folders {
                expired.push(folder.join("old").join("diagnostic"));
                kept_new.push(folder.join("fresh"));
            }
            let expected_home = home.to_path_buf();
            let mut driver = MockProviderDriver::new();
            driver
                .expect_expire_account_home_diagnostics()
                .withf(move |asked_home: &Path, cutoff: &SystemTime| {
                    asked_home == expected_home
                        && *cutoff >= started - KEEP
                        && *cutoff <= SystemTime::now() - KEEP
                })
                .times(1)
                .returning(|_, _| Ok(0));
            drivers.push(Arc::new(driver));
        }
        let drivers = Arc::new(registry_of_first_providers(drivers));
        for path in expired.iter().chain(&kept_old) {
            write_aged(path, OLD);
        }
        for path in &kept_new {
            write_aged(path, NEW);
        }

        let mut job = diagnostic_expiry_job(Arc::new(DiagnosticExpiryDeps {
            data_folder: data.to_path_buf(),
            live_files: Arc::new(|| Ok(Vec::new())),
            configuration,
            reads,
            drivers,
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
    // A pass that cannot name the running services' logs deletes nothing, since it may not know
    // which log is still written. Killed by passing over the failed listing as no live log.
    #[tokio::test]
    async fn a_pass_that_cannot_name_the_live_logs_deletes_nothing() {
        let database = TestDatabase::new(schema_parts());
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
        let data = data_folder.path();
        let old = [
            data.join("logs").join("codex-service-home.log"),
            data.join("logs")
                .join("service-2026-10-01T00-00-00-000.log"),
            data.join(CRASH_DUMPS_FOLDER_NAME).join("crash.dmp"),
        ];
        for path in &old {
            write_aged(path, OLD);
        }

        let mut job = diagnostic_expiry_job(Arc::new(DiagnosticExpiryDeps {
            data_folder: data.to_path_buf(),
            live_files: Arc::new(|| Err(io::Error::other("the records cannot be listed"))),
            configuration,
            reads,
            drivers: Arc::new(registry_of_first_providers(Vec::new())),
        }));
        job(CancellationToken::new())
            .await
            .expect("the pass never fails");

        for path in &old {
            assert!(path.exists(), "{} is kept", path.display());
        }
    }
}
